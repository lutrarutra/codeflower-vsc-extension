// One connection to a worker: its agent over ACP (several sessions at once),
// the worker's session records, and the agent's own sign-in flows. It does not
// use the VS Code API, so it can be tested against the real bridge.
import type {
  AuthMethod,
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  SetSessionConfigOptionResponse,
  StopReason
} from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import {
  SHELL_CONTEXT_META,
  type AgentName,
  type FormContent,
  type FormSchema,
  type PendingPermission,
  type PendingQuestion,
  type QuestionAction,
  type SandboxFile,
  type TranscriptEntry
} from '../shared/messages.ts';
import type { UsageTotals, WorkerUsage } from '../shared/usage.ts';

const MAX_SHELL_CONTEXT = 16 * 1024;

interface ShellRun {
  sessionKey: string;
  command: string;
  output: string;
}
import { AcpClient, ConnectionClosed, METHOD_NOT_FOUND, RpcError } from './acpClient.ts';
import type { WorkerAddress } from './address.ts';
import { sessionKey } from './sessionKey.ts';

export const WORKSPACE = '/codeflower-state/workspace';

/** What session/new, session/resume, and session/load may report about settings. */
interface SessionSettings {
  configOptions?: SessionConfigOption[] | null;
  modes?: SessionModeState | null;
  _meta?: {
    /** How many transcript entries the worker had recorded when it attached the session here. */
    'codeflower/transcriptEntries'?: number;
    /** The agent was working on the session (a turn started by an earlier connection). */
    'codeflower/busy'?: boolean;
  } | null;
}

/** A session attached on this connection. */
export interface AttachedSession {
  key: string;
  /** The live updates start after this many transcript entries; unknown from older workers. */
  transcriptEntries?: number;
}

/** What the worker's agent is doing, sent by the worker whenever it changes. */
export interface WorkerActivity {
  chats: { key: string; state: 'working' | 'waiting'; waitingFor?: 'plan' | 'permission' | 'question' }[];
  working: number;
  waiting: number;
}

/** The worker sends its pending requests again to a window that reattaches; they are in the transcript already. */
const REPLAYED_META = 'codeflower/replayed';

/** The worker closes a connection with this code when another window takes it over. */
export const TAKEN_OVER = 4001;

/** Agents with only the older modes API get their modes as a config option. */
function modeOption(modes: SessionModeState): SessionConfigOption {
  return {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: modes.currentModeId,
    options: modes.availableModes.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description }))
  };
}
export const AUTH_REQUIRED = -32000;

export interface WorkerStatus {
  instanceId: string;
  agent: AgentName;
  agentLabel: string;
  signedIn: boolean;
  /** 'agent': the agent signs in itself (ACP); 'keys': code flower stores keys for it (dsh). */
  credentials: 'agent' | 'keys';
  stateDirectory: string | null;
  engine: string;
  slurmJobId?: string;
  /** Folders the launcher mounted, e.g. /data/input/study42; missing from older workers. */
  mounts?: Mount[];
}

export interface Mount {
  target: string;
  /** The folder on the machine that runs the sandbox. */
  source: string;
  readOnly: boolean;
}

export interface SessionRecord {
  key: string;
  harness: AgentName;
  nativeSessionId: string;
  cwd: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  openOn?: string;
  /** The session's tokens and cost so far; missing from older workers. */
  usage?: UsageTotals | null;
}

/** A URL the agent asks the user to open, e.g. a device-code sign-in. */
export interface UrlElicitation {
  url: string;
  message: string;
  elicitationId?: string;
}

export interface WorkerHandlers {
  entry(sessionKey: string, entry: TranscriptEntry): void;
  permission(sessionKey: string, request: PendingPermission | null): void;
  /** A question for the user (an ACP form), e.g. Claude Code's AskUserQuestion; null when answered. */
  question(sessionKey: string, request: PendingQuestion | null): void;
  busy(sessionKey: string, busy: boolean): void;
  /** The session's settings the agent offers (mode, model, effort, …) changed. */
  config(sessionKey: string, options: SessionConfigOption[]): void;
  /** Resolves when the user accepted or declined. */
  elicitUrl(request: UrlElicitation): Promise<'accept' | 'decline'>;
  elicitationComplete(elicitationId: string): void;
  /** The agent ran `codeflower-show`: the user should see these files. */
  show(request: ShowRequest): void;
  terminalOutput(terminalId: string, data: string): void;
  terminalExit(terminalId: string, exitCode: number): void;
  /** Token counts, cost, or the login's quota changed. */
  usage(usage: WorkerUsage): void;
  closed(reason: string, code: number): void;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
  mimeType?: string;
}

