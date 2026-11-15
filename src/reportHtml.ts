// The HTML an interactive report tab loads: the report itself, behind a policy that
// keeps it off the network and away from local files, with a small bridge to the
// extension (see reportPanel.ts). Also the copy that prints itself in the user's
// browser (see printCopy.ts), as a webview may not open the print dialog.

/** Content-Security-Policy for an untrusted, self-contained page. */
export const REPORT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  'worker-src blob:'
].join('; ');

// Defined before the report's own scripts run, so its runtime finds the host.
const BRIDGE = `<script>(() => {
  const api = acquireVsCodeApi();
  const text = (value) => String(value).slice(0, 20000);
  window.cfHost = Object.freeze({
    send: (value) => api.postMessage({ type: 'send', text: text(value) }),
    reload: () => api.postMessage({ type: 'reload' }),
    print: () => api.postMessage({ type: 'print' }),
    saveComments: (json) => typeof json === 'string' && json.length <= 2000000 && api.postMessage({ type: 'comments', json })
  });
})();</script>`;

/** The report with `head` at the start of its head. */
function withHead(html: string, head: string): string {
  const match = /<head[^>]*>/i.exec(html);
  if (match) return html.slice(0, match.index + match[0].length) + head + html.slice(match.index + match[0].length);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

const POLICY = `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`;

/** The report with the policy and the host bridge at the start of its head. */
export function interactiveHtml(html: string): string {
  return withHead(html, POLICY + BRIDGE);
}

// Opens the print dialog once the copy has loaded and its fonts are ready.
const PRINT = `<script>addEventListener('load', () => {
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => setTimeout(() => print(), 200));
});</script>`;

/**
 * The report as a copy for the user's browser that prints itself once loaded: the
 * policy but no bridge, so its own Print button prints it there again.
 */
export function printableHtml(html: string): string {
  const page = withHead(html, POLICY);
  const end = page.toLowerCase().lastIndexOf('</body>');
  return end < 0 ? page + PRINT : page.slice(0, end) + PRINT + page.slice(end);
}

