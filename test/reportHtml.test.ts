import assert from 'node:assert/strict';
import test from 'node:test';
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
