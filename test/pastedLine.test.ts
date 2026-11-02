import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pastedLine } from '../src/pastedLine.ts';

const line = `codeflower://127.0.0.1:9092?token=a%2Bb&fp=${'x'.repeat(43)}`;

test('takes the line out of a pasted vscode:// link', () => {
  const link = `vscode://codeflower.codeflower/connect?address=${encodeURIComponent(line)}`;
  assert.equal(pastedLine(link), line);
  assert.equal(pastedLine(`  ${link}\n`), line);
});

test('leaves a pasted line as it is', () => {
  assert.equal(pastedLine(line), line);
  assert.equal(pastedLine('worker ready: nothing'), 'worker ready: nothing');
});
