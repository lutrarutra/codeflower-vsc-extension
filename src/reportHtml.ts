// The copy of a report that prints itself in the user's browser (see printCopy.ts),
// as a webview may not open the print dialog, behind a policy that keeps it off the
// network. The report itself runs in its preview tab (codeflower-ui's ReportFrame).

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

/** The report with `head` at the start of its head. */
function withHead(html: string, head: string): string {
  const match = /<head[^>]*>/i.exec(html);
  if (match) return html.slice(0, match.index + match[0].length) + head + html.slice(match.index + match[0].length);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

const POLICY = `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`;

// Opens the print dialog once the copy has loaded and its fonts are ready.
const PRINT = `<script>addEventListener('load', () => {
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => setTimeout(() => print(), 200));
});</script>`;

/**
 * The report as a copy for the user's browser that prints itself once loaded: the
 * policy but no host bridge, so its own Print button prints it there again.
 */
export function printableHtml(html: string): string {
  const page = withHead(html, POLICY);
  const end = page.toLowerCase().lastIndexOf('</body>');
  return end < 0 ? page + PRINT : page.slice(0, end) + PRINT + page.slice(end);
}

