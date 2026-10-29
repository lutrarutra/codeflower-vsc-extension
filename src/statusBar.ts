import * as vscode from 'vscode';
import type { ChatPanels } from './chatPanel.ts';

/**
 * A status bar item for sessions that need attention: orange while any agent
 * waits for the user, a spinner while agents work, hidden otherwise. Clicking
 * it shows the session.
 */
export function attentionStatusBar(panels: ChatPanels): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('codeflower.attention', vscode.StatusBarAlignment.Left, 100);
  item.name = 'code flower sessions';
  item.command = 'codeflower.showAttention';
  const update = () => {
    const waiting = panels.count('waiting');
    const working = panels.count('working');
    if (waiting) {
      item.text = `$(bell-dot) ${waiting === 1 ? 'An agent needs you' : `${waiting} agents need you`}`;
      item.tooltip = 'code flower: show the session waiting for your answer';
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      item.show();
    } else if (working) {
      item.text = `$(loading~spin) ${working === 1 ? 'Agent working' : `${working} agents working`}`;
      item.tooltip = 'code flower: show the working session';
      item.backgroundColor = undefined;
      item.show();
    } else {
      item.hide();
    }
  };
  update();
  return vscode.Disposable.from(
    item,
    panels.onDidChangeStatus(update),
    vscode.commands.registerCommand('codeflower.showAttention', () => panels.revealAttention())
  );
}
