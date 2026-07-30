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
 * - The summary a compaction injects as a user message: the boundary event says
 *   a compaction happened, and the summary is written *to* the model.
 * - The DAG. `parentUuid` makes the transcript a tree — `/rewind` branches and
 *   all — and this maps it in file order, which is the order the user saw.
 *   ponytail: an abandoned branch stays visible; fix it when someone rewinds and
 *   complains, and fix it by walking back from the last leaf.
 */

import type { ConversationEvent } from '@tether/shared';

import { capInput, capOutput } from '../cap.ts';
import type { HookSignal } from '../permission.ts';

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

/**
 * The slash-command records, and what each of them is for. Verified against
 * 2.1.220 by running commands in a pane and reading the transcript back:
 *
 * - `<command-name>` — the command, in its own text block, sometimes with
 *   `<command-args>` beside it. Each tag is matched **wherever it sits** rather
 *   than at the start, because the order is not stable: `/model` writes
 *   `<command-name>` first and `/init` writes `<command-message>` first, so
 *   anchoring loses one of them entirely.
 * - `<local-command-stdout>` / `-stderr` — what it printed. This is what makes a
 *   command *visible*: `/model sonnet` and `/effort high` write one, and without
 *   it the composer's own option bar changes a running agent with nothing on
 *   screen to show it.
 * - `<command-message>` is the command's display name and `<local-command-caveat>`
 *   is an instruction addressed to the model. Neither is conversation.
 *
 * Not every command writes any of these — `/resume`, `/cost` and `/status` are
 * pane-only, and `/clear` moves the session to a whole new transcript. That is a
 * property of the command, not something this can fix, and it is why the web
 * app's command table says where each one's answer will appear.
 */
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_OUT = /<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/;

/**
 * Claude Code writes its own colour codes into `<local-command-stdout>` — the
 * model name in `Set model to \x1b[1mSonnet 5\x1b[22m` is bold on the way to a
 * terminal. The browser is not one, so an SGR sequence left in would reach the
 * page as literal `[1m`.
 */
// An SGR sequence *is* a control sequence, and matching it is the point.
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * A slash-command record → at most one event. `undefined` for the two tags that
 * are bookkeeping rather than conversation, so the caller drops them exactly as
 * it did before this existed.
 */
function commandEvent(text: string, id: string, at: number): ConversationEvent | undefined {
  const clean = (value: string | undefined): string => (value ?? '').replace(SGR, '').trim();
  const name = clean(COMMAND_NAME.exec(text)?.[1]);
  if (name !== '') {
    const args = clean(COMMAND_ARGS.exec(text)?.[1]);
    return { kind: 'command', id, at, text: args === '' ? name : `${name} ${args}` };
  }
  const out = clean(COMMAND_OUT.exec(text)?.[1]);
  return out === '' ? undefined : { kind: 'command', id, at, text: out, output: true };
}

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
        if (text.trim() === '') return;
        if (COMMAND_NOISE.test(text)) {
          const command = commandEvent(text, id, at);
          if (command !== undefined) events.push(command);
          return;
        }
        events.push({ kind: 'user', id, at, text });
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
    if (content.trim() === '') return mapped([]);
    if (COMMAND_NOISE.test(content)) {
      const command = commandEvent(content, uuid, at);
      return mapped(command === undefined ? [] : [command]);
    }
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
 * Tools tether will never hold the agent on, whatever the user has open.
 *
 * `PreToolUse` fires for **every** tool call, and nothing in its payload says
 * whether Claude Code was going to prompt about it — verified on 2.1.220: a
 * `Read` the permission rules auto-allow produces exactly the same hook as a
 * `Bash` that opens a dialog, and `~/.claude/sessions/<pid>.json` reads `busy`
 * throughout either. So a hold applied to everything costs the timeout on every
 * auto-allowed call, and an agent reading twenty files with a phone open would
 * crawl. This list is the cheap half of the answer (the other half is that
 * nothing is held with nobody watching): the tools that are read-only, fire in
 * bursts, and are approved out of the box.
 *
 * Deliberately a *skip* list rather than a hold list. A tool tether has never
 * heard of — an MCP server's, or one Claude Code ships next month — is held,
 * because those are the ones that do prompt, and being late to a card costs a
 * timeout while missing the buttons costs the whole feature.
 *
 * ponytail: a coarse filter, not Claude Code's permission engine, and it cannot
 * be one — the rules live in the user's own settings and are the provider's to
 * apply. `Read` outside an allowed root does prompt, and tether will not have
 * held it; that answer is one tap away in the terminal, which is where it always
 * was. Upgrade path if this ever matters: none worth taking, since re-deriving
 * the engine is how tether would start disagreeing with the agent about what
 * needs approving.
 */
export const NEVER_HELD = new Set([
  'Read',
  'Glob',
  'Grep',
  'TodoWrite',
  'BashOutput',
  'NotebookRead',
  'WebSearch',
]);

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
        // `perhaps`, never `prompting`: a `PreToolUse` says nothing about
        // whether Claude Code was going to ask. See `HoldBasis`.
        hold: NEVER_HELD.has(tool) ? 'never' : 'perhaps',
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
