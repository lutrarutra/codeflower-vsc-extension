<script lang="ts">
  import {
    sessionStatus,
    type ChatState,
    type HostMessage,
    type PendingPermission,
    type PendingQuestion,
    type SessionStatus,
    type TranscriptEntry
  } from '../../shared/messages.ts';
  import type { ChatUsage } from '../../shared/usage.ts';
  import type { AvailableCommand, SessionConfigOption } from '@agentclientprotocol/sdk';
  import CommandMenu from './lib/CommandMenu.svelte';
  import { receivedFile } from './lib/sandboxFiles.svelte.ts';
  import PermissionPrompt from './lib/PermissionPrompt.svelte';
  import QuestionCard from './lib/QuestionCard.svelte';
  import SettingsBar from './lib/SettingsBar.svelte';
  import Transcript from './lib/Transcript.svelte';
  import Tulip from './lib/Tulip.svelte';
  import UsageMeter from './lib/UsageMeter.svelte';
  import { send } from './lib/vscode.ts';

  let chat = $state<ChatState>({ title: '', subtitle: '', live: false, busy: false });
  let entries = $state<TranscriptEntry[]>([]);
  let permission = $state<PendingPermission | null>(null);
  let question = $state<PendingQuestion | null>(null);
  let notice = $state<Extract<HostMessage, { type: 'notice' }> | null>(null);
  let draft = $state('');
  let config = $state<SessionConfigOption[]>([]);
  let usage = $state<ChatUsage>({ session: null, account: null });
  let settings: SettingsBar | undefined = $state();

  /** Shows the choice at once; the agent's reply confirms or corrects it. */
  function setConfig(configId: string, value: string | boolean): void {
    config = config.map((option) =>
      option.id === configId ? ({ ...option, currentValue: value } as SessionConfigOption) : option
    );
    send({ type: 'setConfig', configId, value });
  }

  function receive(event: MessageEvent<HostMessage>): void {
    const message = event.data;
    switch (message.type) {
      case 'state':
        chat = message.state;
        break;
      case 'transcript':
        entries = message.entries;
        break;
      case 'entry':
        entries.push(message.entry);
        break;
      case 'permission':
        permission = message.request;
        break;
      case 'question':
        question = message.request;
        break;
      case 'notice':
        notice = message;
        break;
      case 'config':
        config = message.options;
        break;
      case 'usage':
        usage = message.usage;
        break;
      case 'fileData':
        receivedFile(message.key, message.dataUrl);
        break;
    }
  }

  $effect(() => {
    window.addEventListener('message', receive);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', receive);
  });

  // `!command` runs in the sandbox instead of going to the agent, as in Claude Code.
  const shellMode = $derived(draft.trimStart().startsWith('!'));

  // The agent's slash commands, as it last listed them for this session.
  const commands = $derived.by(() => {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.kind === 'update' && entry.update.sessionUpdate === 'available_commands_update') {
        return entry.update.availableCommands;
      }
    }
    return [] as AvailableCommand[];
  });

  // While the user types a command's name, the menu offers the matching ones.
  const commandQuery = $derived(/^\/(\S*)$/.exec(draft)?.[1]?.toLowerCase());
  const commandMatches = $derived.by(() => {
    if (commandQuery === undefined) return [];
    const starts = commands.filter((command) => command.name.toLowerCase().startsWith(commandQuery));
    const contains = commands.filter(
      (command) => !starts.includes(command) && command.name.toLowerCase().includes(commandQuery)
    );
    return [...starts, ...contains];
  });
  let commandIndex = $state(0);
  let commandMenuClosed = $state(false);
  const commandMenuOpen = $derived(chat.live && !commandMenuClosed && commandMatches.length > 0);
  $effect(() => {
    void commandQuery;
    commandIndex = 0;
    commandMenuClosed = false;
  });
  // A known command typed out in full: its argument hint shows under the composer.
  const typedCommand = $derived(commands.find((command) => draft.trimStart().split(/\s/, 1)[0] === `/${command.name}`));

  /** Enter or a click runs the command as is, as in Claude Code; Tab completes it to add arguments. */
  function chooseCommand(command: AvailableCommand, run: boolean): void {
    if (run) {
      draft = `/${command.name}`;
      submit();
      return;
    }
    draft = `/${command.name} `;
    input?.focus();
  }

  function submit(): void {
    const text = draft.trim();
    if (!text || !chat.live) return;
    if (shellMode) {
      const command = text.slice(1).trim();
      if (!command) return;
      notice = null;
      send({ type: 'shell', command });
      draft = '';
      if (input) input.style.height = '';
      return;
    }
    if (chat.busy) return;
    notice = null;
    send({ type: 'prompt', text });
    draft = '';
    if (input) input.style.height = '';
  }

  let input: HTMLTextAreaElement | undefined = $state();

  function suggest(text: string): void {
    draft = text;
    input?.focus();
  }

  const status = $derived(sessionStatus(chat, permission !== null || question !== null));
  // Dot, label color, tooltip, label; the tab icon uses the same colors.
  const statusLook: Record<SessionStatus, [string, string, string, string]> = {
    ready: ['bg-[#3fbf57]', 'text-green', 'The agent is ready for your next message', 'ready'],
    waiting: ['bg-[#ff9f1c]', 'text-orange', 'The agent is waiting for your answer', 'needs you'],
    working: ['bg-[#1ec8f0]', 'text-cyan', 'The agent is working', 'working'],
    offline: ['bg-muted', 'text-muted', 'Read-only: the worker is not connected or runs elsewhere', 'read-only']
  };

  const agentColor: Record<string, string> = {
    claude: 'bg-orange',
    codex: 'bg-teal',
    dsh: 'bg-indigo'
  };
  // "Claude Code · 127.0.0.1:7710": the agent, then where it runs.
  const [agentLabel, location] = $derived(chat.subtitle.split(' · '));
