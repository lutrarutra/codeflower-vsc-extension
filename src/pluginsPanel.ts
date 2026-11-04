// An agent's plugins in a tab: ui's Plugins view, answered from the worker's
// connection by ui's plugins service. One tab per agent of a worker.
import * as vscode from 'vscode';
import { servePlugins } from 'codeflower-ui/client/pluginsService.ts';
import type { PluginsWebviewMessage } from 'codeflower-ui/protocol/plugins.ts';
import { webviewHtml } from './webviewHtml.ts';
import type { WorkerManager } from './workers.ts';

export class PluginsPanels implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly extensionUri: vscode.Uri;
  private readonly workers: WorkerManager;

  constructor(extensionUri: vscode.Uri, workers: WorkerManager) {
    this.extensionUri = extensionUri;
    this.workers = workers;
  }

  open(workerId: string, agent: string): void {
    const id = `${workerId}|${agent}`;
    const existing = this.panels.get(id);
    if (existing) {
      existing.reveal();
      return;
    }
    const worker = this.workers.get(workerId);
    const state = worker?.agents.find((candidate) => candidate.id === agent);
    if (!state?.capabilities.plugins) throw new Error(`${state?.name ?? agent} has no plugins in code flower`);
    const status = worker?.status;
    const agentLabel = state.name;
    const assets = vscode.Uri.joinPath(this.extensionUri, 'webview', 'dist');
    const panel = vscode.window.createWebviewPanel('codeflower.plugins', `${agentLabel} plugins`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [assets]
    });
    panel.iconPath = new vscode.ThemeIcon('extensions');
    panel.webview.html = webviewHtml(panel.webview, assets, 'plugins');
    const where = status?.stateDirectory ? `--state ${status.stateDirectory}` : '--project PROJECT';
    const service = servePlugins({
      connection: () => this.workers.get(workerId)?.connection,
      agent,
      send: (message) => void panel.webview.postMessage(message),
      agentLabel,
      // Its chats attach to the fresh agent by themselves.
      restart: () => this.workers.require(workerId).restartAgent(agent),
      // VS Code reaches the worker only, not the app that started it.
      fetchHint: `Run \`codeflower plugins fetch --agent ${agent} ${where}\` where the sandbox was started and there is internet access, then restart the agent.`
    });
    panel.webview.onDidReceiveMessage((message: PluginsWebviewMessage) => service.receive(message));
    panel.onDidDispose(() => {
      service.dispose();
      this.panels.delete(id);
    });
    this.panels.set(id, panel);
  }

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose();
  }
}
