/**
 * `ConversationEvent`s → the rows the view renders. All of the decisions live
 * here rather than in the JSX, for two reasons:
 *
 *  1. The tests run under `node --test` with type stripping and no DOM, so a
 *     decision inside a component is a decision nothing can check. What is shown
 *     collapsed (`tool`, `summary`, `failed`) and what is shown expanded
 *     (`input`, `result`) is therefore a property of the row, not of the markup —
 *     `conversation.tsx` only picks elements.
 *  2. Streaming append is incremental: {@link addEvents} appends to the rows it
 *     already built and drops any `seq` it has already applied, so the `since`
 *     replay after a reconnect cannot duplicate anything and no event costs a
 *     re-walk of the whole conversation.
 *
 * The rule the data layer set and this must not undo: **an unrecognised event
 * kind becomes a row, never an exception.** Claude Code's transcript format is
 * internal to a tool that ships weekly; the day it grows a kind, this view must
 * degrade to one grey line and keep rendering the rest.
 */

import type { ConversationEvent } from '@tether/shared';

/** An event with its position in the session's stream, as the server sends it. */
export type SeqEvent = { seq: number; e: ConversationEvent };

export type ToolRow = {
  key: string;
  row: 'tool';
  /** Collapsed: the tool's name and one line saying what it ran. */
  tool: string;
  summary: string;
  failed: boolean;
  /** Expanded: the call's input and what came back. `null` until it returns. */
  input: unknown;
  result: string | null;
};

export type Row =
  | { key: string; row: 'message'; who: 'user' | 'assistant'; text: string }
  | { key: string; row: 'thinking' }
  | { key: string; row: 'compaction' }
  /** An event this build does not understand. Deliberately says nothing else. */
  | { key: string; row: 'note'; text: string }
  | ToolRow;

/**
 * The fields worth putting on a collapsed card, most specific first. A card that
 * says only `Bash` is a card you have to open to learn anything, and an agent
 * session is mostly tool calls — the summary is what makes the list skimmable.
 */
const SUMMARY_FIELDS = [
  'command',
  // Before `path`: a `Grep` carries both, and what it searched for is the news.
  'pattern',
  'file_path',
  'path',
  'url',
  'query',
  'description',
  'prompt',
];

/** Fields whose value is a path, and so is the wrong way round for a phone. */
const PATH_FIELDS = new Set(['file_path', 'path']);

/**
 * A path clipped to its last two segments. CSS clips the *end* of a line, and a
 * column of cards each reading `/tmp/claude-1000/-home-galawayd…` says nothing —
 * which file was read is the whole content of a `Read` card. The full path is
 * one tap away in the card body.
 */
function shortPath(value: string): string {
  const parts = value.split('/').filter((part) => part !== '');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : value;
}

/** One line, whatever the input was: a card is a row, not a paragraph. */
export function summarise(input: unknown): string {
  if (typeof input !== 'object' || input === null) return oneLine(String(input ?? ''));
  const fields = input as Record<string, unknown>;
  for (const name of SUMMARY_FIELDS) {
    const value = fields[name];
    if (typeof value !== 'string' || value.trim() === '') continue;
    return oneLine(PATH_FIELDS.has(name) ? shortPath(value) : value);
  }
  // Nothing recognised — show the shape rather than nothing, and let CSS clip it.
  const rendered = JSON.stringify(input);
  return rendered === '{}' ? '' : oneLine(rendered ?? '');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The rows built so far, plus what {@link addEvents} needs to extend them:
 * `seq` is the highest applied, and `byCall` is where a `tool_result` finds the
 * card its `tool_call` already opened.
 */
export type Rows = {
  rows: readonly Row[];
  seq: number;
  byCall: Map<string, ToolRow>;
};

export function noRows(): Rows {
  return { rows: [], seq: 0, byCall: new Map() };
}

/**
 * Apply events to the rows. Returns the same object when nothing applied, so a
 * duplicate replay is not even a re-render; a new object — with a new `rows`
 * array, since Preact compares by identity — when something did.
 *
 * Events must arrive in `seq` order, which is what both the history route and
 * the `conv` channel promise. Anything at or below the highest applied `seq` is
 * dropped: after a reconnect the server replays from `since`, and a client that
 * asked twice, or asked while its own request was in flight, gets the overlap.
 */
export function addEvents(state: Rows, incoming: readonly SeqEvent[]): Rows {
  let rows: Row[] | undefined;
  let seq = state.seq;
  for (const { seq: at, e } of incoming) {
    if (at <= seq) continue;
    seq = at;
    const row = toRow(String(at), e, state.byCall);
    if (row === undefined) continue;
    rows ??= [...state.rows];
    rows.push(row);
  }
  if (seq === state.seq) return state;
  return { rows: rows ?? state.rows, seq, byCall: state.byCall };
}

/** Convenience for the tests and for a fresh history: rows from nothing. */
export function toRows(events: readonly SeqEvent[]): readonly Row[] {
  return addEvents(noRows(), events).rows;
}

/**
 * One event to one row, or to none. Returning `undefined` is how an event that
 * changes an existing row (a `tool_result`) and one this view deliberately does
 * not render (`status`, which is PR #10's badge) both say "no new row".
 */
function toRow(key: string, e: ConversationEvent, byCall: Map<string, ToolRow>): Row | undefined {
  switch (e.kind) {
    case 'user':
    case 'assistant':
      return { key, row: 'message', who: e.kind, text: e.text };
    case 'thinking':
      // Presence only. The transcript carries an empty `thinking` string, so
      // anything more specific than "it thought here" would be invented.
      return { key, row: 'thinking' };
    case 'compaction':
      return { key, row: 'compaction' };
    case 'tool_call': {
      const row: ToolRow = {
        key,
        row: 'tool',
        tool: e.tool,
        summary: summarise(e.input),
        failed: false,
        input: e.input,
        result: null,
      };
      byCall.set(e.callId, row);
      return row;
    }
    case 'tool_result': {
      const call = byCall.get(e.callId);
      if (call !== undefined) {
        call.result = e.output;
        call.failed = e.isError;
        return undefined;
      }
      // A result whose call never arrived — the mapper dropped a `tool_use` it
      // could not read. Showing the output under no name beats losing it.
      return {
        key,
        row: 'tool',
        tool: 'result',
        summary: '',
        failed: e.isError,
        input: undefined,
        result: e.output,
      };
    }
    case 'status':
      return undefined;
    default:
      // Never `throw`, never a blank. `e` is `never` here, which is the point:
      // this branch exists for the build of Claude Code that ships a kind this
      // build has never compiled against.
      return { key, row: 'note', text: `Unsupported event: ${kindOf(e)}` };
  }
}

function kindOf(e: unknown): string {
  const kind = (e as { kind?: unknown })?.kind;
  return typeof kind === 'string' && kind !== '' ? kind : 'unknown';
}
