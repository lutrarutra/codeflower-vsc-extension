// How files from the sandbox are shown, and which paths in agent text are files.

export type FileKind = 'image' | 'markdown' | 'html' | 'table' | 'json' | 'text' | 'pdf' | 'binary';

export function fileKind(mimeType: string): FileKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'text/markdown') return 'markdown';
  if (mimeType === 'text/html') return 'html';
  if (mimeType === 'text/csv' || mimeType === 'text/tab-separated-values') return 'table';
  if (mimeType === 'application/json') return 'json';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('text/')) return 'text';
  return 'binary';
}

export const kindIcon: Record<FileKind, string> = {
  image: 'file-media',
  markdown: 'markdown',
  html: 'globe',
  table: 'table',
  json: 'json',
  text: 'file-text',
  pdf: 'file-pdf',
  binary: 'file-binary'
};

export function decodeText(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
}

/** CSV or TSV rows, with quoted fields; at most `limit` rows. */
export function parseDelimited(text: string, separator: string, limit: number): { rows: string[][]; total: number } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let total = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.length > 1 || row[0] !== '') {
      total++;
      if (rows.length < limit) rows.push(row);
    }
    row = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === separator) {
      row.push(field);
      field = '';
    } else if (char === '\n') endRow();
    else if (char !== '\r') field += char;
  }
  if (field !== '' || row.length) endRow();
  return { rows, total };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const FILE_EXTENSIONS = 'png|jpe?g|svg|gif|webp|pdf|html?|md|markdown|csv|tsv|json|txt|log|py|r|sh|ya?ml|toml';
/** A path to a file worth previewing, e.g. `figures/umap.png` or `/data/input/study/meta.csv`. */
const FILE_PATH = new RegExp(`^(?:/|\\./|\\.\\./)?[\\w.@+-]+(?:/[\\w.@+-]+)*\\.(?:${FILE_EXTENSIONS})$`, 'i');

/** Paths inside prose: at least one folder, so plain words like "report.md" stay text. */
export const PATH_IN_TEXT = new RegExp(
  `(?:^|(?<=[\\s(\\[:,]))(?:/|\\./)?[\\w.@+-]+(?:/[\\w.@+-]+)+\\.(?:${FILE_EXTENSIONS})(?=$|[\\s).,;:!?\\]])`,
  'gi'
);

export function looksLikeFile(text: string): boolean {
  return FILE_PATH.test(text.trim());
}

/** Links to local files, not to the web or anchors. */
export function isLocalHref(href: string): boolean {
  return !!href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#') && !href.startsWith('//');
}
