// The chats' browsers (codeflower-browser): a Chromium per chat in the
// worker's sandbox, which the agent drives and the user watches and takes
// over. Each shows in a panel beside its chat; the extension holds the
// connection and relays the view's calls and the frames.
import * as vscode from 'vscode';
import type { BrowserCall, BrowserFrame, BrowserPanelHostMessage, BrowserPanelMessage, BrowserState } from 'codeflower-ui/protocol/browser.ts';
import type { ChatState } from 'codeflower-ui/protocol/messages.ts';
import type { TabState } from './tabState.ts';
import { createTabPanel, webviewHtml } from './webviewHtml.ts';
import type { WorkerManager } from './workers.ts';

const CALLS = new Set<BrowserCall>(['watch', 'unwatch', 'ack', 'control', 'input', 'navigate', 'dialog', 'selectTab', 'handBack']);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a chat's header shows of its browser. */
export function chatBrowser(browser: BrowserState | undefined): ChatState['browser'] {
  return browser?.running ? { running: true, needsYou: Boolean(browser.handoff && !browser.yours), yours: browser.yours === true } : undefined;
}

class BrowserPanel {
  readonly panel: vscode.WebviewPanel;
  private readonly owner: BrowserPanels;
  readonly workerId: string;
  readonly key: string;
  private ready = false;

  /** `panel`: a new tab, or one VS Code restored. */
  constructor(owner: BrowserPanels, workerId: string, key: string, panel: vscode.WebviewPanel) {
    this.owner = owner;
    this.workerId = workerId;
    this.key = key;
    this.panel = panel;
    this.panel.iconPath = new vscode.ThemeIcon('globe');
    const tab: TabState = { view: 'browser', workerId, key };
    this.panel.webview.html = webviewHtml(this.panel.webview, owner.extensionUri, 'browser', tab);
    this.panel.webview.onDidReceiveMessage((message: BrowserPanelMessage) => void this.handle(message));
    // Frames come only while the panel shows.
    this.panel.onDidChangeViewState(() => this.post({ type: 'visible', visible: this.panel.visible }));
    this.panel.onDidDispose(() => {
      // The panel goes: it stops watching, and lets go of the browser if it controlled it.
      const connection = owner.workers.get(workerId)?.connection;
      if (connection?.connected) {
        const calls = connection.browser(key);
        void calls.unwatch().catch(() => undefined);
        if (owner.state(workerId, key)?.yours) void calls.control(false).catch(() => undefined);
      }
      owner.closed(this);
    });
  }

  post(message: BrowserPanelHostMessage): void {
    if (this.ready) void this.panel.webview.postMessage(message);
  }

  postState(): void {
    const browser = this.owner.state(this.workerId, this.key) ?? { key: this.key, running: false, tabs: [], url: '', title: '', controlled: false };
    const connected = Boolean(this.owner.workers.get(this.workerId)?.connection?.connected);
    this.panel.title = browser.title && browser.title !== 'about:blank' ? `Browser: ${browser.title}` : 'Browser';
    this.post({ type: 'browser', browser, connected });
  }

  private async handle(message: BrowserPanelMessage): Promise<void> {
    if (message.type === 'ready') {
      this.ready = true;
      this.postState();
      this.post({ type: 'visible', visible: this.panel.visible });
      return;
    }
    if (message.type !== 'call' || !CALLS.has(message.method)) return;
    try {
      const calls = this.owner.workers.require(this.workerId).browser(this.key) as unknown as Record<BrowserCall, (...args: unknown[]) => Promise<void>>;
      await calls[message.method](...(Array.isArray(message.args) ? message.args : []));
      this.post({ type: 'reply', id: message.id });
    } catch (error) {
      this.post({ type: 'reply', id: message.id, error: describe(error) });
    }
  }
}

