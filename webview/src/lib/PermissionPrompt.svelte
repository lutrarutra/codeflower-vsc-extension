<script lang="ts">
  import type { PendingPermission } from '../../../shared/messages.ts';
  import { send } from './vscode.ts';

  let { request }: { request: PendingPermission } = $props();

  function answer(optionId: string | null): void {
    send({ type: 'permissionResponse', requestId: request.requestId, optionId });
  }

  const style: Record<string, string> = {
    allow_once: 'pill-primary',
    allow_always: 'pill-teal'
  };
</script>

<div class="card mx-4 mb-3 flex flex-col gap-2.5 bg-yellow-soft! px-4 py-3">
  <div class="flex items-center gap-2">
    <span class="codicon codicon-shield text-orange"></span>
    <span class="eyebrow text-muted">May I?</span>
  </div>
  <p class="m-0">The agent wants to run</p>
  <pre class="m-0 overflow-x-auto rounded-xl border-[1.5px] border-soft-line bg-card px-3 py-2 font-mono text-[0.88em] whitespace-pre-wrap">{request
      .toolCall?.title ?? 'a tool'}</pre>
  <div class="flex flex-wrap items-center gap-2 pt-1">
    {#each request.options as option (option.optionId)}
      <button class="pill {style[option.kind] ?? ''}" onclick={() => answer(option.optionId)}>
        {option.name}
      </button>
    {/each}
    <button class="link ml-auto" onclick={() => answer(null)}>Cancel</button>
  </div>
</div>
