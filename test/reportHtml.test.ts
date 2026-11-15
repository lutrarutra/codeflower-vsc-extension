import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { REPORT_CSP, interactiveHtml as withTab, printableHtml } from '../src/reportHtml.ts';
import type { TabState } from '../src/tabState.ts';

const TAB: Extract<TabState, { view: 'report' }> = { view: 'report', workerId: '127.0.0.1:7710', path: '/data/output/report.html', title: 'report.html' };
const interactiveHtml = (html: string) => withTab(html, TAB);
const api = (posted: unknown[], states: unknown[] = []) => ({
  postMessage: (message: unknown) => posted.push(message),
  setState: (state: unknown) => states.push(state)
});

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
  runInNewContext(script, { window, acquireVsCodeApi: () => api(posted) });
  window.cfHost!.saveComments('[]');
  window.cfHost!.saveComments('x'.repeat(2_000_001));
  window.cfHost!.saveComments({ not: 'text' });
  // Made in the script's own context: compare as JSON.
  assert.equal(JSON.stringify(posted), JSON.stringify([{ type: 'comments', json: '[]' }]));
});

test('the bridge asks the extension to print, as the webview may not', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(interactiveHtml('<head></head>'))![1]!;
  const posted: unknown[] = [];
  const window: { cfHost?: { print(): void } } = {};
  runInNewContext(script, { window, acquireVsCodeApi: () => api(posted) });
  window.cfHost!.print();
  assert.equal(JSON.stringify(posted), JSON.stringify([{ type: 'print' }]));
});

test('the bridge keeps what the tab is, for VS Code to restore it', () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(interactiveHtml('<head></head>'))![1]!;
  const states: unknown[] = [];
  runInNewContext(script, { window: {}, acquireVsCodeApi: () => api([], states) });
  assert.equal(JSON.stringify(states), JSON.stringify([TAB]));
});

test("a title cannot end the bridge's script", () => {
  const html = withTab('<head></head>', { ...TAB, title: '</script><script>alert(1)</script>' });
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const states: { title?: string }[] = [];
  runInNewContext(script, { window: {}, acquireVsCodeApi: () => api([], states) });
  assert.equal(states[0]!.title, '</script><script>alert(1)</script>');
  assert.doesNotMatch(html, /alert\(1\)<\/script>/);
});

test('a printable copy has the policy, no bridge, and prints itself once loaded', () => {
  const html = printableHtml('<html><head></head><body><p>report</p></body></html>');
  assert.match(html, /<head><meta http-equiv="Content-Security-Policy"/);
  assert.doesNotMatch(html, /acquireVsCodeApi|cfHost/);
  assert.ok(html.indexOf('report') < html.indexOf('print()'));
  assert.ok(html.indexOf('print()') < html.indexOf('</body>'));
});
