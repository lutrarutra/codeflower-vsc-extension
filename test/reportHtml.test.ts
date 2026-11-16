import assert from 'node:assert/strict';
import test from 'node:test';
import { REPORT_CSP, printableHtml } from '../src/reportHtml.ts';

test('the policy blocks the network and remote resources', () => {
  assert.match(REPORT_CSP, /default-src 'none'/);
  assert.doesNotMatch(REPORT_CSP, /connect-src|https?:|\*/);
});

test('a printable copy has the policy, no bridge, and prints itself once loaded', () => {
  const html = printableHtml('<html><head></head><body><p>report</p></body></html>');
  assert.match(html, /<head><meta http-equiv="Content-Security-Policy"/);
  assert.doesNotMatch(html, /acquireVsCodeApi|cfHost/);
  assert.ok(html.indexOf('report') < html.indexOf('print()'));
  assert.ok(html.indexOf('print()') < html.indexOf('</body>'));
});

test('a fragment without a head still gets the policy', () => {
  assert.match(printableHtml('<p>hi</p>'), /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
});
