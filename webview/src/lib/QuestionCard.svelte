<script lang="ts">
  import { formFields, type FormContent, type PendingQuestion, type QuestionAction } from '../../../shared/messages.ts';
  import { send } from './vscode.ts';

  // The agent's question (an ACP form, e.g. Claude Code's AskUserQuestion).
  let { request }: { request: PendingQuestion } = $props();
  const fields = $derived(formFields(request.requestedSchema));
  let values = $state<Record<string, string | string[] | boolean>>({});

  const filled = (key: string) => {
    const value = values[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== '';
  };
  const ready = $derived(
    fields.every((field) => !field.required || filled(field.key) || (field.other && filled(field.other.key)))
  );

  function pick(key: string, value: string, multi: boolean): void {
    if (!multi) {
      values[key] = values[key] === value ? '' : value;
      return;
    }
    const current = Array.isArray(values[key]) ? (values[key] as string[]) : [];
    values[key] = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
  }

  const chosen = (key: string, value: string) => {
    const current = values[key];
    return Array.isArray(current) ? current.includes(value) : current === value;
  };

  function answer(action: QuestionAction): void {
    let content: FormContent | null = null;
    if (action === 'accept') {
      content = {};
      for (const [key, value] of Object.entries(values)) {
        if (Array.isArray(value) ? value.length : value !== '') content[key] = $state.snapshot(value);
      }
      for (const field of fields) {
        if (field.kind === 'number' && typeof content[field.key] === 'string') content[field.key] = Number(content[field.key]);
      }
    }
    send({ type: 'questionResponse', requestId: request.requestId, action, content });
  }
</script>

<form
  class="card mx-4 mb-3 flex max-h-[60vh] flex-col gap-3 overflow-y-auto bg-yellow-soft! px-4 py-3"
  onsubmit={(event) => {
    event.preventDefault();
    if (ready) answer('accept');
  }}
>
  <div class="flex items-center gap-2">
    <span class="codicon codicon-comment-unresolved text-orange"></span>
    <span class="eyebrow text-muted">The agent asks</span>
  </div>
  {#if request.message}
    <p class="m-0 font-display text-[1.05rem] leading-snug font-medium">{request.message}</p>
  {/if}

  {#each fields as field (field.key)}
    <fieldset class="m-0 flex flex-col gap-1.5 border-none p-0">
      {#if field.title || field.kind === 'multi' || (fields.length > 1 && field.description)}
        <legend class="mb-1.5 flex flex-wrap items-baseline gap-2 p-0">
          {#if field.title}<span class="rounded-full bg-card px-2 py-px text-[0.75em] font-bold">{field.title}</span>{/if}
          {#if fields.length > 1 && field.description}<span class="font-semibold">{field.description}</span>{/if}
          {#if field.kind === 'multi'}<span class="text-[0.8em] text-muted">Select all that apply</span>{/if}
        </legend>
      {/if}

      {#if field.kind === 'single' || field.kind === 'multi'}
        {#each field.choices as choice (choice.value)}
          {@const selected = chosen(field.key, choice.value)}
          <button
            type="button"
            role={field.kind === 'multi' ? 'checkbox' : 'radio'}
            aria-checked={selected}
            class="flex w-full items-start gap-2.5 rounded-xl border-[1.5px] px-3 py-2 text-left transition-colors {selected
              ? 'border-indigo bg-indigo-soft'
              : 'border-soft-line bg-card hover:border-line'}"
            onclick={() => pick(field.key, choice.value, field.kind === 'multi')}
          >
            <!-- Squares for "pick any", dots for "pick one". -->
            <span
              class="mt-[3px] grid size-4 shrink-0 place-items-center border-[1.5px] {field.kind === 'multi'
                ? 'rounded-[5px]'
                : 'rounded-full'} {selected ? 'border-indigo bg-indigo text-on-accent' : 'border-muted'}"
            >
              {#if selected}
                {#if field.kind === 'multi'}
                  <span class="codicon codicon-check text-[11px]!"></span>
                {:else}
                  <span class="size-1.5 rounded-full bg-on-accent"></span>
                {/if}
              {/if}
            </span>
            <span class="min-w-0 flex-1">
              <span class="block font-semibold">{choice.title}</span>
              {#if choice.description}<span class="block text-[0.85em] text-muted">{choice.description}</span>{/if}
            </span>
          </button>
        {/each}
      {:else if field.kind === 'boolean'}
        <label class="flex items-center gap-2">
          <input type="checkbox" checked={values[field.key] === true} onchange={(event) => (values[field.key] = event.currentTarget.checked)} />
          {field.description ?? field.title ?? 'Yes'}
        </label>
      {:else}
        <input
          class="rounded-lg border-[1.5px] border-soft-line bg-card px-2.5 py-1.5 outline-none focus:border-indigo"
          type={field.kind === 'number' ? 'number' : 'text'}
          placeholder={field.description ?? ''}
          value={(values[field.key] as string) ?? ''}
          oninput={(event) => (values[field.key] = event.currentTarget.value)}
        />
      {/if}

      {#if field.other}
        <input
          class="rounded-lg border-[1.5px] border-dashed border-soft-line bg-card px-2.5 py-1.5 outline-none focus:border-indigo focus:border-solid"
          type="text"
          placeholder={field.kind === 'multi' ? 'Something else… (optional)' : 'Other answer or a note… (optional)'}
          title={field.other.description ?? undefined}
          value={(values[field.other.key] as string) ?? ''}
          oninput={(event) => (values[field.other!.key] = event.currentTarget.value)}
        />
      {/if}
    </fieldset>
  {/each}

  <div class="flex flex-wrap items-center gap-2">
    <button type="submit" class="pill pill-primary" disabled={!ready}>
      Answer <span class="codicon codicon-arrow-right"></span>
    </button>
    <button type="button" class="link ml-auto" onclick={() => answer('decline')}>Skip</button>
  </div>
</form>
