import type { ConversationEvent } from '@tether/shared';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addAnswer,
  addEcho,
  addEvents,
  addPending,
  markUndelivered,
  noRows,
  rebuild,
  sendBlocked,
  summarise,
  toolResult,
  toolState,
  toRows,
  type Rows,
  type SeqEvent,
  type ToolRow,
} from './conversation.ts';
import { MAX_TEXT } from './keys.ts';

/** Events as the server numbers them: file order, counted from 1. */
function stream(...events: ConversationEvent[]): SeqEvent[] {
  return events.map((e, index) => ({ seq: index + 1, e }));
}

const AT = 1_700_000_000_000;

/** What is still outstanding, which is what nearly every echo assertion is about. */
function texts(state: Rows): string[] {
  return state.echoes.map((echo) => echo.text);
}

test('the three things a conversation is made of become three kinds of row', () => {
  const rows = toRows(
    stream(
      { kind: 'user', id: 'u1', at: AT, text: 'add a test' },
      { kind: 'thinking', id: 'a1#0', at: AT },
      { kind: 'assistant', id: 'a1#1', at: AT, text: 'Reading the file first.' },
    ),
  );
  assert.deepEqual(
    rows.map((row) => row.row),
    ['message', 'thinking', 'message'],
  );
  assert.deepEqual(rows[0], { key: '1', row: 'message', who: 'user', text: 'add a test' });
  // Presence only: the row carries no text, because the transcript carries none.
  assert.deepEqual(rows[1], { key: '2', row: 'thinking' });
});

test('a tool result folds into its call rather than becoming a second row', () => {
  const rows = toRows(
    stream(
      {
        kind: 'tool_call',
        id: 'a1#0',
        at: AT,
        tool: 'Read',
        input: { file_path: '/home/you/notes.txt' },
        callId: 'toolu_1',
      },
      {
        kind: 'tool_result',
        id: 'u1#0',
        at: AT,
        callId: 'toolu_1',
        output: 'hello',
        isError: false,
      },
    ),
  );
  assert.equal(rows.length, 1);
  const card = rows[0] as ToolRow;
  // Collapsed: what ran. Expanded: the input and the result. The split is the
  // row's, not the markup's, so it is the thing that can be asserted.
  assert.equal(card.tool, 'Read');
  assert.equal(card.summary, '…/you/notes.txt');
  assert.deepEqual(card.input, { file_path: '/home/you/notes.txt' });
  assert.equal(card.result, 'hello');
  assert.equal(card.failed, false);
});

test('a call still running has a null result, and a failed one is marked', () => {
  const running = toRows(
    stream({ kind: 'tool_call', id: 'a#0', at: AT, tool: 'Bash', input: {}, callId: 'c' }),
  )[0] as ToolRow;
  assert.equal(running.result, null);

  const failed = toRows(
    stream(
      { kind: 'tool_call', id: 'a#0', at: AT, tool: 'Bash', input: {}, callId: 'c' },
      { kind: 'tool_result', id: 'u#0', at: AT, callId: 'c', output: 'boom', isError: true },
    ),
  )[0] as ToolRow;
  assert.equal(failed.failed, true);
  assert.equal(failed.result, 'boom');
});

test('a result whose call was dropped keeps its output instead of vanishing', () => {
  const rows = toRows(
    stream({
      kind: 'tool_result',
      id: 'u#0',
      at: AT,
      callId: 'gone',
      output: 'orphan',
      isError: false,
    }),
  );
  assert.equal(rows.length, 1);
  const card = rows[0] as ToolRow;
  assert.equal(card.result, 'orphan');
  assert.equal(card.input, undefined);
});

