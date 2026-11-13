import * as vscode from 'vscode';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import {
  sessionStatus,
  type ActionPromptMeta,
  type AgentName,
  type AgentPresentation,
  type BackgroundTask,
  type ChatAction,
  type ChatState,
  type HostMessage,
  type PendingPermission,
  type PendingQuestion,
  type SessionStatus,
  type TranscriptEntry,
  type WebviewMessage
} from 'codeflower-ui/protocol/messages.ts';
import { ChatQueue } from 'codeflower-ui/client/chatQueue.ts';
import type { ChatUsage } from 'codeflower-ui/protocol/usage.ts';
import type { AgentCommand } from 'codeflower-ui/protocol/commands.ts';
import {
  subagentTitle,
  withSubagent,
  type SubagentSettingsState,
  type SubagentSummary
} from 'codeflower-ui/protocol/subagents.ts';
import {
  agentOfKey,
  EMPTY_TRANSCRIPT,
  type AttachedSession,
  type ChatTerminal,
  isAuthRequired,
  isConnectionClosed,
  pageUpTo,
  RpcError,
  TAKEN_OVER,
  type TranscriptPage,
  type WorkerQueue
} from 'codeflower-ui/client/workerConnection.ts';
import { webviewHtml } from './webviewHtml.ts';
import type { WorkerManager } from './workers.ts';

const LEASE_CONFLICT = -32010;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One chat tab: one session on one worker. */
class ChatPanel {
  readonly panel: vscode.WebviewPanel;
  private readonly workers: WorkerManager;
  private readonly signIn: (workerId: string, agent: AgentName) => Promise<void>;
  readonly workerId: string;
  key: string;
  private state: ChatState;
  private ready = false;
  private readonly queue: HostMessage[] = [];
  // What the chat shows, replayed whenever the webview (re)loads.
  private entries: TranscriptEntry[] = [];
  /** The index of `entries[0]` in the transcript; earlier ones load when the view asks. */
  private start = 0;
  private context: TranscriptEntry[] = [];
  private loadingEarlier = false;
  private pending: PendingPermission | null = null;
  private question: PendingQuestion | null = null;
  private config: SessionConfigOption[] = [];
  private usage: ChatUsage = { session: null, account: null };
  /** The chat's subagents, and the worker's defaults for them. */
  subagents: SubagentSummary[] = [];
  private subagentSettings: SubagentSettingsState | null = null;
  private readonly openSubagent: (key: string) => void;
  private readonly openCommand: (command: AgentCommand) => void;
  private readonly extensionUri: vscode.Uri;
  private status: SessionStatus | undefined;
  private readonly onStatus: () => void;
  private readonly onOpenFile: (path: string) => void;
  private readonly onConfigChosen: (configId: string, value: string | boolean) => void;
  private readonly onFoldSteps: (fold: boolean) => void;
  private readonly onFavoriteModel: (value: string, pinned: boolean) => void;
  /** When the user last wrote here or looked at the tab; feedback from previews goes to the latest. */
  lastUsed = Date.now();
  /** The user's `!commands` running now; files they show belong to this chat. */
  shellsRunning = 0;
  /** The prompts that wait for the turn to end: on the worker, or here (chatQueue.ts). */
  private readonly prompts = new ChatQueue({
    state: () => this.state,
    prompt: (text, action) => this.sendPrompt(text, action),
    steer: async (text) => (await this.workers.get(this.workerId)?.connection?.steer(this.key, text).catch(() => false)) ?? false,
    cancel: () => this.workers.get(this.workerId)?.connection?.cancel(this.key),
    worker: () => this.workers.get(this.workerId)?.connection?.workerQueue(this.key),
    post: (message) => this.post(message),
    error: (message) => this.notice('error', message)
  });
  /** Live entries that arrive while the transcript loads; they follow it. */
  private held: TranscriptEntry[] | undefined;

