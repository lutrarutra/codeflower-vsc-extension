// Sign-in through the client: the agent's own flows run inside the sandbox
// and store their login there. code flower only relays what the user types.
import type { AuthMethod } from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { externalUrl } from 'codeflower-ui/client/links.ts';
import type { AgentName } from 'codeflower-ui/protocol/messages.ts';
import type { EndpointModel, UrlElicitation, WorkerConnection } from 'codeflower-ui/client/workerConnection.ts';
import type { WorkerManager } from './workers.ts';

/** A VS Code terminal connected to a sign-in command running in the sandbox. */
class SignInTerminal implements vscode.Pseudoterminal {
  private readonly written = new vscode.EventEmitter<string>();
  private readonly closed = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.written.event;
  readonly onDidClose = this.closed.event;
  terminalId: string | undefined;
  private finished = false;
  private readonly start: (columns: number, rows: number) => Promise<string>;
  private readonly input: (terminalId: string, data: string) => Promise<void>;
  private readonly stop: (terminalId: string) => Promise<void>;
  private readonly register: (terminalId: string, terminal: SignInTerminal) => void;
  private readonly done: (exitCode: number) => void;

  constructor(options: {
    start: (columns: number, rows: number) => Promise<string>;
    input: (terminalId: string, data: string) => Promise<void>;
    stop: (terminalId: string) => Promise<void>;
    register: (terminalId: string, terminal: SignInTerminal) => void;
    done: (exitCode: number) => void;
  }) {
    this.start = options.start;
    this.input = options.input;
    this.stop = options.stop;
    this.register = options.register;
    this.done = options.done;
  }

  open(dimensions: vscode.TerminalDimensions | undefined): void {
    this.written.fire('Starting the sign-in inside the sandbox…\r\n');
    this.start(dimensions?.columns ?? 100, dimensions?.rows ?? 30).then(
      (terminalId) => {
        this.terminalId = terminalId;
        this.register(terminalId, this);
      },
      (error: unknown) => {
        this.written.fire(`\r\nCould not start the sign-in: ${error instanceof Error ? error.message : error}\r\n`);
        this.finished = true;
      }
    );
  }

  output(data: string): void {
    this.written.fire(data);
  }

  exit(exitCode: number): void {
    this.finished = true;
    this.written.fire(
      `\r\n\r\n${exitCode === 0 ? 'Signed in.' : `Sign-in ended with code ${exitCode}.`} Press any key to close.\r\n`
    );
    this.done(exitCode);
  }

  handleInput(data: string): void {
    if (this.finished) {
      this.closed.fire();
      return;
    }
    if (this.terminalId) void this.input(this.terminalId, data).catch(() => undefined);
  }

  close(): void {
    if (this.terminalId && !this.finished) void this.stop(this.terminalId).catch(() => undefined);
  }
}

function isTerminalMethod(method: AuthMethod): boolean {
  const meta = (method as { _meta?: Record<string, unknown> })._meta;
  return Boolean(meta?.['terminal-auth']) || (method as { type?: string }).type === 'terminal';
}

function isApiKeyMethod(method: AuthMethod): boolean {
  return Boolean((method as { _meta?: Record<string, unknown> })._meta?.['api-key']);
}

export class SignIn {
  private readonly workers: WorkerManager;
  private readonly terminals = new Map<string, SignInTerminal>();
  private readonly pendingOutput = new Map<string, string>();

  constructor(workers: WorkerManager) {
    this.workers = workers;
  }

  // ---- routed from the workers ----

  terminalOutput(terminalId: string, data: string): void {
    const terminal = this.terminals.get(terminalId);
    if (terminal) terminal.output(data);
    // Output can arrive before the terminal knows its id.
    else this.pendingOutput.set(terminalId, `${this.pendingOutput.get(terminalId) ?? ''}${data}`.slice(-65536));
  }

  terminalExit(terminalId: string, exitCode: number): void {
    this.terminals.get(terminalId)?.exit(exitCode);
    this.terminals.delete(terminalId);
  }

  /** A page the agent asks the user to open: only a web page, and the user sees where it goes. */
  async elicitUrl(request: UrlElicitation): Promise<'accept' | 'decline'> {
    const page = externalUrl(request.url);
    if (!page) {
      void vscode.window.showWarningMessage(`The agent asked to open a link that is not a web page, so it was not opened: ${request.url}`);
      return 'decline';
    }
    const choice = await vscode.window.showInformationMessage(
      request.message,
      { modal: true, detail: `Opens ${page.href}` },
      `Open ${page.host}`,
      'Cancel'
    );
    if (choice !== `Open ${page.host}`) return 'decline';
    await vscode.env.openExternal(vscode.Uri.parse(page.href, true));
    return 'accept';
  }

  // ---- flows ----

