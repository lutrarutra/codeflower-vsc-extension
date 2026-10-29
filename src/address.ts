// Parses the line a worker prints on start, e.g.
//   codeflower://10.20.3.17:41234?token=Qm9…
// Users may paste it with surrounding text, so the first address is used.

export interface WorkerAddress {
  host: string;
  port: number;
  token: string;
  /** WebSocket URL without the token; the token goes in the Authorization header. */
  url: string;
  /** host:port, safe to show. */
  display: string;
}

const ADDRESS_PATTERN = /(?:codeflower|wss?):\/\/[^\s"'<>]+/i;

export function parseWorkerAddress(text: string): WorkerAddress {
  const match = ADDRESS_PATTERN.exec(text.trim());
  if (!match) {
    throw new Error('Paste the codeflower://… line the worker printed when it started');
  }
  let parsed: URL;
  try {
    parsed = new URL(match[0].replace(/^codeflower:/i, 'http:').replace(/^wss?:/i, 'http:'));
  } catch {
    throw new Error('The worker address is not valid');
  }
  const token = parsed.searchParams.get('token');
  if (!token) {
    throw new Error('The worker address has no token; copy the whole line');
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('The worker address has no port');
  }
  const host = parsed.hostname;
  return {
    host,
    port,
    token,
    url: `ws://${host}:${port}/acp`,
    display: `${host}:${port}`
  };
}
