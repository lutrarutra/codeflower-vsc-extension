import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { REPORT_CSP, interactiveHtml } from '../src/reportHtml.ts';

test('the policy and the bridge come first in the head, before the report scripts', () => {
  const html = interactiveHtml('<!doctype html><html><head><meta charset="utf-8"><script>report()</script></head><body></body></html>');
  const policy = html.indexOf('Content-Security-Policy');
  assert.ok(policy > html.indexOf('<head>'));
  assert.ok(html.indexOf('window.cfHost') < html.indexOf('report()'));
  assert.ok(policy < html.indexOf('report()'));
});

test('the policy blocks the network and remote resources', () => {
  assert.match(REPORT_CSP, /default-src 'none'/);
  assert.doesNotMatch(REPORT_CSP, /connect-src|https?:|\*/);
});

test('a fragment without a head still gets the policy', () => {
  const html = interactiveHtml('<p>hi</p>');
  assert.match(html, /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
  assert.match(html, /<body><p>hi<\/p><\/body>/);
});

test('the bridge passes the comments on, and nothing too large', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(interactiveHtml('<head></head>'))![1]!;
  const posted: unknown[] = [];
  const window: { cfHost?: { saveComments(json: unknown): void } } = {};
  runInNewContext(script, { window, acquireVsCodeApi: () => ({ postMessage: (message: unknown) => posted.push(message) }) });
  window.cfHost!.saveComments('[]');
  window.cfHost!.saveComments('x'.repeat(2_000_001));
  window.cfHost!.saveComments({ not: 'text' });
  // Made in the script's own context: compare as JSON.
  assert.equal(JSON.stringify(posted), JSON.stringify([{ type: 'comments', json: '[]' }]));
});