test('an unrecognised event kind degrades to a note and never throws', () => {
  // The single most likely way a future Claude Code release breaks this view:
  // the data layer already parses tolerantly, and the UI must not undo that.
  const future = { kind: 'hologram', id: 'x', at: AT } as unknown as ConversationEvent;
  const rows = toRows(stream({ kind: 'user', id: 'u', at: AT, text: 'hi' }, future));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], { key: '2', row: 'note', text: 'Unsupported event: hologram' });

  // Even a kind that is not a string at all, which is what a shape change looks
  // like before anyone has read the release notes.
  const shapeless = { at: AT } as unknown as ConversationEvent;
  assert.deepEqual(toRows(stream(shapeless)), [
    { key: '1', row: 'note', text: 'Unsupported event: unknown' },
  ]);
});

test('a status event is left to the header badge, not rendered as a message', () => {
  assert.deepEqual(toRows(stream({ kind: 'status', at: AT, state: 'busy' })), []);
});

test('the since replay after a reconnect appends nothing it already holds', () => {
  const events = stream(
    { kind: 'user', id: 'u1', at: AT, text: 'one' },
    { kind: 'assistant', id: 'a1', at: AT, text: 'two' },
    { kind: 'user', id: 'u2', at: AT, text: 'three' },
  );

  let state = addEvents(noRows(), events.slice(0, 2));
  assert.equal(state.seq, 2);

  // The server replays from `since`, and a client that reconnected while its own
  // history request was in flight sees the overlap. Nothing may double.
  const resumed = addEvents(state, events);
  assert.equal(resumed.seq, 3);
  assert.deepEqual(
    resumed.rows.map((row) => (row.row === 'message' ? row.text : row.row)),
    ['one', 'two', 'three'],
  );

  // A replay of only what is already held is not even a re-render: same object.
  state = resumed;
  assert.equal(addEvents(state, events), state);
});

test('appending reuses the rows already built', () => {
  const first = addEvents(noRows(), stream({ kind: 'user', id: 'u', at: AT, text: 'one' }));
  const second = addEvents(first, [{ seq: 2, e: { kind: 'thinking', id: 't', at: AT } }]);
  // Streaming append: the existing row object survives, so Preact's keyed diff
  // leaves its DOM node alone and only the new row is mounted.
  assert.equal(second.rows[0], first.rows[0]);
  assert.notEqual(second.rows, first.rows);
});

test('a result arriving later mutates its card in place, keeping the list stable', () => {
  const call = addEvents(noRows(), [
    { seq: 1, e: { kind: 'tool_call', id: 'a#0', at: AT, tool: 'Bash', input: {}, callId: 'c' } },
  ]);
  const done = addEvents(call, [
    {
      seq: 2,
      e: { kind: 'tool_result', id: 'u#0', at: AT, callId: 'c', output: 'ok', isError: false },
    },
  ]);
  assert.equal(done.rows.length, 1);
  assert.equal((done.rows[0] as ToolRow).result, 'ok');
  assert.equal(done.seq, 2);
});

test('the collapsed summary says what ran, in one line', () => {
  assert.equal(summarise({ command: 'npm test', description: 'run tests' }), 'npm test');
  assert.equal(summarise({ pattern: 'TODO', path: '/src' }), 'TODO');
  // A path is clipped from the left, because CSS clips from the right and a
  // column of `Read /tmp/claude-1000/-home-galawayd…` cards says nothing.
  assert.equal(summarise({ file_path: '/a/b.ts', offset: 10 }), '/a/b.ts');
  assert.equal(summarise({ file_path: '/very/long/path/to/fizz.js' }), '…/to/fizz.js');
  assert.equal(summarise({ path: 'src/web/style.css' }), '…/web/style.css');
  // A multi-line command is still one line on the card; the card body has it all.
  assert.equal(summarise({ command: 'cd /tmp &&\n  ls -la' }), 'cd /tmp && ls -la');
  // Nothing recognised: show the shape rather than an empty card header.
  assert.equal(summarise({ todos: [1, 2] }), '{"todos":[1,2]}');
  // Nothing at all to say, which is a blank summary rather than "{}".
  assert.equal(summarise({}), '');
  assert.equal(summarise(undefined), '');
});

