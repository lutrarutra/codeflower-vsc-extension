// Tabs that show files from a worker's sandbox: the figures, reports and tables
// the agent shows with `codeflower-show`, or paths clicked in the chat. Each tab
// follows its file and sends the user's feedback to the chat it came from.
import { posix } from 'node:path';
import * as vscode from 'vscode';
import type { PreviewHostMessage, PreviewState, PreviewWebviewMessage, SandboxFile } from '../shared/messages.ts';
import type { ChatPanels } from './chatPanel.ts';
import { WORKSPACE, type ShowRequest } from './workerConnection.ts';
import { InteractiveReport } from './reportPanel.ts';
import { webviewHtml } from './webviewHtml.ts';
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
  private commentsSaved: Promise<void> = Promise.resolve();

  constructor(owner: PreviewPanels, workerId: string, file: SandboxFile, column: vscode.ViewColumn) {
    this.owner = owner;
    this.workerId = workerId;
    this.file = file;
    this.title = posix.basename(file.path);
    this.message = null;
    const assets = vscode.Uri.joinPath(owner.extensionUri, 'webview', 'dist');
    this.panel = vscode.window.createWebviewPanel(
      'codeflower.preview',
      this.title,
      { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [assets] }
    );
    this.panel.iconPath = vscode.Uri.joinPath(owner.extensionUri, 'media', 'preview.svg');
    this.panel.webview.html = webviewHtml(this.panel.webview, assets, 'preview');
    this.panel.webview.onDidReceiveMessage((message: PreviewWebviewMessage) => void this.handle(message));
    // The agent often rewrites a figure under the same name: follow the file.
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.panel.onDidDispose(() => {
      clearInterval(this.timer);
      this.interactive?.panel.dispose();
      owner.closed(this);
    });
  }

  /** Shows the file again, e.g. when the agent shows it once more. */
  update(options: { title?: string; message?: string | null; chatKey?: string }): void {
    if (options.title) this.title = options.title;
    if (options.message !== undefined) {
      this.message = options.message;
      this.noteShown = true;
    }
    if (options.chatKey) this.chatKey = options.chatKey;
    this.panel.title = this.title;
    void this.load();
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
        const file = await this.owner.workers.require(this.workerId).readFile(this.file.path);
        const { data, ...info } = file;
        this.file = info;
        this.data = data;
        this.error = null;
        this.interactive?.update(Buffer.from(data, 'base64').toString('utf8'));
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
  private openInteractive(): void {
    if (!this.data || this.file.mimeType !== 'text/html') return;
    if (!this.interactive) {
      this.interactive = new InteractiveReport(
        this.title,
        vscode.Uri.joinPath(this.owner.extensionUri, 'media', 'preview.svg'),
        this.panel.viewColumn ?? vscode.ViewColumn.Beside,
        {
          send: (text) => {
            // Settings chosen in the report, or comments for the agent: into the feedback box, for the user to send.
            this.panel.reveal(undefined, false);
            this.post({ type: 'draft', text });
          },
          saveComments: (json) => this.saveComments(json)
        },
        () => (this.interactive = undefined)
      );
    }
    this.interactive.update(Buffer.from(this.data, 'base64').toString('utf8'));
    this.interactive.reveal();
  }

  private async handle(message: PreviewWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.postState();
        break;
      case 'feedback': {
        if (!this.chatKey) {
          void vscode.window.showWarningMessage('Open a chat on this worker first; feedback goes to its agent.');
          return;
        }
        const text = `Feedback on ${displayPath(this.file.path)}, which you showed me in VS Code:\n\n${message.text}`;
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
      case 'showChat':
        if (this.chatKey) this.owner.chats.reveal(this.workerId, this.chatKey);
        break;
      case 'interactive':
        this.openInteractive();
        break;
    }
  }
}

export class PreviewPanels {
  private readonly panels = new Map<string, PreviewPanel>();
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

  /** Previews share a column beside the chat. */
  private column(): vscode.ViewColumn {
    const existing = [...this.panels.values()].find((panel) => panel.panel.viewColumn !== undefined);
    return existing?.panel.viewColumn ?? vscode.ViewColumn.Beside;
  }

  /** The agent ran `codeflower-show`. */
  show(workerId: string, request: ShowRequest): void {
    const chatKey = this.chats.chatFor(workerId);
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
      panel = new PreviewPanel(this, workerId, file, this.column());
      this.panels.set(this.id(workerId, file.path), panel);
    }
    panel.update(options);
  }

  closed(panel: PreviewPanel): void {
    if (this.panels.get(this.id(panel.workerId, panel.file.path)) === panel) {
      this.panels.delete(this.id(panel.workerId, panel.file.path));
    }
  }
}
