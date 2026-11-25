// What a code flower tab is, kept in its webview's state (`setState`) so VS
// Code can hand it back when it restores the tab after a reload or restart,
// and what a restored tab shows while its sandbox cannot be reached yet.
import type { SubagentSummary } from 'codeflower-ui/protocol/subagents.ts';

export type TabState =
  | { view: 'chat'; workerId: string; key: string; title: string; subagent?: SubagentSummary }
  /** `interactive`: an HTML report shows with its scripts running. */
  | { view: 'preview'; workerId: string; path: string; title: string; chatKey?: string; interactive?: boolean }
  /** An interactive report's own tab, from before reports ran in their preview tab. */
  | { view: 'report'; workerId: string; path: string; title: string; chatKey?: string }
  | { view: 'browser'; workerId: string; key: string }
  | { view: 'plugins'; workerId: string; agent: string }
  /** A sandbox's map of ideas. */
  | { view: 'roots'; workerId: string };

export type TabView = TabState['view'];

type Fields = Record<string, unknown>;

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isOptionalText = (value: unknown): boolean => value === undefined || typeof value === 'string';

function isSubagent(value: unknown): value is SubagentSummary {
  const fields = value as Fields | null;
  return typeof fields === 'object' && fields !== null && isText(fields.key) && isText(fields.parentKey) && isText(fields.state);
}

/**
 * The tab a restored webview was, if its state is one this version wrote for
 * that kind of tab; tabs from before tabs were restored have none.
 */
export function parseTabState(view: TabView, state: unknown): TabState | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const fields = state as Fields;
  if (fields.view !== view || !isText(fields.workerId)) return undefined;
  const workerId = fields.workerId;
  switch (view) {
    case 'chat':
      if (!isText(fields.key) || typeof fields.title !== 'string') return undefined;
      if (fields.subagent !== undefined && !isSubagent(fields.subagent)) return undefined;
      return {
        view,
        workerId,
        key: fields.key,
        title: fields.title,
        ...(fields.subagent ? { subagent: fields.subagent as SubagentSummary } : {})
      };
    case 'preview':
    case 'report':
      if (!isText(fields.path) || typeof fields.title !== 'string' || !isOptionalText(fields.chatKey)) return undefined;
      return {
        view,
        workerId,
        path: fields.path,
        title: fields.title,
        ...(isText(fields.chatKey) ? { chatKey: fields.chatKey } : {}),
        ...(view === 'preview' && fields.interactive === true ? { interactive: true } : {})
      };
    case 'browser':
      return isText(fields.key) ? { view, workerId, key: fields.key } : undefined;
    case 'plugins':
      return isText(fields.agent) ? { view, workerId, agent: fields.agent } : undefined;
    case 'roots':
      return { view, workerId };
  }
}

/** JSON that is safe inside an HTML `<script>` element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/** What a restored tab shows in place of its view (the view `restore`). */
export type RestoreStatus =
  /** The worker is being connected, or the saved workers are still loading. */
  | { kind: 'connecting'; workerId: string }
  /** The worker is listed but cannot be reached; `retrying` while it is tried again by itself. */
  | { kind: 'unreachable'; workerId: string; error?: string; retrying: boolean }
  /** The worker is no longer listed: it must be connected again. */
  | { kind: 'unknown'; workerId: string }
  /** What the tab showed is gone, e.g. the file was deleted. */
  | { kind: 'gone'; workerId: string; title: string; detail: string }
  /** Restoring the tab failed. */
  | { kind: 'error'; workerId: string; error: string };

/** A worker as the restore logic sees it (workers.ts's WorkerEntry). */
export interface RestoreWorker {
  state: 'connecting' | 'connected' | 'disconnected';
  connection?: { connected: boolean };
  error?: string;
  takenOver?: boolean;
}

/**
 * Whether a restored tab of the worker can show its view (`ready`), or what it
 * shows meanwhile. `settled`: the saved workers have been loaded, so a worker
 * missing now is not coming back by itself.
 */
export function restoreStatus(workerId: string, worker: RestoreWorker | undefined, settled: boolean): RestoreStatus | 'ready' {
  if (!worker) return settled ? { kind: 'unknown', workerId } : { kind: 'connecting', workerId };
  if (worker.state === 'connected' && worker.connection?.connected) return 'ready';
  if (worker.state === 'disconnected') {
    return { kind: 'unreachable', workerId, retrying: !worker.takenOver, ...(worker.error ? { error: worker.error } : {}) };
  }
  return { kind: 'connecting', workerId };
}
