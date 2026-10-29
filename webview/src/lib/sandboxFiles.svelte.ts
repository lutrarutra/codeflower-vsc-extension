// Files from the sandbox that the chat shows, e.g. figures the agent looked at.
// Fetched through the host once per key (a file as one tool call saw it, since the
// agent may rewrite it later); undefined while loading, null if unavailable.
import { send } from './vscode.ts';

const urls = $state<Record<string, string | null>>({});
const requested = new Set<string>();

export function fileUrl(path: string, key: string): string | null | undefined {
  if (!requested.has(key)) {
    requested.add(key);
    send({ type: 'fileData', path, key });
  }
  return urls[key];
}

export function receivedFile(key: string, dataUrl: string | null): void {
  urls[key] = dataUrl;
}
