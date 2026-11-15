// Tabs that show files from a worker's sandbox: the figures, reports and tables
// the agent shows with `codeflower-show`, or paths clicked in the chat. Each tab
// follows its file and sends the user's feedback to the chat it came from.
import { posix } from 'node:path';
import * as vscode from 'vscode';
import type { PreviewHostMessage, PreviewState, PreviewWebviewMessage, SandboxFile } from 'codeflower-ui/protocol/messages.ts';
import { feedbackAnnotations, feedbackFigure, feedbackText } from 'codeflower-ui/chat/lib/feedback.ts';
import type { ChatPanels } from './chatPanel.ts';
import { isFileConflict } from 'codeflower-ui/client/codeflower.ts';
import { WORKSPACE, type ShowRequest } from 'codeflower-ui/client/workerConnection.ts';
import { createReportPanel, InteractiveReport, isStorytellerReport, type ReportHost, type ReportTab } from './reportPanel.ts';
import { TabGone } from './restore.ts';
import type { TabState } from './tabState.ts';
import { createTabPanel, postTabState, webviewHtml } from './webviewHtml.ts';
import type { WorkerManager } from './workers.ts';

const POLL_MS = 2_000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Paths in the workspace read best relative to it, as the agent writes them. */
export function displayPath(path: string): string {
  return path.startsWith(`${WORKSPACE}/`) ? path.slice(WORKSPACE.length + 1) : path;
}

class PreviewPanel {
  readonly panel: vscode.WebviewPanel;
  private readonly owner: PreviewPanels;
  readonly workerId: string;
  file: SandboxFile;
  private title: string;
  private message: string | null;
  /** The agent's note describes the file as shown; it goes once the file changes. */
  private messageFor: number | undefined;
  private noteShown = false;
  chatKey: string | undefined;
  private data: string | null = null;
  private error: string | null = null;
  private ready = false;
  private loading: Promise<void> | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  /** The same HTML file with its scripts running, when the user opened it. */
  private interactive: InteractiveReport | undefined;
  /** Shown or opened again: a storyteller report opens interactive once it has loaded. */
  private wantsInteractive = false;
  private commentsSaved: Promise<void> = Promise.resolve();
  /** Text for the feedback box that came before the page listened. */
  private pendingDraft: string | undefined;

  /** `panel`: a new tab, or one VS Code restored. */
  constructor(owner: PreviewPanels, workerId: string, file: SandboxFile, panel: vscode.WebviewPanel) {
    this.owner = owner;
    this.workerId = workerId;
    this.file = file;
    this.title = posix.basename(file.path);
    this.message = null;
    this.panel = panel;
    this.panel.title = this.title;
    this.panel.iconPath = owner.icon;
    this.panel.webview.html = webviewHtml(this.panel.webview, owner.extensionUri, 'preview', this.tab);
    this.panel.webview.onDidReceiveMessage((message: PreviewWebviewMessage) => void this.handle(message));
    // The agent often rewrites a figure under the same name: follow the file.
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.panel.onDidDispose(() => {
      clearInterval(this.timer);
      this.interactive?.panel.dispose();
      owner.closed(this);
    });
  }

  /** What VS Code keeps of the tab to restore it after a reload. */
  private get tab(): Extract<TabState, { view: 'preview' }> {
    return { view: 'preview', workerId: this.workerId, path: this.file.path, title: this.title, ...(this.chatKey ? { chatKey: this.chatKey } : {}) };
  }

  private get reportTab(): ReportTab {
    return { ...this.tab, view: 'report' };
  }

  /** Where the report's settings, comments and feedback go. */
  private get reportHost(): ReportHost {
    return { send: (text) => this.draft(text), saveComments: (json) => this.saveComments(json) };
  }

  /** The tab's title or chat changed: what VS Code keeps of the tabs follows. */
  private tabChanged(): void {
    this.panel.title = this.title;
    if (this.ready) postTabState(this.panel.webview, this.tab);
    this.interactive?.setTab(this.reportTab);
  }