export interface DirectoryListing {
  path: string;
  entries: DirectoryEntry[];
  truncated: boolean;
}

export interface ShowRequest {
  files: SandboxFile[];
  title?: string;
  message?: string;
}

export interface DshCredentials {
  deepseekApiKey?: string;
  openaiCompatible?: { baseURL: string; models: string[]; apiKey: string };
}

function now(): string {
  return new Date().toISOString();
}

export function isAuthRequired(error: unknown): boolean {
  return error instanceof RpcError && error.code === AUTH_REQUIRED;
}

export class WorkerConnection {
  readonly address: WorkerAddress;
  authMethods: AuthMethod[] = [];
  agent: AgentName | undefined;

  private readonly client: AcpClient;
  private readonly handlers: WorkerHandlers;
  /** Native session ids of the sessions attached on this connection, by key. */
  private readonly sessions = new Map<string, string>();
  private readonly replaying = new Set<string>();
  /** Each session's settings; `modesOnly` marks agents that predate config options. */
  private readonly configs = new Map<string, { options: SessionConfigOption[]; modesOnly: boolean }>();
  private nextPermissionId = 1;
  private readonly permissions = new Map<
    number,
    { resolve: (response: RequestPermissionResponse) => void; sessionKey: string; request: PendingPermission }
  >();
  /** Sessions with a prompt in flight. */
  private readonly busySessions = new Set<string>();
  /** Sessions with a turn an earlier connection started, as the worker reports. */
  private readonly remoteBusy = new Set<string>();
  private readonly shells = new Map<string, ShellRun>();
  /** Shell commands the agent has not been told about yet, by session. */
  private readonly shellContext = new Map<string, string[]>();
  private readonly questions = new Map<
    number,
    {
      resolve: (response: { action: QuestionAction; content?: FormContent }) => void;
      sessionKey: string;
      request: PendingQuestion;
    }
  >();

  private constructor(address: WorkerAddress, client: AcpClient, handlers: WorkerHandlers) {
    this.address = address;
    this.client = client;
    this.handlers = handlers;
  }

  static async connect(address: WorkerAddress, handlers: WorkerHandlers, clientVersion: string): Promise<WorkerConnection> {
    const client = new AcpClient();
    await client.connect(address.url, address.token);
    const connection = new WorkerConnection(address, client, handlers);
    client.onClose((reason, code) => connection.handleClose(reason, code));
    client.onNotification((method, params) => connection.handleNotification(method, params));
    client.onRequest((method, params) => connection.handleRequest(method, params));
    try {
      const status = await connection.status();
      connection.agent = status.agent;
      const initialized = await client.request<InitializeResponse>('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          // Sign-ins run in a terminal inside the sandbox (Claude Code) or
          // as a link the user opens (Codex device code).
          auth: { terminal: true },
          // Forms carry the agent's questions; Claude Code offers AskUserQuestion only with them.
          elicitation: { url: {}, form: {} },
          _meta: { 'terminal-auth': true }
        },
        clientInfo: { name: 'codeflower-vscode', title: 'code flower', version: clientVersion }
      });
      connection.authMethods = initialized.authMethods ?? [];
      return connection;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  get connected(): boolean {
    return this.client.connected;
  }

  close(): void {
    for (const [requestId] of this.permissions) this.answerPermission(requestId, null);
    for (const [requestId] of this.questions) this.answerQuestion(requestId, 'cancel', null);
    this.client.close();
  }

  // ---- worker ----

  status(): Promise<WorkerStatus> {
    return this.client.request<WorkerStatus>('_codeflower/status', {});
  }

  /** Undefined from workers that do not track usage yet. */
  async usage(): Promise<WorkerUsage | undefined> {
    try {
      return await this.client.request<WorkerUsage>('_codeflower/usage', {});
    } catch (error) {
      if (error instanceof RpcError && error.code === METHOD_NOT_FOUND) return undefined;
      throw error;
    }
  }

