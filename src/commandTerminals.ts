// A command an agent runs, watched read-only in a VS Code terminal: what it
// printed so far, then the rest as it comes. Nothing typed reaches it, and
// closing the terminal only stops watching it; the agent stops its commands.
import * as vscode from 'vscode';
import { commandTitle, type AgentCommand } from 'codeflower-ui/protocol/commands.ts';
import type { WorkerManager } from './workers.ts';

/** A command's output has bare line feeds, which a terminal takes as a move down only. */
const crlf = (data: string) => data.replace(/\r?\n/g, '\r\n');

class CommandTerminal implements vscode.Pseudoterminal {
  private readonly written = new vscode.EventEmitter<string>();
  private readonly closed = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.written.event;
  readonly onDidClose = this.closed.event;
  ended = false;

  private readonly command: AgentCommand;
  private readonly attach: (columns: number, rows: number) => Promise<void>;
  private readonly detach: () => Promise<void>;
  private readonly gone: () => void;

  constructor(
    command: AgentCommand,
    attach: (columns: number, rows: number) => Promise<void>,
    detach: () => Promise<void>,
    gone: () => void
  ) {
    this.command = command;
    this.attach = attach;
    this.detach = detach;
    this.gone = gone;
  }

  private header(): string {
    return `\x1b[2mWatching (read-only): ${crlf(this.command.command)}\x1b[0m\r\n\r\n`;
  }

  open(dimensions: vscode.TerminalDimensions | undefined): void {
    this.written.fire(this.header());
    this.attach(dimensions?.columns ?? 100, dimensions?.rows ?? 30).catch((error: unknown) => {
      this.ended = true;
      this.written.fire(`\r\n\x1b[2mThe command cannot be shown: ${error instanceof Error ? error.message : error}\x1b[0m\r\n`);
    });
  }

  output(data: string, replayed: boolean): void {
    // What it printed so far, again after a reconnect: it replaces what the terminal shows.
    if (replayed) this.written.fire(`\x1bc${this.header()}`);
    this.written.fire(crlf(data));
  }

  exit(exitCode: number | null): void {
    this.ended = true;
    this.written.fire(`\r\n\x1b[2mThe command ended${exitCode ? ` with code ${exitCode}` : ''}.\x1b[0m\r\n`);
  }

  handleInput(): void {}

  close(): void {
    if (!this.ended) void this.detach().catch(() => undefined);
    this.gone();
  }
}

/** The command terminals open in this window, by the command's id. */
export class CommandTerminals {
  private readonly open = new Map<string, { terminal: vscode.Terminal; view: CommandTerminal }>();

  private readonly workers: WorkerManager;

  constructor(workers: WorkerManager) {
    this.workers = workers;
  }

  has(commandId: string): boolean {
    return this.open.has(commandId);
  }

  /** Shows the command's terminal, opening it if it is not yet. */
  show(workerId: string, command: AgentCommand, agentName: string): void {
    const existing = this.open.get(command.commandId);
    if (existing) {
      existing.terminal.show();
      return;
    }
    const view = new CommandTerminal(
      command,
      (columns, rows) => this.workers.require(workerId).attachTerminal(command.commandId, columns, rows),
      () => this.workers.require(workerId).detachTerminal(command.commandId),
      () => this.open.delete(command.commandId)
    );
    const terminal = vscode.window.createTerminal({
      name: `${agentName}: ${commandTitle(command, 40)}`,
      pty: view,
      iconPath: new vscode.ThemeIcon('eye')
    });
    this.open.set(command.commandId, { terminal, view });
    terminal.show();
  }

  output(commandId: string, data: string, replayed: boolean): void {
    this.open.get(commandId)?.view.output(data, replayed);
  }

  exit(commandId: string, exitCode: number | null): void {
    this.open.get(commandId)?.view.exit(exitCode);
  }
}
