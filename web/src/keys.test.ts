import assert from 'node:assert/strict';
import test from 'node:test';

import { controlKey, encodeInput, withSeq } from './keys.ts';

test('printable text becomes one text frame, whatever the characters are', () => {
  assert.deepEqual(encodeInput('hello'), [{ c: 'text', text: 'hello' }]);
  // The PR #7 trap, and the two characters next to it. None of them is ever a key
  // name, so none of them can reach the driver's argv guard as a separator.
  assert.deepEqual(encodeInput(';'), [{ c: 'text', text: ';' }]);
  assert.deepEqual(encodeInput('{'), [{ c: 'text', text: '{' }]);
  assert.deepEqual(encodeInput('}'), [{ c: 'text', text: '}' }]);
  assert.deepEqual(encodeInput('const x = {a: 1}; // héllo ✅'), [
    { c: 'text', text: 'const x = {a: 1}; // héllo ✅' },
  ]);
});

test('the keys the accessory bar exists for', () => {
  assert.deepEqual(encodeInput('\x1b'), [{ c: 'key', keys: ['Escape'] }]);
  assert.deepEqual(encodeInput('\t'), [{ c: 'key', keys: ['Tab'] }]);
  assert.deepEqual(encodeInput('\r'), [{ c: 'key', keys: ['Enter'] }]);
  assert.deepEqual(encodeInput('\x03'), [{ c: 'key', keys: ['C-c'] }]);
  assert.deepEqual(encodeInput('\x7f'), [{ c: 'key', keys: ['BSpace'] }]);
  assert.deepEqual(encodeInput('\x1b[A\x1b[B'), [{ c: 'key', keys: ['Up', 'Down'] }]);
  // Application cursor mode — what a full-screen TUI actually turns on.
  assert.deepEqual(encodeInput('\x1bOA\x1bOD'), [{ c: 'key', keys: ['Up', 'Left'] }]);
  assert.deepEqual(encodeInput('\x1b[3~'), [{ c: 'key', keys: ['DC'] }]);
});

test('a longer escape sequence beats the bare Escape that prefixes it', () => {
  // The failure this guards: `\x1b[A` read as Escape then a literal "[A".
  assert.deepEqual(encodeInput('\x1b[A'), [{ c: 'key', keys: ['Up'] }]);
  // Escape on its own is still Escape, which is half of what the bar is for.
  assert.deepEqual(encodeInput('\x1b'), [{ c: 'key', keys: ['Escape'] }]);
});

test("xterm's replies to the application are dropped, not typed into the pane", () => {
  // Found in a browser against a live Claude Code session: `onData` carries
  // xterm's answers to terminal queries as well as the keyboard, and typing one
  // of those into tmux put `;rgb:0000/0000/0000` in the agent's prompt.
  assert.deepEqual(encodeInput('\x1b]11;rgb:0000/0000/0000\x1b\\'), []);
  assert.deepEqual(encodeInput('\x1b]10;rgb:ffff/ffff/ffff\x07'), []);
  // Device attributes, a cursor position report, and focus in/out.
  assert.deepEqual(encodeInput('\x1b[?62;c'), []);
  assert.deepEqual(encodeInput('\x1b[24;80R'), []);
  assert.deepEqual(encodeInput('\x1b[I\x1b[O'), []);
  // A report in the middle of real typing takes nothing else with it.
  assert.deepEqual(encodeInput('ab\x1b[?1;2ccd'), [{ c: 'text', text: 'abcd' }]);
});

test('Alt is a key, not two', () => {
  assert.deepEqual(encodeInput('\x1bb'), [{ c: 'key', keys: ['M-b'] }]);
  assert.deepEqual(encodeInput('\x1b\r'), [{ c: 'key', keys: ['M-Enter'] }]);
});