/**
 * The optimistic card and the record that supersedes it.
 *
 * One rule, in both directions: **replaced, never duplicated**. The proposal
 * arrives from the pre-tool hook, the record arrives from the transcript, and
 * nothing guarantees the order — on Claude Code 2.1.220 the record was measured
 * landing ~150ms *after* the hook, which is close enough that a build with a
 * different flush timer could invert it.
 */
const PROPOSED: Extract<ConversationEvent, { kind: 'tool_call' }> = {
  kind: 'tool_call',
  id: 'pending:toolu_1',
  at: AT,
  tool: 'Write',
  input: { file_path: '/tmp/out.txt', content: 'hello\n' },
  callId: 'toolu_1',
};

test('a proposed tool call is a card of its own, marked pending', () => {
  const state = addPending(noRows(), PROPOSED);
  assert.deepEqual(state.rows.length, 1);
  const row = state.rows[0] as ToolRow;
  assert.equal(row.row, 'tool');
  assert.equal(row.tool, 'Write');
  assert.equal(row.pending, true);
  assert.equal(row.summary, '/tmp/out.txt', 'summarised by the same rules as a real call');
  assert.equal(row.result, null);
  // It moved no cursor: a proposal has no position in the `seq` stream.
  assert.equal(state.seq, 0);
});

test('the transcript record replaces the pending card rather than adding a second', () => {
  const proposed = addPending(noRows(), PROPOSED);
  const after = addEvents(proposed, [
    {
      seq: 1,
      e: { ...PROPOSED, id: 'uuid-7#0', at: AT + 150 },
    },
  ]);

  assert.equal(after.rows.length, 1, 'one card, not two');
  const row = after.rows[0] as ToolRow;
  assert.equal(row.pending, false, 'and it is no longer a proposal');
  assert.equal(row.key, 'pending:toolu_1', 'the same row, so it does not jump in the list');
  assert.equal(after.seq, 1, 'the record itself did move the cursor');

  // And the result still folds into it, so nothing about the join is lost.
  const done = addEvents(after, [
    {
      seq: 2,
      e: { kind: 'tool_result', id: 'r1', at: AT, callId: 'toolu_1', output: 'ok', isError: false },
    },
  ]);
  assert.equal(done.rows.length, 1);
  assert.equal((done.rows[0] as ToolRow).result, 'ok');
});

test('a proposal for a call already on screen is ignored, not shown twice', () => {
  const fromTranscript = addEvents(noRows(), [{ seq: 1, e: { ...PROPOSED, id: 'uuid-7#0' } }]);
  const after = addPending(fromTranscript, PROPOSED);

  assert.equal(after, fromTranscript, 'not even a re-render');
  assert.equal(after.rows.length, 1);
  assert.equal((after.rows[0] as ToolRow).pending, false);
});

test('two proposals in one turn are two cards, and each is replaced by its own record', () => {
  let state = addPending(noRows(), PROPOSED);
  state = addPending(state, {
    ...PROPOSED,
    id: 'pending:toolu_2',
    callId: 'toolu_2',
    tool: 'Bash',
  });
  assert.equal(state.rows.length, 2);

  state = addEvents(state, [
    { seq: 1, e: { ...PROPOSED, id: 'uuid-7#0', callId: 'toolu_2', tool: 'Bash' } },
  ]);
  assert.deepEqual(
    state.rows.map((row) => (row as ToolRow).pending),
    [true, false],
  );
});

test('a composed message shows at once and is replaced, not duplicated, by its record', () => {
  const sent = 'rewrite the parser\n\nkeep the tests passing';
  let state = addEcho(noRows(), sent);
  // Shown before any round trip: the whole point of composing locally is that
  // the textarea does not empty into silence while the agent thinks.
  assert.deepEqual(texts(state), [sent]);
  assert.equal(state.rows.length, 0);

  // The transcript catches up. One message, from the record — never two.
  state = addEvents(state, stream({ kind: 'user', id: 'u1', at: AT, text: sent }));
  assert.deepEqual(texts(state), []);
  assert.deepEqual(state.rows, [{ key: '1', row: 'message', who: 'user', text: sent }]);
});

