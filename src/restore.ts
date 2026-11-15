// Brings code flower's tabs back after VS Code reloads or restarts. VS Code
// restores each tab (in its group, at its place) when it first shows, with
// the state its page kept (tabState.ts); the tab's owner then shows it again.
// Until the tab's sandbox is connected, it shows the view `restore`: the
// wilted flower while the sandbox cannot be reached, and its own view as soon
// as it can.
import * as vscode from 'vscode';
import { parseTabState, restoreStatus, type RestoreStatus, type TabState, type TabView } from './tabState.ts';
import { adoptTabPanel, webviewHtml } from './webviewHtml.ts';
import type { WorkerManager } from './workers.ts';

/** Shows a restored tab's own view in its panel, once its worker is connected. */
export type Revive<T extends TabState> = (panel: vscode.WebviewPanel, tab: T) => Promise<void>;

/** Thrown by a revive whose content is gone (e.g. a deleted file): the tab says so. */
export class TabGone extends Error {
  readonly title: string;

  constructor(title: string, detail: string) {
    super(detail);
    this.title = title;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A restored tab that shows the view `restore`: waiting for its worker, or why it cannot show. */
interface Waiting {
  tab: TabState;
  revive: () => Promise<void>;
  /** Set when showing it failed: it then waits for "Try again", not for the worker. */
  failure?: RestoreStatus;
  status?: RestoreStatus;
  /**
   * The page has loaded. Only then may the tab's own view replace it: VS Code's webview host
   * keeps a page that was set while the one before still loaded hidden for good (both pages
   * share one load timer in its webview/browser/pre/index.html).
   */
  ready: boolean;
  listener: vscode.Disposable;
}

export class TabRestorer implements vscode.Disposable {
  private readonly waiting = new Map<vscode.WebviewPanel, Waiting>();
  private readonly closed = new WeakSet<vscode.WebviewPanel>();
  private readonly disposables: vscode.Disposable[] = [];
  private settled = false;
  private readonly extensionUri: vscode.Uri;
  private readonly workers: WorkerManager;

  /** `settled`: the saved workers are loaded, so a worker still missing then is not coming back by itself. */
  constructor(extensionUri: vscode.Uri, workers: WorkerManager, settled: Promise<unknown>) {
    this.extensionUri = extensionUri;
    this.workers = workers;
    void settled.finally(() => {
      this.settled = true;
      this.update();
    });
    this.disposables.push(workers.onDidChange(() => this.update()));
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    for (const waiting of this.waiting.values()) waiting.listener.dispose();
    this.waiting.clear();
  }

  /** Restores the tabs of one kind; call while the extension activates. */
  register<V extends TabView>(viewType: string, view: V, revive: Revive<Extract<TabState, { view: V }>>): void {
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(viewType, {
        deserializeWebviewPanel: async (panel, state) => {
          const tab = parseTabState(view, state) as Extract<TabState, { view: V }> | undefined;
          // A tab saved before tabs were restored: nothing says what it showed.
          if (!tab) {
            panel.dispose();
            return;
          }
          adoptTabPanel(panel, this.extensionUri);
          panel.onDidDispose(() => {
            this.closed.add(panel);
            this.leave(panel);
          });
          const show = () => revive(panel, tab);
          if (this.status(tab) === 'ready') await this.revive(panel, tab, show);
          else this.wait(panel, tab, show);
        }
      })
    );
  }

  private status(tab: TabState): RestoreStatus | 'ready' {
    return restoreStatus(tab.workerId, this.workers.get(tab.workerId), this.settled);
  }

  /** Shows the view `restore` in the tab until its worker is connected (or, after a failure, the user tries again). */
  private wait(panel: vscode.WebviewPanel, tab: TabState, revive: () => Promise<void>, failure?: RestoreStatus): void {
    this.leave(panel);
    const waiting: Waiting = {
      tab,
      revive,
      failure,
      ready: false,
      listener: panel.webview.onDidReceiveMessage((message: { type?: string }) => {
        if (message?.type === 'ready') {
          waiting.ready = true;
          this.show(panel, waiting);
        } else if (message?.type === 'retry') {
          this.retry(panel, waiting);
        }
      })
    };
    this.waiting.set(panel, waiting);
    panel.webview.html = webviewHtml(panel.webview, this.extensionUri, 'restore', tab);
    this.show(panel, waiting);
  }

  /** The tab stops waiting: its own view takes over its messages. */
  private leave(panel: vscode.WebviewPanel): void {
    this.waiting.get(panel)?.listener.dispose();
    this.waiting.delete(panel);
  }

  private async revive(panel: vscode.WebviewPanel, tab: TabState, revive: () => Promise<void>): Promise<void> {
    this.leave(panel);
    try {
      await revive();
    } catch (error) {
      if (this.closed.has(panel)) return;
      this.wait(
        panel,
        tab,
        revive,
        error instanceof TabGone
          ? { kind: 'gone', workerId: tab.workerId, title: error.title, detail: error.message }
          : { kind: 'error', workerId: tab.workerId, error: describe(error) }
      );
    }
  }

  /** "Try again": shows the tab again after a failure, else connects its worker again. */
  private retry(panel: vscode.WebviewPanel, waiting: Waiting): void {
    const status = this.status(waiting.tab);
    if (status === 'ready') void this.revive(panel, waiting.tab, waiting.revive);
    else if (status.kind === 'unreachable') void this.workers.reconnect(waiting.tab.workerId).catch(() => undefined);
  }

  /** The workers changed: tabs whose worker is connected show again; the others say why they wait. */
  private update(): void {
    for (const [panel, waiting] of [...this.waiting]) this.show(panel, waiting);
  }

  private show(panel: vscode.WebviewPanel, waiting: Waiting): void {
    const status = waiting.failure ?? this.status(waiting.tab);
    if (status === 'ready') {
      if (waiting.ready) void this.revive(panel, waiting.tab, waiting.revive);
      return;
    }
    waiting.status = status;
    this.post(panel, waiting);
  }

  private post(panel: vscode.WebviewPanel, waiting: Waiting): void {
    if (waiting.ready && waiting.status) void panel.webview.postMessage({ type: 'restoreStatus', status: waiting.status });
  }
}
