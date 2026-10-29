import type { PreviewWebviewMessage, WebviewMessage } from '../../../shared/messages.ts';

interface VsCodeApi {
  postMessage(message: WebviewMessage | PreviewWebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : { postMessage: () => {}, getState: () => undefined, setState: () => {} };

export function send(message: WebviewMessage): void {
  vscode.postMessage(message);
}

export function sendPreview(message: PreviewWebviewMessage): void {
  vscode.postMessage(message);
}
