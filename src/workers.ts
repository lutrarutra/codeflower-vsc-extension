import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import type { PendingPermission, PendingQuestion, TranscriptEntry } from '../shared/messages.ts';
import { parseWorkerAddress, type WorkerAddress } from './address.ts';
import {
  TAKEN_OVER,
  WorkerConnection,
  type SessionRecord,
  type ShowRequest,
  type UrlElicitation,
  type WorkerStatus
} from './workerConnection.ts';

const WORKERS_SECRET = 'codeflower.workers';
const POLL_MS = 10_000;

export interface WorkerEntry {
  /** host:port; unique per worker. */
  id: string;
  address: WorkerAddress;
  state: 'connecting' | 'connected' | 'disconnected';
  connection?: WorkerConnection;
  status?: WorkerStatus;
  sessions: SessionRecord[];
  error?: string;
  /** Another window took the worker over; it is not reconnected until the user asks. */
  takenOver?: boolean;
}

/** Receives what a worker's agent sends, tagged with the worker. */
export interface WorkerRouter {
  entry(workerId: string, sessionKey: string, entry: TranscriptEntry): void;
  permission(workerId: string, sessionKey: string, request: PendingPermission | null): void;
  question(workerId: string, sessionKey: string, request: PendingQuestion | null): void;
  busy(workerId: string, sessionKey: string, busy: boolean): void;
  config(workerId: string, sessionKey: string, options: SessionConfigOption[]): void;
  elicitUrl(workerId: string, request: UrlElicitation): Promise<'accept' | 'decline'>;
  elicitationComplete(workerId: string, elicitationId: string): void;
  show(workerId: string, request: ShowRequest): void;
  terminalOutput(terminalId: string, data: string): void;
  terminalExit(terminalId: string, exitCode: number): void;
  /** Connected (again): open chats attach to the worker's agent. */
  connected(workerId: string): Promise<void>;
  disconnected(workerId: string, code: number): void;
}

function serialize(address: WorkerAddress): string {
  return `codeflower://${address.display}?token=${encodeURIComponent(address.token)}`;
}

export class WorkerManager implements vscode.Disposable {
  readonly workers = new Map<string, WorkerEntry>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly context: vscode.ExtensionContext;
  private readonly router: WorkerRouter;
  private readonly poll: ReturnType<typeof setInterval>;
  private polling = false;

  constructor(context: vscode.ExtensionContext, router: WorkerRouter) {
    this.context = context;
    this.router = router;
    this.poll = setInterval(() => void this.refreshAll(), POLL_MS);
  }

  dispose(): void {
    clearInterval(this.poll);
    for (const worker of this.workers.values()) worker.connection?.close();
    this.changed.dispose();
  }

  get(id: string): WorkerEntry | undefined {
    return this.workers.get(id);
  }

  require(id: string): WorkerConnection {
    const connection = this.workers.get(id)?.connection;
    if (!connection?.connected) throw new Error('The worker is not connected');
    return connection;
  }

  /** Reconnects to the workers of the last VS Code session. */
  async restore(): Promise<void> {
    let saved: string[] = [];
    try {
      saved = JSON.parse((await this.context.secrets.get(WORKERS_SECRET)) ?? '[]') as string[];
    } catch {
      saved = [];
    }
    await Promise.all(
      saved.map(async (text) => {
        try {
          await this.add(text, false);
        } catch {
          // Unreachable workers stay listed as disconnected until removed.
        }
      })
    );
  }

  async add(text: string, persist = true): Promise<WorkerEntry> {
    const address = parseWorkerAddress(text);
    const existing = this.workers.get(address.display);
    existing?.connection?.close();
    const entry: WorkerEntry = { id: address.display, address, state: 'connecting', sessions: [] };
    this.workers.set(entry.id, entry);
    this.changed.fire();
    if (persist) await this.save();
    await this.connect(entry);
    return entry;
  }

  async remove(id: string): Promise<void> {
    const entry = this.workers.get(id);
    if (!entry) return;
    this.workers.delete(id);
    entry.connection?.close();
    await this.save();
    this.changed.fire();
  }

  /** Connects again, e.g. to take the worker back from another window. */
  async reconnect(id: string): Promise<void> {
    const entry = this.workers.get(id);
    if (!entry) return;
    entry.takenOver = false;
    const previous = entry.connection;
    entry.connection = undefined;
    previous?.close();
    await this.connect(entry, true);
  }

  async refresh(id: string): Promise<void> {
    const entry = this.workers.get(id);
    if (!entry?.connection?.connected) return;
    try {
      const [status, sessions] = await Promise.all([entry.connection.status(), entry.connection.listSessions()]);
      entry.status = status;
      entry.sessions = sessions;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
    this.changed.fire();
  }

  async refreshAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await Promise.all(
        [...this.workers.values()].map((entry) =>
          entry.state !== 'disconnected'
            ? this.refresh(entry.id)
            : entry.takenOver
              ? undefined
              : this.connect(entry).catch(() => undefined)
        )
      );
    } finally {
      this.polling = false;
    }
  }

  private async save(): Promise<void> {
    await this.context.secrets.store(
      WORKERS_SECRET,
      JSON.stringify([...this.workers.values()].map((entry) => serialize(entry.address)))
    );
  }

  private async connect(entry: WorkerEntry, retry = false): Promise<void> {
    entry.state = 'connecting';
    entry.error = undefined;
    this.changed.fire();
    const deadline = Date.now() + (retry ? 5_000 : 0);
    for (;;) {
      try {
        const connection = await WorkerConnection.connect(
          entry.address,
          {
            entry: (key, item) => this.router.entry(entry.id, key, item),
            permission: (key, request) => this.router.permission(entry.id, key, request),
            question: (key, request) => this.router.question(entry.id, key, request),
            busy: (key, busy) => this.router.busy(entry.id, key, busy),
            config: (key, options) => this.router.config(entry.id, key, options),
            elicitUrl: (request) => this.router.elicitUrl(entry.id, request),
            elicitationComplete: (elicitationId) => this.router.elicitationComplete(entry.id, elicitationId),
            show: (request) => this.router.show(entry.id, request),
            terminalOutput: (terminalId, data) => this.router.terminalOutput(terminalId, data),
            terminalExit: (terminalId, exitCode) => this.router.terminalExit(terminalId, exitCode),
            closed: (reason, code) => {
              if (entry.connection !== connection) return;
              entry.connection = undefined;
              entry.state = 'disconnected';
              entry.error = reason;
              entry.takenOver = code === TAKEN_OVER;
              this.router.disconnected(entry.id, code);
              this.changed.fire();
            }
          },
          String(this.context.extension.packageJSON.version ?? '0.0.0')
        );
        entry.connection = connection;
        entry.state = 'connected';
        entry.takenOver = false;
        await this.refresh(entry.id);
        await this.router.connected(entry.id);
        return;
      } catch (error) {
        // Right after a restart of the agent, the worker may still be starting a fresh one.
        if (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        entry.state = 'disconnected';
        entry.error = error instanceof Error ? error.message : String(error);
        this.changed.fire();
        throw error;
      }
    }
  }
}
