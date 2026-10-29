// Sign-in through the client: the agent's own flows run inside the sandbox
// and store their login there. code flower only relays what the user types.
import type { AuthMethod } from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import type { UrlElicitation } from './workerConnection.ts';
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

  async elicitUrl(request: UrlElicitation): Promise<'accept' | 'decline'> {
    const choice = await vscode.window.showInformationMessage(request.message, { modal: false }, 'Open link', 'Cancel');
    if (choice !== 'Open link') return 'decline';
    await vscode.env.openExternal(vscode.Uri.parse(request.url));
    return 'accept';
  }

  // ---- flows ----

  async run(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    const connection = this.workers.require(workerId);
    const status = worker?.status ?? (await connection.status());
    if (status.credentials === 'keys') {
      await this.setKeys(workerId);
      return;
    }

    const methods = connection.authMethods;
    if (methods.length === 0) {
      void vscode.window.showWarningMessage(`${status.agentLabel} offers no sign-in methods to code flower.`);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      methods.map((method) => ({
        label: method.name,
        detail: method.description ?? undefined,
        method
      })),
      { placeHolder: `Sign in to ${status.agentLabel}`, ignoreFocusOut: true }
    );
    if (!picked) return;
    const method = picked.method;

    if (isTerminalMethod(method)) {
      this.openTerminal(workerId, method);
      return;
    }
    let meta: Record<string, unknown> | undefined;
    if (isApiKeyMethod(method)) {
      const apiKey = await vscode.window.showInputBox({
        prompt: `${status.agentLabel}: API key`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : 'The key cannot be empty')
      });
      if (!apiKey) return;
      meta = { 'api-key': { apiKey: apiKey.trim() } };
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Signing in to ${status.agentLabel}…`, cancellable: false },
      () => connection.authenticate(method.id, meta)
    );
    await this.workers.refresh(workerId);
    void vscode.window.showInformationMessage(`Signed in to ${status.agentLabel}.`);
  }

  private openTerminal(workerId: string, method: AuthMethod): void {
    const connection = this.workers.require(workerId);
    const pty = new SignInTerminal({
      start: (columns, rows) => connection.startTerminal(method.id, columns, rows),
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

  private async setKeys(workerId: string): Promise<void> {
    const connection = this.workers.require(workerId);
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'DeepSeek API key', id: 'deepseek' as const },
        { label: 'OpenAI-compatible endpoint', detail: 'OpenRouter, vLLM on the cluster, …', id: 'compatible' as const }
      ],
      { placeHolder: 'Which credentials should DeepSeek Harness use?', ignoreFocusOut: true }
    );
    if (!choice) return;
    if (choice.id === 'deepseek') {
      const key = await vscode.window.showInputBox({ prompt: 'DeepSeek API key', password: true, ignoreFocusOut: true });
      if (!key?.trim()) return;
      await connection.setCredentials({ deepseekApiKey: key.trim() });
    } else {
      const baseURL = await vscode.window.showInputBox({
        prompt: 'Base URL of the OpenAI-compatible API',
        placeHolder: 'https://openrouter.ai/api/v1',
        ignoreFocusOut: true,
        validateInput: (value) => (/^https?:\/\/\S+$/.test(value.trim()) ? undefined : 'Enter an http(s) URL')
      });
      if (!baseURL) return;
      const models = await vscode.window.showInputBox({
        prompt: 'Model ids served by the endpoint, separated by commas',
        ignoreFocusOut: true,
        validateInput: (value) => (value.split(',').some((model) => model.trim()) ? undefined : 'Enter at least one model')
      });
      if (!models) return;
      const apiKey = await vscode.window.showInputBox({ prompt: 'API key for the endpoint', password: true, ignoreFocusOut: true });
      if (!apiKey?.trim()) return;
      await connection.setCredentials({
        openaiCompatible: {
          baseURL: baseURL.trim(),
          models: models.split(',').map((model) => model.trim()).filter(Boolean),
          apiKey: apiKey.trim()
        }
      });
    }
    // The agent reads its keys at start: restart it, then connect to the fresh one.
    await connection.restartAgent();
    await this.workers.reconnect(workerId);
    void vscode.window.showInformationMessage('DeepSeek Harness credentials saved in the project.');
  }
}
