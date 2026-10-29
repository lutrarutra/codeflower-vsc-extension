<script lang="ts">
  import type { AvailableCommand } from '@agentclientprotocol/sdk';

  // The agent's slash commands matching what the user typed after `/`.
  let {
    matches,
    selected,
    choose
  }: { matches: AvailableCommand[]; selected: number; choose: (command: AvailableCommand) => void } = $props();

  let list: HTMLElement | undefined = $state();

  $effect(() => {
    list?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  });
</script>

<div
  bind:this={list}
  role="listbox"
  aria-label="Commands"
  class="card absolute right-0 bottom-full left-0 z-20 mb-2 flex max-h-72 flex-col overflow-x-hidden overflow-y-auto p-1.5"
>
  <div class="eyebrow px-2 pt-1 pb-1.5 text-indigo">Commands</div>
  {#each matches as command, index (command.name)}
    <!-- mousedown keeps the focus in the composer. -->
    <button
      type="button"
      role="option"
      aria-selected={index === selected}
      data-index={index}
      class="flex w-full items-baseline gap-2 rounded-lg border-none px-2 py-1.5 text-left {index === selected
        ? 'bg-indigo-soft'
        : 'bg-transparent hover:bg-code'}"
      onmousedown={(event) => event.preventDefault()}
      onclick={() => choose(command)}
    >
      <span class="shrink-0 font-mono font-semibold">/{command.name}</span>
      {#if command.input?.hint}<span class="max-w-[45%] min-w-0 truncate font-mono text-[0.85em] text-muted" title={command.input.hint}>{command.input.hint}</span>{/if}
      <span class="min-w-0 flex-1 truncate text-[0.85em] text-muted" title={command.description}>{command.description}</span>
    </button>
  {/each}
</div>
