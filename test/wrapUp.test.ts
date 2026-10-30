import assert from 'node:assert/strict';
import test from 'node:test';
import { wrapUpMessage } from '../src/workerConnection.ts';

test('says the client is quitting and how long it waits', () => {
  assert.equal(
    wrapUpMessage('Claude Code', 'abc', { reason: 'quit', minutes: 10, chats: 2 }),
    'Claude Code on abc: the code flower client that started it is quitting. Its 2 working chats were stopped and asked to save their work and write up where they are. The sandbox stops when they are done, at most in 10 minutes.'
  );
});

test('says when the job ends, also for bridges that send no reason', () => {
  const end = new Date(2026, 9, 30, 17, 45).toISOString();
  const time = new Date(end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  for (const reason of ['time', undefined] as const) {
    assert.equal(
      wrapUpMessage('Codex', 'w1', { reason, end, minutes: 15, chats: 0 }),
      `Codex on w1: the job ends at ${time}, in about 15 minutes, and the sandbox stops with it. No chat was working.`
    );
  }
});