  /** Shows the file again, e.g. when the agent shows it once more. */
  update(options: { title?: string; message?: string | null; chatKey?: string }): void {
    this.wantsInteractive = true;
    if (options.title) this.title = options.title;
    if (options.message !== undefined) {
      this.message = options.message;
      this.noteShown = true;
    }
    if (options.chatKey) this.chatKey = options.chatKey;
    this.tabChanged();
    void this.load();
  }

  /** Shows the file in a tab VS Code restored; its interactive tab opens only if that was restored too. */
  restored(options: { title: string; chatKey?: string }): void {
    this.title = options.title || this.title;
    this.chatKey = options.chatKey;
    this.tabChanged();
    void this.load();
  }

  /** Puts text in the feedback box, for the user to read and send. */
  draft(text: string): void {
    this.panel.reveal(undefined, false);
    if (this.ready) this.post({ type: 'draft', text });
    else this.pendingDraft = text;
  }

  get hasInteractive(): boolean {
    return this.interactive !== undefined;
  }

  /** Takes over an interactive tab of the file that was restored before this preview. */
  adoptInteractive(report: InteractiveReport): void {
    this.interactive = report;
    report.attach(this.reportHost, () => (this.interactive = undefined));
    report.setTab(this.reportTab);
    if (this.data && this.file.mimeType === 'text/html') report.update(Buffer.from(this.data, 'base64').toString('utf8'));
  }

  post(message: PreviewHostMessage): void {
    if (this.ready) void this.panel.webview.postMessage(message);
  }

