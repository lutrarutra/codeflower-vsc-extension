import { mount } from 'svelte';
import App from 'codeflower-ui/chat/App.svelte';
import Plugins from 'codeflower-ui/chat/Plugins.svelte';
import BrowserPanel from 'codeflower-ui/chat/browser/BrowserPanel.svelte';
import Preview from 'codeflower-ui/chat/Preview.svelte';
import { postMessageHost } from 'codeflower-ui/chat/lib/host.ts';
import 'codeflower-ui/chat/app.css';
import Restore from './Restore.svelte';

interface VsCodeApi {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode: VsCodeApi =
  typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {}, setState: () => {} };
const host = postMessageHost<never, never>((message) => vscode.postMessage(message));

// What this tab is, kept for VS Code to hand back when it restores the tab
// after a reload (extension/src/tabState.ts); the extension sends changes.
const tab = document.getElementById('cf-tab')?.textContent;
if (tab) vscode.setState(JSON.parse(tab));
window.addEventListener('message', (event: MessageEvent<{ type?: string; state?: unknown }>) => {
  if (event.data?.type === 'codeflower.tabState') vscode.setState(event.data.state);
});

// The chat's dark look follows VS Code's theme, which can change while the tab is open.
const syncTheme = () => document.body.classList.toggle('cf-dark', document.body.classList.contains('vscode-dark'));
syncTheme();
new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

const target = document.getElementById('app');

if (!target) {
  throw new Error('Webview root element is missing');
}

// One bundle for every webview; the host names the view on <body>.
if (document.body.dataset.view === 'preview') {
  mount(Preview, { target, props: { host, reportFrame: 'webview' } });
} else if (document.body.dataset.view === 'plugins') {
  mount(Plugins, { target, props: { host } });
} else if (document.body.dataset.view === 'browser') {
  mount(BrowserPanel, { target, props: { host } });
} else if (document.body.dataset.view === 'restore') {
  mount(Restore, { target, props: { host } });
} else {
  mount(App, { target, props: { host } });
}
