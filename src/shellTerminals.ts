// The user's shells in a sandbox, from a chat's terminal button: VS Code
// terminals in its panel at the foot of the window, where the user can drag
// them into the editor area like any terminal. What is typed goes to the
// shell; closing the terminal ends the shell, as closing its tab does in the
// app's page.
import * as vscode from 'vscode';
import type { WorkerManager } from './workers.ts';

class ShellTerminal implements vscode.Pseudoterminal {
  private readonly written = new vscode.EventEmitter<string>();
  private readonly closed = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.written.event;
  readonly onDidClose = this.closed.event;
  /** Its id in the sandbox, once it started. */
  terminalId: string | undefined;
  private ended = false;
  /** Typed before the shell started. */
  private pending = '';

  private readonly start: (columns: number, rows: number) => Promise<string>;
  private readonly attach: (terminalId: string, columns: number, rows: number) => Promise<void>;
  private readonly input: (terminalId: string, data: string) => Promise<void>;
  private readonly resize: (terminalId: string, columns: number, rows: number) => Promise<void>;
  private readonly end: (terminalId: string) => Promise<void>;
  private readonly started: (shell: ShellTerminal) => void;
  private readonly gone: (shell: ShellTerminal) => void;

  constructor(options: {
    start: (columns: number, rows: number) => Promise<string>;
    attach: (terminalId: string, columns: number, rows: number) => Promise<void>;
    input: (terminalId: string, data: string) => Promise<void>;
    resize: (terminalId: string, columns: number, rows: number) => Promise<void>;
    end: (terminalId: string) => Promise<void>;
    started: (shell: ShellTerminal) => void;
    gone: (shell: ShellTerminal) => void;
  }) {
    this.start = options.start;
    this.attach = options.attach;
    this.input = options.input;
    this.resize = options.resize;
    this.end = options.end;
    this.started = options.started;
    this.gone = options.gone;
  }

  open(dimensions: vscode.TerminalDimensions | undefined): void {
    const columns = dimensions?.columns ?? 100;
    const rows = dimensions?.rows ?? 30;
    this.start(columns, rows).then(
      async (terminalId) => {
        this.terminalId = terminalId;
        this.started(this);
        // As the page's terminal tab does: shown here, with what it printed so far.
        await this.attach(terminalId, columns, rows).catch(() => undefined);
        if (this.pending) void this.input(terminalId, this.pending).catch(() => undefined);
        this.pending = '';
      },
      (error: unknown) => {
        this.ended = true;
        this.written.fire(`\x1b[2mThe terminal cannot start: ${error instanceof Error ? error.message : error}\x1b[0m\r\n`);
      }
    );
  }

  /** `replayed`: what it printed so far, which replaces what the terminal shows. */
  output(data: string, replayed: boolean): void {
    this.written.fire(replayed ? `\x1bc${data}` : data);
  }

  exit(exitCode: number): void {
    this.ended = true;
    this.closed.fire(exitCode);
  }

  handleInput(data: string): void {
    if (this.ended) return;
    if (!this.terminalId) this.pending += data;
    else void this.input(this.terminalId, data).catch(() => undefined);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    if (this.terminalId && !this.ended) void this.resize(this.terminalId, dimensions.columns, dimensions.rows).catch(() => undefined);
  }

  close(): void {
    if (this.terminalId && !this.ended) void this.end(this.terminalId).catch(() => undefined);
    this.ended = true;
    this.gone(this);
  }
}

/** The shells open in this window, by their id in the sandbox. */
export class ShellTerminals {
  private readonly open = new Map<string, ShellTerminal>();
  private readonly workers: WorkerManager;

  constructor(workers: WorkerManager) {
    this.workers = workers;
  }

  has(terminalId: string): boolean {
    return this.open.has(terminalId);
  }

  /** Starts a shell in the sandbox's workspace, in a terminal in VS Code's panel. */
  show(workerId: string, sandboxName: string): void {
    const connection = () => this.workers.require(workerId);
    const shell = new ShellTerminal({
      start: (columns, rows) => connection().startShell(columns, rows),
      attach: (terminalId, columns, rows) => connection().attachTerminal(terminalId, columns, rows),
      input: (terminalId, data) => connection().terminalInput(terminalId, data),
      resize: (terminalId, columns, rows) => connection().resizeTerminal(terminalId, columns, rows),
      end: (terminalId) => connection().closeTerminal(terminalId),
      started: (started) => this.open.set(started.terminalId!, started),
      gone: (ended) => {
        if (ended.terminalId) this.open.delete(ended.terminalId);
      }
    });
    vscode.window
      .createTerminal({ name: `shell · ${sandboxName}`, pty: shell, iconPath: new vscode.ThemeIcon('terminal'), location: vscode.TerminalLocation.Panel })
      .show();
  }

  output(terminalId: string, data: string, replayed: boolean): void {
    this.open.get(terminalId)?.output(data, replayed);
  }

  exit(terminalId: string, exitCode: number): void {
    this.open.get(terminalId)?.exit(exitCode);
    this.open.delete(terminalId);
  }
}
