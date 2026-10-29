import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkerAddress } from '../src/address.ts';

test('parses the printed line, even with surrounding text', () => {
  const address = parseWorkerAddress(
    'code flower worker ready. Paste:\n  codeflower://10.20.3.17:41234?token=abc%2Fdef \n'
  );
  assert.deepEqual(address, {
    host: '10.20.3.17',
    port: 41234,
    token: 'abc/def',
    url: 'ws://10.20.3.17:41234/acp',
    display: '10.20.3.17:41234'
  });
});

test('accepts host names and IPv6 addresses', () => {
  assert.equal(parseWorkerAddress('codeflower://node12.cluster:5000?token=t').url, 'ws://node12.cluster:5000/acp');
  assert.equal(parseWorkerAddress('codeflower://[fe80::1]:5000?token=t').host, '[fe80::1]');
});

test('rejects incomplete addresses', () => {
  assert.throws(() => parseWorkerAddress('10.20.3.17:41234'), /Paste the codeflower/);
  assert.throws(() => parseWorkerAddress('codeflower://10.20.3.17:41234'), /no token/);
  assert.throws(() => parseWorkerAddress('codeflower://10.20.3.17?token=t'), /no port/);
});
