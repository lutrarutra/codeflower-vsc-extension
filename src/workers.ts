import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import type {
  AgentName,
  BackgroundTask,
  ChatAction,
  PendingPermission,
  PendingQuestion,
  TranscriptEntry
} from 'codeflower-ui/protocol/messages.ts';
import type { SubagentSettingsState, SubagentSummary } from 'codeflower-ui/protocol/subagents.ts';
import type { WorkerUsage } from 'codeflower-ui/protocol/usage.ts';
import type { AgentCommand } from 'codeflower-ui/protocol/commands.ts';
import { parseWorkerAddress, type WorkerAddress } from 'codeflower-ui/client/address.ts';
import {
  TAKEN_OVER,
  WorkerConnection,
  type AgentState,
  type ChatTerminal,
  type SessionRecord,
  type ShowRequest,
  type UrlElicitation,
  type WorkerQueue,
  type WorkerStatus,
  type WrapUpNotice
} from 'codeflower-ui/client/workerConnection.ts';
import { wrapUpMessage } from './wrapUp.ts';
import { wsTransport } from './wsTransport.ts';

const WORKERS_SECRET = 'codeflower.workers';
const POLL_MS = 10_000;

export interface WorkerEntry {
  /** host:port; unique per worker. */
  id: string;
  address: WorkerAddress;
  state: 'connecting' | 'connected' | 'disconnected';
  connection?: WorkerConnection;
  status?: WorkerStatus;
  /** Its agents: whether each can run, is signed in, runs. */
  agents: AgentState[];
  actions?: ChatAction[];
  sessions: SessionRecord[];
  /** Each agent's tokens, cost, and quota; the worker sends changes as they happen. */
  usage: Record<AgentName, WorkerUsage>;
  /** The defaults of each agent's subagents; missing for agents without them in code flower. */
  subagentSettings: Record<AgentName, SubagentSettingsState>;
  error?: string;
  /** Another window took the worker over (older workers only); it is not reconnected until the user asks. */
  takenOver?: boolean;
}

/** Receives what a worker's agent sends, tagged with the worker. */
export interface WorkerRouter {
  entry(workerId: string, sessionKey: string, entry: TranscriptEntry): void;
  permission(workerId: string, sessionKey: string, request: PendingPermission | null): void;
  question(workerId: string, sessionKey: string, request: PendingQuestion | null): void;
  busy(workerId: string, sessionKey: string, busy: boolean): void;
  /** A chat's prompts queued on the worker: when it opens here, and when they change from any window. */
  queue(workerId: string, sessionKey: string, queue: WorkerQueue): void;
  /** The agent's work that runs on after its turns (e.g. background commands) started or ended. */
  background(workerId: string, sessionKey: string, tasks: BackgroundTask[]): void;
  /** The commands a chat's agent runs changed: one started or ended, or a window watches it. */
  commands(workerId: string, sessionKey: string, commands: AgentCommand[]): void;
  config(workerId: string, sessionKey: string, options: SessionConfigOption[]): void;
  elicitUrl(workerId: string, request: UrlElicitation): Promise<'accept' | 'decline'>;
  elicitationComplete(workerId: string, elicitationId: string): void;
  show(workerId: string, request: ShowRequest): void;
  /** The chats open in the agent's own terminal UI (`codeflower attach`): on connect, and when that changes. */
  terminals(workerId: string, terminals: ChatTerminal[]): void;
  /** `replayed`: what the terminal printed before this window attached to it. */
  terminalOutput(terminalId: string, data: string, replayed?: boolean): void;
  terminalExit(terminalId: string, exitCode: number): void;
  /** An agent's usage changed. */
  usage(workerId: string, agent: AgentName): void;
  /** One of a chat's subagents changed. */
  subagent(workerId: string, subagent: SubagentSummary): void;
  /** The defaults of an agent's subagents changed. */
  subagentSettings(workerId: string, agent: AgentName): void;
  /** Connected (again): open chats attach to their agents. */
  connected(workerId: string): Promise<void>;
  disconnected(workerId: string, code: number): void;
  /** An agent's connection ended, e.g. it restarted (1011). */
  agentDisconnected(workerId: string, agent: AgentName, code: number): void;
}

