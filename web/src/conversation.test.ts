import type { ConversationEvent } from '@tether/shared';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addEvents,
  noRows,
  summarise,
  toRows,
  type SeqEvent,
  type ToolRow,
} from './conversation.ts';

/** Events as the server numbers them: file order, counted from 1. */
function stream(...events: ConversationEvent[]): SeqEvent[] {
  return events.map((e, index) => ({ seq: index + 1, e }));
}

const AT = 1_700_000_000_000;

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

test('a status event is left to the badge PR, not rendered as a message', () => {
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
