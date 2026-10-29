import * as vscode from 'vscode';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import {
  sessionStatus,
  type AgentName,
  type ChatState,
  type HostMessage,
  type PendingPermission,
  type PendingQuestion,
  type SessionStatus,
  type TranscriptEntry,
  type WebviewMessage
} from '../shared/messages.ts';
import type { ChatUsage } from '../shared/usage.ts';
import { RpcError } from './acpClient.ts';
import { isAuthRequired, isConnectionClosed, TAKEN_OVER } from './workerConnection.ts';
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
  private readonly signIn: (workerId: string) => Promise<void>;
  readonly workerId: string;
  key: string;
  private state: ChatState;
  private ready = false;
  private readonly queue: HostMessage[] = [];
  // What the chat shows, replayed whenever the webview (re)loads.
  private entries: TranscriptEntry[] = [];
  private pending: PendingPermission | null = null;
  private question: PendingQuestion | null = null;
  private config: SessionConfigOption[] = [];
  private usage: ChatUsage = { session: null, account: null };
  private readonly extensionUri: vscode.Uri;
  private status: SessionStatus | undefined;
  private readonly onStatus: () => void;
  private readonly onOpenFile: (path: string) => void;
  private readonly onConfigChosen: (configId: string, value: string | boolean) => void;
  /** When the user last wrote here or looked at the tab; feedback from previews goes to the latest. */
  lastUsed = Date.now();
  /** The user's `!commands` running now; files they show belong to this chat. */
  shellsRunning = 0;
  /** Messages sent from elsewhere (e.g. a preview's feedback) while the agent was busy. */
  private readonly waiting: string[] = [];
  /** Live entries that arrive while the transcript loads; they follow it. */
  private held: TranscriptEntry[] | undefined;

  constructor(options: {
    extensionUri: vscode.Uri;
    workers: WorkerManager;
    signIn: (workerId: string) => Promise<void>;
    workerId: string;
    key: string;
    title: string;
    subtitle: string;
    agent?: AgentName;
    onDispose: () => void;
    onStatus: () => void;
    onOpenFile: (path: string) => void;
    onConfigChosen: (configId: string, value: string | boolean) => void;
  }) {
    this.workers = options.workers;
    this.signIn = options.signIn;
    this.workerId = options.workerId;
    this.key = options.key;
    this.state = {
      title: options.title,
      subtitle: options.subtitle,
      agent: options.agent,
      live: false,
      busy: false
    };
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
    this.showStatus();
    this.panel.webview.html = webviewHtml(this.panel.webview, assets, 'chat');
    this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handle(message));
    this.panel.onDidDispose(options.onDispose);
    this.panel.onDidChangeViewState(() => {
      if (this.panel.active) this.lastUsed = Date.now();
    });
  }

  get title(): string {
    return this.state.title;
  }

  get busy(): boolean {
    return this.state.busy;
  }

  /** Sends a message to the agent as if typed here; it waits while the agent works. */
  send(text: string): 'sent' | 'queued' {
    if (this.state.busy) {
      this.waiting.push(text);
      return 'queued';
    }
    void this.sendPrompt(text);
    return 'sent';
  }

  private async sendPrompt(text: string): Promise<void> {
    this.lastUsed = Date.now();
    try {
      await this.workers.require(this.workerId).prompt(this.key, text);
    } catch (error) {
      // The disconnect has its own notice; the turn goes on in the worker.
      if (!isConnectionClosed(error)) this.reportError(error);
    } finally {
      void this.workers.refresh(this.workerId);
    }
  }

  /** Holds live entries until `loaded` shows the transcript they follow. */
  hold(): void {
    this.held ??= [];
  }

  loaded(entries: TranscriptEntry[]): void {
    const held = this.held ?? [];
    this.held = undefined;
    this.post({ type: 'transcript', entries: [...entries, ...held] });
  }

  post(message: HostMessage): void {
    if (message.type === 'entry' && this.held) {
      this.held.push(message.entry);
      return;
    }
    if (message.type === 'transcript') this.entries = [...message.entries];
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
    if (!this.ready) {
      this.queue.push(message);
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  setState(update: Partial<ChatState>): void {
    this.state = { ...this.state, ...update };
    if (!this.state.busy && this.state.live && this.waiting.length) {
      void this.sendPrompt(this.waiting.splice(0).join('\n\n'));
    }
    this.panel.title = tabTitle(this.state.title);
    this.showStatus();
    this.post({ type: 'state', state: this.state });
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
        void this.panel.webview.postMessage({ type: 'transcript', entries: this.entries } satisfies HostMessage);
        void this.panel.webview.postMessage({ type: 'permission', request: this.pending } satisfies HostMessage);
        void this.panel.webview.postMessage({ type: 'question', request: this.question } satisfies HostMessage);
        void this.panel.webview.postMessage({ type: 'config', options: this.config } satisfies HostMessage);
        void this.panel.webview.postMessage({ type: 'usage', usage: this.usage } satisfies HostMessage);
        for (const queued of this.queue.splice(0)) {
          if (queued.type === 'notice') void this.panel.webview.postMessage(queued);
        }
        break;
      case 'prompt':
        await this.sendPrompt(message.text);
        break;
      case 'openFile':
        this.onOpenFile(message.path);
        break;
      case 'fileData': {
        let dataUrl: string | null = null;
        try {
          const file = await this.workers.require(this.workerId).readFile(message.path);
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
          ?.connection?.answerQuestion(message.requestId, message.action, message.content);
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
      case 'cancel':
        this.workers.get(this.workerId)?.connection?.cancel(this.key);
        break;
      case 'permissionResponse':
        this.workers.get(this.workerId)?.connection?.answerPermission(message.requestId, message.optionId);
        break;
      case 'action':
        await this.signIn(this.workerId);
        break;
    }
  }
}


const MAX_TAB_TITLE = 32;

/** Titles are often the first prompt; tabs get a short form, the chat header the full one. */
export function tabTitle(title: string): string {
  const text = title.replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_TAB_TITLE) return text;
  const cut = text.slice(0, MAX_TAB_TITLE - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_TAB_TITLE / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

/** Opens chat tabs and routes live agent traffic to them. */
export class ChatPanels {
  private readonly panels = new Map<string, ChatPanel>();
  private readonly statusChanged = new vscode.EventEmitter<void>();
  /** A session started or stopped working or waiting for the user. */
  readonly onDidChangeStatus = this.statusChanged.event;
  private readonly extensionUri: vscode.Uri;
  private readonly workers: WorkerManager;
  private readonly signIn: (workerId: string) => Promise<void>;
  /** Shows a file from the worker's sandbox; set once the previews exist. */
  openFile: (workerId: string, key: string, path: string) => void = () => {};

  /** Remembers the user's last mode per agent for new sessions. */
  private readonly memento: vscode.Memento;

  constructor(
    extensionUri: vscode.Uri,
    workers: WorkerManager,
    signIn: (workerId: string) => Promise<void>,
    memento: vscode.Memento
  ) {
    this.extensionUri = extensionUri;
    this.workers = workers;
    this.signIn = signIn;
    this.memento = memento;
  }

  private modeKey(workerId: string): string | undefined {
    const agent = this.workers.get(workerId)?.status?.agent;
    return agent ? `codeflower.mode.${agent}` : undefined;
  }

  private rememberConfig(workerId: string, key: string, configId: string, value: string | boolean): void {
    const option = this.workers.get(workerId)?.connection?.config(key).find((candidate) => candidate.id === configId);
    const storageKey = this.modeKey(workerId);
    if (option?.category === 'mode' && storageKey) void this.memento.update(storageKey, value);
  }

  /** New sessions start in the mode the user chose last for this agent, e.g. one that asks less. */
  private async applyRememberedMode(workerId: string, key: string): Promise<void> {
    const storageKey = this.modeKey(workerId);
    const remembered = storageKey ? this.memento.get<string>(storageKey) : undefined;
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

  private create(workerId: string, key: string, title: string): ChatPanel {
    const worker = this.workers.get(workerId);
    const panel = new ChatPanel({
      extensionUri: this.extensionUri,
      workers: this.workers,
      signIn: this.signIn,
      workerId,
      key,
      title,
      subtitle: `${worker?.status?.agentLabel ?? 'Agent'} · ${workerId}`,
      agent: worker?.status?.agent,
      onDispose: () => {
        this.panels.delete(this.id(workerId, panel.key));
        this.statusChanged.fire();
      },
      onStatus: () => this.statusChanged.fire(),
      onOpenFile: (path) => this.openFile(workerId, panel.key, path),
      onConfigChosen: (configId, value) => this.rememberConfig(workerId, panel.key, configId, value)
    });
    this.panels.set(this.id(workerId, key), panel);
    this.showUsage(panel);
    return panel;
  }

  async newSession(workerId: string): Promise<void> {
    const connection = this.workers.require(workerId);
    let key: string;
    try {
      key = await connection.newSession();
    } catch (error) {
      if (isAuthRequired(error)) {
        const choice = await vscode.window.showWarningMessage(
          'The agent is not signed in for this project.',
          'Sign in'
        );
        if (choice) await this.signIn(workerId);
        return;
      }
      throw error;
    }
    await this.applyRememberedMode(workerId, key);
    const panel = this.create(workerId, key, 'New session');
    panel.post({ type: 'transcript', entries: [] });
    panel.post({ type: 'config', options: connection.config(key) });
    panel.setState({ live: true });
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
    const panel = this.create(workerId, key, session?.title ?? 'Session');
    await this.attach(panel);
  }

  /**
   * Shows the chat's history and attaches it on the worker's connection. The
   * worker's agent may be mid-turn (a turn this or another window started).
   */
  private async attach(panel: ChatPanel): Promise<void> {
    const { workerId, key } = panel;
    const connection = this.workers.require(workerId);
    const session = this.workers.get(workerId)?.sessions.find((candidate) => candidate.key === key);
    if (!session) {
      panel.loaded(await connection.transcript(key));
      return;
    }
    panel.hold();
    try {
      const attached = await connection.resumeSession(session.nativeSessionId, session.cwd);
      const entries = await connection.transcript(key);
      // Updates after the attach came live; the transcript has them too.
      panel.loaded(attached.transcriptEntries === undefined ? entries : entries.slice(0, attached.transcriptEntries));
      panel.post({ type: 'config', options: connection.config(key) });
      const activity = connection.activity(key);
      panel.post({ type: 'permission', request: activity.permission });
      panel.post({ type: 'question', request: activity.question });
      panel.setState({ live: true, busy: activity.busy });
    } catch (error) {
      panel.loaded(await connection.transcript(key).catch(() => []));
      panel.reportError(error);
    }
  }

  /** The worker is back: its open chats attach again and show what happened meanwhile. */
  async reconnected(workerId: string): Promise<void> {
    const panels = [...this.panels.values()].filter((panel) => panel.workerId === workerId);
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

  /** The worker's counts changed: each of its chats shows its own and the quota. */
  usage(workerId: string): void {
    for (const panel of this.panels.values()) if (panel.workerId === workerId) this.showUsage(panel);
  }

  private showUsage(panel: ChatPanel): void {
    const worker = this.workers.get(panel.workerId);
    const usage = worker?.usage;
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

  rename(workerId: string, key: string, title: string): void {
    this.panels.get(this.id(workerId, key))?.setState({ title });
  }

  close(workerId: string, key: string): void {
    this.panels.get(this.id(workerId, key))?.panel.dispose();
  }

  disconnected(workerId: string, code: number): void {
    // 1011: the agent itself ended, so its turns did too.
    const agentEnded = code === 1011;
    for (const panel of this.panels.values()) {
      if (panel.workerId !== workerId) continue;
      panel.setState(agentEnded ? { live: false, busy: false } : { live: false });
      panel.post({ type: 'config', options: [] });
      panel.notice(
        'info',
        code === TAKEN_OVER
          ? 'Another VS Code window took over this worker. Choose Reconnect on the worker to take it back.'
          : agentEnded
            ? 'The worker\'s agent stopped. The chat reconnects when the worker is reachable again.'
            : 'Disconnected from the worker; the agent keeps working. Reconnecting…'
      );
    }
  }
}