function serialize(address: WorkerAddress): string {
  // The fingerprint stays with the line: a saved worker reconnects over TLS, pinned.
  const fingerprint = address.fingerprint ? `&fp=${address.fingerprint}` : '';
  return `codeflower://${address.display}?token=${encodeURIComponent(address.token)}${fingerprint}`;
}

export class WorkerManager implements vscode.Disposable {
  readonly workers = new Map<string, WorkerEntry>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly context: vscode.ExtensionContext;
  private readonly router: WorkerRouter;
  private readonly poll: ReturnType<typeof setInterval>;
  private polling = false;

  constructor(context: vscode.ExtensionContext, router: WorkerRouter) {
    this.context = context;
    this.router = router;
    this.poll = setInterval(() => void this.refreshAll(), POLL_MS);
  }

  dispose(): void {
    clearInterval(this.poll);
    for (const worker of this.workers.values()) worker.connection?.close();
    this.changed.dispose();
  }

  get(id: string): WorkerEntry | undefined {
    return this.workers.get(id);
  }

  require(id: string): WorkerConnection {
    const connection = this.workers.get(id)?.connection;
    if (!connection?.connected) throw new Error('The worker is not connected');
    return connection;
  }

  /** Reconnects to the workers of the last VS Code session. */
  async restore(): Promise<void> {
    let saved: string[] = [];
    try {
      saved = JSON.parse((await this.context.secrets.get(WORKERS_SECRET)) ?? '[]') as string[];
    } catch {
      saved = [];
    }
    await Promise.all(
      saved.map(async (text) => {
        try {
          await this.add(text, false);
        } catch {
          // Unreachable workers stay listed as disconnected until removed.
        }
      })
    );
  }

  async add(text: string, persist = true): Promise<WorkerEntry> {
    const address = parseWorkerAddress(text);
    const existing = this.workers.get(address.display);
    existing?.connection?.close();
    const entry: WorkerEntry = { id: address.display, address, state: 'connecting', sessions: [], agents: [], usage: {}, subagentSettings: {} };
    this.workers.set(entry.id, entry);
    this.changed.fire();
    if (persist) await this.save();
    await this.connect(entry);
    return entry;
  }

  async remove(id: string): Promise<void> {
    const entry = this.workers.get(id);
    if (!entry) return;
    this.workers.delete(id);
    entry.connection?.close();
    await this.save();
    this.changed.fire();
  }

  /** Connects again, e.g. to take the worker back from another window. */
  async reconnect(id: string): Promise<void> {
    const entry = this.workers.get(id);
    if (!entry) return;
    entry.takenOver = false;
    const previous = entry.connection;
    entry.connection = undefined;
    previous?.close();
    await this.connect(entry, true);
  }