export class BrowserPanels {
  private readonly panels = new Map<string, BrowserPanel>();
  /** Each chat's browser as the worker last said, by worker and chat. */
  private readonly states = new Map<string, BrowserState>();
  /** The chat's header shows its browser: what to tell it, and its title for notices. */
  chatChanged: (workerId: string, key: string, browser: ChatState['browser']) => void = () => {};
  chatTitle: (workerId: string, key: string) => string | undefined = () => undefined;
  /** Whether the chat is open in a tab, and in which column. */
  chatColumn: (workerId: string, key: string) => vscode.ViewColumn | undefined = () => undefined;

  readonly extensionUri: vscode.Uri;
  readonly workers: WorkerManager;

  constructor(extensionUri: vscode.Uri, workers: WorkerManager) {
    this.extensionUri = extensionUri;
    this.workers = workers;
  }

  private id(workerId: string, key: string): string {
    return `${workerId}\n${key}`;
  }

  state(workerId: string, key: string): BrowserState | undefined {
    return this.states.get(this.id(workerId, key));
  }

  /** A chat's browser changed: its panel and its chat's header follow; it opens when it starts beside an open chat or asks for the user. */
  changed(workerId: string, browser: BrowserState): void {
    const id = this.id(workerId, browser.key);
    const previous = this.states.get(id);
    this.states.set(id, browser);
    this.panels.get(id)?.postState();
    this.chatChanged(workerId, browser.key, chatBrowser(browser));
    if (browser.handoff && browser.handoff.at !== previous?.handoff?.at && !browser.yours) {
      this.open(workerId, browser.key, false);
      const title = this.chatTitle(workerId, browser.key) ?? 'A chat';
      void vscode.window
        .showInformationMessage(`${title}: the agent needs you in its browser. ${browser.handoff.reason}`, 'Open browser')
        .then((choice) => choice && this.open(workerId, browser.key, false));
    } else if (browser.running && !previous?.running && this.chatColumn(workerId, browser.key) !== undefined) {
      this.open(workerId, browser.key, true);
    }
  }

  /** A frame for a chat's panel; one nobody shows is answered all the same, or the next would never come. */
  frame(workerId: string, frame: BrowserFrame): void {
    const panel = this.panels.get(this.id(workerId, frame.key));
    if (panel) panel.post({ type: 'frame', frame });
    else void this.workers.get(workerId)?.connection?.browser(frame.key).ack(frame.frameId).catch(() => undefined);
  }

  /** Shows a chat's browser beside its chat (`preserveFocus`: without taking the focus from it). */
  open(workerId: string, key: string, preserveFocus: boolean): void {
    const existing = this.panels.get(this.id(workerId, key));
    if (existing) {
      existing.panel.reveal(undefined, preserveFocus);
      return;
    }
    const tab = createTabPanel(this.extensionUri, 'codeflower.browser', 'Browser', { viewColumn: vscode.ViewColumn.Beside, preserveFocus });
    this.panels.set(this.id(workerId, key), new BrowserPanel(this, workerId, key, tab));
  }

  /** A browser tab VS Code restored after a reload; its worker is connected. */
  async restore(tab: vscode.WebviewPanel, state: Extract<TabState, { view: 'browser' }>): Promise<void> {
    const id = this.id(state.workerId, state.key);
    if (this.panels.has(id)) {
      tab.dispose();
      return;
    }
    // Its state follows when the worker lists its browsers (connected), or is already known.
    this.panels.set(id, new BrowserPanel(this, state.workerId, state.key, tab));
  }

  closed(panel: BrowserPanel): void {
    const id = this.id(panel.workerId, panel.key);
    if (this.panels.get(id) === panel) this.panels.delete(id);
  }

  /** The worker connected (again): what its browsers are, and the open panels watch again. */
  async connected(workerId: string): Promise<void> {
    const listed = await this.workers.get(workerId)?.connection?.browsers().catch(() => undefined);
    for (const browser of listed?.browsers ?? []) this.changed(workerId, browser);
    for (const panel of this.panels.values()) if (panel.workerId === workerId) panel.postState();
  }

  disconnected(workerId: string): void {
    for (const panel of this.panels.values()) if (panel.workerId === workerId) panel.postState();
  }
}
