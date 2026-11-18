// Tabs that show files from a worker's sandbox: the figures, reports and tables
// the agent shows with `codeflower-show`, or paths clicked in the chat. Each tab
// follows its file and sends the user's feedback to the chat it came from. An HTML
// report can show with its scripts running, in a sandboxed frame in the same tab
// (codeflower-ui's ReportFrame): no network, no local files, and nothing but what
// the tab's view passes on from it:
// - its comments (JSON), saved into it;
// - Print, which a webview may not do: a copy opens in the user's browser and
//   prints itself there (printCopy.ts);
// - a file beside it to save (a deck's .pptx).
import { posix } from 'node:path';
import * as vscode from 'vscode';
import type { PreviewHostMessage, PreviewState, PreviewWebviewMessage, SandboxFile } from 'codeflower-ui/protocol/messages.ts';
import { feedbackAnnotations, feedbackFigure, feedbackText } from 'codeflower-ui/chat/lib/feedback.ts';
import { isBesideReport, isStorytellerReport } from 'codeflower-ui/chat/lib/report.ts';
import type { ChatPanels } from './chatPanel.ts';
import { isFileConflict } from 'codeflower-ui/client/codeflower.ts';
import { WORKSPACE, type ShowRequest } from 'codeflower-ui/client/workerConnection.ts';
import { servePrintCopy, type PrintCopy } from './printCopy.ts';
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
  /** The HTML file shows with its scripts running. */
  private interactive = false;
  /** Shown or opened again: a storyteller report shows interactive once it has loaded. */
  private wantsInteractive = false;
  private commentsSaved: Promise<void> = Promise.resolve();
  /** The last copy served for printing, dropped at the next print or when the tab closes. */
  private printCopy: PrintCopy | undefined;

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
      this.printCopy?.close();
      owner.closed(this);
    });
  }

  /** What VS Code keeps of the tab to restore it after a reload. */
  private get tab(): Extract<TabState, { view: 'preview' }> {
    return {
      view: 'preview',
      workerId: this.workerId,
      path: this.file.path,
      title: this.title,
      ...(this.chatKey ? { chatKey: this.chatKey } : {}),
      ...(this.interactive ? { interactive: true } : {})
    };
  }

  /** The tab's title, chat or way of showing changed: what VS Code keeps of the tabs follows. */
  private tabChanged(): void {
    this.panel.title = this.title;
    if (this.ready) postTabState(this.panel.webview, this.tab);
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

  /** Shows the file in a tab VS Code restored, as it showed it. */
  restored(options: { title: string; chatKey?: string; interactive?: boolean }): void {
    this.title = options.title || this.title;
    this.chatKey = options.chatKey;
    this.interactive = !!options.interactive;
    this.tabChanged();
    void this.load();
  }

  /** Shows the HTML file with its scripts running, or as a static page. */
  setInteractive(on: boolean): void {
    this.interactive = on;
    this.tabChanged();
    this.postState();
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
      live: !!this.owner.workers.get(this.workerId)?.connection?.connected,
      interactive: this.interactive
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
        if (this.wantsInteractive) {
          this.wantsInteractive = false;
          // Charts, explorers and comments only work with the scripts running; the tab's
          // switch shows the static page.
          const enabled = vscode.workspace.getConfiguration('codeflower').get('reports.openInteractive', true);
          const html = info.mimeType === 'text/html' ? Buffer.from(data, 'base64').toString('utf8') : '';
          if (enabled && isStorytellerReport(html) && !this.interactive) {
            this.interactive = true;
            this.tabChanged();
          }
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
    if (!this.panel.visible || this.loading) return;
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

  /** Opens the report in the user's browser, which prints it. */
  private async print(): Promise<void> {
    if (!this.data || this.file.mimeType !== 'text/html') return;
    try {
      this.printCopy?.close();
      this.printCopy = await servePrintCopy(Buffer.from(this.data, 'base64').toString('utf8'));
      const uri = await vscode.env.asExternalUri(vscode.Uri.parse(this.printCopy.url, true));
      if (!(await vscode.env.openExternal(uri))) throw new Error('no browser opened it');
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not open ${this.title} in your browser to print it: ${describe(error)}`);
    }
  }

  /** Asks where to save a copy of a file (base64) on this machine. */
  private async saveCopy(name: string, data: string): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.env.HOME ?? '/'), name)
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(data, 'base64'));
    void vscode.window.showInformationMessage(`Saved ${name} to ${target.fsPath}`);
  }

  private async handle(message: PreviewWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        postTabState(this.panel.webview, this.tab);
        this.postState();
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
      case 'save':
        if (this.data) await this.saveCopy(posix.basename(this.file.path), this.data);
        break;
      case 'download': {
        // Only a file in the report's own folder.
        if (!isBesideReport(message.path)) return;
        try {
          const file = await this.owner.workers.require(this.workerId).readFile(posix.join(posix.dirname(this.file.path), message.path));
          await this.saveCopy(message.path, file.data);
        } catch (error) {
          void vscode.window.showErrorMessage(`Could not download ${message.path}: ${describe(error)}`);
        }
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
        this.setInteractive(message.on);
        break;
      case 'reportComments':
        this.saveComments(message.json);
        break;
      case 'print':
        await this.print();
        break;
    }
  }
}

export class PreviewPanels {
  private readonly panels = new Map<string, PreviewPanel>();
  /**
   * Files whose interactive report tab, from before reports ran in their preview tab,
   * VS Code restored before their preview: the preview shows them interactive.
   */
  private readonly interactiveOnRestore = new Set<string>();
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
    const panel = new PreviewPanel(
      this,
      workerId,
      file,
      typeof tab === 'object' ? tab : createTabPanel(this.extensionUri, 'codeflower.preview', posix.basename(file.path), { viewColumn: tab, preserveFocus: true })
    );
    this.panels.set(this.id(workerId, file.path), panel);
    return panel;
  }

  /** A preview tab VS Code restored after a reload; its worker is connected. */
  async restore(tab: vscode.WebviewPanel, state: Extract<TabState, { view: 'preview' }>): Promise<void> {
    const id = this.id(state.workerId, state.path);
    let file: SandboxFile;
    try {
      file = await this.workers.require(state.workerId).statFile(state.path);
    } catch (error) {
      throw new TabGone(`Cannot show ${posix.basename(state.path)}`, `${displayPath(state.path)}: ${describe(error)}`);
    }
    // One tab per file: the file may have been opened again before this tab showed.
    if (this.panels.has(id)) {
      tab.dispose();
      return;
    }
    const legacy = this.interactiveOnRestore.delete(id);
    this.add(state.workerId, file, tab).restored({ title: state.title, chatKey: state.chatKey, interactive: state.interactive || legacy });
  }

  /**
   * An interactive report tab of an older version, which VS Code restored: the report
   * now runs in its preview tab, which shows it interactive.
   */
  async restoreReport(tab: vscode.WebviewPanel, state: Extract<TabState, { view: 'report' }>): Promise<void> {
    tab.dispose();
    const id = this.id(state.workerId, state.path);
    const preview = this.panels.get(id);
    if (preview) preview.setInteractive(true);
    else this.interactiveOnRestore.add(id);
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
        ?.connection?.recordShow(chatKey, request.files.map((file) => file.path), request.message, request.noted === true)
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