  constructor(options: {
    extensionUri: vscode.Uri;
    workers: WorkerManager;
    signIn: (workerId: string, agent: AgentName) => Promise<void>;
    workerId: string;
    key: string;
    title: string;
    subtitle: string;
    agent?: AgentPresentation;
    actions?: ChatAction[];
    onDispose: () => void;
    onStatus: () => void;
    onOpenFile: (path: string) => void;
    onConfigChosen: (configId: string, value: string | boolean) => void;
    /** Whether chats fold each turn's steps, and the user's choice of it (for every chat). */
    foldSteps: boolean;
    onFoldSteps: (fold: boolean) => void;
    /** The models the user pinned for this chat's agent, and pinning one (for every chat of the agent). */
    favoriteModels: string[];
    onFavoriteModel: (value: string, pinned: boolean) => void;
    /** Shows a subagent's chat, or this subagent chat's parent. */
    onOpenSubagent: (key: string) => void;
    /** Shows a command the chat's agent runs, read-only. */
    onOpenCommand: (command: AgentCommand) => void;
    subagent?: ChatState['subagent'];
  }) {
    this.workers = options.workers;
    this.signIn = options.signIn;
    this.workerId = options.workerId;
    this.key = options.key;
    this.state = {
      title: options.title,
      subtitle: options.subtitle,
      agent: options.agent,
      actions: options.actions,
      autoApprove: options.agent?.id === 'dsh' ? true : undefined,
      live: false,
      busy: false,
      foldSteps: options.foldSteps,
      favoriteModels: options.favoriteModels,
      ...(options.subagent ? { subagent: options.subagent } : {})
    };
    this.openSubagent = options.onOpenSubagent;
    this.openCommand = options.onOpenCommand;
    if (this.state.autoApprove !== undefined) {
      this.workers.get(this.workerId)?.connection?.setAutoApprove(this.key, this.state.autoApprove);
    }
    const assets = vscode.Uri.joinPath(options.extensionUri, 'webview', 'dist');
    this.panel = vscode.window.createWebviewPanel('codeflower.chat', tabTitle(options.title), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [assets]
    });
    this.extensionUri = options.extensionUri;
    this.onStatus = options.onStatus;
    this.onOpenFile = options.onOpenFile;
    this.onConfigChosen = options.onConfigChosen;
    this.onFoldSteps = options.onFoldSteps;
    this.onFavoriteModel = options.onFavoriteModel;
    this.showStatus();
    this.panel.webview.html = webviewHtml(this.panel.webview, assets, 'chat');
    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handle(message));
    this.panel.onDidDispose(options.onDispose);
    this.panel.onDidChangeViewState(() => {
      if (!this.panel.active) return;
      this.lastUsed = Date.now();
      // The quota may have changed since, e.g. in another chat or window.
      this.workers.refreshUsage(this.workerId, agentOfKey(this.key));
    });
  }

  get title(): string {
    return this.state.title;
  }

  get busy(): boolean {
    return this.state.busy;
  }

  /** The subagent this chat shows, when it is a subagent's. */
  get subagent(): ChatState['subagent'] {
    return this.state.subagent;
  }

  /** Sends a message to the agent as if typed here; it waits while the agent works. */
  send(text: string): 'sent' | 'queued' {
    return this.prompts.send(text);
  }

  private async sendPrompt(text: string, action?: ActionPromptMeta): Promise<void> {
    this.lastUsed = Date.now();
    try {
      await this.workers.require(this.workerId).prompt(this.key, text, action);
    } catch (error) {
      // The disconnect has its own notice; the turn goes on in the worker.
      if (!isConnectionClosed(error)) this.reportError(error);
    } finally {
      void this.workers.refresh(this.workerId);
    }
  }

  /** The chat's prompts queued on the worker changed, or the chat opened here. */
  queueChanged(queue: WorkerQueue): void {
    this.prompts.workerChanged(queue);
  }

  private runAction(id: string): void {
    if (!this.state.live) {
      this.notice('info', 'This session is read-only here.');
      return;
    }
    const action = this.state.actions?.find((candidate) => candidate.id === id);
    if (!action) {
      this.notice('error', 'This action is unavailable on this worker. Reconnect to an updated sandbox.');
      return;
    }
    this.prompts.action(action);
  }

  /** Holds live entries until `loaded` shows the transcript they follow. */
  hold(): void {
    this.held ??= [];
  }

  loaded(page: TranscriptPage): void {
    const held = this.held ?? [];
    this.held = undefined;
    this.post({ type: 'transcript', entries: [...page.entries, ...held], start: page.start, context: page.context });
  }

  private async loadEarlier(): Promise<void> {
    const before = this.start;
    const connection = this.workers.get(this.workerId)?.connection;
    if (before === 0 || this.loadingEarlier || !connection) return;
    this.loadingEarlier = true;
    try {
      const page = await connection.transcriptPage(this.key, before);
      // A transcript that arrived meanwhile (a reconnect) replaced the one this page goes before.
      if (this.start === before) this.post({ type: 'earlier', entries: page.entries, start: page.start });
    } catch (error) {
      this.notice('error', `Could not load earlier messages: ${describe(error)}`);
    } finally {
      this.loadingEarlier = false;
    }
  }

  post(message: HostMessage): void {
    if (message.type === 'entry' && this.held) {
      this.held.push(message.entry);
      return;
    }
    if (message.type === 'transcript') {
      this.entries = [...message.entries];
      this.start = message.start ?? 0;
      this.context = message.context ?? [];
    } else if (message.type === 'earlier') {
      this.entries = [...message.entries, ...this.entries];
      this.start = message.start;
    }
    else if (message.type === 'entry') this.entries.push(message.entry);
    else if (message.type === 'permission') {
      this.pending = message.request;
      this.showStatus();
    } else if (message.type === 'question') {
      this.question = message.request;
      this.showStatus();
    }
    else if (message.type === 'config') this.config = message.options;
    else if (message.type === 'usage') this.usage = message.usage;
    else if (message.type === 'subagents') this.subagents = message.subagents;
    else if (message.type === 'subagentSettings') this.subagentSettings = message.state;
    if (!this.ready) {
      this.queue.push(message);
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  setState(update: Partial<ChatState>): void {
    this.state = { ...this.state, ...update };
    if (this.state.agent?.id === 'dsh') this.state.autoApprove ??= true;
    else this.state.autoApprove = undefined;
    if (this.state.autoApprove !== undefined) {
      this.workers.get(this.workerId)?.connection?.setAutoApprove(this.key, this.state.autoApprove);
    }
    this.panel.title = tabTitle(this.state.title);
    this.showStatus();
    this.post({ type: 'state', state: this.state });
    this.prompts.flush();
  }

  get sessionStatus(): SessionStatus {
    return this.status ?? 'offline';
  }

  /** The tab icon shows the status; the tree and status bar follow via onStatus. */
  private showStatus(): void {
    const status = sessionStatus(this.state, this.pending !== null || this.question !== null);
    if (status === this.status) return;
    this.status = status;
    const icon = (variant: string) => vscode.Uri.joinPath(this.extensionUri, 'media', 'status', `${status}-${variant}.svg`);
    this.panel.iconPath = { light: icon('light'), dark: icon('dark') };
    this.onStatus?.();
  }

  notice(level: 'info' | 'error', message: string, signIn = false): void {
    this.post({
      type: 'notice',
      level,
      message,
      ...(signIn ? { action: { id: 'signIn' as const, label: 'Sign in' } } : {})
    });
  }

  reportError(error: unknown): void {
    if (isAuthRequired(error)) {
      this.notice('error', 'The agent is not signed in for this project.', true);
    } else if (error instanceof RpcError && error.code === LEASE_CONFLICT) {
      this.notice('info', 'This session is open on another worker; it is read-only here.');
    } else {
      this.notice('error', describe(error));
    }
  }

  private async handle(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        void this.panel.webview.postMessage({ type: 'state', state: this.state } satisfies HostMessage);
        void this.panel.webview.postMessage({
          type: 'transcript',
          entries: this.entries,
          start: this.start,
          context: this.context
        } satisfies HostMessage);
        void this.panel.webview.postMessage({ type: 'permission', request: this.pending } satisfies HostMessage);
        void this.panel.webview.postMessage({ type: 'question', request: this.question } satisfies HostMessage);
        void this.panel.webview.postMessage({ type: 'config', options: this.config } satisfies HostMessage);
        void this.panel.webview.postMessage({ type: 'usage', usage: this.usage } satisfies HostMessage);
        void this.panel.webview.postMessage(this.prompts.message() satisfies HostMessage);
        void this.panel.webview.postMessage({ type: 'subagents', subagents: this.subagents } satisfies HostMessage);
        void this.panel.webview.postMessage({ type: 'subagentSettings', state: this.subagentSettings } satisfies HostMessage);
        for (const queued of this.queue.splice(0)) {
          if (queued.type === 'notice') void this.panel.webview.postMessage(queued);
        }
        break;
      case 'loadEarlier':
        await this.loadEarlier();
        break;
      case 'prompt':
        this.prompts.compose(message.text, message.now ?? false);
        break;
      case 'openFile':
        this.onOpenFile(message.path);
        break;
      case 'fileData': {
        let dataUrl: string | null = null;
        try {
          const connection = this.workers.require(this.workerId);
          const file = message.thumbnail
            ? await connection.thumbnail(message.path, message.thumbnail)
            : await connection.readFile(message.path);
          dataUrl = `data:${file.mimeType};base64,${file.data}`;
        } catch {
          dataUrl = null;
        }
        void this.panel.webview.postMessage({ type: 'fileData', key: message.key, dataUrl } satisfies HostMessage);
        break;
      }
      case 'shell':
        this.shellsRunning++;
        this.lastUsed = Date.now();
        try {
          await this.workers.require(this.workerId).runShell(this.key, message.command);
        } catch (error) {
          this.reportError(error);
        } finally {
          this.shellsRunning--;
        }
        break;
      case 'cancelShell':
        this.workers.get(this.workerId)?.connection?.cancelShell(message.runId);
        break;
      case 'questionResponse':
        this.workers
          .get(this.workerId)
          ?.connection?.answerQuestion(this.key, message.requestId, message.action, message.content);
        break;
      case 'setConfig':
        try {
          await this.workers.require(this.workerId).setConfigOption(this.key, message.configId, message.value);
          this.onConfigChosen(message.configId, message.value);
        } catch (error) {
          this.reportError(error);
          // Show the agent's actual settings again.
          this.post({ type: 'config', options: this.workers.get(this.workerId)?.connection?.config(this.key) ?? this.config });
        }
        break;
      case 'setAutoApprove':
        if (this.state.agent?.id === 'dsh') this.setState({ autoApprove: message.enabled });
        break;
      case 'foldSteps':
        this.onFoldSteps(message.fold);
        break;
      case 'favoriteModel':
        this.onFavoriteModel(message.value, message.favorite);
        break;
      case 'cancel':
        // The user's queued messages go back to the composer instead of after the stop.
        await this.prompts.stop();
        break;
      case 'permissionResponse':
        this.workers.get(this.workerId)?.connection?.answerPermission(this.key, message.requestId, message.optionId);
        break;
      case 'action':
        if (message.id === 'signIn') await this.signIn(this.workerId, agentOfKey(this.key));
        else this.runAction(message.id);
        break;
      case 'removeQueued':
        this.prompts.remove(message.id);
        break;
      case 'sendQueued':
        void this.prompts.sendNow(message.id);
        break;
      case 'editQueued':
        await this.prompts.edit(message.id);
        break;
      case 'resumeQueue':
        this.prompts.resume();
        break;
      case 'openSubagent':
        this.openSubagent(message.key);
        break;
      case 'openParent':
        if (this.state.subagent) this.openSubagent(this.state.subagent.parentKey);
        break;
      case 'openCommand': {
        const command = this.state.commands?.find((candidate) => candidate.commandId === message.commandId);
        if (command) this.openCommand(command);
        break;
      }
      case 'stopSubagent':
        try {
          await this.workers.require(this.workerId).cancelSubagent(message.key);
        } catch (error) {
          this.reportError(error);
        }
        break;
      case 'subagentSettings':
        try {
          const connection = this.workers.require(this.workerId);
          const agent = agentOfKey(this.key);
          const state = await connection.subagentSettings(agent, message.settings);
          const worker = this.workers.get(this.workerId);
          if (worker) worker.subagentSettings[agent] = state;
          this.post({ type: 'subagentSettings', state });
        } catch (error) {
          this.reportError(error);
        }
        break;
      case 'restartAgent':
        try {
          await this.workers.require(this.workerId).restartAgent(agentOfKey(this.key));
        } catch (error) {
          this.reportError(error);
        }
        break;
    }
  }
}


