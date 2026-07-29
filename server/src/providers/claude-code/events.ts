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

import type { ConversationEvent } from '@tether/shared';

/**
 * A tool result can be a whole file, and so can a tool call's input — a `Write`
 * or an `Edit` carries the file body in it. The terminal is the full-fidelity
 * view, so a card in the conversation is capped rather than allowed to put
 * megabytes in the replay buffer and on the wire. The same number for both:
 * asymmetric caps are the uncapped one wearing a hat.
 */
export const MAX_OUTPUT = 16_000;

const TRUNCATED = '\n…[truncated by tether]';

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

/** A tool result's content is a string, or blocks, or something new. */
function output(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((block) => (isObject(block) ? (str(block['text']) ?? '') : ''))
            .filter((part) => part !== '')
            .join('\n')
        : JSON.stringify(content ?? null);
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}${TRUNCATED}` : text;
}

function eachString(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) for (const item of value) eachString(item, visit);
  else if (isObject(value)) for (const item of Object.values(value)) eachString(item, visit);
}

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]),
    );
  }
  return value;
}

/**
 * The longest a single string may be for the whole value to fit in `total`,
 * sharing what the short strings do not need out among the long ones. Every
 * string is measured against the same limit, so which one comes first in the
 * object decides nothing.
 */
function fieldLimit(lengths: readonly number[], total: number): number {
  let remaining = total;
  let count = lengths.length;
  for (const length of [...lengths].sort((a, b) => a - b)) {
    const share = Math.floor(remaining / count);
    if (length > share) return share;
    remaining -= length;
    count -= 1;
  }
  return Infinity;
}

/**
 * The same cap for a `tool_use` input, spent as an equal share per string rather
 * than first-come: an `Edit` whose `old_string` is huge must not leave
 * `new_string` as a bare marker, which reads as a plausible and wrong edit. The
 * shape is kept rather than the value stringified or fields dropped — it is
 * structured, the UI renders it as fields, and it is the strings inside it that
 * are long — and each cut carries the marker a tool result's does.
 */
export function capInput(value: unknown, total = MAX_OUTPUT): unknown {
  const lengths: number[] = [];
  eachString(value, (text) => lengths.push(text.length));
  const limit = fieldLimit(lengths, total);
  if (limit === Infinity) return value;
  return mapStrings(value, (text) =>
    text.length > limit ? `${text.slice(0, limit)}${TRUNCATED}` : text,
  );
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
          output: output(block['content']),
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
