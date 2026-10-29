<script lang="ts">
  import {
    formatCost,
    formatPercent,
    formatReset,
    formatTokens,
    limitIsCurrent,
    limitIsLow,
    limitLine,
    shortLimitLabel,
    totalsLines,
    type ChatUsage
  } from '../../../shared/usage.ts';

  // Under the composer: how full the context is, what this chat used, and how
  // much of the worker's subscription quota is left.
  let { usage }: { usage: ChatUsage } = $props();

  // Resets count down; a minute is fine enough.
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(timer);
  });

  const session = $derived(usage.session);
  const account = $derived(usage.account);
  const estimate = $derived(account?.costEstimate ?? false);
  const context = $derived(session?.context && session.context.size > 0 ? session.context : undefined);
  const contextPercent = $derived(context ? (context.used / context.size) * 100 : 0);
  const limits = $derived(
    account?.auth.kind === 'api_key' ? [] : (account?.limits ?? []).filter((limit) => limitIsCurrent(limit, now))
  );
  const tokens = $derived(session?.tokens);
</script>

{#if context || tokens?.totalTokens || limits.length}
  <div class="mx-4 -mt-2.5 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[0.78em] text-muted">
    {#if context}
      <span
        class="inline-flex items-center gap-1.5"
        title="Context: {formatTokens(context.used)} of {formatTokens(context.size)} tokens"
      >
        <span class="codicon codicon-layers"></span>
        <span class="meter"><span class="fill {contextPercent >= 80 ? 'bg-orange' : 'bg-indigo'}" style:width="{Math.min(contextPercent, 100)}%"></span></span>
        {formatPercent(contextPercent)}
      </span>
    {/if}
    {#if tokens?.totalTokens}
      <span class="inline-flex items-center gap-1.5" title={totalsLines(session!, estimate).join('\n')}>
        <span class="codicon codicon-symbol-numeric"></span>
        {formatTokens(tokens.inputTokens + tokens.cachedReadTokens + tokens.cachedWriteTokens)} in ·
        {formatTokens(tokens.outputTokens)} out
        {#if session?.cost}· {formatCost(session.cost, estimate)}{/if}
      </span>
    {/if}
    {#each limits as limit (limit.id)}
      {@const low = limitIsLow(limit)}
      <span
        class="inline-flex items-center gap-1.5 {low ? 'font-semibold text-orange' : ''}"
        title="{account?.auth.label ?? 'Subscription'}: {limitLine(limit, now)}"
      >
        {shortLimitLabel(limit)}
        <span class="meter"><span class="fill {low ? 'bg-orange' : 'bg-teal'}" style:width="{Math.min(limit.usedPercent ?? 0, 100)}%"></span></span>
        {formatPercent(limit.usedPercent ?? 0)}
        {#if low && limit.resetsAt}<span class="font-normal text-muted">resets {formatReset(limit.resetsAt, now)}</span>{/if}
      </span>
    {/each}
  </div>
{/if}

<style>
  .meter {
    display: inline-block;
    width: 2.6rem;
    height: 0.4rem;
    border-radius: 999px;
    background: var(--cf-soft-line);
    overflow: hidden;
  }

  .fill {
    display: block;
    height: 100%;
    border-radius: 999px;
  }
</style>
