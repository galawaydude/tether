/**
 * Codex rollout records → `ConversationEvent`.
 *
 * The rollout is append-only NDJSON at
 * `$CODEX_HOME/sessions/<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl`, one
 * `{timestamp, type, payload}` per line. Same rule as the Claude Code mapper,
 * for the same reason: **an unrecognised record, payload type or shape is
 * warned about and ignored, never thrown.** The format is internal to a tool
 * that ships weekly, and a mapper that throws loses the user's session while the
 * terminal remains a complete view of everything dropped.
 *
 * Two things about Codex's vocabulary decide most of what is here.
 *
 * **`event_msg` wins over `response_item`.** They partially duplicate each other
 * — `event_msg/user_message` and `event_msg/agent_message` mirror
 * `response_item/message` — and `event_msg` is the de-chunked, UI-facing one
 * that carries `phase`. So every `response_item/message` is dropped, including
 * the `role: "developer"` ones, which are the system prompt rather than
 * conversation.
 *
 * **Nothing here carries a record id.** Only `response_item/*` have provider ids
 * (`fc_…`, `rs_…`, `ctc_…`); `event_msg/*` have none at all, so an id is
 * synthesized from the record's own timestamp and its position in the batch —
 * the same `<something>#<index>` shape the Claude Code mapper uses.
 *
 * ponytail: two `event_msg` records of the same kind in the same millisecond
 * *and* at the same index of two different batches would collide. They are
 * separated by model turns in practice. The spike's suggested fix is the byte
 * offset in the rollout, which means plumbing offsets through `../tail.ts` for
 * one provider; do that if a real collision ever shows up.
 *
 * What is deliberately dropped, and why:
 *
 * - `turn_context`, `world_state`, `thread_settings_applied`, `token_count` and
 *   `session_meta` — configuration and accounting, not conversation. The last
 *   one is still read, for `cli_version`.
 * - `task_started`, `task_complete` and `turn_aborted` — `status.ts` folds those
 *   into the session state, which is not a conversation event (it has no `id`;
 *   see the shape in `@tether/shared`).
 * - `patch_apply_end` — it duplicates the `custom_tool_call_output` for the same
 *   `call_id`, and that is where the result card comes from.
 *
 * Nothing in `providers/` may import from `web/` (report §5).
 */

import type { ConversationEvent } from '@tether/shared';

import { capInput, capOutput } from '../cap.ts';

export type Mapped = {
  events: ConversationEvent[];
  /** From `session_meta`: the Codex CLI version that wrote this rollout. */
  version?: string;
};

export type Warn = (message: string) => void;

const NONE: Mapped = { events: [] };

/**
 * Top-level record types with nothing inside them to render. `turn_context` and
 * `world_state` are per-turn configuration — model, sandbox policy, workspace
 * roots — and carry no payload `type` at all, which is why they are matched here
 * rather than in `IGNORED_PAYLOADS`.
 */
const IGNORED_RECORDS = new Set(['turn_context', 'world_state']);

/**
 * Payload types tether knows about and has nothing to render for. Listed so
 * that a payload type that is *not* here is genuinely new and worth a warning.
 */
const IGNORED_PAYLOADS = new Set([
  'message',
  'thread_settings_applied',
  'token_count',
  'task_started',
  'task_complete',
  'turn_aborted',
  'patch_apply_end',
]);

/**
 * The one place the two vocabularies disagree on a name. The hooks report
 * Claude Code's `Bash`; the rollout reports Codex's own `exec_command`. Both
 * agree on `apply_patch`, and those are the only two tools this spike saw, so
 * this is one verified entry rather than a table of guesses — anything else
 * passes through under the name Codex gave it.
 */
const TOOL_NAMES = new Map([['exec_command', 'Bash']]);

