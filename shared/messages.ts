// Messages between the extension host and a chat tab. The webview never sees
// worker tokens or credentials; it renders one session and sends user intents.
import type {
  ContentBlock,
  PermissionOption,
  RequestPermissionOutcome,
  SessionConfigOption,
  SessionUpdate,
  StopReason,
  ToolCallUpdate
} from '@agentclientprotocol/sdk';

export type AgentName = 'dsh' | 'claude' | 'codex';

// One rendered chat item. Recorded transcripts and live traffic share this
// shape, so the webview renders both the same way.
export type TranscriptEntry =
  | { t: string; kind: 'prompt'; prompt: ContentBlock[] }
  | { t: string; kind: 'update'; update: SessionUpdate }
  | { t: string; kind: 'turn_end'; stopReason: StopReason | null }
  | { t: string; kind: 'permission'; toolCall: ToolCallUpdate | null; options: PermissionOption[] }
  | { t: string; kind: 'permission_outcome'; outcome: RequestPermissionOutcome | null }
  | { t: string; kind: 'question'; message: string; requestedSchema: FormSchema; toolCallId?: string }
  // The user's own shell commands (`!command`); output streams live and is recorded at the end.
  | { t: string; kind: 'shell'; runId: string; command: string }
  | { t: string; kind: 'shell_output'; runId: string; data: string }
  | { t: string; kind: 'shell_end'; runId: string; exitCode: number; timedOut: boolean; output?: string }
  | { t: string; kind: 'question_outcome'; action: QuestionAction; content: FormContent | null }
  // Files the agent showed the user with `codeflower-show`; the client records which chat they belong to.
  | { t: string; kind: 'show'; files: string[]; message?: string };

/** Marks the prompt block that tells the agent about the user's shell commands. */
export const SHELL_CONTEXT_META = 'codeflower/shellContext';

/** An agent's question as an ACP form elicitation, e.g. Claude Code's AskUserQuestion. */
export interface PendingQuestion {
  requestId: number;
  message: string;
  requestedSchema: FormSchema;
}

export type QuestionAction = 'accept' | 'decline' | 'cancel';
export type FormContent = Record<string, string | number | boolean | string[]>;

/** The JSON Schema subset ACP forms use: an object of primitive fields. */
export interface FormSchema {
  type?: 'object';
  properties?: Record<string, FormProperty>;
  required?: string[];
}

export interface FormProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string;
  description?: string;
  enum?: string[];
  oneOf?: FormChoice[];
  items?: { enum?: string[]; anyOf?: FormChoice[] };
}

export interface FormChoice {
  const: string;
  title?: string;
  description?: string;
}

export interface FormField {
  key: string;
  title: string | null;
  description: string | null;
  kind: 'single' | 'multi' | 'text' | 'number' | 'boolean';
  choices: { value: string; title: string; description: string | null }[];
  required: boolean;
  /** The free-text "Other" field that belongs to this question, if any. */
  other: FormField | null;
}

/** Reads a form schema; `<key>_custom` text fields attach to `<key>` as its "Other" box. */
export function formFields(schema: FormSchema): FormField[] {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const field = (key: string, property: FormProperty): FormField => {
    const options = property.oneOf ?? property.items?.anyOf;
    const values = property.enum ?? property.items?.enum;
    const choices = options
      ? options.map((choice) => ({ value: choice.const, title: choice.title ?? choice.const, description: choice.description ?? null }))
      : (values ?? []).map((value) => ({ value, title: value, description: null }));
    const kind: FormField['kind'] =
      property.type === 'array'
        ? 'multi'
        : choices.length
          ? 'single'
          : property.type === 'boolean'
            ? 'boolean'
            : property.type === 'number' || property.type === 'integer'
              ? 'number'
              : 'text';
    return {
      key,
      title: property.title ?? null,
      description: property.description ?? null,
      kind,
      choices,
      required: required.has(key),
      other: null
    };
  };
  const fields: FormField[] = [];
  const byKey = new Map<string, FormField>();
  for (const [key, property] of Object.entries(properties)) {
    const owner = key.endsWith('_custom') ? byKey.get(key.slice(0, -'_custom'.length)) : undefined;
    if (owner && property.type === 'string' && !owner.other) {
      owner.other = field(key, property);
      continue;
    }
    const created = field(key, property);
    byKey.set(key, created);
    fields.push(created);
  }
  return fields;
}

