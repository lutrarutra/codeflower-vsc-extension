<script lang="ts">
  import DOMPurify from 'dompurify';
  import { marked } from 'marked';
  import { PATH_IN_TEXT, isLocalHref, looksLikeFile } from './files.ts';

  // Agent output is untrusted: render markdown, then sanitize the HTML.
  // With `openFile`, file paths and local links open in a preview; with
  // `asset`, local images (e.g. a report's figures) load through the host.
  let {
    text,
    openFile,
    asset
  }: { text: string; openFile?: (path: string) => void; asset?: (path: string) => string | null | undefined } =
    $props();
  const html = $derived(DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true, async: false })));
  let root: HTMLElement | undefined = $state();

  $effect(() => {
    void html;
    if (!root || !openFile) return;
    for (const code of root.querySelectorAll('code')) {
      const path = code.textContent?.trim() ?? '';
      if (!code.closest('pre') && looksLikeFile(path)) code.dataset.file = path;
    }
    // Paths in plain text, e.g. a list of the files the agent wrote.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest('code, pre, a, [data-file]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    for (const node of texts) {
      const value = node.nodeValue ?? '';
      const matches = [...value.matchAll(PATH_IN_TEXT)];
      if (!matches.length) continue;
      const fragment = document.createDocumentFragment();
      let last = 0;
      for (const match of matches) {
        fragment.append(value.slice(last, match.index));
        const span = document.createElement('span');
        span.dataset.file = match[0];
        span.textContent = match[0];
        fragment.append(span);
        last = match.index + match[0].length;
      }
      fragment.append(value.slice(last));
      node.replaceWith(fragment);
    }
    for (const link of root.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') ?? '';
      if (isLocalHref(href)) (link as HTMLElement).dataset.file = decodeURI(href);
    }
  });

  $effect(() => {
    void html;
    if (!root || !asset) return;
    for (const image of root.querySelectorAll('img')) {
      const source = image.dataset.src ?? image.getAttribute('src') ?? '';
      if (!isLocalHref(source)) continue;
      image.dataset.src = source;
      // A figure in a report opens on its own, where it can be zoomed.
      if (openFile) image.dataset.file = source;
      const url = asset(source);
      if (url) image.src = url;
      else image.removeAttribute('src');
    }
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  bind:this={root}
  class="prose break-words"
  onclick={(event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-file]');
    if (!target || !openFile) return;
    event.preventDefault();
    openFile(target.dataset.file!);
  }}
>
  {@html html}
</div>
