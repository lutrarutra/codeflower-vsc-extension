import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workerLinks } from '../src/terminalLinks.ts';

test('a worker line is one link, token and fingerprint included', () => {
  const line = '  VS Code (paste)  codeflower://127.0.0.1:4100?token=abc%2Bdef&fp=xyz';
  assert.deepEqual(workerLinks(line), [
    { startIndex: 19, length: 50, address: 'codeflower://127.0.0.1:4100?token=abc%2Bdef&fp=xyz' }
  ]);
});

test('a connect link connects with the line it carries', () => {
  const link = 'vscode://codeflower.codeflower/connect?address=codeflower%3A%2F%2F10.0.0.5%3A4100%3Ftoken%3Dabc';
  assert.deepEqual(workerLinks(`  VS Code  ${link}`), [
    { startIndex: 11, length: link.length, address: 'codeflower://10.0.0.5:4100?token=abc' }
  ]);
});

test('other links are left to VS Code', () => {
  assert.deepEqual(workerLinks('  http://127.0.0.1:7720/#add=codeflower%3A%2F%2Fx vscode://other.ext/connect?address=y'), []);
  assert.deepEqual(workerLinks('vscode://codeflower.codeflower/connect?address=nothing'), []);
});
