<script lang="ts">
  import type { SessionConfigOption } from '@agentclientprotocol/sdk';
  import Picker, { choices, type SelectOption } from './Picker.svelte';

  // The session settings the agent offers (ACP config options): mode, model,
  // and effort get their own pickers; anything else goes under "More".
  let {
    options,
    set
  }: { options: SessionConfigOption[]; set: (configId: string, value: string | boolean) => void } = $props();

  const isSelect = (option: SessionConfigOption | undefined): option is SelectOption => option?.type === 'select';
  const byCategory = (category: string) => options.find((option) => option.category === category);
  const mode = $derived(byCategory('mode'));
  const model = $derived(byCategory('model'));
  const effort = $derived(byCategory('thought_level'));
  const extras = $derived(options.filter((option) => !['mode', 'model', 'thought_level'].includes(option.category ?? '')));

  // Claude Code's modes; other agents' modes get the neutral look. Skipping
  // permission prompts is a normal choice here: the agent runs in the sandbox.
  const modeLook: Record<string, [string, string]> = {
    default: ['shield', ''],
    acceptEdits: ['edit', 'bg-teal-soft!'],
    plan: ['checklist', 'bg-violet-soft!'],
    auto: ['sparkle', 'bg-indigo-soft!'],
    bypassPermissions: ['package', 'bg-green-soft!']
  };

  const on = (option: SessionConfigOption) =>
    option.type === 'boolean' ? option.currentValue : option.currentValue === 'on' || option.currentValue === 'true';
  const activeExtras = $derived(extras.filter(on));

  /** On/off selects, like Claude Code's fast mode, work as switches. */
  function toggleValue(option: SessionConfigOption): string | boolean {
    if (option.type === 'boolean') return !option.currentValue;
    return option.currentValue === 'on' ? 'off' : 'on';
  }
  const isSwitch = (option: SessionConfigOption) =>
    option.type === 'boolean' ||
    choices(option)
      .map((choice) => choice.value)
      .sort()
      .join() === 'off,on';

  /** Shift+Tab in the composer moves to the next mode, as in Claude Code. */
  export function cycleMode(): void {
    if (!isSelect(mode)) return;
    const values = choices(mode).map((choice) => choice.value);
    set(mode.id, values[(values.indexOf(String(mode.currentValue)) + 1) % values.length]);
  }

  let moreOpen = $state(false);
  let more: HTMLElement | undefined = $state();
</script>

<svelte:window
  onclick={(event) => {
    if (moreOpen && more && !more.contains(event.target as Node)) moreOpen = false;
  }}
/>

{#if isSelect(mode)}
  {@const [icon, tint] = modeLook[String(mode.currentValue)] ?? ['shield', '']}
  <Picker option={mode} choose={(value) => set(mode.id, value)} triggerClass={tint}>
    {#snippet trigger(current)}
      <span class="codicon codicon-{icon}"></span>
      <span>{current?.name ?? mode.currentValue}</span>
    {/snippet}
  </Picker>
{/if}

{#if isSelect(model)}
  <Picker option={model} choose={(value) => set(model.id, value)}>
    {#snippet trigger(current)}
      <span class="codicon codicon-hubot"></span>
      <!-- "Default (recommended)" names its model in the description, e.g. "Opus 5.5". -->
      <span class="max-w-36 truncate">
        {current?.value === 'default' && current.description ? current.description : (current?.name ?? model.currentValue)}
      </span>
    {/snippet}
  </Picker>
{/if}

{#if isSelect(effort)}
  {@const levels = choices(effort).filter((choice) => choice.value !== 'default')}
  {@const level = levels.findIndex((choice) => choice.value === effort.currentValue)}
  <Picker option={effort} choose={(value) => set(effort.id, value)}>
    {#snippet trigger(current)}
      <span class="flex h-3 items-end gap-[2px]" aria-hidden="true">
        {#each levels as _, index (index)}
          <span
            class="w-[3px] rounded-full {level >= index ? 'bg-orange' : 'bg-soft-line'}"
            style="height: {35 + (65 * index) / Math.max(levels.length - 1, 1)}%"
          ></span>
        {/each}
      </span>
      <span>{current?.name ?? effort.currentValue}</span>
    {/snippet}
  </Picker>
{/if}

{#if extras.length}
  <div class="relative" bind:this={more}>
    <button
      type="button"
      class="chip"
      aria-haspopup="dialog"
      aria-expanded={moreOpen}
      title="More settings"
      onclick={() => (moreOpen = !moreOpen)}
      onkeydown={(event) => event.key === 'Escape' && (moreOpen = false)}
    >
      <span class="codicon codicon-settings"></span>
      {#each activeExtras as option (option.id)}
        <span class="rounded-full bg-yellow px-1.5 text-[0.85em] text-[#1d1d1f]">{option.name}</span>
      {/each}
    </button>
    {#if moreOpen}
      <div
        role="dialog"
        aria-label="More settings"
        tabindex="-1"
        class="card absolute bottom-full left-0 z-20 mb-2 flex w-72 flex-col gap-1 p-1.5"
        onkeydown={(event) => event.key === 'Escape' && (moreOpen = false)}
      >
        <div class="eyebrow px-2 pt-1 pb-1 text-indigo">More settings</div>
        {#each extras as option (option.id)}
          {#if isSwitch(option)}
            <button
              type="button"
              role="switch"
              aria-checked={on(option)}
              class="flex w-full items-center gap-2.5 rounded-lg border-none bg-transparent px-2 py-1.5 text-left hover:bg-code"
              onclick={() => set(option.id, toggleValue(option))}
            >
              <span class="min-w-0 flex-1">
                <span class="block font-semibold">{option.name}</span>
                {#if option.description}<span class="block text-[0.8em] text-muted">{option.description}</span>{/if}
              </span>
              <span
                class="relative h-5 w-9 shrink-0 rounded-full border-[1.5px] border-line transition-colors {on(option)
                  ? 'bg-teal'
                  : 'bg-soft-line'}"
              >
                <span
                  class="absolute top-[1.5px] size-3.5 rounded-full border-[1.5px] border-line bg-card transition-all {on(option)
                    ? 'left-[17px]'
                    : 'left-[1.5px]'}"
                ></span>
              </span>
            </button>
          {:else if isSelect(option)}
            <div class="px-2 py-1.5">
              <div class="font-semibold">{option.name}</div>
              <div class="mt-1 flex flex-wrap gap-1">
                {#each choices(option) as choice (choice.value)}
                  <button
                    type="button"
                    class="chip {choice.value === option.currentValue ? 'bg-indigo! text-on-accent!' : ''}"
                    onclick={() => set(option.id, choice.value)}
                  >
                    {choice.name}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
{/if}
