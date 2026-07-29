/**
 * xterm.js keystrokes → tether client frames.
 *
 * tether never writes bytes at the attach PTY; every keystroke reaches the pane
 * through tmux (`send-keys` / the paste buffer), which is what makes input
 * sequenced and exactly-once. So the browser has to say what was pressed, not
 * what byte it produced, and this module is that translation.
 *
 * The split is deliberate and is the answer to the `;` trap: **printable text
 * always goes in a `text` frame**, never as a key name. tmux's own lexer eats a
 * standalone `;`, `{` or `}` argument before `send-keys` sees it, so the server
 * delivers those through the paste buffer instead — but only the server can know
 * that, and a second copy of the rule here would be one that drifts. Sending all
 * printables one way also means a `;`, an emoji and an IME commit are the same
 * case, and there is no allowlist of safe characters to get wrong.
 */

import type { ClientFrame } from '@tether/shared';

/** Frames without their sequence number; the socket assigns those. */
export type InputFrame = { c: 'text'; text: string } | { c: 'key'; keys: string[] };

/** `term-socket.ts` drops a frame that exceeds either of these. */
const MAX_TEXT = 64 * 1024;
const MAX_KEYS = 64;

/** The final byte of a cursor/navigation CSI, and the tmux key name it means. */
const CURSOR: readonly (readonly [string, string])[] = [
  ['A', 'Up'],
  ['B', 'Down'],
  ['C', 'Right'],
  ['D', 'Left'],
  ['F', 'End'],
  ['H', 'Home'],
];

/** The numeric parameter of a `CSI <n> ~` navigation key, and its tmux name. */
const TILDE: readonly (readonly [number, string])[] = [
  [1, 'Home'],
  [3, 'DC'],
  [4, 'End'],
  [5, 'PPage'],
  [6, 'NPage'],
];

/**
 * xterm's modifier encoding: the parameter is 1 + shift(1) + alt(2) + ctrl(4), so
 * Ctrl-Right is `CSI 1;5C`. Word-wise cursor movement and history navigation in an
 * agent TUI are all in here, which is why they are worth a table rather than being
 * left to the drop-everything-unrecognised default.
 */
const MODIFIERS: readonly (readonly [number, string])[] = [
  [2, 'S-'],
  [3, 'M-'],
  [4, 'M-S-'],
  [5, 'C-'],
  [6, 'C-S-'],
  [7, 'C-M-'],
  [8, 'C-M-S-'],
];

/** The escape sequences that are a key someone pressed. Everything else is not. */
const ESCAPES: readonly (readonly [string, string])[] = [
  ...TILDE.map(([n, name]) => [`\x1b[${n}~`, name] as const),
  ...CURSOR.map(([final, name]) => [`\x1b[${final}`, name] as const),
  ['\x1b[Z', 'BTab'],
  // Application cursor mode (DECCKM), which a full-screen TUI usually turns on.
  ...CURSOR.map(([final, name]) => [`\x1bO${final}`, name] as const),
  ...MODIFIERS.flatMap(([param, prefix]) => [
    ...CURSOR.map(([final, name]) => [`\x1b[1;${param}${final}`, prefix + name] as const),
    ...TILDE.map(([n, name]) => [`\x1b[${n};${param}~`, prefix + name] as const),
  ]),
];

/** What one `\x1b` at `at` turns out to be. A `null` key means: consume, send nothing. */
type Escape = { length: number; key: string | null };

/**
 * Resolve the escape sequence starting at `at`.
 *
 * The rule that matters is the default one: **an unrecognised control sequence is
 * dropped, not typed.** `onData` is not only the user's keyboard — it is also how
 * xterm.js answers the terminal queries an application makes of it, and those
 * answers (the OSC 10/11 colour report, the Device Attributes reply, a cursor
 * position report, focus in/out) arrive on exactly the same channel. tether types
 * what it is given into a real pane, so treating one of those as an `Escape`
 * followed by literal text puts `;rgb:0000/0000/0000` in the agent's prompt and
 * an `Escape` it never asked for into its TUI. Observed, in a browser, against a
 * live Claude Code session. The table above is what keeps that default honest: a
 * sequence a keyboard really can produce — including the modifier-encoded cursor
 * keys — has an entry, so what remains unmapped is what a keyboard cannot press
 * and therefore never misses.
 */
