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

import type { ConversationEvent, SessionState, ToolCallEvent } from '@tether/shared';

import { MAX_TEXT } from './keys.ts';
import type { Status } from './terminal.tsx';

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
  /**
   * The card was built from the provider's pre-tool hook and the transcript has
   * not caught up. It is the same card either way — this only lets the view say
   * "asking to run this" rather than "running this".
   */
  pending: boolean;
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
 * A message sent from the composer, before the transcript has shown it back.
 *
 * `undelivered` is the sentence saying it never left, or `null` while it still
 * can. It is a state the echo enters rather than an exit: the text is the thing
 * the user would otherwise lose, so an undeliverable message stays on screen and
 * is marked, never dropped and never silently retired.
 */
export type Echo = { text: string; undelivered: string | null };

/**
 * The rows built so far, plus what {@link addEvents} needs to extend them:
 * `seq` is the highest applied, and `byCall` is where a `tool_result` finds the
 * card its `tool_call` already opened.
 */
export type Rows = {
  rows: readonly Row[];
  seq: number;
  byCall: Map<string, ToolRow>;
  /**
   * Messages sent from the composer that the transcript has not shown back yet,
   * oldest first — the optimistic echo. Rendered after {@link Rows.rows}, which
   * is where they belong: both providers record the user's message when the turn
   * starts, well before any reply, so an echo is only ever the newest thing in
   * the conversation and is gone by the time anything could follow it.
   *
   * Held apart from `rows` rather than mixed in, for the same reason `pending`
   * and `state` are not `conv` frames: a sent message has no `seq` until the
   * transcript gives it one, and inventing a position for it would make the
   * history route and a live tailer disagree about which event is number 12.
   */
  echoes: readonly Echo[];
};

export function noRows(): Rows {
  return { rows: [], seq: 0, byCall: new Map(), echoes: [] };
}

/**
 * The composer sent a message. Shown at once, before any round trip: on a phone
 * the alternative is a textarea that empties into silence for as long as the
 * agent takes to write its first record.
 */
export function addEcho(state: Rows, text: string): Rows {
  return { ...state, echoes: [...state.echoes, { text, undelivered: null }] };
}

/**
 * The same two facts {@link sendBlocked} refuses a *new* message on, applied to
 * the messages already outstanding when the terminal socket closed.
 *
 * A composed message leaves on that socket and there is no retry loop past
 * either close, so an echo standing at "Sending…" after one of them is the same
 * lie in slower motion: the frame is in the resend set, the session is not
 * coming back, and the card claims it is still on its way. It is marked, and
 * says which fact it is — a session that stopped is not a session the server
 * cannot find.
 *
 * Marking is **not** retiring. The echo keeps its place in the queue, so if a
 * record does turn up after all — a message the pane took before it went, whose
 * transcript line the tailer had not reached — {@link addEvents} retires it
 * exactly once through the ordinary path, and the never-duplicate rule is
 * untouched.
 */
const UNDELIVERED: Partial<Record<Status, string>> = {
  ended: 'Not delivered: this session ended.',
  gone: 'Not delivered: the server no longer has this session.',
};

export function markUndelivered(state: Rows, terminal: Status): Rows {
  const note = UNDELIVERED[terminal];
  if (note === undefined || state.echoes.every((echo) => echo.undelivered !== null)) return state;
  return {
    ...state,
    echoes: state.echoes.map((echo) => ({ ...echo, undelivered: echo.undelivered ?? note })),
  };
}

/**
 * Why the composer will not send right now, or `null`. A sentence rather than a
 * boolean: a Send button that is grey for no stated reason is a bug report.
 *
 * Every refusal here is a message that could not arrive. The alternative is not
 * a stricter composer, it is a "Sending…" that never resolves — an interface
 * quietly telling the user something untrue about their own message, which in a
 * tool for supervising work you cannot see is the worst failure available.
 *
 * The three facts it knows, in the order it applies them:
 *
 *  - **The terminal channel is finished.** A composed message is an `input`
 *    frame on that socket, so a session that has ended — or one the server no
 *    longer has — has nowhere for it to go, and the two are said apart because
 *    the user can act on the difference.
 *  - **`waiting`** means the pane is holding on a permission prompt. A message
 *    pasted into that is not a message — it answers the dialog with whatever
 *    option is selected, which can be *yes* to a command the user never read.
 *    The banner above both panes already says where to answer.
 *  - **Longer than the wire allows.** `parseClientFrame` drops an `input` frame
 *    over {@link MAX_TEXT} and never ACKs it, so it would be resent on every
 *    reconnect for the life of the mount. Measured the same way the server
 *    measures it — `String.length` on the text that is actually sent — and
 *    refused rather than split, since a splitting scheme invents an
 *    interleaving no test covers.
 *
 * `busy` is deliberately **not** refused. Both providers accept a message that
 * arrives mid-turn and show it queued in their own pane, and redirecting an
 * agent that is off down the wrong path is the single most valuable thing a
 * phone can do — a composer that locks for the length of a turn is a composer
 * that is unavailable exactly when it is wanted. Nor is `retrying`: the frame
 * waits in the terminal view's unacked set and goes out on the next connect,
 * which is the whole point of that set.
 */