  /** Signs one of the worker's agents in: with its own methods, or the keys code flower keeps for it (dsh). */
  async run(workerId: string, agent: AgentName): Promise<void> {
    const connection = this.workers.require(workerId);
    const state = connection.agent(agent);
    const name = state?.name ?? agent;
    if (state?.unavailable) {
      void vscode.window.showWarningMessage(`${name} cannot run in this worker: ${state.unavailable}`);
      return;
    }
    if (state?.credentials === 'keys') {
      await this.setKeys(workerId, agent, name);
      return;
    }

    const methods = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Starting ${name}…` },
      () => connection.authMethods(agent)
    );
    if (methods.length === 0) {
      void vscode.window.showWarningMessage(`${name} offers no sign-in methods to code flower.`);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      methods.map((method) => ({
        label: method.name,
        detail: method.description ?? undefined,
        method
      })),
      { placeHolder: `Sign in to ${name}`, ignoreFocusOut: true }
    );
    if (!picked) return;
    const method = picked.method;

    if (isTerminalMethod(method)) {
      this.openTerminal(workerId, agent, method);
      return;
    }
    let meta: Record<string, unknown> | undefined;
    if (isApiKeyMethod(method)) {
      const apiKey = await vscode.window.showInputBox({
        prompt: `${name}: API key`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : 'The key cannot be empty')
      });
      if (!apiKey) return;
      meta = { 'api-key': { apiKey: apiKey.trim() } };
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Signing in to ${name}…`, cancellable: false },
      () => connection.authenticate(agent, method.id, meta)
    );
    await this.workers.refresh(workerId);
    void vscode.window.showInformationMessage(`Signed in to ${name}.`);
  }

  private openTerminal(workerId: string, agent: AgentName, method: AuthMethod): void {
    const connection = this.workers.require(workerId);
    const pty = new SignInTerminal({
      start: (columns, rows) => connection.startTerminal(agent, method.id, columns, rows),
      input: (terminalId, data) => connection.terminalInput(terminalId, data),
      stop: (terminalId) => connection.closeTerminal(terminalId),
      register: (terminalId, terminal) => {
        this.terminals.set(terminalId, terminal);
        const early = this.pendingOutput.get(terminalId);
        if (early) {
          this.pendingOutput.delete(terminalId);
          terminal.output(early);
        }
      },
      done: () => void this.workers.refresh(workerId)
    });
    vscode.window.createTerminal({ name: `code flower sign-in: ${method.name}`, pty }).show();
  }

  private async setKeys(workerId: string, agent: AgentName, name: string): Promise<void> {
    const connection = this.workers.require(workerId);
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'DeepSeek API key', id: 'deepseek' as const },
        { label: 'OpenAI-compatible endpoint', detail: 'OpenRouter, vLLM on the cluster, …', id: 'compatible' as const }
      ],
      { placeHolder: `Which credentials should ${name} use?`, ignoreFocusOut: true }
    );
    if (!choice) return;
    if (choice.id === 'deepseek') {
      const key = await vscode.window.showInputBox({ prompt: 'DeepSeek API key', password: true, ignoreFocusOut: true });
      if (!key?.trim()) return;
      await connection.setCredentials(agent, { deepseekApiKey: key.trim() });
    } else {
      const baseURL = await vscode.window.showInputBox({
        prompt: 'Base URL of the OpenAI-compatible API',
        placeHolder: 'https://openrouter.ai/api/v1',
        ignoreFocusOut: true,
        validateInput: (value) => (/^https?:\/\/\S+$/.test(value.trim()) ? undefined : 'Enter an http(s) URL')
      });
      if (!baseURL) return;
      const apiKey = await vscode.window.showInputBox({ prompt: 'API key for the endpoint', password: true, ignoreFocusOut: true });
      if (!apiKey?.trim()) return;
      const models = await this.chooseModels(connection, agent, baseURL.trim(), apiKey.trim());
      if (!models?.length) return;
      const reasoningEfforts = await vscode.window.showInputBox({
        prompt: 'Reasoning effort values accepted by the endpoint, separated by commas (blank disables the picker)',
        value: 'low, medium, high',
        ignoreFocusOut: true
      });
      if (reasoningEfforts === undefined) return;
      await connection.setCredentials(agent, {
        openaiCompatible: {
          baseURL: baseURL.trim(),
          models,
          reasoningEfforts: reasoningEfforts.split(',').map((effort) => effort.trim()).filter(Boolean),
          apiKey: apiKey.trim()
        }
      });
    }
    // The agent reads its keys at start: one that runs restarts, and its chats attach to the fresh one.
    if (connection.agent(agent)?.running) await connection.restartAgent(agent);
    await this.workers.refresh(workerId);
    void vscode.window.showInformationMessage(`${name} credentials saved in the project.`);
  }

  /** The models to use: picked from those the endpoint lists, or typed when it lists none or the sandbox cannot ask. */
  private async chooseModels(
    connection: WorkerConnection,
    agent: AgentName,
    baseURL: string,
    apiKey: string
  ): Promise<(string | EndpointModel)[] | undefined> {
    let listed: EndpointModel[] = [];
    try {
      listed = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Listing the models of ${baseURL}…` },
        () => connection.endpointModels(agent, baseURL, apiKey)
      );
    } catch (error) {
      void vscode.window.showWarningMessage(`Could not list the models: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (listed.length) {
      const picked = await vscode.window.showQuickPick(
        listed.map((model) => ({
          label: model.id,
          description: [
            model.name,
            model.contextWindow && `${Math.round(model.contextWindow / 1024)}k context`,
            model.input?.includes('image') && 'image',
            model.reasoning && 'thinks'
          ]
            .filter(Boolean)
            .join(' · '),
          model
        })),
        { canPickMany: true, matchOnDescription: true, placeHolder: 'Models to use; those that do not think get no reasoning effort', ignoreFocusOut: true }
      );
      return picked?.map((item) => item.model);
    }
    const typed = await vscode.window.showInputBox({
      prompt: 'Model ids served by the endpoint, separated by commas',
      ignoreFocusOut: true,
      validateInput: (value) => (value.split(',').some((model) => model.trim()) ? undefined : 'Enter at least one model')
    });
    return typed?.split(',').map((model) => model.trim()).filter(Boolean);
  }
}
