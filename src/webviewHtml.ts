// The HTML of code flower's webviews: one bundle, which renders the view named
// on <body>: a chat or a file preview.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export function webviewHtml(webview: vscode.Webview, assets: vscode.Uri, view: 'chat' | 'preview'): string {
  const nonce = randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(assets, 'main.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(assets, 'main.css'));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`
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
    <script type="module" nonce="${nonce}" src="${script}"></script>
  </body>
</html>`;
}