export function sendBlocked(agent: SessionState, message: string, terminal: Status): string | null {
  if (terminal === 'ended') return 'This session has ended. Nothing can reach it now.';
  if (terminal === 'gone')
    return 'The server no longer has this session. Nothing can reach it now.';
  if (agent === 'waiting') return 'Answer the prompt in the terminal first.';
  if (message.length > MAX_TEXT) {
    return `Too long to send: ${message.length} characters, and the limit is ${MAX_TEXT}.`;
  }
  return null;
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
/**
 * A tool call the agent has proposed but not yet committed to its transcript —
 * what the user is being asked to approve, arriving before the record does.
 *
 * **Replaced, never duplicated.** The card is keyed by `callId` in `byCall`,
 * which is the same index a `tool_call` event consults, so whichever of the two
 * arrives second updates the card the first one made. That is the whole of the
 * reconciliation, and it works in both directions because neither source's
 * ordering is guaranteed: on Claude Code 2.1.220 the transcript record was
 * measured landing ~150ms *after* the hook, and nothing promises it stays there.
 *
 * Carries no `seq` and never moves one: `seq` is a position in the transcript's
 * event stream and a proposal has no position in it.
 */
export function addPending(state: Rows, e: ToolCallEvent): Rows {
  if (state.byCall.has(e.callId)) return state;
  const row: ToolRow = {
    key: `pending:${e.callId}`,
    row: 'tool',
    tool: e.tool,
    summary: summarise(e.input),
    failed: false,
    input: e.input,
    result: null,
    pending: true,
  };
  state.byCall.set(e.callId, row);
  return { ...state, rows: [...state.rows, row] };
}

export function addEvents(state: Rows, incoming: readonly SeqEvent[]): Rows {
  let rows: Row[] | undefined;
  let seq = state.seq;
  let echoes = state.echoes;
  for (const { seq: at, e } of incoming) {
    if (at <= seq) continue;
    seq = at;
    // **Replaced, never duplicated.** A `user` event is the transcript catching
    // up with something the user sent, so the oldest outstanding echo is retired
    // against it and the real record takes its place — same position in the
    // list, no second copy.
    //
    // Retired by arrival order rather than by matching the text: a provider is
    // free to record what it received rather than what was typed (trailing
    // whitespace, a trailing newline), and a match that fails leaves the echo
    // standing next to its own record forever. The cost of the looser rule is a
    // message typed straight into the terminal while a composed one is in flight
    // retiring the wrong echo — one message shown with the other's text for the
    // moment before its own record lands, and still never two.
    if (e.kind === 'user' && echoes.length > 0) echoes = echoes.slice(1);
    const row = toRow(String(at), e, state.byCall);
    if (row === undefined) continue;
    rows ??= [...state.rows];
    rows.push(row);
  }
  if (seq === state.seq) return state;
  return { rows: rows ?? state.rows, seq, byCall: state.byCall, echoes };
}

/** Convenience for the tests and for a fresh history: rows from nothing. */
export function toRows(events: readonly SeqEvent[]): readonly Row[] {
  return addEvents(noRows(), events).rows;
}

/**
 * The whole conversation again, replacing the rows built so far — the answer to
 * `refetch`, where the gap is wider than the server's tail.
 *
 * Rows are replaced rather than merged: this is the entire transcript, and
 * merging it into rows built from a stream that has since been declared unusable
 * is how a hole gets papered over instead of fixed.
 *
 * Echoes are **carried across**, because a message sent a moment ago cannot have
 * been superseded by a transcript the server built before it arrived, and
 * dropping it blanks a just-sent message from the view for as long as the turn
 * it landed in. It cannot duplicate, because it is the same {@link addEvents}
 * retirement either way — applied only past the `seq` this client had already
 * seen, which is the whole of the two passes: those records already had their
 * chance at the echo and retired nothing, so replaying them must not retire it
 * now.
 */
export function rebuild(state: Rows, events: readonly SeqEvent[]): Rows {
  const seen = addEvents(
    noRows(),
    events.filter(({ seq }) => seq <= state.seq),
  );
  return addEvents({ ...seen, echoes: state.echoes }, events);
}

/**
 * One event to one row, or to none. Returning `undefined` is how an event that
 * changes an existing row (a `tool_result`, or the `tool_call` that supersedes a
 * proposed one) and one this view deliberately does not render (`status`, which
 * is the header badge, not a message) both say "no new row".
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
      // The transcript record for a call the pre-tool hook already proposed.
      // It supersedes that card in place — same `callId`, same position in the
      // list, no second card. Everything else about it is identical, so only
      // `pending` changes.
      const proposed = byCall.get(e.callId);
      if (proposed !== undefined) {
        proposed.pending = false;
        return undefined;
      }
      const row: ToolRow = {
        key,
        row: 'tool',
        tool: e.tool,
        summary: summarise(e.input),
        failed: false,
        input: e.input,
        result: null,
        pending: false,
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
        pending: false,
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
