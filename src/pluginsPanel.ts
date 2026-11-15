// An agent's plugins in a tab: ui's Plugins view, answered from the worker's
// connection by ui's plugins service. One tab per agent of a worker.
import * as vscode from 'vscode';
import { servePlugins } from 'codeflower-ui/client/pluginsService.ts';
import type { PluginsWebviewMessage } from 'codeflower-ui/protocol/plugins.ts';
import { TabGone } from './restore.ts';
import type { TabState } from './tabState.ts';
import { createTabPanel, webviewHtml } from './webviewHtml.ts';
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
    const label = this.agentLabel(workerId, agent);
    this.show(createTabPanel(this.extensionUri, 'codeflower.plugins', `${label} plugins`, vscode.ViewColumn.Active), workerId, agent, label);
  }

  /** A plugins tab VS Code restored after a reload; its worker is connected. */
  async restore(panel: vscode.WebviewPanel, state: Extract<TabState, { view: 'plugins' }>): Promise<void> {
    if (this.panels.has(`${state.workerId}|${state.agent}`)) {
      panel.dispose();
      return;
    }
    let label: string;
    try {
      label = this.agentLabel(state.workerId, state.agent);
    } catch (error) {
      throw new TabGone('No plugins here', error instanceof Error ? error.message : String(error));
    }
    this.show(panel, state.workerId, state.agent, label);
  }

  /** The agent's name, if it has plugins in code flower. */
  private agentLabel(workerId: string, agent: string): string {
    const state = this.workers.get(workerId)?.agents.find((candidate) => candidate.id === agent);
    if (!state?.capabilities.plugins) throw new Error(`${state?.name ?? agent} has no plugins in code flower`);
    return state.name;
  }

  private show(panel: vscode.WebviewPanel, workerId: string, agent: string, agentLabel: string): void {
    const id = `${workerId}|${agent}`;
    const status = this.workers.get(workerId)?.status;
    const tab: TabState = { view: 'plugins', workerId, agent };
    panel.title = `${agentLabel} plugins`;
    panel.iconPath = new vscode.ThemeIcon('extensions');
    panel.webview.html = webviewHtml(panel.webview, this.extensionUri, 'plugins', tab);
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