test('the record retires an echo even when the provider recorded it differently', () => {
  // Matching on text would leave the echo standing beside its own record for
  // the life of the session; matching on arrival order cannot.
  let state = addEcho(noRows(), 'ship it');
  state = addEvents(state, stream({ kind: 'user', id: 'u1', at: AT, text: 'ship it\n' }));
  assert.deepEqual(texts(state), []);
  assert.equal(state.rows.length, 1);
});

test('two messages sent before either lands retire oldest-first and stay in order', () => {
  let state = addEcho(addEcho(noRows(), 'first'), 'second');
  assert.deepEqual(texts(state), ['first', 'second']);

  state = addEvents(state, stream({ kind: 'user', id: 'u1', at: AT, text: 'first' }));
  assert.deepEqual(texts(state), ['second']);

  state = addEvents(state, [{ seq: 2, e: { kind: 'user', id: 'u2', at: AT, text: 'second' } }]);
  assert.deepEqual(texts(state), []);
  assert.deepEqual(
    state.rows.map((row) => (row as { text: string }).text),
    ['first', 'second'],
  );
});

test('a replayed record cannot retire a second echo', () => {
  // The `since` replay after a reconnect re-sends events the client already has.
  // They are dropped by `seq` before anything else looks at them — an echo
  // retired twice would erase a message the user really did send.
  let state = addEcho(addEcho(noRows(), 'first'), 'second');
  const first = stream({ kind: 'user', id: 'u1', at: AT, text: 'first' });
  state = addEvents(state, first);
  state = addEvents(state, first);
  assert.deepEqual(texts(state), ['second']);
  assert.equal(state.rows.length, 1);
});

test('an assistant message does not retire an echo', () => {
  // Only the user’s own record supersedes the user’s own echo.
  const state = addEvents(addEcho(noRows(), 'hello'), [
    { seq: 1, e: { kind: 'assistant', id: 'a1', at: AT, text: 'working on it' } },
  ]);
  assert.deepEqual(texts(state), ['hello']);
});

test('the composer refuses to send into a permission prompt, and only that state', () => {
  // A message pasted at a permission prompt is not a message: it answers the
  // dialog with whatever option is selected, which can be *yes* to a command
  // nobody read. Refused, and the reason is a sentence rather than a grey button.
  assert.equal(
    sendBlocked('waiting', 'ship it', 'live'),
    'Answer the prompt in the terminal first.',
  );
  // Mid-turn is not refused. Both providers queue what arrives during a turn, and
  // redirecting an agent that is off down the wrong path is the whole reason to
  // reach for a phone.
  assert.equal(sendBlocked('busy', 'ship it', 'live'), null);
  assert.equal(sendBlocked('idle', 'ship it', 'live'), null);
  // Nor is a dropped socket: the frame waits in the unacked set and goes out on
  // the next connect, which is what that set is for.
  assert.equal(sendBlocked('idle', 'ship it', 'retrying'), null);
});

test('the composer refuses a message the wire would drop, and says how long it is', () => {
  // `parseClientFrame` returns null over `MAX_TEXT` and so never ACKs, which
  // means the frame is resent on every reconnect while the view shows a
  // "Sending…" that can never resolve. Measured the way the server measures it:
  // `String.length` on the trimmed text that is actually sent.
  assert.equal(sendBlocked('idle', 'x'.repeat(MAX_TEXT), 'live'), null);
  assert.equal(
    sendBlocked('idle', 'x'.repeat(MAX_TEXT + 1), 'live'),
    `Too long to send: ${MAX_TEXT + 1} characters, and the limit is ${MAX_TEXT}.`,
  );
});

test('the composer refuses a session that has ended, and says which kind of gone', () => {
  // The composed message leaves on the terminal socket, so once that socket is
  // finished there is nowhere for it to go. Two closes, two facts: a session
  // that stopped is not a session the server cannot find.
  assert.equal(
    sendBlocked('idle', 'ship it', 'ended'),
    'This session has ended. Nothing can reach it now.',
  );
  assert.equal(
    sendBlocked('idle', 'ship it', 'gone'),
    'The server no longer has this session. Nothing can reach it now.',
  );
});

