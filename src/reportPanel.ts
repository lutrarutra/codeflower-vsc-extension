// An HTML report with its scripts running: interactive charts and explorers, which
// the sanitised preview strips. The page runs in its own webview with no network
// (no connect-src, no remote sources) and no local files (no resource roots); all
// it can do is tell this host two things:
// - "send": settings from a report control, which go to the preview's feedback box
//   for the user to read and send (never straight into the chat);
// - "reload": the page could not apply an update in place and wants a fresh load.
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { interactiveHtml } from './reportHtml.ts';

type ReportMessage = { type: 'send'; text: string } | { type: 'reload' };

const STORYTELLER = /<meta name="generator" content="storyteller /;

export class InteractiveReport {
  readonly panel: vscode.WebviewPanel;
  private html = '';
  private digest = '';
  private readonly onSend: (text: string) => void;

  constructor(
    title: string,
    iconPath: vscode.Uri,
    column: vscode.ViewColumn,
    onSend: (text: string) => void,
    onClose: () => void
  ) {
    this.onSend = onSend;
    this.panel = vscode.window.createWebviewPanel(
      'codeflower.report',
      `${title} (interactive)`,
      { viewColumn: column, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true, enableFindWidget: true }
    );
    this.panel.iconPath = iconPath;
    this.panel.webview.onDidReceiveMessage((message: ReportMessage) => {
      if (message?.type === 'send' && typeof message.text === 'string') this.onSend(message.text);
      else if (message?.type === 'reload') this.load();
    });
    this.panel.onDidDispose(onClose);
  }

  /** Shows a new version: patched into the open page when possible, else loaded afresh. */
  update(html: string): void {
    const digest = createHash('sha256').update(html).digest('hex');
    if (digest === this.digest) return;
    const first = !this.digest;
    this.digest = digest;
    this.html = html;
    // A storyteller report's runtime replaces only the changed sections (keeping scroll
    // position and explorer settings) and asks for a reload when it cannot, e.g. when a
    // chart library appeared. Other pages are loaded afresh.
    if (!first && STORYTELLER.test(html)) void this.panel.webview.postMessage({ type: 'cf-update', html });
    else this.load();
  }

  private load(): void {
    this.panel.webview.html = interactiveHtml(this.html);
  }

  reveal(): void {
    this.panel.reveal(undefined, false);
  }
}
