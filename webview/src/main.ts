import { mount } from 'svelte';
import App from 'codeflower-ui/chat/App.svelte';
import Preview from 'codeflower-ui/chat/Preview.svelte';
import { postMessageHost } from 'codeflower-ui/chat/lib/host.ts';
import 'codeflower-ui/chat/app.css';

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode: VsCodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {} };
const host = postMessageHost<never, never>((message) => vscode.postMessage(message));

// The chat's dark look follows VS Code's theme, which can change while the tab is open.
const syncTheme = () => document.body.classList.toggle('cf-dark', document.body.classList.contains('vscode-dark'));
syncTheme();
new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

const target = document.getElementById('app');

if (!target) {
  throw new Error('Webview root element is missing');
}

// One bundle for both webviews; the host names the view on <body>.
if (document.body.dataset.view === 'preview') {
  mount(Preview, { target, props: { host } });
} else {
  mount(App, { target, props: { host } });
}
