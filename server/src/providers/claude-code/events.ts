/**
 * Claude Code transcript records → `ConversationEvent`.
 *
 * The transcript is internal to a tool that ships frequently, not a public API
 * (report §10, risk 1). So the rule here is absolute: **an unrecognised record,
 * block or shape is logged and ignored, never thrown.** Claude Code's own
 * adapter does exactly this for exactly this reason — a format that gains a type
 * before tether learns about it must cost the user detail, never the session.
 * The raw terminal remains a complete, always-correct view of everything this
 * module drops.
 *
 * Every record carries `version`; `mapRecord` reports it so a mismatch against
 * the version the fixtures were captured from is detectable at runtime.
 *
 * What is deliberately dropped:
 *
 * - `isSidechain` records — a subagent's own thread. Its `Task` tool call and
 *   result are already in the main thread, which is what the user follows.
 * - `attachment` records — context Claude Code injects for itself (skill
 *   listings, hook output, file contents it re-read). Not conversation.
 * - The slash-command bookkeeping records (`<command-name>`, `<local-command-…>`)
 *   and the summary a compaction injects as a user message: the boundary event
 *   says a compaction happened, and the summary is written *to* the model.
 * - The DAG. `parentUuid` makes the transcript a tree — `/rewind` branches and
 *   all — and this maps it in file order, which is the order the user saw.
 *   ponytail: an abandoned branch stays visible; fix it when someone rewinds and
 *   complains, and fix it by walking back from the last leaf.
 */

import type { ConversationEvent, ToolCallEvent } from '@tether/shared';

import { capInput, capOutput } from '../cap.ts';

export type Mapped = {
  events: ConversationEvent[];
  /** From an `ai-title` record: Claude Code's own name for the session. */
  title?: string;
  /** The record's `version`, when it has one. */
  version?: string;
};

export type Warn = (message: string) => void;

const NONE: Mapped = { events: [] };

/**
 * Record types tether knows about and has nothing to render for. Listed so that
 * a type that is *not* here is genuinely new and worth a warning.
 */
const IGNORED = new Set([
  'attachment',
  'file-history-snapshot',
  'file-history-delta',
  'mode',
  'permission-mode',
  'last-prompt',
  'queue-operation',
  'summary',
]);

/** Slash-command bookkeeping Claude Code writes as user messages. */
const COMMAND_NOISE = /^<(command-name|command-message|command-args|local-command-)/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Epoch ms, or 0 for a record whose timestamp is missing or unparseable. */
function timestamp(record: Record<string, unknown>): number {
  const at = Date.parse(str(record['timestamp']) ?? '');
  return Number.isNaN(at) ? 0 : at;
}

function assistantBlocks(
  blocks: unknown[],
  uuid: string,
  at: number,
  warn: Warn,
): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  blocks.forEach((block, index) => {
    if (!isObject(block)) return;
    const id = `${uuid}#${index}`;
    switch (block['type']) {
      case 'text': {
        const text = str(block['text']) ?? '';
        if (text.trim() !== '') events.push({ kind: 'assistant', id, at, text });
        return;
      }
      case 'thinking':
      case 'redacted_thinking':
        // Presence only — Claude Code 2.1.220 writes the signature and an empty
        // `thinking` string, so there is no content to render even if we wanted it.
        events.push({ kind: 'thinking', id, at });
        return;
      case 'tool_use': {
        const tool = str(block['name']);
        const callId = str(block['id']);
        if (tool === undefined || callId === undefined) {
          warn(`assistant tool_use without name or id in ${uuid}`);
          return;
        }
        events.push({ kind: 'tool_call', id, at, tool, input: capInput(block['input']), callId });
        return;
      }
      default:
        warn(`unknown assistant block type ${String(block['type'])} in ${uuid}`);
    }
  });
  return events;
}

function userBlocks(blocks: unknown[], uuid: string, at: number, warn: Warn): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  blocks.forEach((block, index) => {
    if (!isObject(block)) return;
    const id = `${uuid}#${index}`;
    switch (block['type']) {
      case 'tool_result': {
        const callId = str(block['tool_use_id']);
        if (callId === undefined) {
          warn(`tool_result without tool_use_id in ${uuid}`);
          return;
        }
        events.push({
          kind: 'tool_result',
          id,
          at,
          callId,
          output: capOutput(block['content']),
          isError: block['is_error'] === true,
        });
        return;
      }
      case 'text': {
        const text = str(block['text']) ?? '';
        if (text.trim() !== '' && !COMMAND_NOISE.test(text)) {
          events.push({ kind: 'user', id, at, text });
        }
        return;
      }
      case 'image':
        // Nothing to show without shipping the bytes; the terminal has it.
        return;
      default:
        warn(`unknown user block type ${String(block['type'])} in ${uuid}`);
    }
  });
  return events;
}

/**
 * One transcript record → zero or more events. Never throws: a record it cannot
 * make sense of produces no events and one warning.
 */
