// Folds recorded or live ACP traffic into chat items for rendering.
import type { ContentBlock, PlanEntry, ToolCallContent, ToolCallLocation } from '@agentclientprotocol/sdk';
import { looksLikeFile } from './files.ts';
import {
  SHELL_CONTEXT_META,
  formFields,
  type FormContent,
  type FormField,
  type TranscriptEntry
} from '../../../shared/messages.ts';

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; messageId?: string | null }
  | { kind: 'thought'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      title: string;
      /** What the call is for, in words, when the agent says (e.g. Claude Code's Bash description). */
      description: string | null;
      status: string;
      toolKind: string;
      details: string[];
      files: string[];
    }
  | { kind: 'plan'; id: string; entries: PlanEntry[] }
  | { kind: 'permission'; id: string; title: string; outcome: string | null }
  | { kind: 'stop'; id: string; reason: string }
  | { kind: 'shell'; id: string; runId: string; command: string; output: string; exitCode: number | null; timedOut: boolean }
  | { kind: 'question'; id: string; message: string; fields: FormField[]; answers: QuestionAnswer[] | null; skipped: boolean }
  | { kind: 'show'; id: string; files: string[]; message: string | null };

/** One answered field: what was asked and what the user picked or wrote. */
export interface QuestionAnswer {
  question: string;
  answer: string;
}

function answers(fields: FormField[], content: FormContent | null, message: string): QuestionAnswer[] {
  if (!content) return [];
  return fields
    .map((field) => {
      const value = content[field.key];
      const picked = Array.isArray(value) ? value.join(', ') : value === undefined || value === '' ? '' : String(value);
      const other = field.other ? String(content[field.other.key] ?? '').trim() : '';
      return {
        question: field.description ?? field.title ?? message,
        answer: [picked, other].filter(Boolean).join(' · ')
      };
    })
    .filter((answer) => answer.answer);
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'resource_link':
      return `[${block.name}](${block.uri})`;
    case 'resource':
      return 'text' in block.resource ? block.resource.text : `[${block.resource.uri}]`;
    case 'image':
      return '[image]';
    case 'audio':
      return '[audio]';
    default:
      return '';
  }
}

const tokens = (count: number) => (count >= 1000 ? `${(count / 1000).toFixed(1)}k` : `${count}`);

/** Claude Code's `/compact` reports the context it freed as the tool call's output. */
function compactTitle(rawOutput: unknown): string | undefined {
  const output = rawOutput as { preTokens?: unknown; postTokens?: unknown } | null | undefined;
  if (typeof output?.preTokens !== 'number' || typeof output.postTokens !== 'number') return undefined;
  return `Compacted the conversation: ${tokens(output.preTokens)} → ${tokens(output.postTokens)} tokens`;
}

/** Files a tool call touched that a preview can show, e.g. a figure it wrote. */
function toolFiles(locations: ToolCallLocation[] | null | undefined): string[] {
  return [...new Set((locations ?? []).map((location) => location.path).filter(looksLikeFile))];
}

function toolDescription(rawInput: unknown): string | null {
  const description = (rawInput as { description?: unknown } | null | undefined)?.description;
  return typeof description === 'string' && description.trim() ? description.trim() : null;
}

function toolDetails(content: ToolCallContent[] | null | undefined): string[] {
  if (!content) return [];
  return content.map((item) => {
    if (item.type === 'content') return blockText(item.content);
    if (item.type === 'diff') return `edited ${item.path}`;
    return 'terminal output';
  });
}

