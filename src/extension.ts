import * as vscode from 'vscode';
import { parseWorkerAddress } from './address.ts';
import { ChatPanels } from './chatPanel.ts';
import { followDevWorker } from './devWorker.ts';
import { PreviewPanels } from './previewPanel.ts';
import { SignIn } from './signIn.ts';
import { attentionStatusBar } from './statusBar.ts';
import { WorkerTree, type TreeNode } from './tree.ts';
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
    terminalOutput: (terminalId, data) => signIn?.terminalOutput(terminalId, data),
    terminalExit: (terminalId, exitCode) => signIn?.terminalExit(terminalId, exitCode),
    usage: (workerId) => panels?.usage(workerId),
    connected: async (workerId) => panels?.reconnected(workerId),
    disconnected: (workerId, code) => panels?.disconnected(workerId, code)
  });
  signIn = new SignIn(workers);
  const runSignIn = async (workerId: string) => {
    try {
      await signIn!.run(workerId);
    } catch (error) {
      void vscode.window.showErrorMessage(`Sign-in failed: ${message(error)}`);
    }
  };
  panels = new ChatPanels(context.extensionUri, workers, runSignIn, context.globalState);
  previews = new PreviewPanels(context.extensionUri, workers, panels);
  panels.openFile = (workerId, key, path) => void previews!.openPath(workerId, path, key);
  const tree = new WorkerTree(workers, panels);

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
    if (worker.status && !worker.status.signedIn) {
      const choice = await vscode.window.showInformationMessage(
        `${worker.status.agentLabel} is not signed in for this project yet.`,
        'Sign in'
      );
      if (choice) await runSignIn(worker.id);
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
    attentionStatusBar(panels),
    vscode.window.createTreeView('codeflower.workers', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.commands.registerCommand(
      'codeflower.connectWorker',
      guarded(async () => {
        const text = await vscode.window.showInputBox({
          prompt: 'Paste the codeflower://… line the worker printed when it started',
          placeHolder: 'codeflower://10.20.3.17:41234?token=…',
          ignoreFocusOut: true,
          validateInput: (value) => {
            try {
              parseWorkerAddress(value);
              return undefined;
            } catch (error) {
              return message(error);
            }
          }
        });
        if (text) await connect(text);
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
      'codeflower.removeWorker',
      guarded((node: TreeNode) => workers.remove(node.workerId))
    ),
    vscode.commands.registerCommand(
      'codeflower.reconnectWorker',
      guarded((node: TreeNode) => workers.reconnect(node.workerId))
    ),
    vscode.commands.registerCommand('codeflower.signIn', guarded((node: TreeNode) => runSignIn(node.workerId))),
    vscode.commands.registerCommand(
      'codeflower.newSession',
      guarded((node: TreeNode) => panels!.newSession(node.workerId))
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

  void workers.restore();

  // Set by the "Extension + dev worker" launch configuration.
  const devState = process.env.CODEFLOWER_DEV_STATE;
  if (context.extensionMode === vscode.ExtensionMode.Development && devState) {
    context.subscriptions.push(followDevWorker(devState, workers));
  }
}

export function deactivate(): void {}
