import * as vscode from 'vscode';
import { parseWorkerAddress } from 'codeflower-ui/client/address.ts';
import { isWholeLine, movedAddress } from './workerAddress.ts';
import { workerLinks } from './terminalLinks.ts';
import { hostPath } from 'codeflower-ui/client/hostPaths.ts';
import { pastedLine } from './pastedLine.ts';
import { ChatPanels } from './chatPanel.ts';
import { followDevWorker } from './devWorker.ts';
import { PluginsPanels } from './pluginsPanel.ts';
import { PreviewPanels } from './previewPanel.ts';
import { BrowserPanels, chatBrowser } from './browserPanel.ts';
import { SignIn } from './signIn.ts';
import { CommandTerminals } from './commandTerminals.ts';
import { sandboxLabel, ShellTerminals } from './shellTerminals.ts';
import { pickAgent, setIconDirectory } from './agentIcons.ts';
import { attentionStatusBar } from './statusBar.ts';
import { WorkerTree, type TreeNode } from './tree.ts';
import type { AgentState } from 'codeflower-ui/client/workerConnection.ts';
import { WorkerManager } from './workers.ts';
import { TabRestorer } from './restore.ts';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function activate(context: vscode.ExtensionContext): void {
  // The manager reports live traffic to the chat tabs and sign-in terminals,
  // which are created after it; the late-bound references close that loop.
  let panels: ChatPanels | undefined;
  let previews: PreviewPanels | undefined;
  let signIn: SignIn | undefined;
  let commandTerminals: CommandTerminals | undefined;
  let shellTerminals: ShellTerminals | undefined;
  let browsers: BrowserPanels | undefined;
  const workers = new WorkerManager(context, {
    entry: (workerId, key, entry) => panels?.entry(workerId, key, entry),
    permission: (workerId, key, request) => panels?.permission(workerId, key, request),
    question: (workerId, key, request) => panels?.question(workerId, key, request),
    busy: (workerId, key, busy) => panels?.busy(workerId, key, busy),
    queue: (workerId, key, queue) => panels?.queue(workerId, key, queue),
    background: (workerId, key, tasks) => panels?.background(workerId, key, tasks),
    commands: (workerId, key, commands) => panels?.commands(workerId, key, commands),
    jobs: (workerId, jobs) => panels?.jobs(workerId, jobs),
    config: (workerId, key, options) => panels?.config(workerId, key, options),
    elicitUrl: async (_workerId, request) => (signIn ? signIn.elicitUrl(request) : 'decline'),
    elicitationComplete: () => {},
    show: (workerId, request) => previews?.show(workerId, request),
    terminals: (workerId, terminals) => panels?.terminals(workerId, terminals),
    // A command watched here, a shell of the user's, else a sign-in.
    terminalOutput: (terminalId, data, replayed) =>
      commandTerminals?.has(terminalId)
        ? commandTerminals.output(terminalId, data, replayed === true)
        : shellTerminals?.has(terminalId)
          ? shellTerminals.output(terminalId, data, replayed === true)
          : signIn?.terminalOutput(terminalId, data),
    terminalExit: (terminalId, exitCode) =>
      commandTerminals?.has(terminalId)
        ? commandTerminals.exit(terminalId, exitCode)
        : shellTerminals?.has(terminalId)
          ? shellTerminals.exit(terminalId, exitCode)
          : signIn?.terminalExit(terminalId, exitCode),
    usage: (workerId, agent) => panels?.usage(workerId, agent),
    subagent: (workerId, subagent) => panels?.subagentChanged(workerId, subagent),
    subagentSettings: (workerId, agent) => panels?.subagentSettings(workerId, agent),
    browser: (workerId, browser) => browsers?.changed(workerId, browser),
    browserFrame: (workerId, frame) => browsers?.frame(workerId, frame),
    connected: async (workerId) => {
      await panels?.reconnected(workerId);
      await browsers?.connected(workerId);
    },
    disconnected: (workerId, code) => {
      panels?.disconnected(workerId, code);
      browsers?.disconnected(workerId);
    },
    agentDisconnected: (workerId, agent, code) => panels?.agentDisconnected(workerId, agent, code),
    released: (workerId, key) => panels?.released(workerId, key),
    requested: (workerId, key) => panels?.requested(workerId, key)
  });
  setIconDirectory(context.globalStorageUri);
  signIn = new SignIn(workers);
  commandTerminals = new CommandTerminals(workers);
  shellTerminals = new ShellTerminals(workers);
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
  panels.openCommand = (workerId, command, agentName) => commandTerminals!.show(workerId, command, agentName);
  panels.openShell = (workerId) => shellTerminals!.show(workerId);
  browsers = new BrowserPanels(context.extensionUri, workers);
  panels.openBrowser = (workerId, key) => browsers!.open(workerId, key, false);
  panels.browserOf = (workerId, key) => chatBrowser(browsers!.state(workerId, key));
  browsers.chatChanged = (workerId, key, browser) => panels!.browser(workerId, key, browser);
  browsers.chatTitle = (workerId, key) =>
    panels!.chat(workerId, key)?.title ?? workers.get(workerId)?.sessions.find((session) => session.key === key)?.title;
  browsers.chatColumn = (workerId, key) => panels!.column(workerId, key);
  const tree = new WorkerTree(workers, panels);
  const plugins = new PluginsPanels(context.extensionUri, workers);

  // The workers of the last session, and in development the dev worker: restored tabs wait for them.
  const restored: Promise<unknown>[] = [workers.restore()];
  // Set by the "Extension + dev worker" launch configuration.
  const devState = process.env.CODEFLOWER_DEV_STATE;
  if (context.extensionMode === vscode.ExtensionMode.Development && devState) {
    const dev = followDevWorker(devState, workers);
    context.subscriptions.push(dev.watcher);
    restored.push(dev.ready);
  }
  // Tabs VS Code brings back after a reload or restart (package.json's onWebviewPanel events).
  const tabs = new TabRestorer(context.extensionUri, workers, Promise.allSettled(restored));
  tabs.register('codeflower.chat', 'chat', (panel, tab) => panels!.restore(panel, tab));
  tabs.register('codeflower.preview', 'preview', (panel, tab) => previews!.restore(panel, tab));
  tabs.register('codeflower.report', 'report', (panel, tab) => previews!.restoreReport(panel, tab));
  tabs.register('codeflower.browser', 'browser', (panel, tab) => browsers!.restore(panel, tab));
  tabs.register('codeflower.plugins', 'plugins', (panel, tab) => plugins.restore(panel, tab));

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

  // A link asks to connect: any program can print or open one, so the user
  // confirms where to.
  const connectFromLink = async (text: string) => {
    const address = parseWorkerAddress(text);
    const choice = await vscode.window.showInformationMessage(
      `Connect to the code flower sandbox at ${address.display}?`,
      { modal: true, detail: 'Only connect to sandboxes you started yourself, for example from the code flower app.' },
      'Connect'
    );
    if (choice !== 'Connect') return;
    await vscode.commands.executeCommand('workbench.view.extension.codeflower');
    await connect(text);
  };

  context.subscriptions.push(
    // The app window's "Open in VS Code" button:
    //   vscode://codeflower.codeflower/connect?address=codeflower://…
    vscode.window.registerUriHandler({
      handleUri: guarded(async (uri: vscode.Uri) => {
        if (uri.path !== '/connect') return;
        await connectFromLink(new URLSearchParams(uri.query).get('address') ?? '');
      })
    }),
    // Ctrl+click on a worker's codeflower://… line (or its vscode:// link) in
    // the terminal, which VS Code would cut at the "?".
    vscode.window.registerTerminalLinkProvider({
      provideTerminalLinks: (context: vscode.TerminalLinkContext) =>
        workerLinks(context.line).map((link) => ({ ...link, tooltip: 'Connect to this code flower sandbox' })),
      handleTerminalLink: guarded((link: vscode.TerminalLink) => connectFromLink((link as vscode.TerminalLink & { address: string }).address))
    }),
    workers,
    plugins,
    tabs,
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
    // Its sandbox started again (`--continue`) on another node or port: same chats, new host:port.
    vscode.commands.registerCommand(
      'codeflower.editWorkerAddress',
      guarded(async (node: TreeNode) => {
        const worker = workers.get(node.workerId);
        if (!worker) return;
        const current = worker.address;
        const newAddress = (value: string) => {
          const line = pastedLine(value);
          return isWholeLine(line) ? parseWorkerAddress(line) : movedAddress(current, line);
        };
        const text = await vscode.window.showInputBox({
          title: 'Change the sandbox’s address',
          prompt: 'The new host:port (or only the port). A new sandbox, not one started again with --continue: paste its whole codeflower://… line',
          value: current.display,
          valueSelection: [current.display.lastIndexOf(':') + 1, current.display.length],
          ignoreFocusOut: true,
          validateInput: (value) => {
            try {
              const moved = newAddress(value);
              const other = [...workers.workers.values()].find((entry) => entry.id !== worker.id && entry.address.display === moved.display);
              return other ? `Another sandbox in the list is at ${moved.display}` : undefined;
            } catch (error) {
              return message(error);
            }
          }
        });
        if (text === undefined) return;
        const moved = newAddress(text);
        if (moved.url === current.url && moved.token === current.token && moved.fingerprint === current.fingerprint) return;
        try {
          await workers.move(worker.id, moved);
        } catch (error) {
          void vscode.window.showWarningMessage(
            `Saved the sandbox at ${moved.display}, but it does not answer there yet (${message(error)}). code flower keeps trying.`
          );
        }
      })
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
    // A shell in a sandbox, from its row in the sidebar or the command palette (the user picks among several).
    vscode.commands.registerCommand(
      'codeflower.openShell',
      guarded(async (node?: TreeNode) => {
        const connected = [...workers.workers.values()].filter((worker) => worker.state === 'connected');
        let workerId = node?.workerId;
        if (!workerId) {
          if (!connected.length) throw new Error('No sandbox is connected: connect one first ("code flower: Connect to worker…").');
          workerId =
            connected.length === 1
              ? connected[0]!.id
              : (
                  await vscode.window.showQuickPick(
                    connected.map((worker) => ({
                      label: sandboxLabel(worker.status?.stateDirectory, worker.address.display),
                      description: worker.address.display,
                      id: worker.id
                    })),
                    { title: 'Open a shell in' }
                  )
                )?.id;
          if (!workerId) return;
        }
        if (!workers.require(workerId).shellTerminals) {
          throw new Error('This sandbox cannot open a shell: its image is older than that. Start it again with a current code flower.');
        }
        shellTerminals!.show(workerId);
      })
    ),
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
}

export function deactivate(): void {}
