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

import type {
  ConversationEvent,
  PermissionOutcome,
  SessionState,
  Timestamp,
  ToolCallEvent,
} from '@tether/shared';

import { MAX_TEXT } from './keys.ts';
import { markdown, type Block } from './markdown.ts';
import { providerLabel } from './providers.ts';
import type { Status } from './status.ts';

/** An event with its position in the session's stream, as the server sends it. */
export type SeqEvent = { seq: number; e: ConversationEvent };

/**
 * One line of a change, as the card draws it. A *content kind* rather than
 * prose about one: an Edit's input is the old text and the new text, and a
 * paragraph saying so is the thing that is unreadable at 360px.
 */
export type DiffLine = { at: 'add' | 'del' | 'ctx' | 'meta'; text: string };
export type Diff = {
  path: string | null;
  lines: readonly DiffLine[];
  /**
   * Which keys of the input the diff already speaks for. Reported by the branch
   * that built it rather than listed a second time in the view, so the two
   * cannot drift: {@link diffExtras} is what turns this into the fields an
   * answerable card still has to say out loud, and a branch added below without
   * naming its keys shows them all rather than hiding them.
   */
  covers: readonly string[];
};

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
   * The change this call makes, when the input describes one. Computed once,
   * where the row is built, rather than per render: a card is re-rendered on
   * every event in the session and an `apply_patch` input runs to the 16k cap.
   */
  diff: Diff | null;
  /**
   * Characters in the input that can make it read as something it is not, named.
   * Computed here for the same reason `diff` is — a card re-renders on every
   * event in the session — and see {@link inputSuspects} for what is scanned.
   */
  suspects: readonly Suspect[];
  /**
   * The card was built from the provider's pre-tool hook and the transcript has
   * not caught up. It is the same card either way — this only lets the view say
   * "asking to run this" rather than "running this".
   */
  pending: boolean;
  /**
   * The agent is blocked on this call and tether will deliver the answer, until
   * `deadline`. The presence of this — not `pending` — is what puts Approve and
   * Deny on a card: tether reports far more proposals than it can answer, and a
   * button that resolves nothing is worse than no button at all.
   */
  answerable: { callId: string; deadline: Timestamp } | null;
  /**
   * How the hold ended, once it has. `timeout` is not an error and must not read
   * as one: the question simply went back to the provider's own prompt, which
   * the terminal is showing.
   */
  outcome: PermissionOutcome | null;
};

export type Row =
  | {
      key: string;
      row: 'message';
      who: 'user' | 'assistant';
      /** What was written, verbatim. What Copy copies, and never rendered raw. */
      text: string;
      /** The same text as markdown; see `markdown.ts` for why it is data. */
      blocks: readonly Block[];
    }
  | { key: string; row: 'thinking' }
  /**
   * A slash command that ran, or a line it printed. Monospace either way, by the
   * house rule that monospace means the machine said it — a command is typed at
   * the agent's CLI, not written to the model, so it is not a message and does
   * not get a message's box.
   */
  | { key: string; row: 'command'; text: string; output: boolean }
  | { key: string; row: 'compaction' }
  /**
   * A turn the provider's own CLI reported as failed, in its words. `auth` is
   * the only thing tether adds, and only where the provider typed it; see
   * {@link authAdvice}.
   */
  | { key: string; row: 'error'; text: string; auth: boolean }
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

/** Unchanged lines kept either side of a change, as a unified diff keeps them. */
const CONTEXT = 3;