  /** Posts what the tab shows now. */
  postState(): void {
    const chat = this.chatKey ? this.owner.chats.chat(this.workerId, this.chatKey) : null;
    const state: PreviewState = {
      file: this.file,
      data: this.data,
      error: this.error,
      title: this.title,
      message: this.messageFor === this.file.mtimeMs ? this.message : null,
      chat: chat ?? (this.chatKey ? { title: 'the chat', busy: false } : null),
      live: !!this.owner.workers.get(this.workerId)?.connection?.connected
    };
    this.post({ type: 'preview', state });
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const file = await this.owner.workers.require(this.workerId).readPreview(this.file.path);
        const { data, ...info } = file;
        this.file = info;
        this.data = data;
        this.error = null;
        const html = info.mimeType === 'text/html' ? Buffer.from(data, 'base64').toString('utf8') : '';
        this.interactive?.update(html);
        if (this.wantsInteractive) {
          this.wantsInteractive = false;
          // Charts, explorers and comments only work with the scripts running; the static
          // preview stays behind it with the feedback box.
          const enabled = vscode.workspace.getConfiguration('codeflower').get('reports.openInteractive', true);
          if (enabled && isStorytellerReport(html)) this.openInteractive(true);
        }
        if (this.noteShown) {
          this.messageFor = info.mtimeMs;
          this.noteShown = false;
        }
      } catch (error) {
        this.data = null;
        this.error = describe(error);
      } finally {
        this.loading = undefined;
      }
      this.postState();
    })();
    return this.loading;
  }

  private async poll(): Promise<void> {
    // The interactive tab follows the file too, while the preview is in the background.
    if (!(this.panel.visible || this.interactive?.panel.visible) || this.loading) return;
    const connection = this.owner.workers.get(this.workerId)?.connection;
    if (!connection?.connected) return;
    try {
      const file = await connection.statFile(this.file.path);
      if (file.mtimeMs !== this.file.mtimeMs || file.size !== this.file.size || this.error) await this.load();
    } catch (error) {
      if (!this.error) {
        this.error = describe(error);
        this.postState();
      }
    }
  }

  /** Saves the user's comments into the report, one save after another, then shows the new file. */
  private saveComments(json: string): void {
    this.commentsSaved = this.commentsSaved
      .then(async () => {
        await this.owner.workers.require(this.workerId).saveReportComments(this.file.path, json);
        await this.load();
      })
      .catch((error: unknown) => {
        void vscode.window.showErrorMessage(`Could not save the comments on ${this.title}: ${describe(error)}`);
      });
  }

  /** Opens the HTML file in a tab where its scripts run (no network, no local files). */
  private openInteractive(preserveFocus = false): void {
    if (!this.data || this.file.mimeType !== 'text/html') return;
    if (!this.interactive) {
      // Settings chosen in the report, or comments for the agent, go into the feedback box, for the user to send.
      this.interactive = new InteractiveReport(
        createReportPanel(this.title, this.panel.viewColumn ?? vscode.ViewColumn.Beside, preserveFocus),
        this.reportTab,
        this.owner.icon,
        this.reportHost,
        () => (this.interactive = undefined)
      );
    }
    this.interactive.update(Buffer.from(this.data, 'base64').toString('utf8'));
    this.interactive.reveal(preserveFocus);
  }

  private async handle(message: PreviewWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        postTabState(this.panel.webview, this.tab);
        this.postState();
        if (this.pendingDraft !== undefined) this.post({ type: 'draft', text: this.pendingDraft });
        this.pendingDraft = undefined;
        break;
      case 'feedback': {
        if (!this.chatKey) {
          void vscode.window.showWarningMessage('Open a chat on this worker first; feedback goes to its agent.');
          return;
        }
        const text = feedbackText(displayPath(this.file.path), 'VS Code', message.text, feedbackAnnotations(message.annotations), feedbackFigure(message.figure));
        try {
          const outcome = await this.owner.chats.send(this.workerId, this.chatKey, text);
          this.post({ type: 'feedbackSent', queued: outcome === 'queued' });
        } catch (error) {
          void vscode.window.showErrorMessage(`Could not send the feedback: ${describe(error)}`);
        }
        break;
      }
      case 'asset': {
        // Files a report refers to, relative to the report.
        const path = posix.resolve(posix.dirname(this.file.path), message.path);
        let dataUrl: string | null = null;
        try {
          const file = await this.owner.workers.require(this.workerId).readFile(path);
          dataUrl = `data:${file.mimeType};base64,${file.data}`;
        } catch {
          dataUrl = null;
        }
        this.post({ type: 'asset', path: message.path, dataUrl });
        break;
      }
      case 'openFile':
        void this.owner.openPath(
          this.workerId,
          posix.resolve(posix.dirname(this.file.path), message.path),
          this.chatKey
        );
        break;
      case 'save': {
        if (!this.data) return;
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(
            vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.env.HOME ?? '/'),
            posix.basename(this.file.path)
          )
        });
        if (!target) return;
        await vscode.workspace.fs.writeFile(target, Buffer.from(this.data, 'base64'));
        void vscode.window.showInformationMessage(`Saved ${posix.basename(this.file.path)} to ${target.fsPath}`);
        break;
      }
      case 'write':
        try {
          const file = await this.owner.workers.require(this.workerId).writeFile(this.file.path, message.text, message.baseMtimeMs);
          // The saved text is the file now: no need to read it back.
          this.file = file;
          this.data = Buffer.from(message.text, 'utf8').toString('base64');
          this.error = null;
          this.post({ type: 'written', file });
          this.postState();
        } catch (error) {
          this.post({ type: 'writeFailed', error: describe(error), conflict: isFileConflict(error) });
        }
        break;
      case 'dirty':
        // A webview tab cannot ask before it closes: its title says there are edits.
        this.panel.title = message.dirty ? `● ${this.title}` : this.title;
        break;
      case 'showChat':
        if (this.chatKey) this.owner.chats.reveal(this.workerId, this.chatKey);
        break;
      case 'interactive':
        this.openInteractive();
        break;
    }
  }
}

