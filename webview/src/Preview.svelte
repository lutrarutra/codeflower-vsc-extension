<script lang="ts">
  import DOMPurify from 'dompurify';
  import type { PreviewHostMessage, PreviewState } from '../../shared/messages.ts';
  import { decodeText, fileKind, formatSize, isLocalHref, kindIcon, parseDelimited } from './lib/files.ts';
  import HtmlReport from './lib/HtmlReport.svelte';
  import Markdown from './lib/Markdown.svelte';
  import { sendPreview } from './lib/vscode.ts';

  // A file from the sandbox: a figure, report or table the agent showed.
  const MAX_ROWS = 1000;
  const WORKSPACE = '/codeflower-state/workspace/';

  let preview = $state<PreviewState | null>(null);
  let assets = $state<Record<string, string | null>>({});
  let draft = $state('');
  let sent = $state<'sent' | 'queued' | null>(null);
  let updated = $state(false);
  let actualSize = $state(false);

  function receive(event: MessageEvent<PreviewHostMessage>): void {
    const message = event.data;
    switch (message.type) {
      case 'preview': {
        const previous = preview;
        preview = message.state;
        // Say so when the agent rewrote the file; its images may have changed too.
        if (previous?.data && message.state.data && previous.file.mtimeMs !== message.state.file.mtimeMs) {
          assets = {};
          requested = new Set();
          updated = true;
          setTimeout(() => (updated = false), 4000);
        }
        break;
      }
      case 'asset':
        assets[message.path] = message.dataUrl;
        break;
      case 'feedbackSent':
        sent = message.queued ? 'queued' : 'sent';
        setTimeout(() => (sent = null), 6000);
        break;
    }
  }

  $effect(() => {
    window.addEventListener('message', receive);
    sendPreview({ type: 'ready' });
    return () => window.removeEventListener('message', receive);
  });

  /** A file the shown file refers to; undefined until the host sends it. */
  // Requested outside reactive state: rendering may ask for a file, but not change state.
  let requested = new Set<string>();
  function asset(path: string): string | null | undefined {
    if (!requested.has(path)) {
      requested.add(path);
      sendPreview({ type: 'asset', path });
    }
    return assets[path];
  }

  const kind = $derived(preview ? fileKind(preview.file.mimeType) : 'binary');
  const text = $derived(
    preview?.data && ['markdown', 'html', 'table', 'json', 'text'].includes(kind) ? decodeText(preview.data) : null
  );
  const shownPath = $derived(
    preview ? (preview.file.path.startsWith(WORKSPACE) ? preview.file.path.slice(WORKSPACE.length) : preview.file.path) : ''
  );

  const table = $derived.by(() => {
    if (kind !== 'table' || text === null || !preview) return null;
    return parseDelimited(text, preview.file.mimeType === 'text/csv' ? ',' : '\t', MAX_ROWS + 1);
  });

  const json = $derived.by(() => {
    if (kind !== 'json' || text === null) return null;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  });

  // HTML reports render without scripts; their local images load through the host.
  const htmlDocument = $derived.by(() => {
    if (kind !== 'html' || text === null) return '';
    const clean = DOMPurify.sanitize(text, { WHOLE_DOCUMENT: true });
    const document = new DOMParser().parseFromString(clean, 'text/html');
    for (const image of document.images) {
      const source = image.getAttribute('src') ?? '';
      if (!isLocalHref(source)) continue;
      const url = asset(source);
      if (url) image.src = url;
      else image.removeAttribute('src');
    }
    return `<!doctype html>${document.documentElement.outerHTML}`;
  });

  const updatedAt = $derived(
    preview ? new Date(preview.file.mtimeMs).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''
  );

  function submit(): void {
    const feedback = draft.trim();
    if (!feedback || !preview?.chat || !preview.live) return;
    sendPreview({ type: 'feedback', text: feedback });
    draft = '';
  }
</script>

