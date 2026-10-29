// What a worker reports about token use, spend, and its login's quota
// (`_codeflower/usage`), and how the sidebar and the chats put it in words.

/** ACP `Usage` counts; the worker always sends every field. */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  thoughtTokens: number;
  totalTokens: number;
}

export interface Cost {
  amount: number;
  currency: string;
}

/** One quota window of a subscription, e.g. Claude's 5-hour limit or Codex's weekly one. */
export interface UsageLimit {
  id: string;
  label: string;
  /** 0-100; past 100 when usage ran over the cap. */
  usedPercent: number | null;
  resetsAt: string | null;
  status?: 'allowed' | 'allowed_warning' | 'rejected';
}

export interface UsageTotals {
  tokens: TokenCounts;
  cost?: Cost;
}

export interface SessionUsage extends UsageTotals {
  key: string;
  /** How full the agent's context is. */
  context?: { used: number; size: number };
}

export interface UsageAuth {
  kind: 'subscription' | 'api_key' | 'unknown';
  plan?: string;
  label?: string;
}

/** The worker's account and its totals; missing from older workers. */
export interface AccountUsage {
  auth: UsageAuth;
  limits: UsageLimit[];
  limitsUpdatedAt: string | null;
  credits?: { unlimited: boolean; balance?: string };
  /** The agent's cost is its own estimate at API prices (Claude Code). */
  costEstimate: boolean;
}

export interface WorkerUsage extends AccountUsage {
  /** Since the worker started. */
  totals: UsageTotals;
  /** The sessions the worker's agent has loaded. */
  sessions: SessionUsage[];
}

/** What a chat shows: its own counts and its worker's account. */
export interface ChatUsage {
  session: Omit<SessionUsage, 'key'> | null;
  account: AccountUsage | null;
}

/** Past this, a quota window is shown as nearly used up. */
export const LIMIT_WARNING_PERCENT = 80;

const SHORT_LIMITS: Record<string, string> = { five_hour: '5h', seven_day: 'week' };

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(count));
}

export function formatCost(cost: Cost, estimate: boolean): string {
  const amount =
    cost.currency === 'USD'
      ? `$${cost.amount.toFixed(cost.amount < 1 ? 3 : 2)}`
      : `${cost.amount.toFixed(2)} ${cost.currency}`;
  return estimate ? `≈${amount}` : amount;
}

export function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

/** "in 2h 13m", or the day and time for later resets. */
export function formatReset(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return '';
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 24 * 60) return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

export function shortLimitLabel(limit: UsageLimit): string {
  return SHORT_LIMITS[limit.id] ?? limit.label;
}

/** A window that already reset reports nothing about the current one. */
export function limitIsCurrent(limit: UsageLimit, now = Date.now()): boolean {
  return limit.usedPercent !== null && (!limit.resetsAt || Date.parse(limit.resetsAt) > now);
}

export function limitIsLow(limit: UsageLimit): boolean {
  return (
    limit.status === 'rejected' ||
    limit.status === 'allowed_warning' ||
    (limit.usedPercent !== null && limit.usedPercent >= LIMIT_WARNING_PERCENT)
  );
}

/** "5h 37% · week 12%" for subscriptions, "1.2M in · 85k out · $3.40" for keys. */
export function usageSummary(account: AccountUsage, totals: UsageTotals | undefined, now = Date.now()): string {
  const limits = account.limits.filter((limit) => limitIsCurrent(limit, now));
  if (account.auth.kind !== 'api_key' && limits.length) {
    return limits.map((limit) => `${shortLimitLabel(limit)} ${formatPercent(limit.usedPercent!)}`).join(' · ');
  }
  if (!totals || totals.tokens.totalTokens === 0) return '';
  return [
    `${formatTokens(totals.tokens.inputTokens + totals.tokens.cachedReadTokens + totals.tokens.cachedWriteTokens)} in`,
    `${formatTokens(totals.tokens.outputTokens)} out`,
    totals.cost ? formatCost(totals.cost, account.costEstimate) : ''
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Tokens and spend in a few lines, for tooltips. */
export function totalsLines(totals: UsageTotals, costEstimate: boolean): string[] {
  const { tokens } = totals;
  const cached = tokens.cachedReadTokens + tokens.cachedWriteTokens;
  return [
    `${formatTokens(tokens.inputTokens)} input${cached ? ` + ${formatTokens(cached)} cached` : ''} · ${formatTokens(tokens.outputTokens)} output${
      tokens.thoughtTokens ? ` (${formatTokens(tokens.thoughtTokens)} thinking)` : ''
    }`,
    totals.cost
      ? `${formatCost(totals.cost, costEstimate)}${costEstimate ? ' (the agent\'s estimate at API prices)' : ''}`
      : ''
  ].filter(Boolean);
}

export function limitLine(limit: UsageLimit, now = Date.now()): string {
  if (limit.resetsAt && Date.parse(limit.resetsAt) <= now) return `${limit.label}: reset since the last reading`;
  const used = limit.usedPercent === null ? (limit.status === 'rejected' ? 'used up' : 'unknown') : `${formatPercent(limit.usedPercent)} used`;
  const reset = limit.resetsAt ? formatReset(limit.resetsAt, now) : '';
  return `${limit.label}: ${used}${reset ? `, resets ${reset}` : ''}`;
}
