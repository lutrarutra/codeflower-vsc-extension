import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { X509Certificate } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { certificateFingerprint, wsTransport } from '../src/wsTransport.ts';

const fixtures = new URL('./fixtures/', import.meta.url);

/** A worker serving TLS with the test certificate; counts the upgrade requests (with their token) it saw. */
async function tlsWorker(t: test.TestContext) {
  const cert = await readFile(new URL('tls-cert.pem', fixtures), 'utf8');
  const key = await readFile(new URL('tls-key.pem', fixtures), 'utf8');
  const server = createServer({ cert, key });
  const sockets = new WebSocketServer({ server });
  const tokens: string[] = [];
  sockets.on('connection', (socket, request) => {
    tokens.push(String(request.headers.authorization));
    socket.on('message', (data) => socket.send(`echo:${data}`));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    sockets.close();
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return { port, tokens, fingerprint: certificateFingerprint(new X509Certificate(cert).raw) };
}

test('talks to a worker whose certificate has the fingerprint in its line', async (t) => {
  const worker = await tlsWorker(t);
  const transport = await wsTransport({
    host: '127.0.0.1',
    port: worker.port,
    token: 'the-token',
    url: `wss://127.0.0.1:${worker.port}/acp`,
    fingerprint: worker.fingerprint,
    display: ''
  });
  const answer = new Promise<string>((resolve) => transport.onMessage(resolve));
  transport.send('hello');
  assert.equal(await answer, 'echo:hello');
  assert.deepEqual(worker.tokens, ['Bearer the-token']);
  transport.close();
});

test('refuses a worker with another certificate before sending the token', async (t) => {
  const worker = await tlsWorker(t);
  await assert.rejects(
    wsTransport({
      host: '127.0.0.1',
      port: worker.port,
      token: 'the-token',
      url: `wss://127.0.0.1:${worker.port}/acp`,
      fingerprint: 'A'.repeat(43),
      display: ''
    }),
    /does not match/
  );
  assert.deepEqual(worker.tokens, []);
});
