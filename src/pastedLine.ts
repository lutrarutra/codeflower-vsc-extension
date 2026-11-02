// The connect command takes the codeflower://… line, or the
//   vscode://codeflower.codeflower/connect?address=codeflower%3A%2F%2F…
// link the worker also prints, whose line is percent-encoded past the parser.

const LINK_PATTERN = /vscode:\/\/codeflower\.codeflower\/connect\?([^\s"'<>]+)/i;

/** The worker line in pasted text, taken out of a vscode:// link when it is one. */
export function pastedLine(text: string): string {
  const match = LINK_PATTERN.exec(text);
  return (match && new URLSearchParams(match[1]).get('address')) || text;
}
