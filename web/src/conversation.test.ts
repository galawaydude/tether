import type { ConversationEvent, ToolCallEvent } from '@tether/shared';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addAnswer,
  addEcho,
  addEvents,
  addPending,
  AUTH_ADVICE,
  diffExtras,
  elapsedLabel,
  errorAdvice,
  historyPage,
  markUndelivered,
  MAX_CONVERSATION_ROWS,
  messageContent,
  messageWithImages,
  noRows,
  rebuild,
  sendBlocked,
  SLOW_TURN_MS,
  inputSuspects,
  scanSuspects,
  summarise,
  suspectWarning,
  toDiff,
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
  assert.deepEqual(rows[0], {
    key: '1',
    row: 'message',
    who: 'user',
    // Both: `text` is what Copy copies and what a test asserts on, `blocks` is
    // what the view draws. They are the same characters, parsed once.
    text: 'add a test',
    blocks: [{ block: 'p', spans: [{ span: 'text', text: 'add a test' }] }],
    images: [],
  });
  // Presence only: the row carries no text, because the transcript carries none.
  assert.deepEqual(rows[1], { key: '2', row: 'thinking' });
});

test('a pasted image marker gives the provider a path and the browser only an opaque id', () => {
  const id = '11111111-2222-4333-8444-555555555555.png';
  const source = messageWithImages('look at this', [
    { id, path: '/private/state dir/attachments/image.png' },
  ]);
  assert.equal(
    source,
    'look at this\n\n' +
      '[Image attached: 11111111-2222-4333-8444-555555555555.png at "/private/state dir/attachments/image.png"]',
  );
  assert.deepEqual(messageContent(source), {
    text: 'look at this',
    blocks: [{ block: 'p', spans: [{ span: 'text', text: 'look at this' }] }],
    images: [{ id }],
  });
  assert.deepEqual(messageContent(messageWithImages('', [{ id, path: '/state/image.png' }])), {
    text: '',
    blocks: [],
    images: [{ id }],
  });
  assert.deepEqual(messageContent('[Image attached: not-controlled.png at "/etc/passwd"]'), {
    text: '[Image attached: not-controlled.png at "/etc/passwd"]',
    blocks: [
      {
        block: 'p',
        spans: [{ span: 'text', text: '[Image attached: not-controlled.png at "/etc/passwd"]' }],
      },
    ],
    images: [],
  });
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

test("an Edit's input becomes a diff, and the card shows that instead of the input", () => {
  const card = toRows(
    stream({
      kind: 'tool_call',
      id: 'a#0',
      at: AT,
      tool: 'Edit',
      input: {
        file_path: '/home/you/app/src/keys.ts',
        old_string: 'const a = 1;\nconst b = 2;\nconst c = 3;',
        new_string: 'const a = 1;\nconst b = 20;\nconst extra = 0;\nconst c = 3;',
      },
      callId: 'c',
    }),
  )[0] as ToolRow;
  assert.deepEqual(card.diff, {
    path: '/home/you/app/src/keys.ts',
    lines: [
      // The identical head and tail are context; everything between them is
      // removed and then added, which is what an Edit is.
      { at: 'ctx', text: 'const a = 1;' },
      { at: 'del', text: 'const b = 2;' },
      { at: 'add', text: 'const b = 20;' },
      { at: 'add', text: 'const extra = 0;' },
      { at: 'ctx', text: 'const c = 3;' },
    ],
    covers: ['file_path', 'old_string', 'new_string'],
  });
});

test('a Write is every line added, and any other tool has no diff at all', () => {
  const written = toDiff('Write', { file_path: '/tmp/new.txt', content: 'one\ntwo' });
  assert.deepEqual(written, {
    path: '/tmp/new.txt',
    lines: [
      { at: 'add', text: 'one' },
      { at: 'add', text: 'two' },
    ],
    covers: ['file_path', 'content'],
  });
  // Nothing is guessed at: a card only draws a change when the input says one.
  assert.equal(toDiff('Bash', { command: 'rm -rf ./build' }), null);
  assert.equal(toDiff('Read', { file_path: '/etc/hosts' }), null);
  // A string input that is not a patch is not one, however many `+` it holds.
  assert.equal(toDiff('Task', 'add a line\n+ like this'), null);
});

test("Codex's apply_patch is read as the patch it already is", () => {
  // Byte-for-byte the shape in the 0.145.0 rollout fixture.
  const patch =
    '*** Begin Patch\n*** Update File: /home/tester/work/probe.txt\n@@\n-HELLO\n+WORLD\n*** End Patch\n';
  const lines = [
    { at: 'meta', text: '*** Update File: /home/tester/work/probe.txt' },
    { at: 'meta', text: '@@' },
    { at: 'del', text: 'HELLO' },
    { at: 'add', text: 'WORLD' },
  ];
  assert.deepEqual(toDiff('apply_patch', patch), {
    path: '/home/tester/work/probe.txt',
    lines,
    covers: [],
  });
  // The same call as its *hook* payload carries it — `{ command: <patch> }`, the
  // shape in the 0.145.0 hooks fixture. Whichever of the two arrives first is
  // the card that gets drawn, and `toRow` only flips `pending` on the other, so
  // both orderings have to produce the same diff or an answerable Codex card
  // shows raw JSON where the change should be.
  assert.deepEqual(toDiff('apply_patch', { command: patch }), {
    path: '/home/tester/work/probe.txt',
    lines,
    covers: ['command'],
  });
});

test('a rename is kept rather than drawn as an edit of the old path', () => {
  // `*** Move to:` is the one `*** ` directive that changes where the file ends
  // up, and a card the agent is blocked on may not drop it.
  const diff = toDiff(
    'apply_patch',
    '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-a\n+b\n*** End of File\n*** End Patch',
  );
  assert.deepEqual(diff?.lines, [
    { at: 'meta', text: '*** Update File: old.txt' },
    { at: 'meta', text: '*** Move to: new.txt' },
    { at: 'meta', text: '@@' },
    { at: 'del', text: 'a' },
    { at: 'add', text: 'b' },
  ]);
});

test('an answerable card says the input fields its diff does not', () => {
  const edit = (input: unknown): ToolCallEvent => ({
    kind: 'tool_call',
    id: 'a#0',
    at: AT,
    tool: 'Edit',
    input,
    callId: 'c',
  });
  const covered = { file_path: '/home/you/app/src/keys.ts', old_string: 'a', new_string: 'b' };

  // Held: the diff shows one occurrence, `replace_all` rewrites every match of
  // it, and the field is not a special case — it is simply not in the set the
  // branch that built the diff says it consumed, so the rule catches the next
  // such field without anyone having to think of it.
  const held = addPending(noRows(), edit({ ...covered, replace_all: true }), AT + 20_000)
    .rows[0] as ToolRow;
  assert.equal(diffExtras(held), 'replace_all: true');

  // The same call while it runs: nothing is being approved, so the diff is the
  // right level of detail and the card is unchanged.
  const running = toRows(stream(edit({ ...covered, replace_all: true })))[0] as ToolRow;
  assert.equal(diffExtras(running), null);

  // And nothing at all when the diff already speaks for the whole input — no
  // empty section, no heading, no furniture on the card that has to fit a phone.
  const plain = addPending(noRows(), edit(covered), AT + 20_000).rows[0] as ToolRow;
  assert.equal(diffExtras(plain), null);
});

test('a failed call says whether it is fixing itself or waiting for a human', () => {
  // The distinction is the whole feature: one of these means put the phone
  // down, the other means open the terminal.
  const limited = errorAdvice(
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
  );
  assert.equal(limited?.act, false);
  assert.equal(errorAdvice('API Error: 401 {"type":"authentication_error"}')?.act, true);
  assert.equal(
    errorAdvice('approval policy is UnlessTrusted; reject command — rm -rf /')?.act,
    true,
  );

  // Anchored at the start, so a command whose own output talks about rate
  // limits is not reported as the provider rate-limiting.
  assert.equal(errorAdvice('grep: nginx.log: 3 hits for API Error: 429'), null);
  assert.equal(errorAdvice('cc: error: no such file'), null);

  // And the collapsed row carries it, because that is what a glance gets.
  const failed = (result: string): ToolRow =>
    toRows(
      stream(
        { kind: 'tool_call', id: 'a#0', at: AT, tool: 'Bash', input: {}, callId: 'c' },
        { kind: 'tool_result', id: 'u#0', at: AT, callId: 'c', output: result, isError: true },
      ),
    )[0] as ToolRow;
  assert.equal(toolState(failed('API Error: 429 {}')), 'retrying');
  assert.equal(toolState(failed('API Error: 401 {}')), 'needs you');
  assert.equal(toolState(failed('boom')), 'error');
});

test('the turn stopwatch says nothing until a turn is long enough to be news', () => {
  // The number appearing *is* the signal, so a fast turn shows nothing — a
  // counter that runs on every turn is furniture nobody reads by the next day.
  assert.equal(elapsedLabel(AT, AT + 59_000), null);
  assert.equal(elapsedLabel(AT, AT + SLOW_TURN_MS), '1m 00s');
  assert.equal(elapsedLabel(AT, AT + 125_000), '2m 05s');
  // No turn running is no number, whatever the clock says.
  assert.equal(elapsedLabel(null, AT + 10 * SLOW_TURN_MS), null);
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

test('a live conversation keeps only its latest rows', () => {
  const count = MAX_CONVERSATION_ROWS + 8;
  const state = addEvents(
    noRows(),
    stream(
      ...Array.from({ length: count }, (_, index) => ({
        kind: 'assistant' as const,
        id: `a-${index}`,
        at: AT + index,
        text: `reply ${index}`,
      })),
    ),
  );

  assert.equal(state.seq, count, 'the resume cursor still covers the whole stream');
  assert.equal(state.rows.length, MAX_CONVERSATION_ROWS);
  assert.equal(state.truncated, true);
  assert.equal(state.rows[0]?.row === 'message' ? state.rows[0].text : '', 'reply 8');
});

test('an archive response becomes one bounded, labelled page', () => {
  const events = stream(
    { kind: 'assistant', id: 'a1', at: AT, text: 'older one' },
    { kind: 'assistant', id: 'a2', at: AT + 1, text: 'older two' },
  ).map((event) => ({ ...event, seq: event.seq + 100 }));
  const page = historyPage(events, true);
  assert.notEqual(page, null);
  assert.equal(page?.first, 101);
  assert.equal(page?.last, 102);
  assert.equal(page?.more, true);
  assert.deepEqual(
    page?.view.rows.map((row) => (row.row === 'message' ? row.text : row.row)),
    ['older one', 'older two'],
  );
  assert.equal(historyPage([], false), null);
});

test('a result arriving later replaces only its card, keeping the list stable', () => {
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
  assert.notEqual(done.rows[0], call.rows[0], 'the changed card renders through memo');
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

test('bounding a long view never drops an answerable permission card', () => {
  let state = addPending(noRows(), PROPOSED, AT + 20_000);
  state = addEvents(
    state,
    stream(
      ...Array.from({ length: MAX_CONVERSATION_ROWS + 1 }, (_, index) => ({
        kind: 'assistant' as const,
        id: `after-${index}`,
        at: AT + index,
        text: `after ${index}`,
      })),
    ),
  );

  assert.equal(state.truncated, true);
  assert.equal(state.rows.length, MAX_CONVERSATION_ROWS);
  assert.equal(state.rows[0]?.row, 'tool');
  assert.notEqual((state.rows[0] as ToolRow).answerable, null);
});

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
  assert.notEqual(row, proposed.rows[0], 'the changed card renders through memo');
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
  assert.deepEqual(
    state.rows.map((row) => row.row === 'message' && row.text),
    [sent],
  );
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

test('a slash command is a row of its own, and it is not a message', () => {
  // The composer can send a slash command and it is the only evidence outside the
  // pane that one landed. It is not a message either way: it is addressed to the
  // agent's CLI, so it gets no box and no "You" over it — see `.cmd` in
  // `style.css` for why that is the house rule and not a preference.
  const rows = toRows(
    stream(
      { kind: 'command', id: 'c1', at: AT, text: '/model sonnet' },
      { kind: 'command', id: 'c2', at: AT, text: 'Set model to Sonnet 5', output: true },
    ),
  );
  assert.deepEqual(rows, [
    { key: '1', row: 'command', text: '/model sonnet', output: false },
    { key: '2', row: 'command', text: 'Set model to Sonnet 5', output: true },
  ]);
});

test('a slash command does not retire a composed message', () => {
  // `/resume` typed into the composer sends no echo, so nothing is outstanding
  // for a command record to retire — and a message that *is* outstanding must
  // survive a command record landing in between, since only the user's own
  // transcript record supersedes their own echo.
  const state = addEvents(addEcho(noRows(), 'hello'), [
    { seq: 1, e: { kind: 'command', id: 'c1', at: AT, text: '/compact' } },
  ]);
  assert.deepEqual(texts(state), ['hello']);
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
  // finished there is nowhere for it to go. Three closes, three facts: a session
  // that stopped is not a session the server cannot find, and neither of those
  // is an attach that threw for a reason this side never saw.
  assert.equal(
    sendBlocked('idle', 'ship it', 'ended'),
    'This session has ended. Nothing can reach it now.',
  );
  assert.equal(
    sendBlocked('idle', 'ship it', 'gone'),
    'The server no longer has this session. Nothing can reach it now.',
  );
  const failed = sendBlocked('idle', 'ship it', 'failed');
  assert.match(failed ?? '', /could not open a terminal/);
  assert.doesNotMatch(
    failed ?? '',
    /no longer has|not found/,
    'it must not say the session is gone',
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
  assert.equal(
    markUndelivered(sending, 'failed').echoes[0]?.undelivered,
    'The terminal channel failed before the agent recorded this message.',
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

test('a hold that ended while the socket was down comes back dead, not wearing buttons', () => {
  // The screen lock: the only viewer went, which released the agent to its own
  // prompt, and the phone came back to a replay. The server replays the proposal
  // with no deadline — it is not holding this call any more — followed by the
  // answer that ended it, and the card has to read as the over thing it is.
  const held = addPending(noRows(), PROPOSED, DEADLINE);
  const replayed = addPending(held, PROPOSED);
  assert.equal((replayed.rows[0] as ToolRow).answerable, null, 'the buttons are gone');

  const settled = addAnswer(replayed, 'toolu_1', 'timeout');
  const row = settled.rows[0] as ToolRow;
  assert.equal(row.outcome, 'timeout');
  assert.equal(toolState(row), 'in terminal');
  assert.match(toolResult(row, 'claude-code'), /asking in the terminal/);
});

test('an answer for a card this client never built is ignored, not a crash', () => {
  const held = addPending(noRows(), PROPOSED, DEADLINE);
  assert.equal(addAnswer(held, 'toolu_unknown', 'allow'), held);
});

test('what a card says about a permission it is holding, and about how it ended', () => {
  const held = addPending(noRows(), PROPOSED, DEADLINE).rows[0] as ToolRow;
  assert.equal(toolState(held), 'asking');
  assert.match(toolResult(held, 'claude-code'), /waiting on your answer/);

  const answered = (outcome: 'allow' | 'deny' | 'timeout') =>
    addAnswer(addPending(noRows(), PROPOSED, DEADLINE), 'toolu_1', outcome).rows[0] as ToolRow;

  assert.equal(toolState(answered('deny')), 'denied');
  assert.match(toolResult(answered('deny'), 'claude-code'), /did not run it/);
  // A timeout is not an error and must not read as one: the question went back
  // to the agent's own prompt, which the terminal is showing.
  assert.equal(toolState(answered('timeout')), 'in terminal');
  assert.match(toolResult(answered('timeout'), 'claude-code'), /asking in the terminal/);
  // It names the agent that is actually running. It used to say "Claude Code"
  // outright, which on a Codex card sent the user to answer an agent that was
  // not there — the same family of fault as the close code above it.
  assert.match(toolResult(answered('timeout'), 'claude-code'), /^No answer here in time — Claude/);
  assert.match(toolResult(answered('timeout'), 'codex'), /^No answer here in time — Codex/);
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
  assert.equal(toolResult(done.rows[0] as ToolRow, 'claude-code'), 'ok');
});

/* ── lookalike characters ────────────────────────────────────────────────────
 *
 * The guard on the permission card, and the reason it is narrower than Zed's:
 * a tool call's input is arbitrary text, so a guard that fires on ordinary
 * non-English text trains people to click through the one that matters. Every
 * case below is one of the two halves — a real attack that must be named, or an
 * ordinary command that must stay silent.
 *
 * The suspicious characters are written as escapes on purpose: a literal
 * zero-width space in a test file is a character nobody reviewing this can see.
 */

/** What the warning names, as one string, for the assertions below. */
function named(text: string): string {
  return suspectWarning(scanSuspects(text)) ?? '';
}

test('a Cyrillic homoglyph in an otherwise-ASCII path is named, with its code point and script', () => {
  const found = scanSuspects('rm -rf ./bu\u0456ld');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.kind, 'confusable');
  // The character, its code point and its script — a warning that says
  // "suspicious characters" without saying which teaches nothing.
  assert.equal(found[0]?.description, "'\u0456' (U+0456 Cyrillic)");
  assert.match(named('rm -rf ./bu\u0456ld'), /U\+0456 Cyrillic/);
});

test('a zero-width character inside a command is named, and no glyph is printed for it', () => {
  const found = scanSuspects('curl https://git\u200Bhub.com/install.sh');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.kind, 'invisible');
  assert.equal(found[0]?.description, 'U+200B zero-width space');
});

test('a right-to-left override is named as one, and never printed into the warning', () => {
  const found = scanSuspects('cat resume\u202Egpj.exe');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.kind, 'bidi');
  assert.equal(found[0]?.description, 'U+202E right-to-left override');
  // Printing the control itself would reorder the warning's own text.
  assert.ok(!named('cat resume\u202Egpj.exe').includes('\u202E'));
});

test('a compatibility form standing in for an ASCII character says which one', () => {
  const found = scanSuspects('rm -rf \uFF0Fetc');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.description, '\'\uFF0F\' (U+FF0F looks like "/")');
});

/**
 * The case that decides whether this guard is worth having. A path with genuine
 * non-English text is ordinary, and crying wolf on it trains people to tap
 * through the warning that is real — so **no** legitimate non-ASCII command may
 * be flagged. The Latin block is exempt entirely (`søren`, `kullanıcı`,
 * `café` are all ASCII letters mixed with a non-ASCII Latin one) and a word of
 * one non-Latin script is a word in that language, not a homoglyph.
 */
test('a legitimate non-ASCII command is not flagged', () => {
  for (const command of [
    'ls -la',
    'rm -rf /home/user/документы',
    'cat /home/søren/notes.txt',
    'cat /home/kullanıcı/build',
    'git commit -m "café naïve résumé"',
    'echo "日本語のテキスト" > notes.txt',
    'grep -r "αβγ" src/',
    'python3 -c "print(1)"\n\tls\t-la',
  ]) {
    assert.deepEqual(scanSuspects(command), [], command);
  }
});

test('each character is named once, in the order it appears', () => {
  const found = scanSuspects('\u0430bc\u0430 x\u200By\u200Bz \u202E');
  assert.deepEqual(
    found.map((suspect) => suspect.kind),
    ['confusable', 'invisible', 'bidi'],
  );
});

test('the list of names is capped, so a warning cannot grow without limit', () => {
  const many = suspectWarning(scanSuspects(`xабвгдежзy`)) ?? '';
  assert.match(many, /and 2 more\.$/);
  assert.equal(suspectWarning([]), null);
});

test('a card scans every string in the input, keys included, and never the result', () => {
  // The path is the attack and it is nested, so a scan of the summary alone
  // would miss it. `inputSuspects` walks the input instead of enumerating the
  // fields the card happens to show today.
  const found = inputSuspects({ edits: [{ file_path: '/tmp/bu\u0456ld/app.ts' }] });
  assert.equal(found[0]?.description, "'\u0456' (U+0456 Cyrillic)");
  assert.deepEqual(inputSuspects({ command: 'npm test' }), []);
  assert.deepEqual(inputSuspects(undefined), []);
});

test('an answerable card carries the finding, and an ordinary one still notes it', () => {
  const input = { command: 'rm -rf ./bu\u0456ld' };
  const proposed: ToolCallEvent = { ...PROPOSED, tool: 'Bash', input };
  const held = addPending(noRows(), proposed, DEADLINE).rows[0] as ToolRow;
  assert.match(suspectWarning(held.suspects) ?? '', /U\+0456 Cyrillic/);

  // The same finding on a card nobody is deciding on. It is a note there — the
  // gate is the view's, and there is no answer to hold back.
  const ran = toRows([{ seq: 1, e: { ...proposed, id: 'uuid-7#0' } }])[0] as ToolRow;
  assert.match(suspectWarning(ran.suspects) ?? '', /U\+0456 Cyrillic/);

  // And an ordinary call carries nothing at all, so the view draws nothing.
  const clean = addPending(noRows(), { ...PROPOSED, input: { command: 'npm test' } }, DEADLINE)
    .rows[0] as ToolRow;
  assert.deepEqual(clean.suspects, []);
});

test('a failed turn is a row of its own, and only an auth one asks for anything', () => {
  const rows = toRows(
    stream(
      {
        kind: 'error',
        id: 'e1',
        at: AT,
        text: 'Please run /login · API Error: 401 OAuth token has expired.',
        auth: true,
      },
      { kind: 'error', id: 'e2', at: AT, text: 'API Error: 500 Internal server error.' },
    ),
  );

  // Not a message: rendering the agent's CLI in the agent's voice is how "your
  // login expired" reads as the agent saying something strange.
  assert.deepEqual(
    rows.map((row) => row.row),
    ['error', 'error'],
  );
  assert.deepEqual(
    rows.map((row) => (row.row === 'error' ? row.auth : null)),
    [true, false],
  );

  // The provider's own sentence, kept verbatim — it is what the pane says too.
  assert.equal(
    rows[0]?.row === 'error' ? rows[0].text : '',
    'Please run /login · API Error: 401 OAuth token has expired.',
  );
});

test('tether’s advice on an auth failure is the same claim its tool cards make', () => {
  // `act` is the needs-you/retrying distinction the typed-error work set, and
  // this reuses it rather than inventing a second vocabulary for one screen.
  assert.equal(AUTH_ADVICE.act, true);
  assert.equal(errorAdvice('API Error: 401 {"type":"authentication_error"}')?.act, AUTH_ADVICE.act);

  // It may not name a provider: one string on this screen already does and it
  // is wrong on a Codex card. See `providerLabel`.
  assert.doesNotMatch(AUTH_ADVICE.text, /Claude|Codex/);
});