test('an echo outstanding when the socket closes for good is marked, not left sending', () => {
  // The composer refuses a *new* message after either close, but the card above
  // that refusal was claiming a message was on its way with no socket left to
  // carry it. Marked rather than dropped: the text is what the user would lose.
  const sending = addEcho(noRows(), 'ship it');
  assert.equal(sending.echoes[0]?.undelivered, null);

  // Every other status leaves it alone, and says so by identity — a message on a
  // reconnecting socket is still going out, which is what the unacked set is for.
  for (const status of ['connecting', 'live', 'retrying', 'signedOut'] as const) {
    assert.equal(markUndelivered(sending, status), sending);
  }

  // Two closes, two facts — and each says only the fact. Whether the message
  // arrived is not something this side knows: the ACK is an earlier milestone
  // than the transcript record, and it lives in the terminal view's unacked set.
  assert.equal(
    markUndelivered(sending, 'ended').echoes[0]?.undelivered,
    'This session ended before the agent recorded this message.',
  );
  assert.equal(
    markUndelivered(sending, 'gone').echoes[0]?.undelivered,
    'The server no longer has this session, and the agent had not recorded this message.',
  );

  // Nothing outstanding, and a second pass over what is already marked, are both
  // the same object: the effect that calls this runs on every status change.
  const empty = noRows();
  assert.equal(markUndelivered(empty, 'ended'), empty);
  const marked = markUndelivered(sending, 'ended');
  assert.equal(markUndelivered(marked, 'ended'), marked);
});

test('marking an echo undelivered is not retiring it: a late record still retires it once', () => {
  // Marked is a state, not an exit. If the pane did take the message before it
  // went and the record turns up, it retires the echo through the ordinary path
  // — exactly once, and never beside a second copy of itself.
  let state = markUndelivered(addEcho(addEcho(noRows(), 'first'), 'second'), 'ended');
  assert.deepEqual(texts(state), ['first', 'second']);

  const record = stream({ kind: 'user', id: 'u1', at: AT, text: 'first' });
  state = addEvents(state, record);
  assert.deepEqual(texts(state), ['second']);
  // The replay of that same record cannot take the second one with it.
  state = addEvents(state, record);
  assert.deepEqual(texts(state), ['second']);
  assert.equal(state.rows.length, 1);
  assert.equal(
    state.echoes[0]?.undelivered,
    'This session ended before the agent recorded this message.',
  );
});

test('a refetch keeps an outstanding echo, and its record still retires it once', () => {
  // The server answered `refetch`, so the whole history is replayed onto fresh
  // rows. The echo must survive that: the records already applied had their
  // chance and retired nothing, and dropping it blanks a just-sent message for
  // as long as the turn it landed in.
  const history = [
    { seq: 1, e: { kind: 'user', id: 'u1', at: AT, text: 'first' } },
    { seq: 2, e: { kind: 'assistant', id: 'a1', at: AT, text: 'done' } },
  ] as const;
  let live = addEvents(noRows(), history);
  live = addEcho(live, 'second');

  // The replayed record for 'first' already had its chance at the echo and
  // retired nothing, so replaying it must not retire it now.
  let fresh = rebuild(live, history);
  assert.deepEqual(texts(fresh), ['second']);
  assert.equal(fresh.rows.length, 2);
  assert.equal(fresh.seq, 2);

  // And the record retires it exactly once when it finally lands.
  fresh = addEvents(fresh, [{ seq: 3, e: { kind: 'user', id: 'u2', at: AT, text: 'second' } }]);
  assert.deepEqual(texts(fresh), []);
  assert.equal(fresh.rows.filter((row) => row.row === 'message' && row.who === 'user').length, 2);

  // A refetch with nothing outstanding is the plain full rebuild.
  assert.deepEqual(texts(rebuild(noRows(), history)), []);
  assert.equal(rebuild(noRows(), history).rows.length, 2);
});

