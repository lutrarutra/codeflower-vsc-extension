<script lang="ts">
  // The code flower tulip, always with its ink outline; dark themes show it
  // on a clay tile like the favicon, since a light outline reads too heavy.
  let { size = 28, sway = false }: { size?: number; sway?: boolean } = $props();
</script>

<span
  class="tulip grid shrink-0 place-items-center"
  style="--size: {size}px; {sway ? 'animation: cf-sway 3.2s ease-in-out infinite; transform-origin: 50% 90%;' : ''}"
>
  <svg viewBox="0 0 64 64" aria-hidden="true" class="overflow-visible">
    <g stroke="#1d1d1f" stroke-width="3.2" stroke-linejoin="round">
      <path d="M31 36C29 44 30 51 28 58l4 .5C33 51 33 44 34.5 36Z" fill="#78b56a" />
      <path d="M30 53C21 54 14 48 13 39c5-1 11 1 14 5 2 3 3 6 3 9Z" fill="#78b56a" />
      <g transform="rotate(-5 32 36)">
        <path d="M32 37C22 38 15 30 17 15c6 3 11 9 15 22Z" fill="#ed9e4b" />
        <path d="M33 37C43 36 48 28 45 17c-6 2-10 8-12 20Z" fill="#e5483b" />
        <path d="M32 37C25 31 26 17 31 8c8 8 9 22 1 29Z" fill="#ffcf3f" />
      </g>
      <circle cx="46" cy="45" r="3.2" fill="#2ec4f1" />
    </g>
  </svg>
</span>

<style>
  .tulip {
    width: var(--size);
    height: var(--size);
  }

  svg {
    width: 100%;
    height: 100%;
  }

  :global(body.vscode-dark) .tulip {
    background: #f6efd9;
    border-radius: 28%;
  }

  :global(body.vscode-dark) svg {
    width: 82%;
    height: 82%;
  }
</style>
