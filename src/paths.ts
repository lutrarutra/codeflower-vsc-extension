import { hostPath } from 'codeflower-ui/client/hostPaths.ts';
import type { WorkerStatus } from 'codeflower-ui/client/workerConnection.ts';

/**
 * The context of a file or folder in the tree, which its menu follows:
 * `file` or `folder`, and `.host` when it is in a folder from the machine
 * that runs the sandbox, so it has a host path to copy.
 */
export function pathContext(kind: 'file' | 'folder', status: WorkerStatus | undefined, path: string): string {
  return hostPath(status, path) ? `${kind}.host` : kind;
}