<main class="flex h-full flex-col">
  {#if preview}
    <header class="flex items-center gap-3 border-b-[1.5px] border-soft-line px-4 py-2.5">
      <span class="grid size-8 shrink-0 place-items-center rounded-lg border-[1.5px] border-line bg-teal-soft">
        <span class="codicon codicon-{kindIcon[kind]}"></span>
      </span>
      <div class="min-w-0 flex-1">
        <h1 class="m-0 truncate font-display text-[1.1rem] leading-tight font-medium">{preview.title}</h1>
        <div class="flex items-center gap-2 text-[0.8em] text-muted">
          <span class="truncate font-mono" title={preview.file.path}>{shownPath}</span>
          <span class="shrink-0">· {formatSize(preview.file.size)} · {updatedAt}</span>
        </div>
      </div>
      {#if updated}
        <span class="shrink-0 rounded-full bg-teal-soft px-2 py-0.5 text-[0.8em] font-semibold text-teal">
          <span class="codicon codicon-refresh text-[11px]!"></span> updated
        </span>
      {/if}
      <button class="chip shrink-0" title="Save a copy on this machine" disabled={!preview.data} onclick={() => sendPreview({ type: 'save' })}>
        <span class="codicon codicon-save"></span> Save
      </button>
    </header>

    {#if preview.message}
      <div class="mx-4 mt-3 flex items-start gap-2 rounded-xl bg-yellow-soft px-3 py-2">
        <span class="codicon codicon-sparkle mt-[3px] text-orange"></span>
        <span class="flex-1">{preview.message}</span>
      </div>
    {/if}

    <section class="min-h-0 flex-1 overflow-auto px-4 py-3">
      {#if preview.error}
        <div class="m-auto flex max-w-sm flex-col items-center gap-2 py-10 text-center text-muted">
          <span class="codicon codicon-warning text-2xl! text-pink"></span>
          <p class="m-0">{preview.error}</p>
        </div>
      {:else if !preview.data}
        <div class="flex items-center gap-2 py-10 text-muted">
          <span class="codicon codicon-loading codicon-modifier-spin"></span> Loading…
        </div>
      {:else if kind === 'image'}
        <!-- Click toggles between fitting the tab and the figure's own size. -->
        <button
          class="block w-full cursor-zoom-in border-none bg-transparent p-0 {actualSize ? 'cursor-zoom-out' : ''}"
          title={actualSize ? 'Fit to the tab' : 'Show at full size'}
          onclick={() => (actualSize = !actualSize)}
        >
          <img
            class="mx-auto block rounded-lg bg-white {actualSize ? 'max-w-none' : 'max-h-[calc(100vh-14rem)] max-w-full object-contain'}"
            src="data:{preview.file.mimeType};base64,{preview.data}"
            alt={preview.title}
          />
        </button>
      {:else if kind === 'markdown' && text !== null}
        <article class="card mx-auto max-w-3xl px-6 py-5">
          <Markdown {text} {asset} openFile={(path) => sendPreview({ type: 'openFile', path })} />
        </article>
      {:else if kind === 'html'}
        <HtmlReport html={htmlDocument} />
      {:else if table}
        <div class="overflow-auto rounded-xl border-[1.5px] border-soft-line">
          <table class="w-full border-collapse font-mono text-[0.85em]">
            <thead class="sticky top-0 bg-card">
              <tr>
                {#each table.rows[0] ?? [] as cell, index (index)}
                  <th class="border-b-[1.5px] border-soft-line px-2.5 py-1.5 text-left font-semibold whitespace-nowrap">{cell}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each table.rows.slice(1, MAX_ROWS + 1) as row, index (index)}
                <tr class="odd:bg-code/60">
                  {#each row as cell, column (column)}
                    <td class="px-2.5 py-1 whitespace-nowrap">{cell}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="mt-2 text-[0.85em] text-muted">
          {table.total - 1} rows{table.total - 1 > MAX_ROWS ? `, the first ${MAX_ROWS} shown` : ''} · {table.rows[0]?.length ?? 0} columns
        </p>
      {:else if json !== null}
        <pre class="m-0 rounded-xl bg-code px-3 py-2 font-mono text-[0.85em] whitespace-pre-wrap">{json}</pre>
      {:else if text !== null}
        <pre class="m-0 rounded-xl bg-code px-3 py-2 font-mono text-[0.85em] whitespace-pre-wrap">{text}</pre>
      {:else}
        <div class="m-auto flex max-w-sm flex-col items-center gap-3 py-10 text-center text-muted">
          <span class="codicon codicon-{kindIcon[kind]} text-3xl!"></span>
          <p class="m-0">
            {kind === 'pdf' ? 'PDFs cannot be shown here yet.' : 'This kind of file cannot be shown here.'} Save a copy to open it
            on this machine{kind === 'pdf' ? ', or ask the agent for a PNG or SVG' : ''}.
          </p>
          <button class="pill pill-small" onclick={() => sendPreview({ type: 'save' })}>
            <span class="codicon codicon-save"></span> Save a copy
          </button>
        </div>
      {/if}
    </section>

    <form
      class="card mx-4 mb-4 flex flex-col gap-1 px-3 pt-2 pb-2 focus-within:border-indigo"
      onsubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        rows="2"
        class="max-h-40 min-h-[2.8em] resize-none border-none bg-transparent p-0.5 outline-none placeholder:text-muted disabled:cursor-not-allowed"
        placeholder={preview.chat
          ? `Tell the agent what to change… (${kind === 'image' ? 'e.g. bigger labels, a log scale, other colors' : 'it sees which file you mean'})`
          : 'Open a chat on this worker to give the agent feedback'}
        disabled={!preview.chat || !preview.live}
        bind:value={draft}
        onkeydown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      ></textarea>
      <div class="flex items-center gap-2 text-[0.8em] text-muted">
        <span class="flex min-w-0 flex-1 items-center gap-1">
          {#if sent === 'queued'}
            <span class="codicon codicon-clock text-orange"></span>
            <span class="truncate">The agent is busy; your feedback goes to it when this turn ends.</span>
          {:else if sent === 'sent'}
            <span class="codicon codicon-check text-green"></span> Sent to the chat.
          {:else if preview.chat}
            <span class="shrink-0">Goes to</span>
            <button
              type="button"
              class="link min-w-0 truncate font-semibold"
              title={preview.chat.title}
              onclick={() => sendPreview({ type: 'showChat' })}>{preview.chat.title || 'the chat'}</button
            >
            {#if preview.chat.busy}<span class="shrink-0">· after this turn</span>{/if}
          {/if}
        </span>
        <button type="submit" class="pill pill-primary pill-small" disabled={!draft.trim() || !preview.chat || !preview.live}>
          Send <span class="codicon codicon-arrow-up"></span>
        </button>
      </div>
    </form>
  {:else}
    <div class="m-auto flex items-center gap-2 text-muted">
      <span class="codicon codicon-loading codicon-modifier-spin"></span> Loading…
    </div>
  {/if}
</main>