</script>

<main class="flex h-full flex-col">
  <header class="flex items-center gap-3 border-b-[1.5px] border-soft-line px-4 py-2.5">
    <Tulip size={30} />
    <div class="min-w-0 flex-1">
      <h1 class="m-0 truncate font-display text-[1.1rem] leading-tight font-medium">
        {chat.title || 'New session'}
      </h1>
      <div class="flex items-center gap-2 text-[0.8em] text-muted">
        {#if agentLabel}
          <span
            class="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-line bg-card px-2 py-px font-semibold text-ink"
          >
            <span class="size-2 rounded-full {agentColor[chat.agent ?? ''] ?? 'bg-violet'}"></span>
            {agentLabel}
          </span>
        {/if}
        {#if location}<span class="truncate font-mono">{location}</span>{/if}
      </div>
    </div>
    <span
      class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.8em] font-semibold {statusLook[status][1]}"
      title={statusLook[status][2]}
    >
      <span class="size-2 rounded-full {statusLook[status][0]} {status === 'working' ? 'animate-pulse' : ''}"></span>
      {statusLook[status][3]}
    </span>
  </header>

  {#if notice}
    <div
      class="mx-4 mt-3 flex items-start gap-2.5 rounded-xl border-[1.5px] border-line px-3 py-2 {notice.level === 'error'
        ? 'bg-pink-soft'
        : 'bg-indigo-soft'}"
    >
      <span class="codicon mt-[3px] {notice.level === 'error' ? 'codicon-warning text-pink' : 'codicon-info text-indigo'}"></span>
      <span class="flex-1">{notice.message}</span>
      {#if notice.action}
        <button class="pill pill-primary pill-small" onclick={() => send({ type: 'action', id: notice!.action!.id })}>
          {notice.action.label}
        </button>
      {/if}
      <button class="link" aria-label="Dismiss" onclick={() => (notice = null)}>
        <span class="codicon codicon-close"></span>
      </button>
    </div>
  {/if}

  <Transcript {entries} busy={chat.busy} live={chat.live} {suggest} />

  {#if permission}
    <PermissionPrompt request={permission} />
  {/if}

  {#if question}
    {#key question.requestId}
      <QuestionCard request={question} />
    {/key}
  {/if}

  <form
    class="card relative mx-4 mb-4 flex flex-col gap-1 px-3 pt-2 pb-2 {shellMode ? 'border-teal!' : 'focus-within:border-indigo'}"
    onsubmit={(event) => {
      event.preventDefault();
      submit();
    }}
  >
    {#if commandMenuOpen}
      <CommandMenu matches={commandMatches} selected={commandIndex} choose={(command) => chooseCommand(command, true)} />
    {/if}
    <textarea
      bind:this={input}
      rows="2"
      class="max-h-60 min-h-[2.8em] resize-none border-none bg-transparent p-0.5 outline-none placeholder:text-muted disabled:cursor-not-allowed {shellMode
        ? 'font-mono'
        : ''}"
      placeholder={chat.live
        ? `Ask the agent…  (${commands.length ? '/ for commands, ' : ''}! runs a command in the sandbox)`
        : 'This session is read-only here'}
      disabled={!chat.live}
      bind:value={draft}
      oninput={() => {
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = `${input.scrollHeight}px`;
      }}
      onkeydown={(event) => {
        if (commandMenuOpen) {
          const count = commandMatches.length;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            commandIndex = (commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
            return;
          }
          if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && !event.shiftKey)) {
            event.preventDefault();
            chooseCommand(commandMatches[commandIndex], event.key === 'Enter');
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            commandMenuClosed = true;
            return;
          }
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          submit();
        } else if (event.key === 'Tab' && event.shiftKey && config.length) {
          event.preventDefault();
          settings?.cycleMode();
        }
      }}
    ></textarea>
    <div class="flex items-center gap-2">
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {#if chat.live && shellMode}
          <span class="chip border-teal! text-teal" title="Runs in the sandbox's workspace; the agent sees it with your next message">
            <span class="codicon codicon-terminal"></span> Shell command
          </span>
        {:else if chat.live && typedCommand}
          <span class="chip min-w-0 border-indigo! text-indigo" title={typedCommand.description}>
            <span class="codicon codicon-symbol-event"></span>
            <span class="font-mono">/{typedCommand.name}</span>
            {#if typedCommand.input?.hint}<span class="truncate font-mono text-muted">{typedCommand.input.hint}</span>{/if}
          </span>
        {:else if chat.live}
          <SettingsBar bind:this={settings} options={config} set={setConfig} />
        {/if}
      </div>
      {#if chat.busy && !shellMode}
        <button type="button" class="pill pill-pink pill-small" onclick={() => send({ type: 'cancel' })}>
          <span class="codicon codicon-debug-stop"></span> Stop
        </button>
      {/if}
      <button
        type="submit"
        class="pill pill-small {shellMode ? 'pill-teal' : 'pill-primary'}"
        title={shellMode
          ? 'Run in the sandbox (Enter)'
          : `Enter to send · Shift+Enter for a new line${config.length ? ' · Shift+Tab to change mode' : ''}`}
        disabled={!chat.live || !draft.trim() || (chat.busy && !shellMode)}
      >
        {#if shellMode}Run <span class="codicon codicon-play"></span>{:else}Send <span class="codicon codicon-arrow-up"></span>{/if}
      </button>
    </div>
  </form>

  <UsageMeter {usage} />
</main>