  async listSessions(): Promise<SessionRecord[]> {
    return (await this.client.request<{ sessions: SessionRecord[] }>('_codeflower/sessions/list', {})).sessions;
  }

  async transcript(key: string): Promise<TranscriptEntry[]> {
    return (await this.client.request<{ entries: TranscriptEntry[] }>('_codeflower/sessions/transcript', { key }))
      .entries;
  }

  async renameSession(key: string, title: string): Promise<void> {
    await this.client.request('_codeflower/sessions/rename', { key, title });
  }

  async deleteSession(key: string): Promise<void> {
    await this.client.request('_codeflower/sessions/delete', { key });
  }

  // ---- files in the sandbox ----

  async readFile(path: string): Promise<SandboxFile & { data: string }> {
    return this.client.request<SandboxFile & { data: string }>('_codeflower/files/read', { path });
  }

  async statFile(path: string): Promise<SandboxFile> {
    return this.client.request<SandboxFile>('_codeflower/files/stat', { path });
  }

  /**
   * Saves the comments the user left on a storyteller report (a JSON array) into the
   * report's store and its page. Workers from before comments do not have this.
   */
  async saveReportComments(path: string, comments: string): Promise<void> {
    try {
      await this.client.request('_codeflower/reports/comments', { path, comments });
    } catch (error) {
      if (error instanceof RpcError && error.code === METHOD_NOT_FOUND) {
        throw new Error('this sandbox is too old to save comments; update its image');
      }
      throw error;
    }
  }

  /** Notes in the session's history which files the agent showed the user. */
  async recordShow(key: string, files: string[], message?: string): Promise<void> {
    const sessionId = this.sessions.get(key);
    if (!sessionId) return;
    const entry = { kind: 'show' as const, files, ...(message ? { message } : {}) };
    this.handlers.entry(key, { t: now(), ...entry });
    await this.client.request('_codeflower/sessions/record', { sessionId, entry });
  }

  async listDirectory(path: string): Promise<DirectoryListing> {
    return this.client.request<DirectoryListing>('_codeflower/files/list', { path });
  }

  // ---- sessions ----

  isAttached(key: string): boolean {
    return this.sessions.has(key);
  }

  async newSession(): Promise<string> {
    const response = await this.client.request<NewSessionResponse>('session/new', { cwd: WORKSPACE, mcpServers: [] });
    const key = this.attach(response.sessionId);
    this.setConfig(key, response);
    return key;
  }

  /**
   * Attaches a session on this connection. The worker's agent may still have it
   * loaded, even mid-turn, from an earlier connection.
   */
  async resumeSession(nativeSessionId: string, cwd: string | null): Promise<AttachedSession> {
    const existing = sessionKey(this.requireAgent(), nativeSessionId);
    if (this.sessions.has(existing)) return { key: existing };
    const params = { sessionId: nativeSessionId, cwd: cwd ?? WORKSPACE, mcpServers: [] };
    // History is shown from code flower's transcript; ignore any replay.
    this.replaying.add(nativeSessionId);
    let response: SessionSettings | null;
    try {
      try {
        response = await this.client.request<SessionSettings | null>('session/resume', params);
      } catch (error) {
        if (!(error instanceof RpcError) || error.code !== METHOD_NOT_FOUND) throw error;
        response = await this.client.request<SessionSettings | null>('session/load', params);
      }
    } finally {
      this.replaying.delete(nativeSessionId);
    }
    const key = this.attach(nativeSessionId);
    this.setConfig(key, response ?? {});
    const meta = response?._meta;
    if (meta?.['codeflower/busy']) this.setRemoteBusy(key, true);
    const transcriptEntries = meta?.['codeflower/transcriptEntries'];
    return { key, ...(typeof transcriptEntries === 'number' ? { transcriptEntries } : {}) };
  }

  /** What a session is doing now, for a chat tab that opens mid-turn. */
  activity(key: string): { busy: boolean; permission: PendingPermission | null; question: PendingQuestion | null } {
    const find = <T>(map: Map<number, { sessionKey: string; request: T }>) =>
      [...map.values()].find((pending) => pending.sessionKey === key)?.request ?? null;
    return { busy: this.isBusy(key), permission: find(this.permissions), question: find(this.questions) };
  }

  config(key: string): SessionConfigOption[] {
    return this.configs.get(key)?.options ?? [];
  }

