import assert from 'node:assert/strict';
import test from 'node:test';

import { createEscapeFilter } from './escape.ts';

const bytes = (s: string) => Buffer.from(s, 'utf8');
const text = (b: Uint8Array) => Buffer.from(b).toString('utf8');

/** Feed a whole string through a fresh filter in one chunk. */
function filterOnce(input: string): string {
  return text(createEscapeFilter()(bytes(input)));
}

const STRIPPED = [
  ['alt screen (xterm)', '\x1b[?1049h'],
  ['alt screen (legacy)', '\x1b[?47h'],
  ['alt screen (legacy, with clear)', '\x1b[?1047h'],
  ['erase saved lines', '\x1b[3J'],
  ['mouse click tracking', '\x1b[?1000h'],
  ['mouse button-event tracking', '\x1b[?1002h'],
  ['mouse any-event tracking', '\x1b[?1003h'],
  ['mouse SGR coordinates', '\x1b[?1006h'],
] as const;

for (const [what, sequence] of STRIPPED) {
  test(`${what} is stripped`, () => {
    assert.equal(filterOnce(`before${sequence}after`), 'beforeafter');
  });
}

test('the whole tmux attach handshake is stripped in one pass', () => {
  // The first bytes of a real `tmux attach-session`, from report section 3.
  const handshake = '\x1b[?1h\x1b=\x1b[H\x1b[2J\x1b[?12l\x1b[?25h\x1b[?1000h\x1b[?1002h';
  assert.equal(filterOnce(handshake), '\x1b[?1h\x1b=\x1b[H\x1b[2J\x1b[?12l\x1b[?25h');
});

test('ESC[2J and ESC[J survive — the attach repaint is built on them', () => {
  assert.equal(filterOnce('\x1b[H\x1b[2Jrepaint\x1b[J'), '\x1b[H\x1b[2Jrepaint\x1b[J');
});

test('an incomplete CSI split across chunks is still stripped', () => {
  // A naive per-chunk regex lets this straight through, and the conversation
  // vanishes the next time the agent opens a picker.
  const filter = createEscapeFilter();
  assert.equal(text(filter(bytes('keep\x1b[?104'))), 'keep');
  assert.equal(text(filter(bytes('9hmore'))), 'more');
});

test('every split point of a stripped sequence behaves the same', () => {
  const input = 'a\x1b[?1049hb';
  for (let at = 0; at <= input.length; at++) {
    const filter = createEscapeFilter();
    const out = text(filter(bytes(input.slice(0, at)))) + text(filter(bytes(input.slice(at))));
    assert.equal(out, 'ab', `split at ${at}`);
  }
});

test('an ESC that never completes is passed through, not held forever', () => {
  const filter = createEscapeFilter();
  // Longer than the longest sequence the filter strips, so it can never become
  // one and must not stall the stream behind it.
  assert.equal(text(filter(bytes('\x1b[?123456789'))), '\x1b[?123456789');
});

test('a held tail is emitted once the stream turns out to be innocent', () => {
  const filter = createEscapeFilter();
  assert.equal(text(filter(bytes('x\x1b[?10'))), 'x');
  assert.equal(text(filter(bytes('12h'))), '\x1b[?1012h');
});

test('multi-byte UTF-8 survives a chunk boundary through the middle of a glyph', () => {
  // The filter works on bytes precisely so that this cannot corrupt: `─` is
  // three bytes, and a decode-per-chunk turns the split into U+FFFD.
  const glyphs = '─'.repeat(40);
  const raw = bytes(`\x1b[?1000h${glyphs}`);
  const filter = createEscapeFilter();
  const out = Buffer.concat([filter(raw.subarray(0, 20)), filter(raw.subarray(20))]);
  assert.equal(text(out), glyphs);
});