export function mapRecord(record: unknown, warn: Warn = () => {}): Mapped {
  if (!isObject(record)) {
    warn('transcript record is not an object');
    return NONE;
  }
  const type = str(record['type']);
  if (type === undefined) {
    warn('transcript record has no type');
    return NONE;
  }
  const version = str(record['version']);
  const mapped = (events: ConversationEvent[]): Mapped =>
    version === undefined ? { events } : { events, version };

  if (type === 'ai-title') {
    const title = str(record['aiTitle']);
    return title === undefined ? NONE : { events: [], title };
  }
  if (IGNORED.has(type)) return mapped([]);

  if (type === 'system') {
    // Every other subtype (`turn_duration`, `stop_hook_summary`, …) is Claude
    // Code talking to itself. Unknown ones are not warned about: subtypes come
    // and go far faster than record types do.
    if (record['subtype'] !== 'compact_boundary') return mapped([]);
    const uuid = str(record['uuid']);
    if (uuid === undefined) return mapped([]);
    const meta = record['compactMetadata'];
    const trigger = isObject(meta) ? str(meta['trigger']) : undefined;
    return mapped([
      {
        kind: 'compaction',
        id: uuid,
        at: timestamp(record),
        ...(trigger === undefined ? {} : { trigger }),
      },
    ]);
  }

  if (type !== 'user' && type !== 'assistant') {
    warn(`unknown transcript record type ${type}`);
    return mapped([]);
  }

  // A subagent's own thread, or a record with no identity to hang an event on.
  if (record['isSidechain'] === true) return mapped([]);
  const uuid = str(record['uuid']);
  if (uuid === undefined) {
    warn(`${type} record without a uuid`);
    return mapped([]);
  }
  const at = timestamp(record);
  const message = record['message'];
  const content = isObject(message) ? message['content'] : undefined;

  if (typeof content === 'string') {
    if (type === 'assistant') return mapped([{ kind: 'assistant', id: uuid, at, text: content }]);
    // `isCompactSummary` is the summary a compaction feeds back to the model —
    // it is addressed to the model, not written by the user.
    if (record['isCompactSummary'] === true) return mapped([]);
    if (content.trim() === '' || COMMAND_NOISE.test(content)) return mapped([]);
    return mapped([{ kind: 'user', id: uuid, at, text: content }]);
  }
  if (Array.isArray(content)) {
    return mapped(
      type === 'assistant'
        ? assistantBlocks(content, uuid, at, warn)
        : userBlocks(content, uuid, at, warn),
    );
  }
  warn(`${type} record ${uuid} has no usable content`);
  return mapped([]);
}

/**
 * What a hook payload means to tether, if anything.
 *
 * Only the two events `installHook` registers produce one. Everything else —
 * including an event a future Claude Code adds and a payload whose fields have
 * moved — is `undefined` and one warning, by the same rule the transcript mapper
 * follows: the hook is an accelerator, and losing one costs a card a moment of
 * lateness, never the session.
 */
export type HookSignal =
  /** A tool call proposed but not yet in the transcript. Superseded by `callId`. */
  | { signal: 'pending'; e: ToolCallEvent }
  /** The agent has stopped and is waiting on the user. */
  | { signal: 'waiting'; detail?: string };

export function mapHook(
  payload: unknown,
  warn: Warn = () => {},
  now = Date.now(),
): HookSignal | undefined {
  if (!isObject(payload)) {
    warn('hook payload is not an object');
    return undefined;
  }
  const event = str(payload['hook_event_name']);
  switch (event) {
    case 'PreToolUse': {
      const tool = str(payload['tool_name']);
      const callId = str(payload['tool_use_id']);
      if (tool === undefined || callId === undefined) {
        warn('PreToolUse hook without tool_name or tool_use_id');
        return undefined;
      }
      return {
        signal: 'pending',
        // `id` is not a transcript uuid and must not look like one: this event
        // never enters the `seq` stream, and the client keys it by `callId`.
        e: {
          kind: 'tool_call',
          id: `pending:${callId}`,
          at: now,
          tool,
          input: capInput(payload['tool_input']),
          callId,
        },
      };
    }
    case 'Notification': {
      // Every Notification means the agent has stopped and wants the user —
      // a permission prompt, or an idle nudge. Claude Code's own words are the
      // detail; inventing a friendlier sentence would only be wrong later.
      const detail = str(payload['message']);
      return { signal: 'waiting', ...(detail === undefined || detail === '' ? {} : { detail }) };
    }
    default:
      warn(`unknown hook event ${String(event)}`);
      return undefined;
  }
}

/**
 * Map whole lines of NDJSON. A line that is not JSON is one warning and no
 * events — a truncated write reaches here only if the tailer's carry was lost,
 * and even then it must not take the conversation with it.
 */
export function mapLines(lines: readonly string[], warn: Warn = () => {}): Mapped {
  const events: ConversationEvent[] = [];
  let title: string | undefined;
  let version: string | undefined;
  for (const line of lines) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      warn('transcript line is not JSON');
      continue;
    }
    const result = mapRecord(record, warn);
    events.push(...result.events);
    if (result.title !== undefined) title = result.title;
    if (result.version !== undefined) version = result.version;
  }
  return {
    events,
    ...(title === undefined ? {} : { title }),
    ...(version === undefined ? {} : { version }),
  };
}
