import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkerStatus } from 'codeflower-ui/client/workerConnection.ts';
import { pathContext } from '../src/paths.ts';

test('marks the files and folders that have a host path', () => {
  const status = {
    stateDirectory: '/Users/ana/codeflower/projects/p',
    mounts: [{ target: '/data/input/study42', source: '/gpfs/ana/study42', readOnly: true }]
  } as WorkerStatus;
  assert.equal(pathContext('file', status, '/codeflower-state/workspace/a.txt'), 'file.host');
  assert.equal(pathContext('folder', status, '/data/input/study42'), 'folder.host');
  assert.equal(pathContext('folder', status, '/codeflower-state/cache/uv'), 'folder');
  // An older worker reports no mounts: its folders have none.
  assert.equal(pathContext('file', undefined, '/inputs/a.csv'), 'file');
});
