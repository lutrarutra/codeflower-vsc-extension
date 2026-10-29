// The HTML an interactive report tab loads: the report itself, behind a policy that
// keeps it off the network and away from local files, with a small bridge to the
// extension (see reportPanel.ts).

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
    saveComments: (json) => typeof json === 'string' && json.length <= 2000000 && api.postMessage({ type: 'comments', json })
  });
})();</script>`;

/** The report with the policy and the host bridge at the start of its head. */
export function interactiveHtml(html: string): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">${BRIDGE}`;
  const match = /<head[^>]*>/i.exec(html);
  if (match) return html.slice(0, match.index + match[0].length) + head + html.slice(match.index + match[0].length);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