const MAX_TAB_TITLE = 32;
// After an agent's restart, how long its chats wait before they attach to the fresh one.
const AGENT_RESTART_MS = 500;

/** Titles are often the first prompt; tabs get a short form, the chat header the full one. */
export function tabTitle(title: string): string {
  const text = title.replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_TAB_TITLE) return text;
  const cut = text.slice(0, MAX_TAB_TITLE - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_TAB_TITLE / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

/** Opens chat tabs and routes live agent traffic to them. */
const FOLD_STEPS_KEY = 'codeflower.foldSteps';
/** The models pinned in the model picker, by agent (their values are the agent's own). */
const FAVORITE_MODELS_KEY = 'codeflower.favoriteModels';

export class ChatPanels {
  private readonly panels = new Map<string, ChatPanel>();
  /** Chats open in the agent's own terminal UI (`codeflower attach`), by worker and key. */
  private readonly terminalsByWorker = new Map<string, Record<string, ChatTerminal>>();
  /** The terminal notice each panel shows, so it is posted once and cleared when the terminal goes. */
  private readonly terminalNotices = new Map<ChatPanel, string>();
  /** The subagents of the chats open here, by worker and their chats' keys. */
  private readonly subagentsByWorker = new Map<string, Map<string, SubagentSummary>>();
  private readonly statusChanged = new vscode.EventEmitter<void>();
  /** A session started or stopped working or waiting for the user. */
  readonly onDidChangeStatus = this.statusChanged.event;
  private readonly extensionUri: vscode.Uri;
  private readonly workers: WorkerManager;
  private readonly signIn: (workerId: string, agent: AgentName) => Promise<void>;
  /** Shows a file from the worker's sandbox; set once the previews exist. */
  openFile: (workerId: string, key: string, path: string) => void = () => {};
  /** Shows a command an agent runs, read-only; set once the terminals exist. */
  openCommand: (workerId: string, command: AgentCommand, agentName: string) => void = () => {};

  /** Remembers the user's last mode per agent for new sessions, and whether chats fold their steps. */
  private readonly memento: vscode.Memento;

  constructor(
    extensionUri: vscode.Uri,
    workers: WorkerManager,
    signIn: (workerId: string, agent: AgentName) => Promise<void>,
    memento: vscode.Memento
  ) {
    this.extensionUri = extensionUri;
    this.workers = workers;
    this.signIn = signIn;
    this.memento = memento;
  }

  /** Chats show every step unless the user folds them; the choice holds for every chat. */
  private get foldSteps(): boolean {
    return this.memento.get<boolean>(FOLD_STEPS_KEY) ?? false;
  }

  private setFoldSteps(fold: boolean): void {
    void this.memento.update(FOLD_STEPS_KEY, fold);
    for (const panel of this.panels.values()) panel.setState({ foldSteps: fold });
  }

  private favoriteModels(agent: string | undefined): string[] {
    return (agent && this.memento.get<Record<string, string[]>>(FAVORITE_MODELS_KEY)?.[agent]) || [];
  }

  /** Pins a model, or unpins it, in every chat of the agent. */
  private setFavoriteModel(agent: string | undefined, value: string, pinned: boolean): void {
    if (!agent) return;
    const all = this.memento.get<Record<string, string[]>>(FAVORITE_MODELS_KEY) ?? {};
    const others = (all[agent] ?? []).filter((model) => model !== value);
    const next = pinned ? [...others, value] : others;
    void this.memento.update(FAVORITE_MODELS_KEY, { ...all, [agent]: next });
    for (const panel of this.panels.values()) {
      if (agentOfKey(panel.key) === agent) panel.setState({ favoriteModels: next });
    }
  }

  /** Where the mode the user chose last for the chat's agent is kept. */
  private modeKey(key: string): string {
    return `codeflower.mode.${agentOfKey(key)}`;
  }

  private rememberConfig(workerId: string, key: string, configId: string, value: string | boolean): void {
    const option = this.workers.get(workerId)?.connection?.config(key).find((candidate) => candidate.id === configId);
    if (option?.category === 'mode') void this.memento.update(this.modeKey(key), value);
  }

  /** New sessions start in the mode the user chose last for this agent, e.g. one that asks less. */
  private async applyRememberedMode(workerId: string, key: string): Promise<void> {
    const remembered = this.memento.get<string>(this.modeKey(key));
    const connection = this.workers.get(workerId)?.connection;
    const mode = connection?.config(key).find((option) => option.category === 'mode');
    if (!connection || !remembered || mode?.type !== 'select' || mode.currentValue === remembered) return;
    const values = mode.options.flatMap((entry) => ('options' in entry ? entry.options : [entry])).map((choice) => choice.value);
    if (!values.includes(remembered)) return;
    try {
      await connection.setConfigOption(key, mode.id, remembered);
    } catch {
      // The agent keeps its own default.
    }
  }

  /**
   * The chat a shown file belongs to: one running the user's own `!command`,
   * else one whose agent is working (agents show files during a turn), else the
   * one used last.
   */
  chatFor(workerId: string): string | undefined {
    const panels = [...this.panels.values()].filter((panel) => panel.workerId === workerId);
    const shells = panels.filter((panel) => panel.shellsRunning > 0);
    const busy = panels.filter((panel) => panel.busy);
    const candidates = shells.length ? shells : busy.length ? busy : panels;
    return candidates.sort((a, b) => b.lastUsed - a.lastUsed)[0]?.key;
  }

  chat(workerId: string, key: string): { title: string; busy: boolean } | null {
    const panel = this.panels.get(this.id(workerId, key));
    return panel ? { title: panel.title, busy: panel.busy } : null;
  }

  /** Sends text to a session's agent through its chat tab, which opens if needed. */
  async send(workerId: string, key: string, text: string): Promise<'sent' | 'queued'> {
    if (!this.panels.has(this.id(workerId, key))) await this.open(workerId, key);
    const panel = this.panels.get(this.id(workerId, key));
    if (!panel) throw new Error('The chat could not be opened');
    return panel.send(text);
  }

  reveal(workerId: string, key: string): void {
    void this.open(workerId, key);
  }

  private id(workerId: string, key: string): string {
    return `${workerId}|${key}`;
  }

  /** The status of an open session; closed sessions have none. */
  status(workerId: string, key: string): SessionStatus | undefined {
    return this.panels.get(this.id(workerId, key))?.sessionStatus;
  }

  count(status: SessionStatus): number {
    return [...this.panels.values()].filter((panel) => panel.sessionStatus === status).length;
  }

  /** Shows the first session waiting for the user, else the first one working. */
  revealAttention(): void {
    const panels = [...this.panels.values()];
    const panel =
      panels.find((candidate) => candidate.sessionStatus === 'waiting') ??
      panels.find((candidate) => candidate.sessionStatus === 'working');
    panel?.panel.reveal();
  }

  /** A chat's agent as its header shows it: name, color and logo. */
  private presentation(workerId: string, key: string): AgentPresentation {
    const agent = agentOfKey(key);
    return this.workers.get(workerId)?.connection?.presentation(agent) ?? { id: agent };
  }

  /** What a chat's header says of its agent, once the worker told its name. */
  private header(workerId: string, key: string): Pick<ChatState, 'subtitle' | 'agent'> {
    const agent = this.presentation(workerId, key);
    return { subtitle: `${agent.name ?? 'Agent'} · ${workerId}`, agent };
  }

  private create(workerId: string, key: string, title: string, subagent?: SubagentSummary): ChatPanel {
    const worker = this.workers.get(workerId);
    const agent = this.presentation(workerId, key);
    const panel = new ChatPanel({
      extensionUri: this.extensionUri,
      workers: this.workers,
      signIn: this.signIn,
      workerId,
      key,
      title,
      actions: worker?.actions,
      subtitle: `${agent.name ?? 'Agent'} · ${workerId}`,
      agent,
      onDispose: () => {
        this.panels.delete(this.id(workerId, panel.key));
        this.terminalNotices.delete(panel);
        // A subagent's updates stop coming once no chat of it is open.
        if (panel.subagent) void this.workers.get(workerId)?.connection?.closeSubagent(panel.key).catch(() => undefined);
        this.statusChanged.fire();
      },
      onStatus: () => this.statusChanged.fire(),
      onOpenFile: (path) => this.openFile(workerId, panel.key, path),
      onConfigChosen: (configId, value) => this.rememberConfig(workerId, panel.key, configId, value),
      foldSteps: this.foldSteps,
      onFoldSteps: (fold) => this.setFoldSteps(fold),
      favoriteModels: this.favoriteModels(agent.id),
      onFavoriteModel: (value, pinned) => this.setFavoriteModel(agent.id, value, pinned),
      onOpenSubagent: (target) => void this.open(workerId, target).catch((error) => panel.reportError(error)),
      onOpenCommand: (command) => this.openCommand(workerId, command, agent.name ?? agentOfKey(panel.key)),
      ...(subagent ? { subagent: this.subagentState(workerId, subagent) } : {})
    });
    this.panels.set(this.id(workerId, key), panel);
    this.showUsage(panel);
    this.workers.refreshUsage(workerId, agent.id);
    panel.post({ type: 'subagentSettings', state: worker?.subagentSettings[agent.id] ?? null });
    return panel;
  }

  /** A new chat with one of the worker's agents. */
  async newSession(workerId: string, agent: AgentName): Promise<void> {
    const connection = this.workers.require(workerId);
    let started: AttachedSession;
    try {
      started = await connection.startSession(agent);
    } catch (error) {
      if (isAuthRequired(error)) {
        const name = connection.agent(agent)?.name ?? 'The agent';
        const choice = await vscode.window.showWarningMessage(`${name} is not signed in for this project.`, 'Sign in');
        if (choice) await this.signIn(workerId, agent);
        return;
      }
      throw error;
    }
    const { key, transcriptEntries } = started;
    // Created before anything else is awaited, so no live update finds it missing.
    const panel = this.create(workerId, key, 'New session');
    if (transcriptEntries) {
      panel.hold();
      panel.loaded(pageUpTo(await connection.transcriptPage(key).catch(() => EMPTY_TRANSCRIPT), transcriptEntries));
    } else {
      panel.post({ type: 'transcript', entries: [] });
    }
    await this.applyRememberedMode(workerId, key);
    panel.post({ type: 'config', options: connection.config(key) });
    panel.setState({ live: true, steer: connection.canSteer(key) });
    const notice = connection.mcpNotice(key);
    if (notice) panel.notice('info', notice);
    void this.workers.refresh(workerId);
  }

  async open(workerId: string, key: string): Promise<void> {
    const existing = this.panels.get(this.id(workerId, key));
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const session = this.workers.get(workerId)?.sessions.find((candidate) => candidate.key === key);
    this.workers.require(workerId);
    const subagent = session ? undefined : this.subagentsByWorker.get(workerId)?.get(key);
    const panel = this.create(workerId, key, session?.title ?? (subagent ? subagentTitle(subagent) : 'Session'), subagent);
    await this.attach(panel);
  }

  /**
   * Shows the chat's history and attaches it on the worker's connection. The
   * worker's agent may be mid-turn (a turn this or another window started).
   */
  private async attach(panel: ChatPanel): Promise<void> {
    const { workerId, key } = panel;
    const connection = this.workers.require(workerId);
    if (panel.subagent) return this.attachSubagent(panel);
    const session = this.workers.get(workerId)?.sessions.find((candidate) => candidate.key === key);
    if (!session) {
      panel.loaded(await connection.transcriptPage(key));
      return;
    }
    panel.hold();
    try {
      const attached = await connection.resumeSession(session.harness, session.nativeSessionId, session.cwd);
      // Updates after the attach came live; the transcript has them too.
      panel.loaded(pageUpTo(await connection.transcriptPage(key), attached.transcriptEntries));
      panel.post({ type: 'config', options: connection.config(key) });
      const activity = connection.activity(key);
      panel.post({ type: 'permission', request: activity.permission });
      panel.post({ type: 'question', request: activity.question });
      panel.setState({
        ...this.header(workerId, key),
        live: true,
        busy: activity.busy,
        background: activity.background,
        steer: connection.canSteer(key)
      });
      // MCP servers from the app's config the chat is without, e.g. one that did not start.
      const notice = connection.mcpNotice(key);
      if (notice) panel.notice('info', notice);
      this.noticeTerminal(panel);
      void this.loadSubagents(panel);
      void this.loadCommands(panel);
    } catch (error) {
      panel.loaded(await connection.transcriptPage(key).catch(() => EMPTY_TRANSCRIPT));
      panel.reportError(error);
    }
  }

  // ---- subagents ----

  /** A subagent's chat: what it recorded so far, then its updates live while it runs. */
  private async attachSubagent(panel: ChatPanel): Promise<void> {
    const { workerId, key } = panel;
    const connection = this.workers.require(workerId);
    panel.hold();
    try {
      const opened = await connection.openSubagent(key);
      panel.loaded(pageUpTo(await connection.transcriptPage(key), opened.transcriptEntries));
      if (opened.subagent) this.subagentChanged(workerId, opened.subagent);
      void this.loadSubagents(panel);
    } catch (error) {
      panel.loaded(await connection.transcriptPage(key).catch(() => EMPTY_TRANSCRIPT));
      panel.reportError(error);
    }
  }

  /** A chat's subagents, for its cards and its badge. */
  private async loadSubagents(panel: ChatPanel): Promise<void> {
    const connection = this.workers.get(panel.workerId)?.connection;
    if (!connection?.subagentFeatures(agentOfKey(panel.key))) return;
    const subagents = await connection.subagents(panel.key).catch(() => undefined);
    if (!subagents) return;
    for (const subagent of subagents) this.knownSubagents(panel.workerId).set(subagent.key, subagent);
    panel.post({ type: 'subagents', subagents });
  }

  private knownSubagents(workerId: string): Map<string, SubagentSummary> {
    let known = this.subagentsByWorker.get(workerId);
    if (!known) this.subagentsByWorker.set(workerId, (known = new Map()));
    return known;
  }

  private subagentState(workerId: string, subagent: SubagentSummary): ChatState['subagent'] {
    const parent =
      this.panels.get(this.id(workerId, subagent.parentKey))?.title ??
      this.workers.get(workerId)?.sessions.find((session) => session.key === subagent.parentKey)?.title;
    return { ...subagent, ...(parent ? { parentTitle: parent } : {}) };
  }

  /** One of a chat's subagents changed: its parent's cards and its own chat follow. */
  subagentChanged(workerId: string, subagent: SubagentSummary): void {
    this.knownSubagents(workerId).set(subagent.key, subagent);
    const parent = this.panels.get(this.id(workerId, subagent.parentKey));
    parent?.post({ type: 'subagents', subagents: withSubagent(parent.subagents, subagent) });
    this.panels.get(this.id(workerId, subagent.key))?.setState({ subagent: this.subagentState(workerId, subagent) });
  }

  /** An agent's defaults for subagents changed, or the worker connected. */
  subagentSettings(workerId: string, agent: AgentName): void {
    const state = this.workers.get(workerId)?.subagentSettings[agent] ?? null;
    for (const panel of this.panels.values()) {
      if (panel.workerId === workerId && agentOfKey(panel.key) === agent) panel.post({ type: 'subagentSettings', state });
    }
  }

  terminals(workerId: string, terminals: ChatTerminal[]): void {
    this.terminalsByWorker.set(workerId, Object.fromEntries(terminals.map((terminal) => [terminal.sessionKey, terminal])));
    for (const panel of this.panels.values()) if (panel.workerId === workerId) this.noticeTerminal(panel);
  }

  /**
   * A chat open in the agent's terminal UI says so, as on the app's page:
   * Claude Code's has the chat (what is sent here is typed there), the others
   * share it.
   */
  private noticeTerminal(panel: ChatPanel): void {
    const terminal = this.terminalsByWorker.get(panel.workerId)?.[panel.key];
    const shown = this.terminalNotices.get(panel);
    if (!terminal) {
      if (shown !== undefined) panel.post({ type: 'clearNotice' });
      this.terminalNotices.delete(panel);
      return;
    }
    const id = `${terminal.terminalId}:${terminal.mode}`;
    if (shown === id) return;
    this.terminalNotices.set(panel, id);
    const agent = this.presentation(panel.workerId, panel.key).name ?? 'the agent';
    // VS Code knows the worker by its address, which `codeflower attach` does not take: its picker finds the chat.
    const command = ' In a terminal on its computer, `codeflower attach` opens it.';
    panel.notice(
      'info',
      terminal.mode === 'handoff'
        ? `This chat is open in ${agent}'s own terminal UI. What you send here is typed there (text only), and permissions are answered there; quit it there (~q) to go on here.${command}`
        : `This chat is also open in ${agent}'s own terminal UI; both follow it as it goes.${command}`
    );
  }

  /** The worker is back: its open chats attach again and show what happened meanwhile. */
  async reconnected(workerId: string): Promise<void> {
    const panels = [...this.panels.values()].filter((panel) => panel.workerId === workerId);
    // The worker tells which chats have a terminal again; notices after the disconnect one are posted anew.
    for (const panel of panels) this.terminalNotices.delete(panel);
    for (const panel of panels) panel.setState({ actions: this.workers.get(workerId)?.actions });
    await Promise.all(panels.map((panel) => this.attach(panel).catch((error) => panel.reportError(error))));
  }

  entry(workerId: string, key: string, entry: TranscriptEntry): void {
    const panel = this.panels.get(this.id(workerId, key));
    panel?.post({ type: 'entry', entry });
    // The worker names a session after its first prompt, and again when the agent
    // names it (often early in a long turn); the list says which title wins.
    const named = entry.kind === 'update' && entry.update.sessionUpdate === 'session_info_update' && !!entry.update.title;
    if (panel && (entry.kind === 'turn_end' || named)) {
      const update = () =>
        void this.workers.refresh(workerId).then(() => {
          const title = this.workers.get(workerId)?.sessions.find((session) => session.key === key)?.title;
          if (title) panel.setState({ title });
        });
      // The worker records the new title just after relaying it.
      if (named) setTimeout(update, 1000);
      else update();
    }
  }

  /** An agent's counts changed: each of its chats shows its own and the quota. */
  usage(workerId: string, agent: AgentName): void {
    for (const panel of this.panels.values()) if (panel.workerId === workerId && agentOfKey(panel.key) === agent) this.showUsage(panel);
  }

  private showUsage(panel: ChatPanel): void {
    const worker = this.workers.get(panel.workerId);
    const usage = worker?.usage[agentOfKey(panel.key)];
    let session: ChatUsage['session'] = null;
    const live = usage?.sessions.find((candidate) => candidate.key === panel.key);
    if (live) {
      const { key: _, ...counts } = live;
      session = counts;
    } else {
      // Not loaded on the worker: what its turns recorded.
      session = worker?.sessions.find((candidate) => candidate.key === panel.key)?.usage ?? null;
    }
    let account: ChatUsage['account'] = null;
    if (usage) {
      const { sessions: _, totals: __, ...rest } = usage;
      account = rest;
    }
    panel.post({ type: 'usage', usage: { session, account } });
  }

  permission(workerId: string, key: string, request: PendingPermission | null): void {
    this.panels.get(this.id(workerId, key))?.post({ type: 'permission', request });
  }

  question(workerId: string, key: string, request: PendingQuestion | null): void {
    this.panels.get(this.id(workerId, key))?.post({ type: 'question', request });
  }

  config(workerId: string, key: string, options: SessionConfigOption[]): void {
    this.panels.get(this.id(workerId, key))?.post({ type: 'config', options });
  }

  busy(workerId: string, key: string, busy: boolean): void {
    this.panels.get(this.id(workerId, key))?.setState({ busy });
  }

  queue(workerId: string, key: string, queue: WorkerQueue): void {
    this.panels.get(this.id(workerId, key))?.queueChanged(queue);
  }

  background(workerId: string, key: string, background: BackgroundTask[]): void {
    this.panels.get(this.id(workerId, key))?.setState({ background });
  }

  commands(workerId: string, key: string, commands: AgentCommand[]): void {
    this.panels.get(this.id(workerId, key))?.setState({ commands });
  }

  /** The commands a chat's agent runs, for its strip. */
  private async loadCommands(panel: ChatPanel): Promise<void> {
    const connection = this.workers.get(panel.workerId)?.connection;
    if (!connection?.commandsFeature(agentOfKey(panel.key))) return;
    const commands = await connection.commands(panel.key).catch(() => undefined);
    if (commands) panel.setState({ commands });
  }

  rename(workerId: string, key: string, title: string): void {
    this.panels.get(this.id(workerId, key))?.setState({ title });
  }

  close(workerId: string, key: string): void {
    this.panels.get(this.id(workerId, key))?.panel.dispose();
  }

  /**
   * An agent's connection ended. After its restart (1011) its open chats attach again, which
   * starts it; otherwise they say so.
   */
  agentDisconnected(workerId: string, agent: AgentName, code: number): void {
    const panels = [...this.panels.values()].filter((panel) => panel.workerId === workerId && agentOfKey(panel.key) === agent);
    const restarted = code === 1011;
    for (const panel of panels) {
      panel.setState(restarted ? { live: false, busy: false, background: [] } : { live: false });
      panel.post({ type: 'config', options: [] });
    }
    if (!restarted) {
      for (const panel of panels) panel.notice('info', 'Disconnected from the agent; it keeps working. Open the chat again to reconnect.');
      return;
    }
    // The worker starts the agent again once the old one is gone.
    setTimeout(() => {
      for (const panel of panels) void this.attach(panel).catch((error) => panel.reportError(error));
    }, AGENT_RESTART_MS);
  }

  disconnected(workerId: string, code: number): void {
    // 1011: the agent itself ended, so its turns did too.
    const agentEnded = code === 1011;
    for (const panel of this.panels.values()) {
      if (panel.workerId !== workerId) continue;
      panel.setState(agentEnded ? { live: false, busy: false, background: [] } : { live: false });
      panel.post({ type: 'config', options: [] });
      panel.notice(
        'info',
        code === TAKEN_OVER
          ? 'Another window took over this worker. Choose Reconnect on the worker to take it back.'
          : agentEnded
            ? 'The worker\'s agent stopped. The chat reconnects when the worker is reachable again.'
            : 'Disconnected from the worker; the agent keeps working. Reconnecting…'
      );
    }
  }
}
