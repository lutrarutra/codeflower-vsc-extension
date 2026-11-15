import assert from 'node:assert/strict';
import test from 'node:test';
import { servePrintCopy } from '../src/printCopy.ts';

test('serves the printable copy at its secret path only, sandboxed and off the network', async () => {
  const copy = await servePrintCopy('<html><head></head><body><p>report</p></body></html>');
  try {
    const url = new URL(copy.url);
    assert.equal(url.hostname, '127.0.0.1');
    assert.match(url.pathname, /^\/[0-9a-f]{48}$/);
    const response = await fetch(copy.url);
    assert.equal(response.status, 200);
    const policy = response.headers.get('content-security-policy') ?? '';
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /sandbox allow-scripts allow-modals$/);
    assert.doesNotMatch(policy, /allow-same-origin/);
    assert.match(await response.text(), /<p>report<\/p><script>addEventListener\('load'/);
    assert.equal((await fetch(new URL('/', copy.url))).status, 404);
    assert.equal((await fetch(`${copy.url}x`)).status, 404);
  } finally {
    copy.close();
  }
});

test('stops serving the copy after a while', async () => {
  const copy = await servePrintCopy('<p>report</p>', 50);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await assert.rejects(fetch(copy.url));
});
