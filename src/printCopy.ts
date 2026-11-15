// Print, for a report tab: a webview may not open the print dialog (VS Code
// sandboxes its frames without allow-modals), so the report's Print button opens
// a copy in the user's browser that prints itself. The copy is served once, from
// a loopback port under an unguessable path, for a few minutes; the extension
// opens it through vscode.env.asExternalUri, which forwards the port when the
// extension runs remotely (WSL, SSH, a container).
//
// The copy keeps the report's policy (no network) and is also sandboxed by its
// header, so it runs in an opaque origin: no cookies or storage of other pages
// on this loopback address, and no way to reach them.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { REPORT_CSP, printableHtml } from './reportHtml.ts';

/** How long a copy stays served: long enough for a browser to start. */
const SERVED_FOR_MS = 5 * 60_000;

export interface PrintCopy {
  /** The copy's address on this machine, to pass through asExternalUri. */
  url: string;
  close(): void;
}

/** Serves the report as a copy that prints itself, at a fresh secret address. */
export async function servePrintCopy(html: string, servedFor = SERVED_FOR_MS): Promise<PrintCopy> {
  const body = Buffer.from(printableHtml(html), 'utf8');
  const path = `/${randomBytes(24).toString('hex')}`;
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== path) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'content-security-policy': `${REPORT_CSP}; sandbox allow-scripts allow-modals`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const close = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  const timer = setTimeout(close, servedFor);
  timer.unref();
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}${path}`, close };
}
