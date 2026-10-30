// An HTML report with its scripts running: interactive charts and explorers, which
// the sanitised preview strips. The page runs in its own webview with no network
// (no connect-src, no remote sources) and no local files (no resource roots); all
// it can do is tell this host three things:
// - "send": settings from a report control, or the user's comments for the agent, which
//   go to the preview's feedback box for the user to read and send (never straight
//   into the chat);
// - "comments": the comments the user left on the report (JSON), to save into it;
// - "reload": the page could not apply an update in place and wants a fresh load.
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { interactiveHtml } from './reportHtml.ts';

type ReportMessage = { type: 'send'; text: string } | { type: 'comments'; json: string } | { type: 'reload' };

export interface ReportHost {
  /** Text for the feedback box. */
  send(text: string): void;
  /** The user's comments on the report, as JSON. */
  saveComments(json: string): void;
}

const STORYTELLER = /<meta name="generator" content="storyteller /;

/** Pages made by storyteller, whose runtime takes comments and in-place updates. */
export function isStorytellerReport(html: string): boolean {
  return STORYTELLER.test(html);
}

export class InteractiveReport {
  readonly panel: vscode.WebviewPanel;
  private html = '';
  private digest = '';
  private readonly host: ReportHost;

  constructor(
    title: string,
    iconPath: vscode.Uri,
    column: vscode.ViewColumn,
    host: ReportHost,
    onClose: () => void,
    preserveFocus = false
  ) {
    this.host = host;
    this.panel = vscode.window.createWebviewPanel(
      'codeflower.report',
      `${title} (interactive)`,
      { viewColumn: column, preserveFocus },
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true, enableFindWidget: true }
    );
    this.panel.iconPath = iconPath;
    this.panel.webview.onDidReceiveMessage((message: ReportMessage) => {
      if (message?.type === 'send' && typeof message.text === 'string') this.host.send(message.text);
      else if (message?.type === 'comments' && typeof message.json === 'string') this.host.saveComments(message.json);
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

  reveal(preserveFocus = false): void {
    this.panel.reveal(undefined, preserveFocus);
  }
}