  async setConfigOption(key: string, configId: string, value: string | boolean): Promise<void> {
    const sessionId = this.sessions.get(key);
    const config = this.configs.get(key);
    if (!sessionId || !config) throw new Error('This session is not open on the worker');
    if (config.modesOnly) {
      await this.client.request('session/set_mode', { sessionId, modeId: String(value) });
      this.applyMode(key, String(value));
      return;
    }
    const response = await this.client.request<SetSessionConfigOptionResponse>(
      'session/set_config_option',
      typeof value === 'boolean' ? { sessionId, configId, type: 'boolean', value } : { sessionId, configId, value }
    );
    this.configs.set(key, { options: response.configOptions, modesOnly: false });
    this.handlers.config(key, response.configOptions);
  }

  async prompt(key: string, text: string): Promise<StopReason> {
    const sessionId = this.sessions.get(key);
    if (!sessionId) throw new Error('This session is not open on the worker');
    const prompt = [{ type: 'text' as const, text }];
    this.handlers.entry(key, { t: now(), kind: 'prompt', prompt });
    // Like Claude Code's `!` commands: the agent sees what the user ran with the next message.
    // A slash command must stay the first block for the agent to run it, so the
    // commands wait for the next message instead.
    const command = text.trimStart().startsWith('/');
    const context = command ? undefined : this.shellContext.get(key);
    if (!command) this.shellContext.delete(key);
    const blocks = context?.length
      ? [{ type: 'text' as const, text: context.join('\n\n'), _meta: { [SHELL_CONTEXT_META]: true } }, ...prompt]
      : prompt;
    this.busySessions.add(key);
    this.handlers.busy(key, true);
    try {
      const response = await this.client.request<PromptResponse>('session/prompt', { sessionId, prompt: blocks });
      this.handlers.entry(key, { t: now(), kind: 'turn_end', stopReason: response.stopReason });
      return response.stopReason;
    } finally {
      this.busySessions.delete(key);
      // A dropped connection leaves the turn running on the worker.
      if (this.connected) this.handlers.busy(key, this.isBusy(key));
    }
  }

  cancel(key: string): void {
    const sessionId = this.sessions.get(key);
    if (!sessionId) return;
    for (const [requestId, pending] of this.permissions) {
      if (pending.sessionKey === key) this.answerPermission(requestId, null);
    }
    for (const [requestId, pending] of this.questions) {
      if (pending.sessionKey === key) this.answerQuestion(requestId, 'cancel', null);
    }
    this.client.notify('session/cancel', { sessionId });
  }

  answerPermission(requestId: number, optionId: string | null): void {
    const pending = this.permissions.get(requestId);
    if (!pending) return;
    this.permissions.delete(requestId);
    const outcome = optionId ? ({ outcome: 'selected', optionId } as const) : ({ outcome: 'cancelled' } as const);
    this.handlers.entry(pending.sessionKey, { t: now(), kind: 'permission_outcome', outcome });
    this.handlers.permission(pending.sessionKey, null);
    pending.resolve({ outcome });
  }

  /** Runs the user's `!command` in the sandbox's workspace; output streams as entries. */
  async runShell(key: string, command: string): Promise<{ exitCode: number; timedOut: boolean }> {
    const sessionId = this.sessions.get(key);
    if (!sessionId) throw new Error('This session is not open on the worker');
    const runId = randomUUID();
    const run: ShellRun = { sessionKey: key, command, output: '' };
    this.shells.set(runId, run);
    this.handlers.entry(key, { t: now(), kind: 'shell', runId, command });
    let result = { exitCode: 1, timedOut: false };
    try {
      result = await this.client.request<{ exitCode: number; timedOut: boolean }>('_codeflower/shell/run', {
        sessionId,
        runId,
        command
      });
    } catch (error) {
      run.output += `${error instanceof Error ? error.message : String(error)}\n`;
      this.handlers.entry(key, { t: now(), kind: 'shell_output', runId, data: run.output });
    } finally {
      this.shells.delete(runId);
      this.handlers.entry(key, { t: now(), kind: 'shell_end', runId, ...result });
      const output = run.output.length > MAX_SHELL_CONTEXT ? `${run.output.slice(0, MAX_SHELL_CONTEXT)}\n[output truncated]` : run.output;
      const note = [
        'The user ran this shell command in the sandbox themselves (not you):',
        `$ ${command}`,
        `[exit code ${result.exitCode}${result.timedOut ? ', timed out' : ''}]`,
        output.trimEnd() || '[no output]'
      ].join('\n');
      this.shellContext.set(key, [...(this.shellContext.get(key) ?? []), note]);
    }
    return result;
  }

