// In the Extension Development Host, connects to the worker that
// `make dev-worker` runs and follows it across restarts, so F5 needs no
// pasting. The bridge writes a connection file per start into
// <state>/instances; the newest one is the running worker.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { WorkerManager } from './workers.ts';

interface Instance {
  url: string;
  started_at: string;
}

async function newestInstance(directory: string): Promise<Instance | undefined> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.json'));
  } catch {
    return undefined;
  }
  const instances = await Promise.all(
    names.map(async (name) => {
      try {
        return JSON.parse(await readFile(join(directory, name), 'utf8')) as Instance;
      } catch {
        return undefined;
      }
    })
  );
  return instances
    .filter((instance): instance is Instance => typeof instance?.url === 'string')
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
}

export function followDevWorker(state: string, workers: WorkerManager): vscode.Disposable {
  const directory = join(state, 'instances');
  let connected: string | undefined;
  let pending = Promise.resolve();
  const sync = () => {
    pending = pending.then(async () => {
      const newest = await newestInstance(directory);
      if (!newest || newest.url === connected) return;
      connected = newest.url;
      // Not persisted: the dev worker's token changes on every start.
      await workers.add(newest.url, false).catch(() => undefined);
    });
  };
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(directory), '*.json')
  );
  watcher.onDidCreate(sync);
  watcher.onDidChange(sync);
  sync();
  return watcher;
}
