<script lang="ts">
  // An HTML report, sanitized (no scripts or handlers) and rendered in a shadow
  // root, so its styles neither leak out nor pick up the chat's.
  let { html }: { html: string } = $props();
  let host: HTMLElement | undefined = $state();
  // storyteller reports mark their parts with a content hash: parts that changed
  // since the last version flash (their stylesheet has the animation).
  let hashes = new Map<string, string>();

  $effect(() => {
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const document = new DOMParser().parseFromString(html, 'text/html');
    // The report's page-level rules apply to its container here.
    const styles = [...document.querySelectorAll('style')]
      .map((style) => `<style>${(style.textContent ?? '').replace(/(^|[\s,}])(html|body)(?=[\s,{.:#[])/g, '$1.report')}</style>`)
      .join('');
    // Reports are written for paper: dark text on white, whatever the editor theme.
    root.innerHTML = `<style>:host{all:initial;display:block;color:#1d1d1f;font-family:system-ui,sans-serif;line-height:1.5}
      .report{padding:24px 28px;overflow-wrap:anywhere} img,svg,table{max-width:100%;height:auto}</style>${styles}<div class="report">${document.body.innerHTML}</div>`;
    const parts = [...root.querySelectorAll<HTMLElement>('[data-cf-part]')];
    for (const part of parts) {
      const before = hashes.get(part.dataset.cfPart ?? '');
      if (hashes.size && before !== part.dataset.cfHash) part.classList.add('cf-changed');
    }
    hashes = new Map(parts.map((part) => [part.dataset.cfPart ?? '', part.dataset.cfHash ?? '']));
  });
</script>

<div bind:this={host} class="overflow-auto rounded-lg border-[1.5px] border-soft-line bg-white"></div>