  cancelShell(runId: string): void {
    if (this.shells.has(runId)) void this.client.request('_codeflower/shell/cancel', { runId }).catch(() => undefined);
  }

  answerQuestion(requestId: number, action: QuestionAction, content: FormContent | null): void {
    const pending = this.questions.get(requestId);
    if (!pending) return;
    this.questions.delete(requestId);
    this.handlers.entry(pending.sessionKey, { t: now(), kind: 'question_outcome', action, content });
    this.handlers.question(pending.sessionKey, null);
    pending.resolve(action === 'accept' ? { action, content: content ?? {} } : { action });
  }

  // ---- sign-in ----

  /** ACP sign-in handled by the agent, e.g. Codex's API key or device code. */
  async authenticate(methodId: string, meta?: Record<string, unknown>): Promise<unknown> {
    return this.client.request('authenticate', { methodId, ...(meta ? { _meta: meta } : {}) });
  }

  async startTerminal(methodId: string, columns: number, rows: number): Promise<string> {
    return (
      await this.client.request<{ terminalId: string }>('_codeflower/terminal/start', { methodId, columns, rows })
    ).terminalId;
  }

  async terminalInput(terminalId: string, data: string): Promise<void> {
    await this.client.request('_codeflower/terminal/input', { terminalId, data });
  }

  async closeTerminal(terminalId: string): Promise<void> {
    await this.client.request('_codeflower/terminal/close', { terminalId });
  }

  /** dsh keys; the agent must be restarted to pick them up. */
  async setCredentials(credentials: DshCredentials): Promise<void> {
    await this.client.request('_codeflower/credentials/set', credentials);
  }

  /** Ends the worker's agent (refused while chats are working); the next connection starts a fresh one. */
  async restartAgent(): Promise<void> {
    await this.client.request('_codeflower/agent/restart', {});
  }

  // ---- internals ----

  private isBusy(key: string): boolean {
    return this.busySessions.has(key) || this.remoteBusy.has(key);
  }

  private setRemoteBusy(key: string, busy: boolean): void {
    const before = this.isBusy(key);
    if (busy) this.remoteBusy.add(key);
    else this.remoteBusy.delete(key);
    if (this.isBusy(key) !== before) this.handlers.busy(key, !before);
  }

  private requireAgent(): AgentName {
    if (!this.agent) throw new Error('The worker did not report its agent');
    return this.agent;
  }

  private attach(nativeSessionId: string): string {
    const key = sessionKey(this.requireAgent(), nativeSessionId);
    this.sessions.set(key, nativeSessionId);
    return key;
  }

  private setConfig(key: string, settings: SessionSettings): void {
    const options = settings.configOptions ?? (settings.modes ? [modeOption(settings.modes)] : []);
    this.configs.set(key, { options, modesOnly: !settings.configOptions && !!settings.modes });
    this.handlers.config(key, options);
  }

  /** Mode changes the agent made itself, e.g. leaving plan mode. */
  private applyMode(key: string, modeId: string): void {
    const config = this.configs.get(key);
    if (!config) return;
    config.options = config.options.map((option) =>
      option.category === 'mode' && option.type === 'select' ? { ...option, currentValue: modeId } : option
    );
    this.handlers.config(key, config.options);
  }

