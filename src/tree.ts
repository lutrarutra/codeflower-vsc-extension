import * as vscode from 'vscode';
import { limitIsCurrent, limitIsLow, limitLine, totalsLines, usageSummary, type WorkerUsage } from '../shared/usage.ts';
import type { SessionStatus } from '../shared/messages.ts';
import { WORKSPACE, type Mount } from './workerConnection.ts';
import type { WorkerEntry, WorkerManager } from './workers.ts';

/** The app mounts each of the user's folders in a subfolder of one of these. */
const MOUNT_GROUPS = [
  { root: '/data/input', label: 'Inputs', icon: 'database' },
  { root: '/data/output', label: 'Outputs', icon: 'output' },
  { root: '/data/code', label: 'Code', icon: 'code' },
  { root: '/data/skills', label: 'Skills', icon: 'lightbulb' }
];

/** Single folders mounted by workers from before /data. */
const MOUNT_LOOK: Record<string, [string, string]> = {
  '/inputs': ['Inputs', 'database'],
  '/outputs': ['Outputs', 'output']
};

function mountFolder(workerId: string, mount: Mount, label: string, icon: string): TreeNode {
  return {
    kind: 'folder',
    workerId,
    path: mount.target,
    label,
    icon,
    ...(mount.source ? { source: mount.source, readOnly: mount.readOnly } : {})
  };
}

/** Where the agent works and what the user mounted, browsable from the tree. */
function folders(workerId: string, mounts: Mount[] | undefined): TreeNode[] {
  const nodes: TreeNode[] = [{ kind: 'folder', workerId, path: WORKSPACE, label: 'Workspace', icon: 'root-folder' }];
  // Workers from before mounts were reported always had /inputs.
  const all = mounts ?? [{ target: '/inputs', source: '', readOnly: true }];
  const grouped = new Set<Mount>();
  for (const group of MOUNT_GROUPS) {
    const members = all.filter((mount) => mount.target.startsWith(`${group.root}/`));
    if (!members.length) continue;
    members.forEach((mount) => grouped.add(mount));
    nodes.push({ kind: 'group', workerId, root: group.root, label: group.label, icon: group.icon, mounts: members });
  }
  for (const mount of all.filter((mount) => !grouped.has(mount))) {
    const [label, icon] = MOUNT_LOOK[mount.target] ?? [mount.target, 'folder-library'];
    nodes.push(mountFolder(workerId, mount, label, icon));
  }
  return nodes;
}

const FILE_ICONS: [RegExp, string][] = [
  [/\.(png|jpe?g|gif|webp|svg)$/i, 'file-media'],
  [/\.(md|markdown)$/i, 'markdown'],
  [/\.html?$/i, 'globe'],
  [/\.(csv|tsv)$/i, 'table'],
  [/\.json$/i, 'json'],
  [/\.pdf$/i, 'file-pdf'],
  [/\.(py|r|R|sh|ipynb)$/i, 'file-code']
];

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Open sessions show what they are doing, like their chat tabs. */
const statusLook: Record<SessionStatus, [string, string, string]> = {
  waiting: ['bell-dot', 'charts.orange', 'needs you'],
  working: ['loading~spin', 'charts.blue', 'working'],
  ready: ['comment-discussion', 'charts.green', ''],
  offline: ['debug-disconnect', 'charts.red', 'not connected']
};

export interface SessionStatuses {
  status(workerId: string, key: string): SessionStatus | undefined;
  onDidChangeStatus: vscode.Event<void>;
}

export type TreeNode =
  | { kind: 'worker'; workerId: string }
  | { kind: 'session'; workerId: string; key: string }
  | { kind: 'signIn'; workerId: string }
  | { kind: 'group'; workerId: string; root: string; label: string; icon: string; mounts: Mount[] }
  | { kind: 'folder'; workerId: string; path: string; label: string; icon?: string; source?: string; readOnly?: boolean }
  | { kind: 'file'; workerId: string; path: string; label: string; size: number; mtimeMs: number }
  | { kind: 'message'; workerId: string; text: string };