  async refresh(id: string): Promise<void> {
    const entry = this.workers.get(id);
    if (!entry?.connection?.connected) return;
    try {
      const [status, sessions] = await Promise.all([entry.connection.status(), entry.connection.listSessions()]);
      entry.status = status;
      entry.agents = status.agents;
      entry.sessions = sessions;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
    this.changed.fire();
  }

  async refreshAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await Promise.all(
        [...this.workers.values()].map((entry) =>
          entry.state !== 'disconnected'
            ? this.refresh(entry.id)
            : entry.takenOver
              ? undefined
              : this.connect(entry).catch(() => undefined)
        )
      );
    } finally {
      this.polling = false;
    }
  }

  private warnWrapUp(entry: WorkerEntry, notice: WrapUpNotice): void {
    void vscode.window.showWarningMessage(wrapUpMessage('The worker', entry.id, notice));
  }

  /**
   * Asks for an agent's usage again, e.g. when a chat of it opens or comes to
   * the front: the worker then reads the login's quota if its last read is
   * old, and sends it when it has it.
   */
  refreshUsage(id: string, agent: AgentName): void {
    const entry = this.workers.get(id);
    const connection = entry?.connection;
    if (!entry || !connection) return;
    void connection.usage(agent).then((usage) => {
      if (usage && entry.connection === connection) this.setUsage(entry, agent, usage);
    });
  }

  private setUsage(entry: WorkerEntry, agent: AgentName, usage: WorkerUsage): void {
    entry.usage[agent] = usage;
    this.router.usage(entry.id, agent);
    this.changed.fire();
  }

  private async save(): Promise<void> {
    await this.context.secrets.store(
      WORKERS_SECRET,
      JSON.stringify([...this.workers.values()].map((entry) => serialize(entry.address)))
    );
  }

  private async connect(entry: WorkerEntry, retry = false): Promise<void> {
    entry.state = 'connecting';
    entry.error = undefined;
    this.changed.fire();
    const deadline = Date.now() + (retry ? 5_000 : 0);
    for (;;) {
      try {
        const connection = await WorkerConnection.connect(
          (agent) => wsTransport(entry.address, agent),
          {
            entry: (key, item) => this.router.entry(entry.id, key, item),
            permission: (key, request) => this.router.permission(entry.id, key, request),
            question: (key, request) => this.router.question(entry.id, key, request),
            busy: (key, busy) => this.router.busy(entry.id, key, busy),
            queue: (key, queue) => this.router.queue(entry.id, key, queue),
            background: (key, tasks) => this.router.background(entry.id, key, tasks),
            commands: (key, commands) => this.router.commands(entry.id, key, commands),
            config: (key, options) => this.router.config(entry.id, key, options),
            elicitUrl: (request) => this.router.elicitUrl(entry.id, request),
            elicitationComplete: (elicitationId) => this.router.elicitationComplete(entry.id, elicitationId),
            show: (request) => this.router.show(entry.id, request),
            terminals: (terminals) => this.router.terminals(entry.id, terminals),
            terminalOutput: (terminalId, data, replayed) => this.router.terminalOutput(terminalId, data, replayed),
            terminalExit: (terminalId, exitCode) => this.router.terminalExit(terminalId, exitCode),
            usage: (agent, usage) => {
              if (entry.connection !== connection) return;
              this.setUsage(entry, agent, usage);
            },
            agents: (agents) => {
              entry.agents = agents;
              this.changed.fire();
            },
            wrapUp: (notice) => this.warnWrapUp(entry, notice),
            subagent: (_parentKey, subagent) => this.router.subagent(entry.id, subagent),
            subagentSettings: (agent, state) => {
              if (entry.connection !== connection) return;
              entry.subagentSettings[agent] = state;
              this.router.subagentSettings(entry.id, agent);
            },
            agentClosed: (agent, _reason, code) => {
              if (entry.connection !== connection) return;
              delete entry.usage[agent];
              this.router.agentDisconnected(entry.id, agent, code);
            },
            closed: (reason, code) => {
              if (entry.connection !== connection) return;
              entry.connection = undefined;
              entry.usage = {};
              entry.state = 'disconnected';
              entry.error = reason;
              entry.takenOver = code === TAKEN_OVER;
              this.router.disconnected(entry.id, code);
              this.changed.fire();
            }
          },
          { name: 'codeflower-vscode', title: 'code flower', version: String(this.context.extension.packageJSON.version ?? '0.0.0') }
        );
        let actions: ChatAction[] | undefined;
        try {
          actions = await connection.actions();
        } catch (error) {
          connection.close();
          throw error;
        }
        entry.connection = connection;
        entry.actions = actions;
        entry.agents = connection.agents;
        entry.state = 'connected';
        entry.takenOver = false;
        await this.refresh(entry.id);
        // Every agent's usage and subagent defaults; asking starts no agent. Later changes come as notifications.
        for (const agent of connection.agents) {
          const usage = await connection.usage(agent.id);
          if (usage && entry.connection === connection) this.setUsage(entry, agent.id, usage);
          if (!agent.capabilities.subagents) continue;
          const settings = await connection.subagentSettings(agent.id).catch(() => undefined);
          if (settings && entry.connection === connection) {
            entry.subagentSettings[agent.id] = settings;
            this.router.subagentSettings(entry.id, agent.id);
          }
        }
        await this.router.connected(entry.id);
        return;
      } catch (error) {
        // Right after a restart of the agent, the worker may still be starting a fresh one.
        if (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        entry.state = 'disconnected';
        entry.error = error instanceof Error ? error.message : String(error);
        this.changed.fire();
        throw error;
      }
    }
  }
}
