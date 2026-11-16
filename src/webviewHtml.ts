// The HTML of code flower's webviews: one bundle, which renders the view named
// on <body>: a chat, a file preview, an agent's plugins, a chat's browser, or a
// restored tab waiting for its sandbox. Each page keeps what its tab is
// (tabState.ts) in the webview's state, so VS Code can restore the tab.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { scriptJson, type TabState } from './tabState.ts';

export type WebviewView = 'chat' | 'preview' | 'plugins' | 'browser' | 'restore';

/** The bundle's folder: the only local files code flower's webviews may load. */
export function webviewAssets(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'webview', 'dist');
}

function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [webviewAssets(extensionUri)] };
}

/** A new tab for one of the bundle's views; it keeps its page while in the background. */
export function createTabPanel(
  extensionUri: vscode.Uri,
  viewType: string,
  title: string,
  show: vscode.ViewColumn | { viewColumn: vscode.ViewColumn; preserveFocus?: boolean }
): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel(viewType, title, show, { ...webviewOptions(extensionUri), retainContextWhenHidden: true });
}

/** A tab VS Code restored: it may load the bundle again (its panel options are restored with it). */
export function adoptTabPanel(panel: vscode.WebviewPanel, extensionUri: vscode.Uri): void {
  panel.webview.options = webviewOptions(extensionUri);
}

/** Tells a page that what its tab is changed, e.g. the chat a preview's feedback goes to. */
export function postTabState(webview: vscode.Webview, tab: TabState): void {
  void webview.postMessage({ type: 'codeflower.tabState', state: tab });
}

export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: WebviewView, tab: TabState): string {
  const assets = webviewAssets(extensionUri);
  const nonce = randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(assets, 'main.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(assets, 'main.css'));
  // A preview runs an HTML report in a sandboxed frame written into the page (srcdoc),
  // which keeps this policy as well as the report's own: the scripts get the nonce
  // (and those they add run by 'strict-dynamic'), and the report's data: and blob:
  // media and workers are allowed. Still no network, and no frame may load a page.
  const report = view === 'preview';
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}${report ? ' data:' : ''}`,
    `img-src ${webview.cspSource} data:${report ? ' blob:' : ''}`,
    ...(report ? ['media-src data: blob:', 'worker-src blob:'] : []),
    `script-src 'nonce-${nonce}'${report ? " 'strict-dynamic'" : ''}`
  ].join('; ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${style}" />
    <title>code flower</title>
  </head>
  <body data-view="${view}">
    <div id="app"></div>
    <script type="application/json" id="cf-tab">${scriptJson(tab)}</script>
    <script type="module" nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
}