/**
 * Closes a restored tab that VS Code has not shown yet (it revives a tab only when it
 * first shows), found by its kind and title in a group; only when exactly one matches.
 */
async function closeUnshownTab(viewType: string, label: string, column: vscode.ViewColumn | undefined): Promise<void> {
  const matches = vscode.window.tabGroups.all
    .filter((group) => column === undefined || group.viewColumn === column)
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewType) && tab.label === label);
  if (matches.length === 1) await vscode.window.tabGroups.close(matches[0]!, true);
}

export class PreviewPanels {
  private readonly panels = new Map<string, PreviewPanel>();
  /** Interactive tabs VS Code restored while their file's preview was not open; it takes them over when it opens. */
  private readonly reports = new Map<string, InteractiveReport>();
  readonly extensionUri: vscode.Uri;
  readonly workers: WorkerManager;
  readonly chats: ChatPanels;

  constructor(extensionUri: vscode.Uri, workers: WorkerManager, chats: ChatPanels) {
    this.extensionUri = extensionUri;
    this.workers = workers;
    this.chats = chats;
    // The tab says where feedback goes and whether the agent is busy.
    chats.onDidChangeStatus(() => {
      for (const panel of this.panels.values()) panel.postState();
    });
    workers.onDidChange(() => {
      for (const panel of this.panels.values()) panel.postState();
    });
  }

  private id(workerId: string, path: string): string {
    return `${workerId}|${path}`;
  }