export function buildItems(entries: TranscriptEntry[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>();
  let pendingPermission: Extract<ChatItem, { kind: 'permission' }> | undefined;
  let pendingQuestion: Extract<ChatItem, { kind: 'question' }> | undefined;
  const shells = new Map<string, Extract<ChatItem, { kind: 'shell' }>>();

  entries.forEach((entry, index) => {
    const id = `${index}`;
    const last = items.at(-1);
    switch (entry.kind) {
      case 'prompt':
        items.push({
          kind: 'user',
          id,
          // The agent also got the user's earlier shell commands; the chat shows them as their own cards.
          text: entry.prompt
            .filter((block) => !block._meta?.[SHELL_CONTEXT_META])
            .map(blockText)
            .join('\n')
        });
        break;
      case 'turn_end':
        if (entry.stopReason && entry.stopReason !== 'end_turn') {
          items.push({ kind: 'stop', id, reason: entry.stopReason.replace(/_/g, ' ') });
        }
        break;
      case 'permission': {
        pendingPermission = {
          kind: 'permission',
          id,
          title: entry.toolCall?.title ?? 'a tool call',
          outcome: null
        };
        items.push(pendingPermission);
        break;
      }
      case 'permission_outcome':
        if (pendingPermission) {
          pendingPermission.outcome =
            entry.outcome?.outcome === 'selected' ? entry.outcome.optionId : 'cancelled';
          pendingPermission = undefined;
        }
        break;
      case 'shell': {
        const shell = { kind: 'shell' as const, id, runId: entry.runId, command: entry.command, output: '', exitCode: null, timedOut: false };
        shells.set(entry.runId, shell);
        items.push(shell);
        break;
      }
      case 'shell_output': {
        const shell = shells.get(entry.runId);
        if (shell) shell.output += entry.data;
        break;
      }
      case 'shell_end': {
        const shell = shells.get(entry.runId);
        if (!shell) break;
        shell.exitCode = entry.exitCode;
        shell.timedOut = entry.timedOut;
        // Recorded history carries the output only here.
        if (entry.output !== undefined) shell.output = entry.output;
        break;
      }
      case 'show':
        items.push({ kind: 'show', id, files: entry.files, message: entry.message ?? null });
        break;
      case 'question':
        // The question card replaces the row of the tool call that asked it (e.g. AskUserQuestion).
        if (entry.toolCallId && tools.has(entry.toolCallId)) {
          const tool = tools.get(entry.toolCallId)!;
          items.splice(items.indexOf(tool), 1);
          tools.delete(entry.toolCallId);
        }
        pendingQuestion = {
          kind: 'question',
          id,
          message: entry.message,
          fields: formFields(entry.requestedSchema),
          answers: null,
          skipped: false
        };
        items.push(pendingQuestion);
        break;
      case 'question_outcome':
        if (pendingQuestion) {
          pendingQuestion.answers = answers(pendingQuestion.fields, entry.content, pendingQuestion.message);
          pendingQuestion.skipped = entry.action !== 'accept' || pendingQuestion.answers.length === 0;
          pendingQuestion = undefined;
        }
        break;
      case 'update': {
        const update = entry.update;
        switch (update.sessionUpdate) {
          case 'agent_message_chunk': {
            const text = blockText(update.content);
            const messageId = update.messageId;
            // Chunks of one message join; a new message id starts a new one.
            if (last?.kind === 'assistant' && (!messageId || !last.messageId || last.messageId === messageId)) {
              // Claude Code sends the output of some local commands (e.g. `/context`) twice.
              if (text.length > 40 && text.trim() === last.text.trim()) break;
              last.text += text;
              last.messageId ??= messageId;
            } else items.push({ kind: 'assistant', id, text, messageId });
            break;
          }
          case 'agent_thought_chunk': {
            const text = blockText(update.content);
            if (last?.kind === 'thought') last.text += text;
            else items.push({ kind: 'thought', id, text });
            break;
          }
          case 'tool_call': {
            const tool = {
              kind: 'tool' as const,
              id,
              title: update.title,
              description: toolDescription(update.rawInput),
              status: update.status ?? 'pending',
              toolKind: update.kind ?? 'other',
              details: toolDetails(update.content),
              files: toolFiles(update.locations)
            };
            tools.set(update.toolCallId, tool);
            items.push(tool);
            break;
          }
          case 'tool_call_update': {
            const tool = tools.get(update.toolCallId);
            if (!tool) break;
            if (update.title) tool.title = update.title;
            tool.description = toolDescription(update.rawInput) ?? tool.description;
            if (update.status) tool.status = update.status;
            if (update.content) tool.details = toolDetails(update.content);
            if (update.locations) tool.files = toolFiles(update.locations);
            const compacted = compactTitle(update.rawOutput);
            if (compacted) tool.title = compacted;
            break;
          }
          case 'plan':
            if (last?.kind === 'plan') last.entries = update.entries;
            else items.push({ kind: 'plan', id, entries: update.entries });
            break;
        }
        break;
      }
    }
  });
  // The same, when the two copies came with different message ids.
  return items.filter((item, index) => {
    const previous = items[index - 1];
    return !(item.kind === 'assistant' && previous?.kind === 'assistant' && previous.text.trim() === item.text.trim());
  });
}