/** Codex's own name for a tool, under the name the rest of tether uses. */
export function toolName(name: string): string {
  return TOOL_NAMES.get(name) ?? name;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Whether a tool result reports failure.
 *
 * Codex has no `isError` field: `function_call_output.output` and
 * `custom_tool_call_output.output` are unstructured strings with the status in a
 * preamble — `Process exited with code 0` for `exec_command`, `Exit code: 0` for
 * `apply_patch`. A sandbox refusal carries neither and is prose:
 * `"approval policy is UnlessTrusted; reject command — …"`.
 *
 * So success is the positive case and everything else is an error: a zero exit
 * must be *stated* to be believed. Getting this backwards would show a refused
 * command as a successful one, which is the direction that misleads.
 */
export function isErrorOutput(output: string): boolean {
  return !/^(?:Process exited with code|Exit code:) 0\b/m.test(output);
}

/** `function_call.arguments` is JSON in a string; anything else is shown as it is. */
function parseArguments(value: unknown): unknown {
  const text = str(value);
  if (text === undefined) return value;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toolCall(
  payload: Record<string, unknown>,
  id: string,
  at: number,
  input: unknown,
  warn: Warn,
): ConversationEvent[] {
  const callId = str(payload['call_id']);
  const name = str(payload['name']);
  if (callId === undefined || name === undefined) {
    warn(`codex ${String(payload['type'])} without call_id or name`);
    return [];
  }
  return [{ kind: 'tool_call', id, at, tool: toolName(name), input: capInput(input), callId }];
}

function toolResult(
  payload: Record<string, unknown>,
  id: string,
  at: number,
  warn: Warn,
): ConversationEvent[] {
  const callId = str(payload['call_id']);
  if (callId === undefined) {
    warn(`codex ${String(payload['type'])} without call_id`);
    return [];
  }
  const output = capOutput(payload['output']);
  return [{ kind: 'tool_result', id, at, callId, output, isError: isErrorOutput(output) }];
}

/**
 * One rollout line → zero or more events. Never throws: a record it cannot make
 * sense of produces no events and one warning.
 *
 * `index` is the record's position in the batch and only ever feeds the
 * synthesized id.
 */
export function mapRecord(record: unknown, index = 0, warn: Warn = () => {}): Mapped {
  if (!isObject(record)) {
    warn('codex rollout record is not an object');
    return NONE;
  }
  const type = str(record['type']);
  if (type === undefined) {
    warn('codex rollout record has no type');
    return NONE;
  }
  const stamp = Date.parse(str(record['timestamp']) ?? '');
  const at = Number.isNaN(stamp) ? 0 : stamp;
  const payload = record['payload'];

  if (type === 'session_meta') {
    const version = isObject(payload) ? str(payload['cli_version']) : undefined;
    return version === undefined ? NONE : { events: [], version };
  }
  if (IGNORED_RECORDS.has(type)) return NONE;
  if (type !== 'event_msg' && type !== 'response_item') {
    warn(`unknown codex rollout record type ${type}`);
    return NONE;
  }
  if (!isObject(payload)) {
    warn(`codex ${type} record has no payload`);
    return NONE;
  }

  const kind = str(payload['type']);
  if (kind === undefined) {
    warn(`codex ${type} payload has no type`);
    return NONE;
  }
  if (IGNORED_PAYLOADS.has(kind)) return NONE;

  // Unique where Codex gives one, synthesized where it does not.
  const id = str(payload['id']) ?? `${at}#${index}`;

  switch (kind) {
    case 'user_message': {
      const text = str(payload['message']) ?? '';
      return text.trim() === '' ? NONE : { events: [{ kind: 'user', id, at, text }] };
    }
    case 'agent_message': {
      const text = str(payload['message']) ?? '';
      if (text.trim() === '') return NONE;
      // `commentary` is what the TUI collapses once the `final_answer` lands.
      // Without carrying it through, the two read as duplicated assistant text.
      const phase = payload['phase'];
      return {
        events: [
          {
            kind: 'assistant',
            id,
            at,
            text,
            ...(phase === 'commentary' || phase === 'final_answer' ? { phase } : {}),
          },
        ],
      };
    }
    case 'reasoning':
      // Presence only, and genuinely so: `summary` is empty and
      // `encrypted_content` is exactly that.
      return { events: [{ kind: 'thinking', id, at }] };
    case 'function_call':
      return { events: toolCall(payload, id, at, parseArguments(payload['arguments']), warn) };
    case 'custom_tool_call':
      return { events: toolCall(payload, id, at, payload['input'], warn) };
    case 'function_call_output':
    case 'custom_tool_call_output':
      return { events: toolResult(payload, id, at, warn) };
    default:
      warn(`unknown codex ${type} payload type ${kind}`);
      return NONE;
  }
}

/**
 * Map whole lines of NDJSON. A line that is not JSON is one warning and no
 * events — a truncated write reaches here only if the tailer's carry was lost,
 * and even then it must not take the conversation with it.
 */
export function mapLines(lines: readonly string[], warn: Warn = () => {}): Mapped {
  const events: ConversationEvent[] = [];
  let version: string | undefined;
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      warn('codex rollout line is not JSON');
      return;
    }
    const result = mapRecord(record, index, warn);
    events.push(...result.events);
    if (result.version !== undefined) version = result.version;
  });
  return { events, ...(version === undefined ? {} : { version }) };
}