test('runs coalesce and stay in order', () => {
  assert.deepEqual(encodeInput('ls -la\r'), [
    { c: 'text', text: 'ls -la' },
    { c: 'key', keys: ['Enter'] },
  ]);
  assert.deepEqual(encodeInput('a\rb'), [
    { c: 'text', text: 'a' },
    { c: 'key', keys: ['Enter'] },
    { c: 'text', text: 'b' },
  ]);
});

test('a bracketed paste is one text frame, newlines and all', () => {
  // The markers are consumed and the body is not: `Terminals.text` sends anything
  // with a line break through tmux's paste buffer, which does not submit. Splitting
  // on the newlines here would send the first line of a pasted prompt to the agent
  // and type the remainder into a fresh one.
  assert.deepEqual(encodeInput('\x1b[200~one\ntwo\x1b[201~'), [{ c: 'text', text: 'one\ntwo' }]);
  // Paste mode ends with the closing marker: the Enter after it is a keypress
  // again, and is the only thing in the payload that submits anything.
  assert.deepEqual(encodeInput('\x1b[200~x\ny\x1b[201~\r'), [
    { c: 'text', text: 'x\ny' },
    { c: 'key', keys: ['Enter'] },
  ]);
  // Text typed around a paste is literal too, so it coalesces with it — one
  // `text` frame is one paste-buffer delivery, and neither part submits.
  assert.deepEqual(encodeInput('a\x1b[200~x\ny\x1b[201~b'), [{ c: 'text', text: 'ax\nyb' }]);
});

test('a bare Enter outside a paste is still a key', () => {
  assert.deepEqual(encodeInput('\r'), [{ c: 'key', keys: ['Enter'] }]);
  assert.deepEqual(encodeInput('hi\r'), [
    { c: 'text', text: 'hi' },
    { c: 'key', keys: ['Enter'] },
  ]);
});

test('modifier-encoded cursor and navigation keys are keys, not noise', () => {
  assert.deepEqual(encodeInput('\x1b[1;5C'), [{ c: 'key', keys: ['C-Right'] }]);
  assert.deepEqual(encodeInput('\x1b[1;5D'), [{ c: 'key', keys: ['C-Left'] }]);
  assert.deepEqual(encodeInput('\x1b[1;2A'), [{ c: 'key', keys: ['S-Up'] }]);
  assert.deepEqual(encodeInput('\x1b[1;3B'), [{ c: 'key', keys: ['M-Down'] }]);
  assert.deepEqual(encodeInput('\x1b[1;6H'), [{ c: 'key', keys: ['C-S-Home'] }]);
  assert.deepEqual(encodeInput('\x1b[3;5~'), [{ c: 'key', keys: ['C-DC'] }]);
  assert.deepEqual(encodeInput('\x1b[5;3~'), [{ c: 'key', keys: ['M-PPage'] }]);
  // The unmodified forms still resolve — a modified entry must not shadow them.
  assert.deepEqual(encodeInput('\x1b[1~\x1b[C'), [{ c: 'key', keys: ['Home', 'Right'] }]);
});

test('nothing exceeds the limits the server enforces', () => {
  const big = encodeInput('x'.repeat(64 * 1024 + 10));
  assert.deepEqual(
    big.map((f) => (f.c === 'text' ? f.text.length : 0)),
    [64 * 1024, 10],
  );
  const many = encodeInput('\x1b[A'.repeat(70));
  assert.deepEqual(
    many.map((f) => (f.c === 'key' ? f.keys.length : 0)),
    [64, 6],
  );
});

test('controlKey leaves ordinary characters alone', () => {
  assert.equal(controlKey('a'), null);
  assert.equal(controlKey(';'), null);
  assert.equal(controlKey('\x01'), 'C-a');
  assert.equal(controlKey('\x1a'), 'C-z');
});

test('withSeq produces the wire frames the server parses', () => {
  assert.deepEqual(withSeq({ c: 'text', text: ';' }, 7), { c: 'text', seq: 7, text: ';' });
  assert.deepEqual(withSeq({ c: 'key', keys: ['C-c'] }, 8), { c: 'key', seq: 8, keys: ['C-c'] });
});