function relative(timestamp: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(timestamp)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

export class WorkerTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly workers: WorkerManager;
  private readonly statuses: SessionStatuses;

  constructor(workers: WorkerManager, statuses: SessionStatuses) {
    this.workers = workers;
    this.statuses = statuses;
    workers.onDidChange(() => this.changed.fire(undefined));
    statuses.onDidChangeStatus(() => this.changed.fire(undefined));
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      return [...this.workers.workers.keys()].map((workerId) => ({ kind: 'worker', workerId }));
    }
    if (node.kind === 'group') {
      return node.mounts.map((mount) =>
        mountFolder(node.workerId, mount, mount.target.slice(node.root.length + 1), 'folder')
      );
    }
    if (node.kind === 'folder') return this.folderChildren(node);
    if (node.kind !== 'worker') return [];
    const worker = this.workers.get(node.workerId);
    if (!worker) return [];
    if (worker.state === 'connecting') return [{ kind: 'message', workerId: worker.id, text: 'Connecting…' }];
    if (worker.state === 'disconnected') {
      const text = worker.takenOver
        ? 'In use by another VS Code window; Reconnect takes it back'
        : `Not reachable${worker.error ? `: ${worker.error}` : ''}`;
      return [{ kind: 'message', workerId: worker.id, text }];
    }
    const children: TreeNode[] = [];
    if (worker.status && !worker.status.signedIn) children.push({ kind: 'signIn', workerId: worker.id });
    children.push(...folders(worker.id, worker.status?.mounts));
    for (const session of worker.sessions) children.push({ kind: 'session', workerId: worker.id, key: session.key });
    if (!worker.sessions.length) children.push({ kind: 'message', workerId: worker.id, text: 'No sessions yet' });
    return children;
  }

  private async folderChildren(node: Extract<TreeNode, { kind: 'folder' }>): Promise<TreeNode[]> {
    const connection = this.workers.get(node.workerId)?.connection;
    if (!connection?.connected) return [];
    try {
      const listing = await connection.listDirectory(node.path);
      const children: TreeNode[] = listing.entries.map((entry) =>
        entry.type === 'directory'
          ? { kind: 'folder', workerId: node.workerId, path: entry.path, label: entry.name }
          : { kind: 'file', workerId: node.workerId, path: entry.path, label: entry.name, size: entry.size, mtimeMs: entry.mtimeMs }
      );
      if (!children.length) children.push({ kind: 'message', workerId: node.workerId, text: 'Empty' });
      if (listing.truncated) children.push({ kind: 'message', workerId: node.workerId, text: 'More files not shown' });
      return children;
    } catch (error) {
      return [{ kind: 'message', workerId: node.workerId, text: error instanceof Error ? error.message : String(error) }];
    }
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const worker = this.workers.get(node.workerId);
    switch (node.kind) {
      case 'worker':
        return this.workerItem(worker);
      case 'session': {
        const session = worker?.sessions.find((candidate) => candidate.key === node.key);
        const item = new vscode.TreeItem(session?.title ?? node.key, vscode.TreeItemCollapsibleState.None);
        const elsewhere = session?.openOn && session.openOn !== worker?.status?.instanceId;
        const status = this.statuses.status(node.workerId, node.key);
        const [icon, color, label] = status ? statusLook[status] : ['comment-discussion', '', ''];
        item.description = [label, session ? relative(session.updatedAt) : '', elsewhere ? 'open on another worker' : '']
          .filter(Boolean)
          .join(' · ');
        item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
        // Loaded on the worker: its live counts; otherwise those its turns recorded.
        const counts = worker?.usage?.sessions.find((candidate) => candidate.key === node.key) ?? session?.usage;
        if (session && counts?.tokens.totalTokens) {
          item.tooltip = [session.title, ...totalsLines(counts, worker?.usage?.costEstimate ?? false)].join('\n');
        }
        item.contextValue = 'session';
        item.command = { command: 'codeflower.openSession', title: 'Open session', arguments: [node] };
        return item;
      }
      case 'signIn': {
        const item = new vscode.TreeItem(
          `Sign in to ${worker?.status?.agentLabel ?? 'the agent'}…`,
          vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('key');
        item.command = { command: 'codeflower.signIn', title: 'Sign in', arguments: [node] };
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `group:${node.workerId}:${node.root}`;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.description = `${node.root} · ${node.mounts.length} folder${node.mounts.length === 1 ? '' : 's'}`;
        item.tooltip = node.mounts.map((mount) => `${mount.target}\nfrom ${mount.source}`).join('\n\n');
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `folder:${node.workerId}:${node.path}`;
        item.iconPath = new vscode.ThemeIcon(node.icon ?? 'folder');
        // Mounted folders are known by where they come from; the tooltip has both.
        if (node.source) item.description = `${node.source} · ${node.readOnly ? 'read-only' : 'read-write'}`;
        else if (node.icon) item.description = node.path;
        item.tooltip = node.source ? `${node.path}\nfrom ${node.source}` : node.path;
        item.accessibilityInformation = { label: node.path };
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `file:${node.workerId}:${node.path}`;
        item.iconPath = new vscode.ThemeIcon(FILE_ICONS.find(([pattern]) => pattern.test(node.label))?.[1] ?? 'file');
        item.description = `${size(node.size)} · ${relative(new Date(node.mtimeMs).toISOString())}`;
        item.tooltip = node.path;
        item.contextValue = 'file';
        item.command = { command: 'codeflower.openFile', title: 'Show', arguments: [node] };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
    }
  }

  private workerItem(worker: WorkerEntry | undefined): vscode.TreeItem {
    if (!worker) return new vscode.TreeItem('Unknown worker');
    const label = worker.status?.agentLabel ?? 'Worker';
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `worker:${worker.id}`;
    const usage = worker.usage;
    const summary = usage ? usageSummary(usage, usage.totals) : '';
    const end = worker.status?.allocationEnd
      ? `until ${new Date(worker.status.allocationEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';
    item.description = [worker.id, worker.status?.slurmJobId ? `job ${worker.status.slurmJobId}` : '', end, summary]
      .filter(Boolean)
      .join(' · ');
    item.tooltip = new vscode.MarkdownString(
      [
        `**${label}** on \`${worker.id}\``,
        worker.status?.stateDirectory ? `Project: \`${worker.status.stateDirectory}\`` : '',
        worker.status ? (worker.status.signedIn ? signedInText(usage) : 'Not signed in') : '',
        usage ? usageTooltip(usage) : '',
        worker.error ? `Last error: ${worker.error}` : ''
      ]
        .filter(Boolean)
        .join('\n\n'),
      // For the warning icon on a quota window that is nearly used up.
      true
    );
    const color =
      worker.state === 'connected'
        ? new vscode.ThemeColor(worker.status?.signedIn ? 'testing.iconPassed' : 'editorWarning.foreground')
        : new vscode.ThemeColor('disabledForeground');
    // A quota window nearly used up turns the worker orange.
    const low = usage?.auth.kind === 'subscription' && usage.limits.some((limit) => limitIsCurrent(limit) && limitIsLow(limit));
    item.iconPath = new vscode.ThemeIcon(
      worker.state === 'connected' ? 'vm-running' : 'vm-outline',
      low && worker.state === 'connected' ? new vscode.ThemeColor('editorWarning.foreground') : color
    );
    item.contextValue = worker.state === 'connected' ? 'worker.connected' : 'worker.disconnected';
    return item;
  }
}

