<script lang="ts">
  import type { TranscriptEntry } from '../../../shared/messages.ts';
  import Markdown from './Markdown.svelte';
  import { send } from './vscode.ts';
  import { buildItems } from './transcript.ts';
  import { fileUrl } from './sandboxFiles.svelte.ts';

  const isImage = (path: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
  import Tulip from './Tulip.svelte';

  let {
    entries,
    busy,
    live,
    suggest
  }: { entries: TranscriptEntry[]; busy: boolean; live: boolean; suggest: (text: string) => void } = $props();
  const items = $derived(buildItems(entries));
  let container: HTMLElement | undefined = $state();

  // Follow new output while the user is at the bottom, and jump there when they
  // send something (also from elsewhere, e.g. feedback from a file preview).
  let lastUserItem: string | undefined;
  $effect.pre(() => {
    void items.length;
    void busy;
    if (!container) return;
    const lastUser = items.findLast((item) => item.kind === 'user')?.id;
    const sent = lastUserItem !== undefined && lastUser !== lastUserItem;
    lastUserItem = lastUser;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
    if (atBottom || sent) queueMicrotask(() => container!.scrollTo({ top: container!.scrollHeight }));
  });

  // ACP tool kinds: an icon and a tile color each.
  const toolIcon: Record<string, [string, string]> = {
    read: ['file', 'bg-teal-soft'],
    edit: ['edit', 'bg-indigo-soft'],
    delete: ['trash', 'bg-pink-soft'],
    move: ['arrow-swap', 'bg-indigo-soft'],
    search: ['search', 'bg-yellow-soft'],
    execute: ['terminal', 'bg-indigo-soft'],
    think: ['lightbulb', 'bg-yellow-soft'],
    fetch: ['globe', 'bg-teal-soft'],
    switch_mode: ['settings-gear', 'bg-yellow-soft']
  };

  const statusIcon: Record<string, string> = {
    completed: 'codicon-pass-filled text-green',
    failed: 'codicon-error text-red',
    in_progress: 'codicon-loading codicon-modifier-spin text-indigo',
    pending: 'codicon-circle-large-outline text-muted'
  };

  const suggestions = [
    'What data is in /data/input?',
    'Explore the data and suggest an analysis plan',
    'Make a figure that summarizes the data'
  ];

  const allowed = (outcome: string | null) => !!outcome && /allow|yes|approve/i.test(outcome);
</script>

<!-- Items keep their size and the list scrolls; shrinking would squash cards that clip their content. -->
<div bind:this={container} class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 *:shrink-0">
  {#each items as item, index (item.id)}
    {#if item.kind === 'user'}
      <div
        class="bubble-user max-w-[85%] self-end rounded-[18px] rounded-br-md border-2 border-line bg-indigo px-3.5 py-2 whitespace-pre-wrap text-on-accent shadow-[3px_3px_0_var(--cf-shadow)]"
      >
        {item.text}
      </div>
    {:else if item.kind === 'assistant'}
      <div class="max-w-[95%]"><Markdown text={item.text} openFile={(path) => send({ type: 'openFile', path })} /></div>
    {:else if item.kind === 'thought'}
      <details class="group self-start text-muted">
        <summary
          class="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full border-[1.5px] border-dashed border-soft-line px-2.5 py-0.5 text-[0.85em] select-none hover:text-ink"
        >
          <span class="codicon codicon-sparkle text-violet"></span>
          Thinking
          <span class="codicon codicon-chevron-right transition-transform group-open:rotate-90"></span>
        </summary>
        <div class="mt-2 border-l-2 border-soft-line pl-3 text-[0.9em] whitespace-pre-wrap">{item.text}</div>
      </details>
    {:else if item.kind === 'tool'}
      {@const [icon, tile] = toolIcon[item.toolKind] ?? ['tools', 'bg-yellow-soft']}
      <details class="group rounded-xl border-[1.5px] border-soft-line bg-card">
        <summary class="flex cursor-pointer list-none items-center gap-2.5 px-2.5 py-1.5 select-none">
          <span class="grid size-6 shrink-0 place-items-center rounded-lg border-[1.5px] border-line {tile}">
            <span class="codicon codicon-{icon} text-[13px]!"></span>
          </span>
          {#if item.description}
            <span class="flex min-w-0 flex-1 items-baseline gap-2" title={item.title}>
              <span class="shrink-0 truncate text-[0.92em]">{item.description}</span>
              <span class="min-w-0 truncate font-mono text-[0.78em] text-muted">{item.title}</span>
            </span>
          {:else}
            <span class="min-w-0 flex-1 truncate font-mono text-[0.85em]">{item.title}</span>
          {/if}
          {#each item.files as path (path)}
            <button
              class="link shrink-0 text-[0.85em]"
              title="Show {path}"
              onclick={(event) => {
                event.preventDefault();
                send({ type: 'openFile', path });
              }}
            >
              <span class="codicon codicon-eye"></span>
            </button>
          {/each}
          <span class="codicon {statusIcon[item.status] ?? statusIcon.pending}"></span>
          {#if item.details.length || item.description}
            <span class="codicon codicon-chevron-right text-muted transition-transform group-open:rotate-90"></span>
          {/if}
        </summary>
        {#if item.description && item.toolKind === 'execute'}
          <pre
            class="mx-2.5 mb-2.5 max-h-60 overflow-auto rounded-lg bg-code px-2.5 py-2 font-mono text-[0.8em] whitespace-pre-wrap">{item.title}</pre>
        {/if}
        {#each item.details as detail, index (index)}
          <pre
            class="mx-2.5 mb-2.5 max-h-60 overflow-auto rounded-lg bg-code px-2.5 py-2 font-mono text-[0.8em] whitespace-pre-wrap">{detail}</pre>
        {/each}
      </details>
      <!-- Figures the agent looked at, so the user sees them too. -->
      {#if item.status === 'completed' && item.files.some(isImage)}
        <div class="-mt-1.5 flex flex-wrap gap-2 pl-9">
          {#each item.files.filter(isImage) as path (path)}
            {@const url = fileUrl(path, `${item.id}|${path}`)}
            {#if url}
              <button
                class="overflow-hidden rounded-lg border-[1.5px] border-soft-line bg-white p-0 hover:border-indigo"
                title="Show {path}"
                onclick={() => send({ type: 'openFile', path })}
              >
                <img class="block max-h-40 max-w-full" src={url} alt={path} />
              </button>
            {/if}
          {/each}
        </div>
      {/if}
    {:else if item.kind === 'plan'}
      <div class="rounded-xl border-[1.5px] border-soft-line bg-card px-3.5 py-2.5">
        <div class="eyebrow mb-1.5 text-indigo">Plan</div>
        <ul class="m-0 flex list-none flex-col gap-1 p-0">
          {#each item.entries as step, index (index)}
            <li class="flex items-start gap-2 {step.status === 'completed' ? 'text-muted line-through' : ''}">
              <span
                class="codicon mt-[3px] {step.status === 'completed'
                  ? 'codicon-pass-filled text-green'
                  : step.status === 'in_progress'
                    ? 'codicon-circle-large-filled text-yellow'
                    : 'codicon-circle-large-outline text-muted'}"
              ></span>
              <span>{step.content}</span>
            </li>
          {/each}
        </ul>
      </div>
    {:else if item.kind === 'permission' && item.outcome !== null}
      {@const previous = items[index - 1]}
      <!-- An unanswered request is the prompt card; answered ones read as a note. -->
      <div class="-mt-1.5 flex items-center gap-1.5 self-start pl-1 text-[0.8em] text-muted">
        {#if allowed(item.outcome)}
          <span class="codicon codicon-check text-green"></span> Allowed
        {:else}
          <span class="codicon codicon-circle-slash text-pink"></span> Not allowed
        {/if}
        {#if previous?.kind !== 'tool' || previous.title !== item.title}
          <span class="truncate font-mono">{item.title}</span>
        {/if}
      </div>
    {:else if item.kind === 'shell'}
      <!-- The user's own `!command`, run in the sandbox. -->
      <div class="flex max-w-full flex-col overflow-hidden rounded-xl border-[1.5px] border-soft-line bg-code">
        <div class="flex items-center gap-2 px-3 py-1.5">
          <span class="font-mono font-bold text-teal">$</span>
          <span class="min-w-0 flex-1 truncate font-mono text-[0.88em]" title={item.command}>{item.command}</span>
          {#if item.exitCode === null}
            <span class="codicon codicon-loading codicon-modifier-spin text-cyan"></span>
            <button class="link text-[0.85em]" onclick={() => send({ type: 'cancelShell', runId: item.runId })}>Stop</button>
          {:else if item.exitCode === 0}
            <span class="codicon codicon-pass-filled text-green" title="Exit code 0"></span>
          {:else}
            <span class="rounded-full bg-pink-soft px-2 text-[0.8em] font-semibold text-pink">
              {item.timedOut ? 'timed out' : `exit ${item.exitCode}`}
            </span>
          {/if}
        </div>
        {#if item.output}
          <pre
            class="m-0 max-h-72 overflow-auto border-t-[1.5px] border-soft-line px-3 py-2 font-mono text-[0.8em] whitespace-pre-wrap">{item.output}</pre>
        {/if}
      </div>
    {:else if item.kind === 'question' && item.answers !== null}
      <!-- An open question is the card above the composer; answered ones stay in the chat. -->
      <div class="flex max-w-[90%] flex-col gap-1 self-start rounded-xl border-[1.5px] border-soft-line bg-card px-3 py-2">
        <div class="flex items-center gap-1.5 text-[0.85em] text-muted">
          <span class="codicon codicon-comment-unresolved text-orange"></span>
          {item.message || 'The agent asked'}
        </div>
        {#if item.skipped}
          <div class="text-[0.85em] text-muted italic">Skipped</div>
        {:else}
          {#each item.answers as answer, index (index)}
            <div>
              {#if item.answers.length > 1}<span class="text-[0.85em] text-muted">{answer.question} </span>{/if}
              <span class="font-semibold">{answer.answer}</span>
            </div>
          {/each}
        {/if}
      </div>
    {:else if item.kind === 'show'}
      <!-- Files the agent opened for the user; they also open as tabs. -->
      <div class="flex flex-col gap-2 rounded-xl border-[1.5px] border-soft-line bg-card px-3 py-2.5">
        <div class="flex items-start gap-1.5 text-[0.85em]">
          <span class="codicon codicon-eye mt-[2px] text-teal"></span>
          <span class="eyebrow mt-[1px] shrink-0 text-teal">Shown to you</span>
          {#if item.message}<span class="text-muted">· {item.message}</span>{/if}
        </div>
        <div class="flex flex-wrap gap-2">
          {#each item.files as path (path)}
            {@const name = path.split('/').pop()}
            {#if isImage(path)}
              {@const url = fileUrl(path, `${item.id}|${path}`)}
              <button
                class="flex flex-col overflow-hidden rounded-lg border-[1.5px] border-soft-line bg-white p-0 text-left hover:border-indigo"
                title="Open {path}"
                onclick={() => send({ type: 'openFile', path })}
              >
                {#if url}<img class="block max-h-48 max-w-full" src={url} alt={name} />{/if}
                <span class="bg-card px-2 py-0.5 font-mono text-[0.75em] text-muted">{name}</span>
              </button>
            {:else}
              <button class="chip" title="Open {path}" onclick={() => send({ type: 'openFile', path })}>
                <span class="codicon codicon-file"></span>
                <span class="font-mono">{name}</span>
              </button>
            {/if}
          {/each}
        </div>
      </div>
    {:else if item.kind === 'stop'}
      <div class="flex items-center gap-1.5 self-start rounded-full bg-pink-soft px-2.5 py-0.5 text-[0.85em]">
        <span class="codicon codicon-debug-stop text-pink"></span>
        Turn ended: {item.reason}
      </div>
    {/if}
  {:else}
    <div class="m-auto flex max-w-sm flex-col items-center gap-3 py-8 text-center">
      <Tulip size={72} sway />
      <h2 class="m-0 font-display text-2xl font-semibold ">What shall we grow today?</h2>
      <p class="m-0 text-muted">
        Ask the agent about your data. It analyses it in its own sandbox, shows you figures and writes up what it finds.
      </p>
      {#if live}
        <div class="flex flex-wrap justify-center gap-2 pt-2">
          {#each suggestions as suggestion (suggestion)}
            <button class="pill pill-small" onclick={() => suggest(suggestion)}>{suggestion}</button>
          {/each}
        </div>
      {/if}
    </div>
  {/each}

  {#if busy}
    <div class="flex items-center gap-1.5 py-1" aria-label="The agent is working">
      {#each ['bg-indigo', 'bg-pink', 'bg-yellow'] as color, index (color)}
        <span
          class="size-2 rounded-full border-[1.5px] border-line {color}"
          style="animation: cf-bounce 1.1s ease-in-out {index * 0.15}s infinite"
        ></span>
      {/each}
    </div>
  {/if}
</div>
