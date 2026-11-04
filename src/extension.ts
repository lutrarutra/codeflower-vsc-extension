import * as vscode from 'vscode';
import { parseWorkerAddress } from 'codeflower-ui/client/address.ts';
import { hostPath } from 'codeflower-ui/client/hostPaths.ts';
import { pastedLine } from './pastedLine.ts';
import { ChatPanels } from './chatPanel.ts';
import { followDevWorker } from './devWorker.ts';
import { PluginsPanels } from './pluginsPanel.ts';
import { PreviewPanels } from './previewPanel.ts';
import { SignIn } from './signIn.ts';
import { pickAgent, setIconDirectory } from './agentIcons.ts';
import { attentionStatusBar } from './statusBar.ts';
import { WorkerTree, type TreeNode } from './tree.ts';
import type { AgentState } from 'codeflower-ui/client/workerConnection.ts';
import { WorkerManager } from './workers.ts';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function activate(context: vscode.ExtensionContext): void {
  // The manager reports live traffic to the chat tabs and sign-in terminals,
  // which are created after it; the late-bound references close that loop.
  let panels: ChatPanels | undefined;
  let previews: PreviewPanels | undefined;
  let signIn: SignIn | undefined;
  const workers = new WorkerManager(context, {
    entry: (workerId, key, entry) => panels?.entry(workerId, key, entry),
    permission: (workerId, key, request) => panels?.permission(workerId, key, request),
    question: (workerId, key, request) => panels?.question(workerId, key, request),
    busy: (workerId, key, busy) => panels?.busy(workerId, key, busy),
    config: (workerId, key, options) => panels?.config(workerId, key, options),
    elicitUrl: async (_workerId, request) => (signIn ? signIn.elicitUrl(request) : 'decline'),
    elicitationComplete: () => {},
    show: (workerId, request) => previews?.show(workerId, request),
    terminals: (workerId, terminals) => panels?.terminals(workerId, terminals),
    terminalOutput: (terminalId, data) => signIn?.terminalOutput(terminalId, data),
    terminalExit: (terminalId, exitCode) => signIn?.terminalExit(terminalId, exitCode),
    usage: (workerId, agent) => panels?.usage(workerId, agent),
    subagent: (workerId, subagent) => panels?.subagentChanged(workerId, subagent),
    subagentSettings: (workerId, agent) => panels?.subagentSettings(workerId, agent),
    connected: async (workerId) => panels?.reconnected(workerId),
    disconnected: (workerId, code) => panels?.disconnected(workerId, code),
    agentDisconnected: (workerId, agent, code) => panels?.agentDisconnected(workerId, agent, code)
  });
  setIconDirectory(context.globalStorageUri);
  signIn = new SignIn(workers);
  const runSignIn = async (workerId: string, agent: string) => {
    try {
      await signIn!.run(workerId, agent);
    } catch (error) {
      void vscode.window.showErrorMessage(`Sign-in failed: ${message(error)}`);
    }
  };
  /** The agent a tree node names, or the user's pick among the worker's agents. */
  const agentOf = async (node: TreeNode, title: string, only?: (agent: AgentState) => boolean): Promise<string | undefined> => {
    if (node.kind === 'agent') return node.agent;
    const worker = workers.get(node.workerId);
    const first = context.globalState.get<string>(`codeflower.newChatAgent.${node.workerId}`);
    return (await pickAgent(worker?.agents ?? [], { title, first, only }))?.id;
  };
  /** A new chat with the agent the node names, or the one the user picks (the one used last first). */
  const newSession = async (node: TreeNode) => {
    const agent = await agentOf(node, 'New session with');
    if (!agent) return;
    void context.globalState.update(`codeflower.newChatAgent.${node.workerId}`, agent);
    if (workers.get(node.workerId)?.agents.find((candidate) => candidate.id === agent)?.signedIn === false) {
      await runSignIn(node.workerId, agent);
      return;
    }
    await panels!.newSession(node.workerId, agent);
  };
  panels = new ChatPanels(context.extensionUri, workers, runSignIn, context.globalState);
  previews = new PreviewPanels(context.extensionUri, workers, panels);
  panels.openFile = (workerId, key, path) => void previews!.openPath(workerId, path, key);
  const tree = new WorkerTree(workers, panels);
  const plugins = new PluginsPanels(context.extensionUri, workers);

  const guarded =
    <T extends unknown[]>(action: (...args: T) => Promise<unknown> | unknown) =>
    async (...args: T) => {
      try {
        await action(...args);
      } catch (error) {
        void vscode.window.showErrorMessage(message(error));
      }
    };

  const connect = async (text: string) => {
    const worker = await vscode.window.withProgress({ location: { viewId: 'codeflower.workers' } }, () =>
      workers.add(text)
    );
    // Once for every agent not signed in yet; the Agents node signs each in later.
    const waiting = worker.agents.filter((agent) => !agent.signedIn && !agent.unavailable);
    if (waiting.length === worker.agents.length && waiting.length) {
      const choice = await vscode.window.showInformationMessage('No agent is signed in for this project yet.', 'Sign in');
      if (!choice) return;
      const agent = await pickAgent(waiting, { title: 'Sign in to' });
      if (agent) await runSignIn(worker.id, agent.id);
    }
  };

  context.subscriptions.push(
    // The app window's "Open in VS Code" button:
    //   vscode://codeflower.codeflower/connect?address=codeflower://…
    vscode.window.registerUriHandler({
      handleUri: guarded(async (uri: vscode.Uri) => {
        if (uri.path !== '/connect') return;
        const text = new URLSearchParams(uri.query).get('address') ?? '';
        const address = parseWorkerAddress(text);
        // Any link can ask to connect, so the user confirms where to.
        const choice = await vscode.window.showInformationMessage(
          `Connect to the code flower sandbox at ${address.display}?`,
          { modal: true, detail: 'Only connect to sandboxes you started yourself, for example from the code flower app.' },
          'Connect'
        );
        if (choice !== 'Connect') return;
        await vscode.commands.executeCommand('workbench.view.extension.codeflower');
        await connect(text);
      })
    }),
    workers,
    plugins,
    attentionStatusBar(panels),
    vscode.window.createTreeView('codeflower.workers', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.commands.registerCommand(
      'codeflower.connectWorker',
      guarded(async () => {
        const text = await vscode.window.showInputBox({
          prompt: 'Paste the codeflower://… line (or vscode://… link) the worker printed when it started',
          placeHolder: 'codeflower://10.20.3.17:41234?token=…',
          ignoreFocusOut: true,
          validateInput: (value) => {
            try {
              parseWorkerAddress(pastedLine(value));
              return undefined;
            } catch (error) {
              return message(error);
            }
          }
        });
        if (text) await connect(pastedLine(text));
      })
    ),
    vscode.commands.registerCommand('codeflower.refresh', guarded(() => workers.refreshAll())),
    vscode.commands.registerCommand(
      'codeflower.openFile',
      guarded((node: TreeNode) =>
        node.kind === 'file' ? previews!.openPath(node.workerId, node.path, panels!.chatFor(node.workerId)) : undefined
      )
    ),
    vscode.commands.registerCommand(
      'codeflower.copySandboxPath',
      guarded((node: TreeNode) => (node.kind === 'file' || node.kind === 'folder' ? vscode.env.clipboard.writeText(node.path) : undefined))
    ),
    vscode.commands.registerCommand(
      'codeflower.copyHostPath',
      guarded(async (node: TreeNode) => {
        if (node.kind !== 'file' && node.kind !== 'folder') return;
        const path = hostPath(workers.get(node.workerId)?.status, node.path);
        if (path) await vscode.env.clipboard.writeText(path);
        else void vscode.window.showInformationMessage(`${node.path} is not in a folder from the machine that runs the sandbox.`);
      })
    ),
    vscode.commands.registerCommand(
      'codeflower.removeWorker',
      guarded((node: TreeNode) => workers.remove(node.workerId))
    ),
    vscode.commands.registerCommand(
      'codeflower.reconnectWorker',
      guarded((node: TreeNode) => workers.reconnect(node.workerId))
    ),
    vscode.commands.registerCommand(
      'codeflower.signIn',
      guarded(async (node: TreeNode) => {
        const agent = await agentOf(node, 'Sign in to');
        if (agent) await runSignIn(node.workerId, agent);
      })
    ),
    vscode.commands.registerCommand(
      'codeflower.plugins',
      guarded(async (node: TreeNode) => {
        const agent = await agentOf(node, 'Plugins of', (candidate) => !!candidate.capabilities.plugins);
        if (agent) plugins.open(node.workerId, agent);
      })
    ),
    vscode.commands.registerCommand('codeflower.newSession', guarded(newSession)),
    vscode.commands.registerCommand(
      'codeflower.openSession',
      guarded((node: TreeNode) => (node.kind === 'session' ? panels!.open(node.workerId, node.key) : undefined))
    ),
    vscode.commands.registerCommand(
      'codeflower.renameSession',
      guarded(async (node: TreeNode) => {
        if (node.kind !== 'session') return;
        const current = workers.get(node.workerId)?.sessions.find((session) => session.key === node.key);
        const title = await vscode.window.showInputBox({ prompt: 'Session title', value: current?.title });
        if (!title?.trim()) return;
        await workers.require(node.workerId).renameSession(node.key, title.trim());
        panels!.rename(node.workerId, node.key, title.trim());
        await workers.refresh(node.workerId);
      })
    ),
    vscode.commands.registerCommand(
      'codeflower.deleteSession',
      guarded(async (node: TreeNode) => {
        if (node.kind !== 'session') return;
        const choice = await vscode.window.showWarningMessage(
          'Delete this session? The agent’s own session files stay in the project.',
          { modal: true },
          'Delete'
        );
        if (choice !== 'Delete') return;
        panels!.close(node.workerId, node.key);
        await workers.require(node.workerId).deleteSession(node.key);
        await workers.refresh(node.workerId);
      })
    )
  );

  void workers.restore();

  // Set by the "Extension + dev worker" launch configuration.
  const devState = process.env.CODEFLOWER_DEV_STATE;
  if (context.extensionMode === vscode.ExtensionMode.Development && devState) {
    context.subscriptions.push(followDevWorker(devState, workers));
  }
}

export function deactivate(): void {}