function signedInText(usage: WorkerUsage | undefined): string {
  const auth = usage?.auth;
  if (!auth || auth.kind === 'unknown') return 'Signed in';
  const how = auth.label ?? (auth.kind === 'api_key' ? 'an API key' : auth.plan ? `a ${auth.plan} subscription` : 'a subscription');
  return `Signed in with ${how}`;
}

/** The quota windows, then what this worker used, in Markdown lines. */
function usageTooltip(usage: WorkerUsage): string {
  const lines: string[] = [];
  if (usage.limits.length) {
    lines.push(...usage.limits.map((limit) => `${limitIsLow(limit) ? '$(warning) ' : ''}${limitLine(limit)}`));
    if (usage.limitsUpdatedAt) lines.push(`_Quota as of ${new Date(usage.limitsUpdatedAt).toLocaleString()}_`);
  } else if (usage.auth.kind === 'subscription') {
    lines.push('_The quota shows after the first answer._');
  }
  if (usage.credits) lines.push(`Credits: ${usage.credits.unlimited ? 'unlimited' : (usage.credits.balance ?? 'none')}`);
  if (usage.totals.tokens.totalTokens) {
    lines.push('**This worker so far**', ...totalsLines(usage.totals, usage.costEstimate));
  }
  return lines.join('  \n');
}
