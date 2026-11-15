<script lang="ts">
  // A tab VS Code restored after a reload, while its sandbox cannot be reached
  // or what it showed is gone (extension/src/restore.ts). It turns into the
  // tab's own view once the sandbox is connected.
  import ErrorState from 'codeflower-ui/chat/lib/ErrorState.svelte';
  import OfflineState from 'codeflower-ui/chat/lib/OfflineState.svelte';
  import Tulip from 'codeflower-ui/chat/lib/Tulip.svelte';
  import type { Host } from 'codeflower-ui/chat/lib/host.ts';
  import type { RestoreStatus } from '../../src/tabState.ts';

  type Outgoing = { type: 'ready' } | { type: 'retry' };
  type Incoming = { type: 'restoreStatus'; status: RestoreStatus };

  let { host }: { host: Host<Outgoing, Incoming> } = $props();
  let status = $state<RestoreStatus | undefined>();

  $effect(() => {
    const stop = host.listen((message) => {
      if (message.type === 'restoreStatus') status = message.status;
    });
    // Ready once loaded: the extension replaces this page with the tab's own view only then, as
    // VS Code's webview host keeps a page set before the one ahead of it fired `load` hidden for
    // good. The page is written with document.write, so its readyState says "complete" early;
    // the bundle always runs before `load`, so the event itself is waited for.
    const ready = () => setTimeout(() => host.send({ type: 'ready' }), 0);
    window.addEventListener('load', ready, { once: true });
    return () => {
      window.removeEventListener('load', ready);
      stop();
    };
  });

  const retry = () => host.send({ type: 'retry' });
</script>

<main class="flex min-h-screen p-4">
  {#if !status || status.kind === 'connecting'}
    <div class="m-auto flex max-w-sm flex-col items-center gap-3 py-8 text-center" role="status">
      <Tulip size={72} sway />
      <p class="m-0 text-muted">Connecting to the sandbox{status ? ` at ${status.workerId}` : ''}…</p>
    </div>
  {:else if status.kind === 'unreachable'}
    <OfflineState
      title="Cannot reach the sandbox"
      detail={`${status.workerId} is not answering${status.error ? ` (${status.error})` : ''}. This tab opens again once it is running.`}
      retrying={status.retrying}
    >
      <button type="button" class="chip" onclick={retry}>Try again</button>
    </OfflineState>
  {:else if status.kind === 'unknown'}
    <ErrorState
      title="Cannot reach the sandbox"
      detail={`${status.workerId} is no longer in code flower's list of sandboxes. Connect to it again to open this tab.`}
      role="status"
    />
  {:else if status.kind === 'gone'}
    <ErrorState title={status.title} detail={status.detail} role="status">
      <button type="button" class="chip" onclick={retry}>Try again</button>
    </ErrorState>
  {:else}
    <ErrorState title="This tab could not be restored" detail={status.error}>
      <button type="button" class="chip" onclick={retry}>Try again</button>
    </ErrorState>
  {/if}
</main>
