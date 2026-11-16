import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTabState, restoreStatus, scriptJson } from '../src/tabState.ts';

const WORKER = '127.0.0.1:7710';

test('each kind of tab comes back as it was kept', () => {
  const tabs = [
    { view: 'chat', workerId: WORKER, key: 'claude:abc', title: 'Cluster the cells' },
    { view: 'preview', workerId: WORKER, path: '/data/output/umap.png', title: 'umap.png', chatKey: 'claude:abc' },
    { view: 'preview', workerId: WORKER, path: '/data/output/report.html', title: 'report.html', interactive: true },
    { view: 'report', workerId: WORKER, path: '/data/output/report.html', title: 'report.html' },
    { view: 'browser', workerId: WORKER, key: 'claude:abc' },
    { view: 'plugins', workerId: WORKER, agent: 'claude' }
  ] as const;
  for (const tab of tabs) assert.deepEqual(parseTabState(tab.view, JSON.parse(JSON.stringify(tab))), tab);
});

test("a subagent's chat keeps its subagent", () => {
  const subagent = { key: 'claude:sub', parentKey: 'claude:abc', sessionId: 's', state: 'running' };
  const tab = { view: 'chat', workerId: WORKER, key: 'claude:sub', title: 'Explore', subagent };
  assert.deepEqual(parseTabState('chat', tab), tab);
  assert.equal(parseTabState('chat', { ...tab, subagent: { key: 'claude:sub' } }), undefined);
});

test('state of another kind, or of a tab from before tabs were restored, is no tab', () => {
  assert.equal(parseTabState('chat', undefined), undefined);
  assert.equal(parseTabState('chat', null), undefined);
  assert.equal(parseTabState('chat', 'claude:abc'), undefined);
  assert.equal(parseTabState('chat', { view: 'preview', workerId: WORKER, path: '/x', title: 'x' }), undefined);
  assert.equal(parseTabState('chat', { view: 'chat', key: 'claude:abc', title: '' }), undefined);
  assert.equal(parseTabState('preview', { view: 'preview', workerId: WORKER, path: '', title: 'x' }), undefined);
  assert.equal(parseTabState('preview', { view: 'preview', workerId: WORKER, path: '/x', title: 'x', chatKey: 3 }), undefined);
  assert.equal(parseTabState('plugins', { view: 'plugins', workerId: WORKER }), undefined);
});

test('fields a tab does not keep are dropped', () => {
  assert.deepEqual(parseTabState('browser', { view: 'browser', workerId: WORKER, key: 'k', extra: 1 }), {
    view: 'browser',
    workerId: WORKER,
    key: 'k'
  });
});

test('script JSON cannot close its element', () => {
  const json = scriptJson({ title: '</script><b>&' });
  assert.doesNotMatch(json, /[<>&]/);
  assert.deepEqual(JSON.parse(json), { title: '</script><b>&' });
});

test('a restored tab shows once its worker is connected', () => {
  assert.equal(restoreStatus(WORKER, { state: 'connected', connection: { connected: true } }, true), 'ready');
  assert.deepEqual(restoreStatus(WORKER, { state: 'connecting' }, true), { kind: 'connecting', workerId: WORKER });
  // Connected, but its connection is closing.
  assert.deepEqual(restoreStatus(WORKER, { state: 'connected', connection: { connected: false } }, true), {
    kind: 'connecting',
    workerId: WORKER
  });
});

test('a missing worker may still come while the saved workers load', () => {
  assert.deepEqual(restoreStatus(WORKER, undefined, false), { kind: 'connecting', workerId: WORKER });
  assert.deepEqual(restoreStatus(WORKER, undefined, true), { kind: 'unknown', workerId: WORKER });
});

test('an unreachable worker is retried by itself, unless another window took it over', () => {
  assert.deepEqual(restoreStatus(WORKER, { state: 'disconnected', error: 'ECONNREFUSED' }, true), {
    kind: 'unreachable',
    workerId: WORKER,
    retrying: true,
    error: 'ECONNREFUSED'
  });
  assert.deepEqual(restoreStatus(WORKER, { state: 'disconnected', takenOver: true }, true), {
    kind: 'unreachable',
    workerId: WORKER,
    retrying: false
  });
});