/**
 * A tool call's input → the change it makes, or `null` if it does not make one.
 *
 * Only the two shapes both providers actually write are read, and each is read
 * from the **input** rather than from the result: an Edit's result is a prose
 * sentence plus a `cat -n` excerpt, while the input is the change itself.
 *
 *  - Claude Code's `Edit` (`old_string`/`new_string`) and `Write` (`content`,
 *    which is every line added).
 *  - Codex's `apply_patch`, whose input already *is* a patch — so it is read
 *    rather than recomputed, and its own `+`/`-` are believed. It arrives in
 *    two shapes and both are read here: the rollout record's `input` is the
 *    patch string itself, while the hook that proposes the same call wraps it
 *    as `{ command: <patch> }`. Whichever of the two reaches the client first
 *    builds the card — `toRow` only flips `pending` on the other — so a card
 *    built from the hook has to be right the first time or it shows raw JSON
 *    where the change should be, on the one card the agent is blocked on.
 *
 * Anything else is `null` and the card keeps the input view it has always had.
 * A third provider's shape is another branch here, not a redesign: the row
 * carries a `Diff`, and the view knows nothing about where one came from.
 */
export function toDiff(tool: string, input: unknown): Diff | null {
  if (typeof input === 'string') return parsePatch(input);
  if (typeof input !== 'object' || input === null) return null;
  const fields = input as Record<string, unknown>;
  const path = typeof fields['file_path'] === 'string' ? fields['file_path'] : null;
  const before = fields['old_string'];
  const after = fields['new_string'];
  if (typeof before === 'string' && typeof after === 'string') {
    return {
      path,
      lines: lineDiff(before, after),
      covers: ['file_path', 'old_string', 'new_string'],
    };
  }
  const content = fields['content'];
  if (tool === 'Write' && typeof content === 'string') {
    return {
      path,
      lines: content.split('\n').map((text) => ({ at: 'add', text })),
      covers: ['file_path', 'content'],
    };
  }
  const command = fields['command'];
  if (typeof command === 'string') {
    const patch = parsePatch(command);
    // `parsePatch` requires the marker, so an ordinary `Bash` command is `null`
    // here and the card keeps its input view.
    return patch === null ? null : { ...patch, covers: ['command'] };
  }
  return null;
}

/**
 * The input fields the diff does **not** itself say, on a card the agent is
 * blocked on — one `name: value` per line, or `null` when there are none.
 *
 * The diff replaces the input view, which is the right level of detail for a
 * call already running: it is the change, and the fields it was built from are
 * in it. On an *answerable* card it is not, because anything the diff cannot
 * draw is then a part of what is being approved that nobody is shown —
 * `replace_all` rewriting every match where the diff shows one occurrence is
 * the instance that was noticed, and the next such field is the one nobody
 * thought of. So the rule is the general one: whatever `Diff.covers` does not
 * name is said beside it. In the ordinary case the set is empty and the card is
 * exactly as short as it was.
 */
export function diffExtras(row: ToolRow): string | null {
  const diff = row.diff;
  if (row.answerable === null || diff === null) return null;
  if (typeof row.input !== 'object' || row.input === null) return null;
  const covered = new Set(diff.covers);
  const extras = Object.entries(row.input as Record<string, unknown>)
    .filter(([name]) => !covered.has(name))
    .map(([name, value]) => `${name}: ${typeof value === 'string' ? value : format(value)}`);
  return extras.length === 0 ? null : extras.join('\n');
}

function format(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/**
 * Two texts → the lines that differ, by trimming the identical head and tail
 * and calling everything between them changed.
 *
 * ponytail: not an LCS. An `Edit` replaces one contiguous run — that is what
 * the tool is for — so the cheap answer is the right answer for the shape that
 * actually arrives, and where it is not (two separate hunks in one string) it
 * over-reports the middle rather than mis-attributing a line. A real diff
 * algorithm is the upgrade if `MultiEdit`-shaped inputs ever reach a card.
 */
function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const cut = (text: string, at: DiffLine['at']): DiffLine => ({ at, text });
  return [
    ...a.slice(Math.max(0, head - CONTEXT), head).map((text) => cut(text, 'ctx')),
    ...a.slice(head, a.length - tail).map((text) => cut(text, 'del')),
    ...b.slice(head, b.length - tail).map((text) => cut(text, 'add')),
    ...a.slice(a.length - tail, a.length - tail + CONTEXT).map((text) => cut(text, 'ctx')),
  ];
}

