// The agents' logos for the tree and quick picks, which show icons from files:
// each logo the worker sends (an SVG data URL) is written to the extension's
// storage. A mono logo, drawn in currentColor, gets a light and a dark file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { AgentState } from 'codeflower-ui/client/workerConnection.ts';

const SVG_DATA = 'data:image/svg+xml;base64,';
// VS Code's icon colors in its default light and dark themes.
const MONO = { light: '#424242', dark: '#c5c5c5' };

let directory: string | undefined;
const written = new Map<string, string>();

/** Where the logos go: the extension's global storage. */
export function setIconDirectory(uri: vscode.Uri): void {
  directory = join(uri.fsPath, 'agent-icons');
}

function file(name: string, content: string): vscode.Uri {
  const path = join(directory!, name);
  if (written.get(path) !== content) {
    mkdirSync(directory!, { recursive: true });
    writeFileSync(path, content);
    written.set(path, content);
  }
  return vscode.Uri.file(path);
}

/** The agent's logo as a tree item's or quick pick item's icon; a generic one without it. */
export function agentIcon(agent: AgentState): vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } | vscode.ThemeIcon {
  if (!directory || !agent.icon?.startsWith(SVG_DATA) || !/^[a-z0-9_-]+$/i.test(agent.id)) return new vscode.ThemeIcon('hubot');
  const svg = Buffer.from(agent.icon.slice(SVG_DATA.length), 'base64').toString('utf8');
  if (!agent.iconMono) return file(`${agent.id}.svg`, svg);
  return {
    light: file(`${agent.id}-light.svg`, svg.replaceAll('currentColor', MONO.light)),
    dark: file(`${agent.id}-dark.svg`, svg.replaceAll('currentColor', MONO.dark))
  };
}

/** What a list says of an agent beside its name. */
export function agentState(agent: AgentState): string {
  if (agent.unavailable) return "can't run here";
  return agent.signedIn ? 'signed in' : 'not signed in';
}

/**
 * Asks which agent, with their logos: those that can run, `first` (e.g. the one used last) and
 * the signed-in ones on top. With one choice there is no question.
 */
export async function pickAgent(
  agents: AgentState[],
  options: { title: string; first?: string; only?: (agent: AgentState) => boolean }
): Promise<AgentState | undefined> {
  const rank = (agent: AgentState) => (agent.id === options.first ? 0 : agent.signedIn ? 1 : 2);
  const choices = agents
    .filter((agent) => !agent.unavailable && (options.only?.(agent) ?? true))
    .sort((a, b) => rank(a) - rank(b));
  if (choices.length <= 1) return choices[0];
  const picked = await vscode.window.showQuickPick(
    choices.map((agent) => ({
      label: agent.name,
      description: agent.signedIn ? undefined : 'not signed in',
      iconPath: agentIcon(agent),
      agent
    })),
    { title: options.title, placeHolder: 'Agent', ignoreFocusOut: true }
  );
  return picked?.agent;
}
