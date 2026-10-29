<script lang="ts" module>
  import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';

  export type SelectOption = Extract<SessionConfigOption, { type: 'select' }>;

  /** Options may come flat or in named groups. */
  export function groups(option: SelectOption): { name: string | null; options: SessionConfigSelectOption[] }[] {
    const list = option.options;
    if (list.length && 'group' in list[0]) {
      return (list as { name: string; options: SessionConfigSelectOption[] }[]).map((group) => ({
        name: group.name,
        options: group.options
      }));
    }
    return [{ name: null, options: list as SessionConfigSelectOption[] }];
  }

  export function choices(option: SelectOption): SessionConfigSelectOption[] {
    return groups(option).flatMap((group) => group.options);
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';

  // A compact selector that opens a card above the composer.
  let {
    option,
    choose,
    trigger,
    triggerClass = ''
  }: {
    option: SelectOption;
    choose: (value: string) => void;
    trigger: Snippet<[SessionConfigSelectOption | undefined]>;
    triggerClass?: string;
  } = $props();

  let open = $state(false);
  let root: HTMLElement | undefined = $state();
  let list: HTMLElement | undefined = $state();
  const current = $derived(choices(option).find((choice) => choice.value === option.currentValue));

  function toggle(): void {
    open = !open;
    if (open) queueMicrotask(() => list?.querySelector<HTMLElement>('[aria-checked="true"], [role="menuitemradio"]')?.focus());
  }

  function pick(value: string): void {
    open = false;
    root?.querySelector<HTMLElement>('button')?.focus();
    if (value !== option.currentValue) choose(value);
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      open = false;
      root?.querySelector<HTMLElement>('button')?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(list?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }
</script>

<svelte:window
  onclick={(event) => {
    if (open && root && !root.contains(event.target as Node)) open = false;
  }}
/>

<div class="relative" bind:this={root} onkeydown={keydown} role="presentation">
  <button
    type="button"
    class="chip {triggerClass}"
    aria-haspopup="menu"
    aria-expanded={open}
    title={option.description ?? option.name}
    onclick={toggle}
  >
    {@render trigger(current)}
    <span class="codicon codicon-chevron-up text-[11px]! opacity-60 transition-transform {open ? '' : 'rotate-180'}"></span>
  </button>

  {#if open}
    <div
      bind:this={list}
      role="menu"
      aria-label={option.name}
      class="card absolute bottom-full left-0 z-20 mb-2 flex max-h-80 w-72 flex-col overflow-y-auto p-1.5"
    >
      <div class="eyebrow px-2 pt-1 pb-1.5 text-indigo">{option.name}</div>
      {#each groups(option) as group, index (index)}
        {#if group.name}<div class="px-2 pt-1.5 text-[0.75em] font-semibold text-muted">{group.name}</div>{/if}
        {#each group.options as choice (choice.value)}
          {@const selected = choice.value === option.currentValue}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            class="flex w-full items-start gap-2 rounded-lg border-none bg-transparent px-2 py-1.5 text-left hover:bg-code focus-visible:bg-code focus-visible:outline-none"
            onclick={() => pick(choice.value)}
          >
            <span class="codicon codicon-check mt-[3px] {selected ? 'text-indigo' : 'invisible'}"></span>
            <span class="min-w-0 flex-1">
              <span class="block font-semibold">{choice.name}</span>
              {#if choice.description}<span class="block text-[0.8em] text-muted">{choice.description}</span>{/if}
            </span>
          </button>
        {/each}
      {/each}
    </div>
  {/if}
</div>
