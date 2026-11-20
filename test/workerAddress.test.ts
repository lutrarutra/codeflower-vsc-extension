import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkerAddress } from 'codeflower-ui/client/address.ts';
import { isWholeLine, movedAddress, parseSavedWorkers, serializeSavedWorkers, workerLine } from '../src/workerAddress.ts';

const fp = 'x'.repeat(43);
const current: WorkerAddress = { host: '10.0.0.1', port: 9092, token: 'a+b', url: 'wss://10.0.0.1:9092/acp', fingerprint: fp, display: '10.0.0.1:9092' };

test('a new host:port keeps the token and fingerprint', () => {
  const moved = movedAddress(current, ' node7.cluster:41234 ');
  assert.equal(moved.display, 'node7.cluster:41234');
  assert.equal(moved.token, 'a+b');
  assert.equal(moved.fingerprint, fp);
  assert.equal(moved.url, 'wss://node7.cluster:41234/acp');
});

test('a port alone keeps the host', () => {
  assert.equal(movedAddress(current, '5000').display, '10.0.0.1:5000');
  const ipv6: WorkerAddress = { host: '[::1]', port: 9092, token: 't', url: 'ws://[::1]:9092/acp', display: '[::1]:9092' };
  assert.equal(movedAddress(ipv6, '9093').display, '[::1]:9093');
  assert.equal(movedAddress(ipv6, '9093').url, 'ws://[::1]:9093/acp');
  assert.equal(movedAddress(current, '[::1]:9093').display, '[::1]:9093');
});

test('tells a whole line from host:port', () => {
  assert.equal(isWholeLine(' codeflower://10.0.0.2:1?token=new'), true);
  assert.equal(isWholeLine('wss://h:1/acp?token=x'), true);
  assert.equal(isWholeLine('node7:41234'), false);
});

test('rejects what is not an address', () => {
  assert.throws(() => movedAddress(current, ''));
  assert.throws(() => movedAddress(current, 'host'));
  assert.throws(() => movedAddress(current, 'host:0'));
  assert.throws(() => movedAddress(current, 'host:70000'));
  assert.throws(() => movedAddress(current, 'a/b:1'));
});

test('saves a moved worker with its id, others as bare lines', () => {
  const moved = movedAddress(current, '5000');
  const text = serializeSavedWorkers([
    { id: current.display, address: current },
    { id: current.display + '#2', address: moved }
  ]);
  const saved = JSON.parse(text);
  assert.equal(saved[0], workerLine(current));
  assert.deepEqual(saved[1], { id: '10.0.0.1:9092#2', line: workerLine(moved) });
  assert.deepEqual(parseSavedWorkers(text), [
    { line: workerLine(current) },
    { id: '10.0.0.1:9092#2', line: workerLine(moved) }
  ]);
});

test('reads older and damaged lists', () => {
  assert.deepEqual(parseSavedWorkers(undefined), []);
  assert.deepEqual(parseSavedWorkers('not json'), []);
  assert.deepEqual(parseSavedWorkers('{}'), []);
  assert.deepEqual(parseSavedWorkers(JSON.stringify([workerLine(current), { id: 1 }, null, 3])), [{ line: workerLine(current) }]);
});