/**
 * Answering from the card.
 *
 * The rule that matters here is that the *deadline* decides whether a card has
 * buttons, not `pending`. tether reports far more proposals than it holds — a
 * read-only tool, a background session, a hold turned off — and a button on a
 * card nobody is waiting on would send a tap into a prompt that has moved on.
 */
const DEADLINE = AT + 20_000;

test('a proposal tether is holding gets buttons; one it is only reporting does not', () => {
  assert.equal((addPending(noRows(), PROPOSED).rows[0] as ToolRow).answerable, null);

  const held = addPending(noRows(), PROPOSED, DEADLINE);
  assert.deepEqual((held.rows[0] as ToolRow).answerable, {
    callId: 'toolu_1',
    deadline: DEADLINE,
  });
});

test('the record landing first does not cost the buttons: the agent is still blocked', () => {
  // The measured ordering on 2.1.220 was hook-then-record, but the fixtures
  // caught the other one. Either way the hook is what the agent is waiting on.
  const fromTranscript = addEvents(noRows(), [{ seq: 1, e: { ...PROPOSED, id: 'uuid-7#0' } }]);
  const after = addPending(fromTranscript, PROPOSED, DEADLINE);
  assert.equal(after.rows.length, 1, 'still one card');
  assert.deepEqual((after.rows[0] as ToolRow).answerable?.deadline, DEADLINE);
});

test('an answer takes the buttons away, whoever gave it', () => {
  for (const outcome of ['allow', 'deny', 'timeout'] as const) {
    const held = addPending(noRows(), PROPOSED, DEADLINE);
    const after = addAnswer(held, 'toolu_1', outcome);
    const row = after.rows[0] as ToolRow;
    assert.equal(row.answerable, null, outcome);
    assert.equal(row.outcome, outcome);
    // A second frame for the same call changes nothing — the reconnect replay,
    // or two viewers' sockets both reporting the one answer.
    assert.equal(addAnswer(after, 'toolu_1', 'deny'), after, outcome);
  }
});

test('an answer for a card this client never built is ignored, not a crash', () => {
  const held = addPending(noRows(), PROPOSED, DEADLINE);
  assert.equal(addAnswer(held, 'toolu_unknown', 'allow'), held);
});

test('what a card says about a permission it is holding, and about how it ended', () => {
  const held = addPending(noRows(), PROPOSED, DEADLINE).rows[0] as ToolRow;
  assert.equal(toolState(held), 'asking');
  assert.match(toolResult(held), /waiting on your answer/);

  const answered = (outcome: 'allow' | 'deny' | 'timeout') =>
    addAnswer(addPending(noRows(), PROPOSED, DEADLINE), 'toolu_1', outcome).rows[0] as ToolRow;

  assert.equal(toolState(answered('deny')), 'denied');
  assert.match(toolResult(answered('deny')), /did not run it/);
  // A timeout is not an error and must not read as one: the question went back
  // to the agent's own prompt, which the terminal tab is showing.
  assert.equal(toolState(answered('timeout')), 'in terminal');
  assert.match(toolResult(answered('timeout')), /asking in the terminal/);
  assert.equal(toolState(answered('allow')), '…', 'approved, and now simply running');

  // And once the real result lands, the card is an ordinary finished one again.
  const approved = addAnswer(addPending(noRows(), PROPOSED, DEADLINE), 'toolu_1', 'allow');
  const done = addEvents(approved, [
    { seq: 1, e: { ...PROPOSED, id: 'uuid-7#0' } },
    {
      seq: 2,
      e: { kind: 'tool_result', id: 'r1', at: AT, callId: 'toolu_1', output: 'ok', isError: false },
    },
  ]);
  assert.equal(toolState(done.rows[0] as ToolRow), '✓');
  assert.equal(toolResult(done.rows[0] as ToolRow), 'ok');
});
