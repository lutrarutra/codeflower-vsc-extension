// Worker lines in VS Code's terminal, made clickable as a whole.
//
// VS Code knows no codeflower:// scheme, so a Ctrl+click on a worker's
//   codeflower://10.20.3.17:41234?token=…&fp=…
// line searched for its text, cut at the "?", and the token was lost. The
// extension claims these lines, and the vscode://codeflower.codeflower/connect
// links, which then connect here, in this window, also in VS Code for the web
// and over Remote-SSH.

import { pastedLine } from './pastedLine.ts';

export interface WorkerLink {
  startIndex: number;
  length: number;
  /** The codeflower:// line to connect with. */
  address: string;
}

const LINK_PATTERN = /codeflower:\/\/[^\s"'<>]+|vscode:\/\/codeflower\.codeflower\/connect\?[^\s"'<>]+/gi;

/** The worker lines and connect links in a line of terminal text. */
export function workerLinks(line: string): WorkerLink[] {
  const links: WorkerLink[] = [];
  for (const match of line.matchAll(LINK_PATTERN)) {
    const text = match[0];
    const address = pastedLine(text);
    if (!/^codeflower:\/\//i.test(address)) continue;
    links.push({ startIndex: match.index, length: text.length, address });
  }
  return links;
}