export interface PendingPermission {
  requestId: number;
  toolCall: ToolCallUpdate | null;
  options: PermissionOption[];
}

export interface ChatState {
  title: string;
  subtitle: string;
  /** Picks the agent's color in the header; unknown while the worker connects. */
  agent?: AgentName;
  /** The session runs on the connected worker and accepts prompts. */
  live: boolean;
  busy: boolean;
}

/** What the session is doing, shown on its tab and in its header. */
export type SessionStatus = 'ready' | 'waiting' | 'working' | 'offline';

export function sessionStatus(state: ChatState, waitingForUser: boolean): SessionStatus {
  if (!state.live) return 'offline';
  if (waitingForUser) return 'waiting';
  return state.busy ? 'working' : 'ready';
}

export type HostMessage =
  | { type: 'state'; state: ChatState }
  | { type: 'transcript'; entries: TranscriptEntry[] }
  | { type: 'entry'; entry: TranscriptEntry }
  | { type: 'permission'; request: PendingPermission | null }
  | { type: 'question'; request: PendingQuestion | null }
  /** The session's settings the agent offers: mode, model, effort, … */
  | { type: 'config'; options: SessionConfigOption[] }
  | { type: 'notice'; level: 'info' | 'error'; message: string; action?: { id: 'signIn'; label: string } }
  /** A file from the sandbox the chat asked for, e.g. a figure the agent looked at; null if unavailable. */
  | { type: 'fileData'; key: string; dataUrl: string | null };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'prompt'; text: string }
  | { type: 'cancel' }
  | { type: 'permissionResponse'; requestId: number; optionId: string | null }
  | { type: 'setConfig'; configId: string; value: string | boolean }
  | { type: 'shell'; command: string }
  | { type: 'cancelShell'; runId: string }
  | { type: 'questionResponse'; requestId: number; action: QuestionAction; content: FormContent | null }
  /** A file path in the chat was clicked: show it in a preview tab. */
  | { type: 'openFile'; path: string }
  | { type: 'fileData'; path: string; key: string }
  | { type: 'action'; id: 'signIn' };

/** A file in the sandbox, as `_codeflower/files/stat` and `codeflower-show` report it. */
export interface SandboxFile {
  path: string;
  size: number;
  mtimeMs: number;
  mimeType: string;
}

/** What a preview tab shows: one file the agent (or the user) opened. */
export interface PreviewState {
  file: SandboxFile;
  /** Base64 contents; null while loading or when the file cannot be shown. */
  data: string | null;
  error: string | null;
  title: string;
  /** The agent's note about the file, from `codeflower-show --message`. */
  message: string | null;
  /** Where the user's feedback goes; null when no chat of the worker is open. */
  chat: { title: string; busy: boolean } | null;
  /** The worker is connected and the file is watched for changes. */
  live: boolean;
}

export type PreviewHostMessage =
  | { type: 'preview'; state: PreviewState }
  /** A file a report refers to (e.g. an image in Markdown), as a data URL. */
  | { type: 'asset'; path: string; dataUrl: string | null }
  | { type: 'feedbackSent'; queued: boolean }
  /** Text for the feedback box (from the interactive report), for the user to send. */
  | { type: 'draft'; text: string };

export type PreviewWebviewMessage =
  | { type: 'ready' }
  /** Open the HTML file with its scripts running, in its own tab. */
  | { type: 'interactive' }
  | { type: 'feedback'; text: string }
  | { type: 'asset'; path: string }
  | { type: 'openFile'; path: string }
  | { type: 'save' }
  | { type: 'showChat' };
