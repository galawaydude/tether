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
 * synthesized from the record's own timestamp and its **line number in the
 * rollout** — the same `<something>#<index>` shape the Claude Code mapper uses,
 * and stable for the same reason its is. The line number is the file's and not
 * the batch's: `mapLines` takes the index its first line sits at, so the same
 * record carries the same id whether a client read it from the history route in
 * one go or received it live one line at a time. Pass the wrong offset and a
 * refetch renumbers every card the browser is holding.
 *
 * ponytail: a line number is only unique while the file is append-only. Both
 * providers only ever append, and `../tail.ts` starts over from byte 0 if one
 * ever shrinks; a rollout that is rewritten in place would renumber.
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
import type { HookSignal } from '../permission.ts';

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
 *
 * Only the preamble states it. Everything after the `Output:` line is the
 * command's own stdout, which can say anything at all — `printf 'Process exited
 * with code 0'; exit 1` would otherwise render a failure as a success, which is
 * exactly the direction above.
 */
export function isErrorOutput(output: string): boolean {
  const [preamble = output] = output.split('\nOutput:\n');
  return !/^(?:Process exited with code|Exit code:) 0\b/m.test(preamble);
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
 * `index` is the record's line number in the rollout and only ever feeds the
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
 * A Codex hook payload → the one signal tether answers on.
 *
 * Only `PermissionRequest` is mapped, and that is not a subset of what the
 * installer registers — it is the only Codex event that *needs* an answer.
 * Everything else tether asks Codex for goes to the hook log and is folded into
 * the session state by `status.ts`; only this one arrives over HTTP, because
 * only this one has a decision to write back (`hooks.ts`).
 *
 * Note what this is not, and how it differs from Claude Code's `mapHook`.
 * `PreToolUse` there is a *proposal*: Claude Code writes nothing to its
 * transcript during a prompt, so the card has to be invented from the hook and
 * is superseded later. Codex flushes its `function_call` before the dialog goes
 * up (the Codex spike: report risk #2 does not exist for Codex), so the card is
 * already on screen and what this adds to it is the buttons — which is why the
 * signal is `prompting` rather than `perhaps`, and why the caller must not treat
 * "the transcript already has this call" as a reason to drop it.
 *
 * `callId` is supplied by the caller because Codex does not supply it: verified
 * against 0.145.0's own hook schema, `PermissionRequest` carries `session_id`,
 * `turn_id`, `tool_name` and `tool_input` and **no `tool_use_id`**. It is a
 * correlation, made in `CodexStatus#correlate` and limited in the ways set out
 * there. `undefined` is a normal answer and the only safe response to it is to
 * report the prompt without buttons — hence `waiting` rather than a `pending`
 * keyed by a call tether guessed at.
 */
export function mapHook(
  payload: unknown,
  callId: string | undefined,
  warn: Warn = () => {},
  now = Date.now(),
): HookSignal | undefined {
  if (!isObject(payload)) {
    warn('codex hook payload is not an object');
    return undefined;
  }
  const event = str(payload['hook_event_name']);
  if (event !== 'PermissionRequest') {
    warn(`unanswerable codex hook event ${String(event)}`);
    return undefined;
  }
  const tool = str(payload['tool_name']);
  if (tool === undefined) {
    warn('codex PermissionRequest hook without tool_name');
    return undefined;
  }
  // The badge and the tool's name, and nothing that could put a live button on
  // a card. `status.ts` will have said the same thing off the hook log; saying
  // it here too costs one `#setState` that changes nothing.
  if (callId === undefined) return { signal: 'waiting', detail: tool };
  return {
    signal: 'pending',
    hold: 'prompting',
    // `id` is not a rollout id and must not look like one: this event never
    // enters the `seq` stream, and the client keys it by `callId`.
    e: {
      kind: 'tool_call',
      id: `pending:${callId}`,
      at: now,
      // Claude Code's vocabulary already: the hooks say `Bash` where the
      // rollout says `exec_command`, so the card and the record agree without
      // `toolName` being asked. Asked anyway — it is a no-op for a name that is
      // already normalised, and the alternative is two rules for one thing.
      tool: toolName(tool),
      input: capInput(payload['tool_input']),
      callId,
    },
  };
}

/**
 * Map whole lines of NDJSON. A line that is not JSON is one warning and no
 * events — a truncated write reaches here only if the tailer's carry was lost,
 * and even then it must not take the conversation with it.
 *
 * `from` is the rollout line number `lines[0]` sits at, counted from byte 0 and
 * counting blank lines: it is what makes a synthesized id the same in a live
 * batch and in a whole-file read. A caller with the whole file passes 0.
 */
export function mapLines(lines: readonly string[], warn: Warn = () => {}, from = 0): Mapped {
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
    const result = mapRecord(record, from + index, warn);
    events.push(...result.events);
    if (result.version !== undefined) version = result.version;
  });
  return { events, ...(version === undefined ? {} : { version }) };
}
