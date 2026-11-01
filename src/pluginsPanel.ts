// A worker's agent's plugins in a tab: ui's Plugins view, answered from the
// worker's connection by ui's plugins service. One tab per worker.
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

  open(workerId: string): void {
    const existing = this.panels.get(workerId);
    if (existing) {
      existing.reveal();
      return;
    }
    const status = this.workers.get(workerId)?.status;
    if (!status?.capabilities?.plugins) throw new Error('This worker\'s agent has no plugins in code flower, or its image is too old');
    const agentLabel = status.agentLabel;
    const assets = vscode.Uri.joinPath(this.extensionUri, 'webview', 'dist');
    const panel = vscode.window.createWebviewPanel('codeflower.plugins', `${agentLabel} plugins`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [assets]
    });
    panel.iconPath = new vscode.ThemeIcon('extensions');
    panel.webview.html = webviewHtml(panel.webview, assets, 'plugins');
    const where = status.stateDirectory ? `--state ${status.stateDirectory}` : '--project PROJECT';
    const service = servePlugins({
      connection: () => this.workers.get(workerId)?.connection,
      send: (message) => void panel.webview.postMessage(message),
      agentLabel,
      restart: async () => {
        await this.workers.require(workerId).restartAgent();
        await this.workers.reconnect(workerId);
      },
      // VS Code reaches the worker only, not the app that started it.
      fetchHint: `Run \`codeflower plugins fetch --agent ${status.agent} ${where}\` where the sandbox was started and there is internet access, then restart the agent.`
    });
    panel.webview.onDidReceiveMessage((message: PluginsWebviewMessage) => service.receive(message));
    panel.onDidDispose(() => {
      service.dispose();
      this.panels.delete(workerId);
    });
    this.panels.set(workerId, panel);
  }

  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose();
  }
}
