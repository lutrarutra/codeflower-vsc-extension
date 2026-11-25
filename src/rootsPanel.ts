// A sandbox's map of ideas in a tab: ui's Roots view, answered from the
// worker's connection by ui's roots service. One tab per worker.
import * as vscode from 'vscode';
import { serveRoots } from 'codeflower-ui/client/rootsService.ts';
import type { RootsChat, RootsWebviewMessage } from 'codeflower-ui/protocol/roots.ts';
import type { ChatPanels } from './chatPanel.ts';
import { TabGone } from './restore.ts';
import type { TabState } from './tabState.ts';
import { createTabPanel, webviewHtml } from './webviewHtml.ts';
import type { WorkerManager } from './workers.ts';

export class RootsPanels implements vscode.Disposable {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; focus(idea: number): void }>();
  private readonly extensionUri: vscode.Uri;
  private readonly workers: WorkerManager;
  private readonly chats: ChatPanels;
  /** A new chat on the worker with a message ready to send; set by the extension, which picks the agent. */
  newChat: (workerId: string, draft: string) => void = () => {};
  /** Shows a file from the worker's sandbox; set once the previews exist. */
  openFile: (workerId: string, path: string) => void = () => {};

  constructor(extensionUri: vscode.Uri, workers: WorkerManager, chats: ChatPanels) {
    this.extensionUri = extensionUri;
    this.workers = workers;
    this.chats = chats;
  }

  /** The worker's map, on `idea` when given. */
  open(workerId: string, idea?: number): void {
    const existing = this.panels.get(workerId);
    if (existing) {
      existing.panel.reveal();
      if (idea !== undefined) existing.focus(idea);
      return;
    }
    this.workers.require(workerId);
    const panel = createTabPanel(this.extensionUri, 'codeflower.roots', this.title(workerId), vscode.ViewColumn.Active);
    this.show(panel, workerId);
    if (idea !== undefined) this.panels.get(workerId)?.focus(idea);
  }

  /** A Roots tab VS Code restored after a reload; its worker is connected. */
  async restore(panel: vscode.WebviewPanel, state: Extract<TabState, { view: 'roots' }>): Promise<void> {
    if (this.panels.has(state.workerId)) {
      panel.dispose();
      return;
    }
    if (!this.workers.get(state.workerId)?.connection) throw new TabGone('No map here', 'The sandbox is not connected');
    this.show(panel, state.workerId);
  }

  private label(workerId: string): string {
    return this.workers.get(workerId)?.status?.stateDirectory?.split('/').filter(Boolean).at(-1) ?? 'Sandbox';
  }

  private title(workerId: string): string {
    return `Roots: ${this.label(workerId)}`;
  }

  /** The worker's chats, with the state of those open here. */
  private chatList(workerId: string): RootsChat[] {
    const worker = this.workers.get(workerId);
    return (worker?.sessions ?? []).map((session) => {
      const status = this.chats.status(workerId, session.key);
      return {
        key: session.key,
        title: session.title,
        agentLabel: worker?.agents.find((agent) => agent.id === session.harness)?.name ?? session.harness,
        state: status === 'working' ? 'working' : status === 'waiting' ? 'waiting' : 'idle'
      };
    });
  }

  private show(panel: vscode.WebviewPanel, workerId: string): void {
    const tab: TabState = { view: 'roots', workerId };
    panel.title = this.title(workerId);
    panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
    panel.webview.html = webviewHtml(panel.webview, this.extensionUri, 'roots', tab);
    const service = serveRoots({
      connection: () => this.workers.get(workerId)?.connection,
      send: (message) => void panel.webview.postMessage(message),
      label: () => this.label(workerId),
      chats: () => this.chatList(workerId),
      openChat: (key) => void this.chats.open(workerId, key).catch((error) => void vscode.window.showErrorMessage(String(error))),
      newChat: (prompt) => this.newChat(workerId, prompt),
      openFile: (path) => this.openFile(workerId, path)
    });
    const changes = [
      // The worker's project may come after the tab, e.g. one restored after a reload.
      this.workers.onDidChange(() => {
        panel.title = this.title(workerId);
        service.chatsChanged();
      }),
      this.chats.onDidChangeStatus(() => service.chatsChanged())
    ];
    panel.webview.onDidReceiveMessage((message: RootsWebviewMessage) => service.receive(message));
    panel.onDidDispose(() => {
      service.dispose();
      for (const change of changes) change.dispose();
      this.panels.delete(workerId);
    });
    this.panels.set(workerId, { panel, focus: (idea) => service.focus(idea) });
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
  }
}