  private keyFor(nativeSessionId: string): string | undefined {
    const key = this.agent ? sessionKey(this.agent, nativeSessionId) : undefined;
    return key && this.sessions.has(key) ? key : undefined;
  }

  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'session/update': {
        const notification = params as SessionNotification;
        if (this.replaying.has(notification.sessionId)) return;
        const key = this.keyFor(notification.sessionId);
        if (!key) break;
        const update = notification.update;
        if (update.sessionUpdate === 'config_option_update') {
          this.configs.set(key, { options: update.configOptions, modesOnly: false });
          this.handlers.config(key, update.configOptions);
        } else if (update.sessionUpdate === 'current_mode_update') {
          this.applyMode(key, update.currentModeId);
        }
        this.handlers.entry(key, { t: now(), kind: 'update', update });
        break;
      }
      case '_codeflower/shell/output': {
        const { runId, data } = params as { runId: string; data: string };
        const run = this.shells.get(runId);
        if (!run) break;
        if (run.output.length < MAX_SHELL_CONTEXT * 4) run.output += data;
        this.handlers.entry(run.sessionKey, { t: now(), kind: 'shell_output', runId, data });
        break;
      }
      case '_codeflower/show':
        this.handlers.show(params as ShowRequest);
        break;
      case '_codeflower/activity': {
        const working = new Set((params as WorkerActivity).chats.map((chat) => chat.key));
        for (const key of this.sessions.keys()) this.setRemoteBusy(key, working.has(key));
        break;
      }
      case '_codeflower/usage':
        this.handlers.usage(params as WorkerUsage);
        break;
      case 'elicitation/complete':
        this.handlers.elicitationComplete(String((params as { elicitationId?: unknown }).elicitationId ?? ''));
        break;
      case '_codeflower/terminal/output': {
        const { terminalId, data } = params as { terminalId: string; data: string };
        this.handlers.terminalOutput(terminalId, data);
        break;
      }
      case '_codeflower/terminal/exit': {
        const { terminalId, exitCode } = params as { terminalId: string; exitCode: number };
        this.handlers.terminalExit(terminalId, exitCode);
        break;
      }
    }
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'session/request_permission') {
      const request = params as RequestPermissionRequest;
      const key = this.keyFor(request.sessionId) ?? sessionKey(this.requireAgent(), request.sessionId);
      const requestId = this.nextPermissionId++;
      if (!request._meta?.[REPLAYED_META]) {
        this.handlers.entry(key, { t: now(), kind: 'permission', toolCall: request.toolCall ?? null, options: request.options });
      }
      return new Promise<RequestPermissionResponse>((resolve) => {
        const pending = { requestId, toolCall: request.toolCall ?? null, options: request.options };
        this.permissions.set(requestId, { resolve, sessionKey: key, request: pending });
        this.handlers.permission(key, pending);
      });
    }
    if (method === 'elicitation/create') {
      const request = params as {
        mode?: string;
        url?: string;
        message?: string;
        elicitationId?: string;
        sessionId?: string;
        requestedSchema?: FormSchema;
        toolCallId?: string;
        _meta?: Record<string, unknown>;
      };
      if (request.mode === 'form' || (request.mode === undefined && request.requestedSchema)) {
        const key = request.sessionId ? this.keyFor(request.sessionId) : undefined;
        // Forms belong in a chat; one for no open session cannot be shown.
        if (!key) return { action: 'decline' };
        const question = { message: request.message ?? '', requestedSchema: request.requestedSchema ?? {} };
        const requestId = this.nextPermissionId++;
        if (!request._meta?.[REPLAYED_META]) {
          this.handlers.entry(key, {
            t: now(),
            kind: 'question',
            ...question,
            ...(request.toolCallId ? { toolCallId: request.toolCallId } : {})
          });
        }
        return new Promise((resolve) => {
          const pending = { requestId, ...question };
          this.questions.set(requestId, { resolve, sessionKey: key, request: pending });
          this.handlers.question(key, pending);
        });
      }
      if (request.mode !== 'url' || typeof request.url !== 'string') {
        return { action: 'decline' };
      }
      const action = await this.handlers.elicitUrl({
        url: request.url,
        message: request.message ?? 'Open this link to continue.',
        ...(request.elicitationId ? { elicitationId: request.elicitationId } : {})
      });
      return { action };
    }
    throw new RpcError({ code: METHOD_NOT_FOUND, message: `Method not found: ${method}` });
  }

  /**
   * The worker's agent keeps working without us: pending requests are asked
   * again when the session is reattached, so they are only hidden here.
   */
  private handleClose(reason: string, code: number): void {
    this.permissions.clear();
    this.questions.clear();
    for (const key of this.sessions.keys()) {
      this.handlers.permission(key, null);
      this.handlers.question(key, null);
    }
    this.sessions.clear();
    this.remoteBusy.clear();
    this.handlers.closed(reason, code);
  }
}

/** A request the connection dropped; the worker carries on with it. */
export function isConnectionClosed(error: unknown): boolean {
  return error instanceof ConnectionClosed;
}