/** `*** Update File: <path>`, and the two siblings that add and delete one. */
const PATCH_FILE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/;

/**
 * The only `*** ` lines that carry nothing: the two delimiters and the marker
 * that a hunk runs to the end of the file. Every other directive is kept —
 * `*** Move to: <path>` is a rename, and a rename dropped from a card the agent
 * is blocked on is a file moving somewhere nobody approved.
 */
const PATCH_NOISE = /^\*\*\* (?:Begin Patch|End Patch|End of File)\s*$/;

/**
 * Codex's `apply_patch` input. Verified against the 0.145.0 rollout fixture:
 * `*** Begin Patch` / `*** Update File: <path>` / `@@` / `-old` / `+new` /
 * `*** End Patch`. The marker is required rather than sniffed for `+`/`-`,
 * because a string input to some other tool is not a patch and guessing that it
 * is would draw a change that nobody proposed.
 */
function parsePatch(text: string): Diff | null {
  if (!text.includes('*** Begin Patch')) return null;
  let path: string | null = null;
  const lines: DiffLine[] = [];
  for (const line of text.replace(/\n+$/, '').split('\n')) {
    const file = PATCH_FILE.exec(line);
    if (file !== null) {
      path ??= file[1] ?? null;
      lines.push({ at: 'meta', text: line });
    } else if (PATCH_NOISE.test(line)) continue;
    else if (line.startsWith('*** ')) lines.push({ at: 'meta', text: line });
    else if (line.startsWith('@@')) lines.push({ at: 'meta', text: line });
    else if (line.startsWith('+')) lines.push({ at: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) lines.push({ at: 'del', text: line.slice(1) });
    else lines.push({ at: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line });
  }
  return { path, lines, covers: [] };
}

/**
 * A message sent from the composer, before the transcript has shown it back.
 *
 * `undelivered` is the sentence saying the socket it was sent on has closed for
 * good, or `null` while the transcript can still show it back. It is a state the
 * echo enters rather than an exit: the text is the thing the user would
 * otherwise lose, so the message stays on screen and is marked, never dropped
 * and never silently retired.
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
 * What the note may say is bounded by what this side knows, which is **less than
 * whether the message arrived**. An echo is outstanding until the *transcript*
 * records it, and the ACK is a different, earlier milestone that lives in the
 * terminal view's unacked set: a message sent mid-turn can be applied, ACKed and
 * queued by the agent, and the session then end before its record is written. So
 * each sentence states the close and stops there. Saying "not delivered" would
 * be the same over-claim as "Sending…", pointing the other way.
 *
 * Marking is **not** retiring. The echo keeps its place in the queue, so if a
 * record does turn up after all — a message the pane took before it went, whose
 * transcript line the tailer had not reached — {@link addEvents} retires it
 * exactly once through the ordinary path, and the never-duplicate rule is
 * untouched.
 */
const UNDELIVERED: Partial<Record<Status, string>> = {
  ended: 'This session ended before the agent recorded this message.',
  gone: 'The server no longer has this session, and the agent had not recorded this message.',
  // Same rule as the other two, applied to the one close that has no cause in
  // it: something stopped the terminal channel, this side never saw what, and
  // the note says only that — the server's log is where the exception is.
  failed: 'The terminal channel failed before the agent recorded this message.',
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
 *    frame on that socket, so a session that has ended — one the server has no
 *    row for, or one whose attach threw — has nowhere for it to go, and the
 *    three are said apart because the user can act on the difference. Only the
 *    middle one may say the session is missing: saying it for the other two is
 *    the bug this file's `Status` comment is about.
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
  if (terminal === 'failed')
    return 'tether could not open a terminal for this session, so this has nowhere to go. The reason is in the server’s log.';
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
export function addPending(state: Rows, e: ToolCallEvent, deadline?: Timestamp): Rows {
  const existing = state.byCall.get(e.callId);
  if (existing !== undefined) {
    // The record beat the proposal, or a reconnect replayed it. Nothing about
    // the card changes except whether it can still be answered — and the frame
    // is authoritative in both directions: a `deadline` means the agent is
    // blocked on it whatever the transcript says, and its *absence* means tether
    // is not holding this call, so buttons a reconnect would otherwise bring
    // back for a hold that ended while the socket was down have to go.
    const answerable = deadline === undefined ? null : { callId: e.callId, deadline };
    if (existing.answerable === null && answerable === null) return state;
    existing.answerable = answerable;
    return { ...state, rows: [...state.rows] };
  }
  const row: ToolRow = {
    key: `pending:${e.callId}`,
    row: 'tool',
    tool: e.tool,
    summary: summarise(e.input),
    failed: false,
    input: e.input,
    result: null,
    diff: toDiff(e.tool, e.input),
    suspects: inputSuspects(e.input),
    pending: true,
    answerable: deadline === undefined ? null : { callId: e.callId, deadline },
    outcome: null,
  };
  state.byCall.set(e.callId, row);
  return { ...state, rows: [...state.rows, row] };
}

/**
 * A held proposal is over, however it ended. The buttons go, and the card says
 * which of the three things happened.
 *
 * This is the client half of "whichever answers first wins": the frame reaches
 * every viewer, so a second phone showing the same card stops offering an answer
 * the moment the first one gives it — and so does this one when the answer came
 * from the timer or from the terminal instead.
 *
 * Applied to a card with no buttons too, because that is how a reconnect learns
 * how a hold it missed ended: the replayed proposal clears the buttons and this
 * says which of the three things happened.
 */
export function addAnswer(state: Rows, callId: string, outcome: PermissionOutcome): Rows {
  const row = state.byCall.get(callId);
  if (row === undefined) return state;
  // A card with no buttons and an outcome already on it is settled, and stays
  // settled: a second frame for one call is the replay or a second socket, never
  // a second answer. A card with no buttons and *no* outcome is the replayed
  // proposal above, which is exactly what this is here to complete.
  if (row.answerable === null && row.outcome !== null) return state;
  row.answerable = null;
  row.outcome = outcome;
  return { ...state, rows: [...state.rows] };
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
      return { key, row: 'message', who: e.kind, text: e.text, blocks: markdown(e.text) };
    case 'thinking':
      // Presence only. The transcript carries an empty `thinking` string, so
      // anything more specific than "it thought here" would be invented.
      return { key, row: 'thinking' };
    case 'command':
      return { key, row: 'command', text: e.text, output: e.output === true };
    case 'compaction':
      return { key, row: 'compaction' };
    case 'error':
      return { key, row: 'error', text: e.text, auth: e.auth === true };
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
        diff: toDiff(e.tool, e.input),
        suspects: inputSuspects(e.input),
        pending: false,
        answerable: null,
        outcome: null,
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
        diff: null,
        suspects: [],
        pending: false,
        answerable: null,
        outcome: null,
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

/* ── lookalike characters ────────────────────────────────────────────────────
 *
 * A clipped command is approving blind; a homoglyph is the same failure with no
 * visual tell at all. `rm -rf ./buіld` — Cyrillic `і` — is `rm -rf ./build` to
 * every reader at every width, and a phone shows less context and gets tapped
 * faster than a desktop editor does. So the three classes that can make a
 * command or a path read as something it is not are named on the card, and on an
 * **answerable** card Approve waits behind an acknowledgement while Deny stays
 * live: someone who sees this warning most likely wants to deny, and must never
 * be made to acknowledge a warning in order to.
 *
 * Modelled on Zed's `crates/agent_ui/src/unicode_confusables.rs`, with one
 * deliberate difference that is the whole difficulty of the feature. Zed scans
 * *domains and paths* in a sandbox prompt, where **any** non-ASCII character is
 * surprising, so it flags all of them. A tool call's input is arbitrary text —
 * a Russian directory name, a Japanese commit message, a Danish username — and a
 * guard that fires on ordinary text trains people to click through, which is
 * worse than no guard. What is flagged is therefore narrowed to what can
 * actually be mistaken for ASCII:
 *
 *  - **Bidi controls** and **invisible characters** — always, wherever they are.
 *    Neither has a legitimate place in a command or a path, and the second is by
 *    definition something the user cannot see.
 *  - **Confusables** — only a non-ASCII character that either folds to a *single*
 *    ASCII character under NFKC (`Ａ` → `A`, `／` → `/`), or belongs to a script
 *    whose letters are drawn like Latin ones *and* shares a word with an ASCII
 *    letter. A word of pure Cyrillic is a Russian word; a Cyrillic `і` in the
 *    middle of `build` is an attack.
 *
 * ponytail: the confusable half is four script ranges and an NFKC fold, not
 * UTS#39's confusables table. That is a real ceiling in both directions —
 * `ﬁle` (a ligature, which folds to *two* ASCII characters) and `ı` are missed —
 * and the upgrade is a generated table, which is a dependency this does not
 * need for the attack that is actually cheap to mount. The Latin block is
 * exempt **on purpose and must stay exempt**: `søren`, `kullanıcı` and `café`
 * are all ASCII letters mixed with a non-ASCII Latin one, so a rule that caught
 * `ı` would cry wolf on ordinary names.
 */

export type SuspectKind = 'bidi' | 'invisible' | 'confusable';

/**
 * One character worth naming, and the way it is named: the glyph where showing
 * one means anything, the code point always, and the script or the ASCII it
 * stands in for where that is knowable. "Suspicious characters" without saying
 * which teaches nothing and cannot be checked by the reader.
 */
export type Suspect = { char: string; kind: SuspectKind; description: string };

/** Bidi controls — the "Trojan Source" set. Nothing else reorders text. */
const BIDI = /^[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]$/;

/**
 * Zero-width, invisible and non-ASCII-space characters. Only ever asked about a
 * **non-ASCII** character, which is what keeps a newline, a tab or an ordinary
 * space — all legitimate in a command and in a patch — out of it, and is why
 * three whole categories can stand in for a hand-written list: `Cf` is every
 * format character (the zero-width set, the soft hyphen, the BOM), `Cc` the
 * remaining controls, `Zs` every exotic space.
 */
const INVISIBLE = /^(?:\p{Cc}|\p{Cf}|\p{Zs})$/u;

/**
 * The invisible characters that are *letters* by category and so in none of
 * those three \u2014 the Hangul and Khmer fillers, which render as nothing at all. A
 * set rather than a character class because two of them combine into one
 * grapheme, which is a lint error in a class and would be a silent one here.
 */
const INVISIBLE_LETTERS = new Set(['\u115F', '\u1160', '\u17B4', '\u17B5', '\u3164', '\uFFA0']);

/** The characters a word is made of, for "is this word otherwise ASCII?". */
const WORD = /^[\p{L}\p{M}\p{N}]$/u;

/**
 * Scripts whose letters are drawn like Latin ones. The four UTS#39 names as the
 * usual source of Latin homoglyphs; Han, Arabic, Hebrew and the rest are absent
 * because their glyphs are not mistakable for ASCII and flagging them would fire
 * on every genuinely multilingual path.
 */
const CONFUSABLE_SCRIPTS: readonly [number, number, string][] = [
  [0x0370, 0x03ff, 'Greek'],
  [0x1f00, 0x1fff, 'Greek'],
  [0x0400, 0x052f, 'Cyrillic'],
  [0x2de0, 0x2dff, 'Cyrillic'],
  [0xa640, 0xa69f, 'Cyrillic'],
  [0x0530, 0x058f, 'Armenian'],
  [0x13a0, 0x13ff, 'Cherokee'],
  [0xab70, 0xabbf, 'Cherokee'],
];

/**
 * Names for the invisible and bidi characters most likely to turn up, so the
 * warning reads as English rather than as a column of code points. Anything not
 * listed is named by its code point alone, which still says *where* to look.
 */
const NAMES: Record<string, string> = {
  '\u00A0': 'no-break space',
  '\u00AD': 'soft hyphen',
  '\u061C': 'arabic letter mark',
  '\u180E': 'mongolian vowel separator',
  '\u200B': 'zero-width space',
  '\u200C': 'zero-width non-joiner',
  '\u200D': 'zero-width joiner',
  '\u200E': 'left-to-right mark',
  '\u200F': 'right-to-left mark',
  '\u202A': 'left-to-right embedding',
  '\u202B': 'right-to-left embedding',
  '\u202C': 'pop directional formatting',
  '\u202D': 'left-to-right override',
  '\u202E': 'right-to-left override',
  '\u2060': 'word joiner',
  '\u2066': 'left-to-right isolate',
  '\u2067': 'right-to-left isolate',
  '\u2068': 'first strong isolate',
  '\u2069': 'pop directional isolate',
  '\u3000': 'ideographic space',
  '\u3164': 'hangul filler',
  '\uFEFF': 'zero-width no-break space',
};

function scriptOf(char: string): string | null {
  const at = char.codePointAt(0) ?? 0;
  return CONFUSABLE_SCRIPTS.find(([from, to]) => at >= from && at <= to)?.[2] ?? null;
}

/** The single ASCII character this one is a compatibility form of, if it is. */
function foldsToAscii(char: string): string | null {
  const folded = char.normalize('NFKC');
  return folded.length === 1 && /^[!-~]$/.test(folded) ? folded : null;
}

/**
 * The non-ASCII, Latin-lookalike letters that share a word with an ASCII letter.
 * Words are split on anything that is not a letter, mark or digit, so `файл-name`
 * is two words and `buіld` is one — which is the distinction between a Russian
 * name beside an English one and a Latin word with a Cyrillic letter in it.
 */
function mixedScript(text: string): Set<string> {
  const found = new Set<string>();
  let word: string[] = [];
  let ascii = false;
  const end = () => {
    if (ascii) for (const char of word) found.add(char);
    word = [];
    ascii = false;
  };
  for (const char of text) {
    if (!WORD.test(char)) {
      end();
      continue;
    }
    if (/^[A-Za-z]$/.test(char)) ascii = true;
    else if (scriptOf(char) !== null) word.push(char);
  }
  end();
  return found;
}

function describe(char: string, kind: SuspectKind): Suspect {
  const point = `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
  if (kind !== 'confusable') {
    // No glyph: there is nothing to show, and printing a bidi control into the
    // warning would reorder the warning's own text.
    const name = NAMES[char];
    return { char, kind, description: name === undefined ? point : `${point} ${name}` };
  }
  const script = scriptOf(char);
  const ascii = foldsToAscii(char);
  const note = script ?? (ascii === null ? null : `looks like "${ascii}"`);
  return { char, kind, description: `'${char}' (${point}${note === null ? '' : ` ${note}`})` };
}

/**
 * Every distinct character in `text` worth naming, once each, in order of first
 * appearance — the order they occur in the thing the user is reading.
 */
export function scanSuspects(text: string): readonly Suspect[] {
  const mixed = mixedScript(text);
  const found = new Map<string, Suspect>();
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 0x80 || found.has(char)) continue;
    const kind: SuspectKind | null = BIDI.test(char)
      ? 'bidi'
      : INVISIBLE.test(char) || INVISIBLE_LETTERS.has(char)
        ? 'invisible'
        : mixed.has(char) || foldsToAscii(char) !== null
          ? 'confusable'
          : null;
    if (kind === null) continue;
    found.set(char, describe(char, kind));
  }
  return [...found.values()];
}

/**
 * A tool call's input → the characters worth naming on its card.
 *
 * Every string in the input is scanned, keys included: what a card shows is
 * built from the input — the summary, the diff, the extras, the input view — so
 * scanning the input covers every field on the card without having to enumerate
 * them, and a field a later provider adds is covered the day it arrives.
 *
 * The **result** is deliberately not scanned. It is arbitrary output that the
 * user is not deciding about, and a `grep` over a UTF-8 file would put a warning
 * on a card where nothing is being approved. What is scanned is what is being
 * asked for.
 */
export function inputSuspects(input: unknown): readonly Suspect[] {
  const text: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') text.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (typeof value === 'object' && value !== null) {
      for (const [name, item] of Object.entries(value)) {
        text.push(name);
        walk(item);
      }
    }
  };
  walk(input);
  return scanSuspects(text.join('\n'));
}

/** How many are named before the line becomes one nobody reads. */
const NAMED = 6;

/**
 * The sentence, or `null` when there is nothing to say. Bounded by construction
 * rather than by a scroll container: an input can carry fifty distinct
 * lookalikes, and a card whose warning grows without limit pushes Deny — the
 * answer this warning exists to make easy — off a short phone.
 */
export function suspectWarning(suspects: readonly Suspect[]): string | null {
  if (suspects.length === 0) return null;
  const named = suspects.slice(0, NAMED).map((suspect) => suspect.description);
  const rest = suspects.length - named.length;
  const list = rest > 0 ? `${named.join(', ')}, and ${rest} more` : named.join(', ');
  return `This contains characters that can make it read as something else: ${list}.`;
}

/**
 * What a failed call means for the person holding the phone: whether it is
 * fixing itself or whether it wants them.
 *
 * That distinction is the whole of this — not a catalogue of provider errors.
 * A user who glances at a screen and reads *retrying* puts the phone down; one
 * who reads *needs you* opens the terminal, and getting those two the wrong way
 * round wastes either an agent's turn or a user's afternoon.
 *
 * **Cases are added one at a time as they are actually met**, and each is
 * anchored to the start of the output rather than matched anywhere in it: tool
 * output is arbitrary text, and a `grep` that finds the words "rate limit" in a
 * log must not be reported as the provider rate-limiting. `null` — no claim at
 * all — is the right answer for everything not yet recognised, and the card
 * still shows the output.
 */
export type Advice = {
  /** True: nothing will happen until the user does something. */
  act: boolean;
  text: string;
};

/** Anchored at the start of the output, or on a line of its own. See above. */
const ADVICE: readonly { when: RegExp; advice: Advice }[] = [
  {
    // Claude Code writes the API's own error through: `API Error: 429 {"type":
    // "error","error":{"type":"rate_limit_error",…}}`.
    when: /^\s*API Error: (?:429|529)\b|^\s*(?:"?type"?:\s*"?)?(?:rate_limit|overloaded)_error\b/,
    advice: {
      act: false,
      text: 'The provider is rate-limited or overloaded. The agent retries this itself.',
    },
  },
  {
    when: /^\s*API Error: 40[13]\b|^\s*(?:"?type"?:\s*"?)?(?:authentication|permission)_error\b|^\s*Credit balance is too low\b/,
    advice: {
      act: true,
      text: 'The provider refused the credentials. Sign in again in the terminal — nothing retries this.',
    },
  },
  {
    // Codex, verified in the 0.145.0 fixtures: a sandbox refusal is prose with
    // no exit code in it at all.
    when: /^\s*approval policy is \w+; reject command\b/,
    advice: {
      act: true,
      text: 'Codex refused this under its own sandbox policy. Answer it in the terminal to let it run.',
    },
  },
];

export function errorAdvice(output: string): Advice | null {
  return ADVICE.find(({ when }) => when.test(output))?.advice ?? null;
}

/**
 * The one line tether adds to a failed turn, and only when the provider itself
 * typed that turn's failure as an authentication one.
 *
 * The same {@link Advice} the tool cards carry, and deliberately the same first
 * sentence as the `authentication_error` entry above: a user who meets this on a
 * failed `Bash` and again on a whole turn is meeting one situation, and two
 * wordings for it would read as two.
 *
 * Everything else about the failure is the provider's own sentence, which the
 * row shows above this — Claude Code writes "Please run /login · API Error: 401
 * OAuth token has expired…", Codex "Your access token could not be refreshed."
 * Both already say it plainly, so what is added here is only the part they
 * cannot say: that nothing is going to retry, and where to go.
 *
 * There is no matching line for a failure that is *not* authentication. The
 * provider's own text is shown and tether claims nothing — an unrelated failure
 * that says "sign in again" costs someone a re-authentication for no reason,
 * which is the whole reason the flag comes from a typed field.
 */
export const AUTH_ADVICE: Advice = {
  act: true,
  text: 'The provider refused the credentials. Sign in again — nothing retries this.',
};

/**
 * The word on a collapsed card, and the sentence inside it. Here rather than in
 * the JSX for the reason at the top of this file: what a card says about a
 * permission it is holding is the most consequential wording in the product, and
 * a decision made inside a component is one no test can reach.
 */
export function toolState(row: ToolRow): string {
  if (row.answerable !== null) return 'asking';
  if (row.outcome === 'deny') return 'denied';
  if (row.outcome === 'timeout' && row.result === null) return 'in terminal';
  // Approved here, so it is no longer being asked about — it is running, even
  // though the transcript has not caught up and the card is still `pending`.
  if (row.outcome === 'allow' && row.result === null) return '…';
  if (row.pending) return 'asking';
  if (row.result === null) return '…';
  if (!row.failed) return '✓';
  // The collapsed row is what a glance gets, so the retry-vs-act answer belongs
  // in it rather than only inside a card nobody has opened.
  const advice = errorAdvice(row.result);
  if (advice === null) return 'error';
  return advice.act ? 'needs you' : 'retrying';
}

/**
 * `provider` for exactly one of these sentences, and it had to be taken from
 * somewhere: the expired-hold line named Claude Code outright, so a Codex card
 * told the user to go and answer an agent that was not running. `providerLabel`
 * is where the rest of the web app already reads an agent's name from, so this
 * is the existing seam rather than a new one.
 */
export function toolResult(row: ToolRow, provider: string): string {
  if (row.result !== null) return row.result;
  if (row.answerable !== null) return 'The agent is waiting on your answer.';
  switch (row.outcome) {
    case 'allow':
      return 'Approved here. The agent is running it.';
    case 'deny':
      return 'Denied here. The agent was told you refused, and did not run it.';
    case 'timeout':
      // Not a failure, and it must not read as one: tether stopped holding and
      // the agent's own prompt has the question, which the terminal shows.
      return `No answer here in time — ${providerLabel(provider)} is asking in the terminal instead.`;
    default:
      return row.pending ? 'Waiting for you to answer in the terminal.' : 'Still running.';
  }
}

/**
 * How long a turn has been running, but **only once it is long enough to be
 * news**. A fast turn shows nothing at all, so the number appearing is itself
 * the signal — which is the point, and why this is not a timer that is always
 * on: a phone has no other sense of progress, and a counter that runs on every
 * turn is furniture that stops being read within a day.
 *
 * Counted from when this client first saw the turn start. A page opened mid-turn
 * therefore under-reports, which delays the signal rather than inventing one.
 */
export const SLOW_TURN_MS = 60_000;

export function elapsedLabel(
  startedAt: number | null,
  now: number,
  threshold = SLOW_TURN_MS,
): string | null {
  if (startedAt === null) return null;
  const ms = now - startedAt;
  if (ms < threshold) return null;
  const seconds = Math.floor(ms / 1000);
  // The seconds are padded, so the label does not jitter a character wider and
  // narrower every second. It is not a *constant* width — the minutes grow at
  // 10m — and it does not need to be: what may not change on the session bar is
  // its **height**, and `.chip` is `nowrap` inside a `.bar-chips` row that is
  // sized by the row and not by this string.
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function kindOf(e: unknown): string {
  const kind = (e as { kind?: unknown })?.kind;
  return typeof kind === 'string' && kind !== '' ? kind : 'unknown';
}