export function escapeAt(data: string, at: number): Escape {
  const known = ESCAPES.find(([sequence]) => data.startsWith(sequence, at));
  if (known !== undefined) return { length: known[0].length, key: known[1] };

  const introducer = data.charAt(at + 1);
  // CSI: parameters and intermediates, then one final byte in 0x40–0x7e.
  if (introducer === '[') {
    let end = at + 2;
    while (end < data.length && data.charCodeAt(end) >= 0x20 && data.charCodeAt(end) <= 0x3f) {
      end += 1;
    }
    return { length: Math.min(end + 1, data.length) - at, key: null };
  }
  // OSC and the other string-introducers, terminated by BEL or ST (`\x1b\\`).
  if (
    introducer === ']' ||
    introducer === 'P' ||
    introducer === 'X' ||
    introducer === '^' ||
    introducer === '_'
  ) {
    const bel = data.indexOf('\x07', at + 2);
    const st = data.indexOf('\x1b\\', at + 2);
    if (bel !== -1 && (st === -1 || bel < st)) return { length: bel + 1 - at, key: null };
    if (st !== -1) return { length: st + 2 - at, key: null };
    return { length: data.length - at, key: null };
  }
  // ESC then one more key is Alt: `M-b`, `M-Enter`; tmux reads those names. The
  // handful whose character tmux's lexer would mangle — `M-;` — are refused at
  // the driver and cost that one keystroke, which is why the name is synthesised
  // here rather than filtered: the lexer rule has one home, and it is `tmux.ts`.
  if (introducer !== '') {
    return { length: 2, key: `M-${controlKey(introducer) ?? introducer}` };
  }
  return { length: 1, key: 'Escape' };
}

/**
 * A C0 control character as a tmux key name, or `null` if it is ordinary text.
 * Only the range tmux is certain to accept: an unknown key name makes `send-keys`
 * exit non-zero, which the server treats as a failed command.
 */
export function controlKey(ch: string): string | null {
  const code = ch.charCodeAt(0);
  if (code === 0x7f) return 'BSpace';
  if (code === 0x09) return 'Tab';
  if (code === 0x0d || code === 0x0a) return 'Enter';
  // C-a … C-z. \x08 lands here as C-h, which is what a terminal means by it.
  if (code >= 0x01 && code <= 0x1a) return `C-${String.fromCharCode(0x60 + code)}`;
  return null;
}

/**
 * xterm brackets a paste whenever the application has asked for it (DECSET 2004,
 * which `machine/escape.ts` deliberately leaves alone), and that is the only
 * signal that separates a pasted line break from a pressed Enter.
 */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * Split one `onData` payload into frames, coalescing runs so that a paste is one
 * `text` frame and a key-repeat is one `key` frame.
 *
 * Between the paste markers everything is literal, newlines included: the body
 * goes out as one `text` frame, which `Terminals.text` delivers through tmux's
 * paste buffer without submitting. Unbracketing it here instead would submit the
 * first line of a pasted prompt to the agent and type the rest into a fresh one.
 * The markers themselves are dropped — `paste-buffer -p` re-adds them, and only
 * if the application asked.
 */
export function encodeInput(data: string): InputFrame[] {
  const frames: InputFrame[] = [];

  // Split rather than truncate at the limit: the server drops an oversized frame,
  // and a paste that silently loses its tail is worse than one that arrives whole.
  const pushText = (text: string) => {
    let rest = text;
    while (rest !== '') {
      const last = frames.at(-1);
      const room = last?.c === 'text' ? MAX_TEXT - last.text.length : 0;
      if (last?.c === 'text' && room > 0) last.text += rest.slice(0, room);
      else frames.push({ c: 'text', text: rest.slice(0, MAX_TEXT) });
      rest = rest.slice(room > 0 ? room : MAX_TEXT);
    }
  };
  const pushKey = (key: string) => {
    const last = frames.at(-1);
    if (last?.c === 'key' && last.keys.length < MAX_KEYS) last.keys.push(key);
    else frames.push({ c: 'key', keys: [key] });
  };

  let i = 0;
  let run = '';
  let pasting = false;
  const flush = () => {
    if (run !== '') pushText(run);
    run = '';
  };

  while (i < data.length) {
    const ch = data.charAt(i);

    if (pasting) {
      if (data.startsWith(PASTE_END, i)) {
        flush();
        pasting = false;
        i += PASTE_END.length;
      } else {
        run += ch;
        i += 1;
      }
      continue;
    }

    if (data.startsWith(PASTE_START, i)) {
      flush();
      pasting = true;
      i += PASTE_START.length;
      continue;
    }

    if (ch === '\x1b') {
      const escape = escapeAt(data, i);
      flush();
      if (escape.key !== null) pushKey(escape.key);
      i += escape.length;
      continue;
    }

    const key = controlKey(ch);
    if (key !== null) {
      flush();
      pushKey(key);
      i += 1;
      continue;
    }

    run += ch;
    i += 1;
  }
  flush();
  return frames;
}

/** Attach the per-client sequence number a frame needs to be exactly-once. */
export function withSeq(frame: InputFrame, seq: number): ClientFrame {
  return frame.c === 'text'
    ? { c: 'text', seq, text: frame.text }
    : { c: 'key', seq, keys: frame.keys };
}