  get icon(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'media', 'preview.svg');
  }

  /** A preview of the file in `tab`, or in a new tab in `column`. */
  private add(workerId: string, file: SandboxFile, tab: vscode.WebviewPanel | vscode.ViewColumn): PreviewPanel {
    const id = this.id(workerId, file.path);
    const panel = new PreviewPanel(
      this,
      workerId,
      file,
      typeof tab === 'object' ? tab : createTabPanel(this.extensionUri, 'codeflower.preview', posix.basename(file.path), { viewColumn: tab, preserveFocus: true })
    );
    this.panels.set(id, panel);
    const report = this.reports.get(id);
    if (report) {
      this.reports.delete(id);
      panel.adoptInteractive(report);
    }
    return panel;
  }

  /** The file a restored tab showed, or why it cannot show it. */
  private async restoredFile(workerId: string, path: string): Promise<SandboxFile> {
    try {
      return await this.workers.require(workerId).statFile(path);
    } catch (error) {
      throw new TabGone(`Cannot show ${posix.basename(path)}`, `${displayPath(path)}: ${describe(error)}`);
    }
  }

  /** A preview tab VS Code restored after a reload; its worker is connected. */
  async restore(tab: vscode.WebviewPanel, state: Extract<TabState, { view: 'preview' }>): Promise<void> {
    const file = await this.restoredFile(state.workerId, state.path);
    // One tab per file: the file may have been opened again before this tab showed.
    if (this.panels.has(this.id(state.workerId, state.path))) {
      tab.dispose();
      return;
    }
    this.add(state.workerId, file, tab).restored({ title: state.title, chatKey: state.chatKey });
  }

  /**
   * An interactive report tab VS Code restored. Its preview takes it, if open;
   * else it shows on its own until the preview opens, which the report's
   * feedback does (the two usually share a group, so the preview shows later).
   */
  async restoreReport(tab: vscode.WebviewPanel, state: ReportTab): Promise<void> {
    const id = this.id(state.workerId, state.path);
    const connection = this.workers.require(state.workerId);
    let html = '';
    if (!this.panels.has(id)) {
      try {
        html = Buffer.from((await connection.readPreview(state.path)).data, 'base64').toString('utf8');
      } catch (error) {
        throw new TabGone(`Cannot show ${posix.basename(state.path)}`, `${displayPath(state.path)}: ${describe(error)}`);
      }
    }
    const preview = this.panels.get(id);
    if ((preview && preview.hasInteractive) || this.reports.has(id)) {
      tab.dispose();
      return;
    }
    const report = new InteractiveReport(tab, state, this.icon, this.standaloneHost(state), () => this.reports.delete(id));
    if (preview) {
      preview.adoptInteractive(report);
      return;
    }
    this.reports.set(id, report);
    report.update(html);
  }

  /** Where a report restored without its preview sends to: the preview, opened beside it. */
  private standaloneHost(state: ReportTab): ReportHost {
    const { workerId, path } = state;
    return {
      send: (text) => {
        const column = this.reports.get(this.id(workerId, path))?.panel.viewColumn;
        void (async () => {
          const file = await this.restoredFile(workerId, path);
          let preview = this.panels.get(this.id(workerId, path));
          if (!preview) {
            // Its restored tab has not shown yet, so this one replaces it; unless a shown tab of
            // another file has the same title there, and the tabs cannot be told apart.
            const sameTitle = [...this.panels.values()].some((other) => other.panel.title === state.title && other.panel.viewColumn === column);
            if (!sameTitle) await closeUnshownTab('codeflower.preview', state.title, column);
            preview = this.panels.get(this.id(workerId, path)) ?? this.add(workerId, file, column ?? this.column());
            preview.restored({ title: state.title, chatKey: state.chatKey });
          }
          preview.draft(text);
        })().catch((error: unknown) => void vscode.window.showErrorMessage(describe(error)));
      },
      saveComments: (json) => {
        const connection = this.workers.get(workerId)?.connection;
        void (async () => {
          if (!connection?.connected) throw new Error('The worker is not connected');
          await connection.saveReportComments(path, json);
          const file = await connection.readPreview(path);
          this.reports.get(this.id(workerId, path))?.update(Buffer.from(file.data, 'base64').toString('utf8'));
        })().catch((error: unknown) => {
          void vscode.window.showErrorMessage(`Could not save the comments on ${state.title}: ${describe(error)}`);
        });
      }
    };
  }

  /** Previews share a column beside the chat. */
  private column(): vscode.ViewColumn {
    const existing = [...this.panels.values()].find((panel) => panel.panel.viewColumn !== undefined);
    return existing?.panel.viewColumn ?? vscode.ViewColumn.Beside;
  }

  /** The agent ran `codeflower-show`, or asks to approve a plan in a chat. */
  show(workerId: string, request: ShowRequest): void {
    const chatKey = request.sessionKey ?? this.chats.chatFor(workerId);
    if (chatKey) {
      void this.workers
        .get(workerId)
        ?.connection?.recordShow(chatKey, request.files.map((file) => file.path), request.message)
        .catch(() => undefined);
    }
    for (const file of request.files) {
      this.open(workerId, file, {
        chatKey,
        message: request.message ?? null,
        ...(request.title && request.files.length === 1 ? { title: request.title } : {})
      });
    }
  }

  /** A path clicked in a chat or a report. */
  async openPath(workerId: string, path: string, chatKey: string | undefined): Promise<void> {
    try {
      const file = await this.workers.require(workerId).statFile(path);
      this.open(workerId, file, { chatKey });
    } catch (error) {
      void vscode.window.showErrorMessage(`Cannot show ${path}: ${describe(error)}`);
    }
  }

  private open(
    workerId: string,
    file: SandboxFile,
    options: { chatKey?: string; message?: string | null; title?: string }
  ): void {
    let panel = this.panels.get(this.id(workerId, file.path));
    if (panel) {
      panel.panel.reveal(undefined, true);
    } else {
      panel = this.add(workerId, file, this.column());
    }
    panel.update(options);
  }

  closed(panel: PreviewPanel): void {
    if (this.panels.get(this.id(panel.workerId, panel.file.path)) === panel) {
      this.panels.delete(this.id(panel.workerId, panel.file.path));
    }
  }
}
