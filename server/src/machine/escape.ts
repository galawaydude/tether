/**
 * The two escape-sequence hazards from report section 3, filtered out of every
 * byte that reaches the browser — the live attach stream and the scrollback
 * capture alike. Both come from tmux's own attach handshake as well as from the
 * agent's TUI, so filtering only one source is not enough.
 *
 *  - Alt-screen and "erase saved lines". xterm.js obeys them: it switches to a
 *    buffer that has no scrollback, and drops the saved lines. The conversation
 *    vanishes the moment the agent opens a full-screen picker.
 *  - Mouse tracking. Once on, xterm.js forwards wheel and touch-scroll to the
 *    TUI instead of scrolling its viewport, so on a phone the scrollback exists
 *    but cannot be reached.
 *
 * `ESC[2J` and `ESC[J` are deliberately *not* stripped: the attach repaint is
 * built on them, and removing them leaves the joining viewer's viewport stale.
 *
 * Everything here works on bytes. The terminal path is binary from the PTY to
 * `term.write(Uint8Array)` because a multi-byte UTF-8 glyph split across a chunk
 * boundary corrupts silently otherwise, and a filter that decoded would put the
 * split back.
 */

const ESC = 0x1b;
const BRACKET = 0x5b; // '['

/** CSI grammar (ECMA-48): parameters, then intermediates, then one final byte. */
const isParameter = (b: number) => b >= 0x30 && b <= 0x3f;
const isIntermediate = (b: number) => b >= 0x20 && b <= 0x2f;
const isFinal = (b: number) => b >= 0x40 && b <= 0x7e;

const STRIP = new Set([
  '\x1b[?1049h', // alt screen (xterm)
  '\x1b[?47h', // alt screen (legacy)
  '\x1b[?1047h', // alt screen (legacy, with clear)
  '\x1b[3J', // erase saved lines
  '\x1b[?1000h', // mouse: click tracking
  '\x1b[?1002h', // mouse: button-event tracking
  '\x1b[?1003h', // mouse: any-event tracking
  '\x1b[?1006h', // mouse: SGR extended coordinates
]);

/**
 * The longest sequence above is 8 bytes, so an incomplete CSI longer than that
 * can no longer become one and is passed straight through. That bound is what
 * stops an unterminated CSI — `ESC[` and then silence — stalling the stream.
 */
const MAX_HOLD = 8;

const INCOMPLETE = -1;
const NOT_CSI = -2;

/** Index one past the CSI starting at `i`, or {@link INCOMPLETE}/{@link NOT_CSI}. */
function csiEnd(buf: Uint8Array, i: number): number {
  if (i + 1 >= buf.length) return INCOMPLETE; // a bare ESC could still become one
  if (buf[i + 1] !== BRACKET) return NOT_CSI;
  let j = i + 2;
  while (j < buf.length && isParameter(buf[j]!)) j++;
  while (j < buf.length && isIntermediate(buf[j]!)) j++;
  if (j >= buf.length) return INCOMPLETE;
  return isFinal(buf[j]!) ? j + 1 : NOT_CSI;
}

/**
 * Every byte of a CSI is printable ASCII by construction of {@link csiEnd}, so
 * this is exact — and it is not a decode of the stream, only of a sequence the
 * scanner has already fully delimited.
 */
function isStripped(buf: Uint8Array, start: number, end: number): boolean {
  if (end - start > MAX_HOLD) return false;
  return STRIP.has(String.fromCharCode(...buf.subarray(start, end)));
}

const EMPTY = new Uint8Array(0);

/**
 * A stateful filter over one stream. Stateful because a chunk ending in
 * `\x1b[?104` with `9h` at the head of the next slips straight through any
 * regex applied per chunk: the tail is held back and prepended to the next
 * chunk instead.
 *
 * One filter per stream — a live attach and a capture must not share one, or a
 * held-back tail crosses between them.
 */
export function createEscapeFilter(): (chunk: Uint8Array) => Uint8Array {
  let held = EMPTY;

  return (chunk) => {
    const buf = held.length === 0 ? chunk : Buffer.concat([held, chunk]);
    held = EMPTY;

    const kept: Uint8Array[] = [];
    let start = 0; // first byte not yet accounted for
    let i = 0;

    while (i < buf.length) {
      if (buf[i] !== ESC) {
        i++;
        continue;
      }
      const end = csiEnd(buf, i);
      if (end === INCOMPLETE && buf.length - i <= MAX_HOLD) {
        held = new Uint8Array(buf.subarray(i)); // copied: the chunk is not ours to keep
        break;
      }
      if (end < 0) {
        i++;
        continue;
      }
      if (isStripped(buf, i, end)) {
        kept.push(buf.subarray(start, i));
        start = end;
      }
      i = end;
    }

    kept.push(buf.subarray(start, buf.length - held.length));
    return Buffer.concat(kept);
  };
}
