// A listed worker's address, as the user edits it, and the list as it is saved.
// Types only from codeflower-ui, so tests run it as it is.
import type { WorkerAddress } from 'codeflower-ui/client/address.ts';

/** The line a worker prints on start, for an address. */
export function workerLine(address: WorkerAddress): string {
  // The fingerprint stays with the line: a saved worker reconnects over TLS, pinned.
  const fingerprint = address.fingerprint ? `&fp=${address.fingerprint}` : '';
  return `codeflower://${address.display}?token=${encodeURIComponent(address.token)}${fingerprint}`;
}

/** Whether the user pasted a whole codeflower://… line rather than host:port. */
export function isWholeLine(text: string): boolean {
  const value = text.trim();
  return /^(?:codeflower|wss?):\/\//i.test(value) || value.includes('token=');
}

/**
 * `current` at the host:port (or only the port) the user typed. A sandbox
 * started again with `--continue` keeps its token and certificate, so only
 * those two change; a new sandbox needs its whole new line (`isWholeLine`).
 */
export function movedAddress(current: WorkerAddress, text: string): WorkerAddress {
  const value = text.trim();
  if (!value) throw new Error('Give the new host:port, or paste the whole codeflower://… line');
  const match = /^(?:(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_.-]+):)?(\d+)$/.exec(value);
  if (!match) throw new Error('Give host:port (e.g. 10.20.3.17:41234), or only the port');
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new Error('The port must be between 1 and 65535');
  // An IPv6 host keeps its brackets (as URL's hostname gives it).
  const host = (match[1] ?? current.host).toLowerCase();
  return {
    host,
    port,
    token: current.token,
    url: `${current.fingerprint ? 'wss' : 'ws'}://${host}:${port}/acp`,
    ...(current.fingerprint ? { fingerprint: current.fingerprint } : {}),
    display: `${host}:${port}`
  };
}

/** A saved worker: its line, and its id when that is not its address (it was moved). */
export interface SavedWorker {
  id?: string;
  line: string;
}

/** The saved list; entries of older versions are lines only. */
export function parseSavedWorkers(text: string | undefined): SavedWorker[] {
  let saved: unknown;
  try {
    saved = JSON.parse(text ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(saved)) return [];
  return saved.flatMap((item): SavedWorker[] => {
    if (typeof item === 'string') return [{ line: item }];
    const fields = item as { id?: unknown; line?: unknown } | null;
    return typeof fields?.id === 'string' && fields.id && typeof fields.line === 'string' ? [{ id: fields.id, line: fields.line }] : [];
  });
}

/** The list to save: a worker whose id is its address stays a bare line, which older versions read too. */
export function serializeSavedWorkers(workers: { id: string; address: WorkerAddress }[]): string {
  return JSON.stringify(
    workers.map((worker) => (worker.id === worker.address.display ? workerLine(worker.address) : { id: worker.id, line: workerLine(worker.address) }))
  );
}
