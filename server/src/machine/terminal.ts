/**
 * The terminal transport: one `tmux attach-session` PTY per session, fanned out
 * to every connected viewer.
 *
 * tether keeps no server-side byte log of a terminal. It re-derives the terminal
 * from tmux on every attach, which is idempotent by construction — that is *why*
 * there is nothing here to lose or duplicate, and why this module has no ring
 * buffer, no sequence numbers and no resume cursor. Report section 3 proved the
 * recipe exact against a live session; `terminal.test.ts` keeps it that way.
 *
 * The one place at-least-once is not good enough is input: a duplicated prompt is
 * a real, user-visible bug. Hence the per-client highest-applied map below, and
 * nothing more.
 */

import type { IPty } from 'node-pty';

import { createEscapeFilter } from './escape.ts';
import {
  captureScrollback,
  paneSize,
  pasteText,
  refreshClients,
  resizeWindow,
  sendKeys,
  tmuxArgv,
} from './tmux.ts';

/** How deep a reconnecting viewer's scrollback goes. tether.conf keeps 100k. */
const DEFAULT_HISTORY_LINES = 5000;

/**
 * Ink treats an Enter arriving in the same tmux invocation as the text as a
 * literal newline rather than a submit; the spike found 50–300ms reliable.
 */
const SUBMIT_DELAY_MS = 100;

/** Receives raw terminal bytes. One per connected socket. */
export type Viewer = (bytes: Uint8Array) => void;

/**
 * node-pty ships no Linux prebuild and npm 12 blocks dependency install scripts,
 * so the native module is missing unless the root package.json's `allowScripts`
 * entry was honoured by a toolchain that could actually build it. Distinguished
 * from every other failure so the CLI can print an instruction, not a trace.
 */
export class PtyUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "node-pty's native module is not built, so tether cannot attach to a terminal.\n" +
        '  Install a C++ toolchain (build-essential, python3) and re-run `npm ci`.\n' +
        '  npm 12 blocks install scripts by default; the approval lives in the root\n' +
        '  package.json as `allowScripts`, or run `npm install-scripts approve node-pty`.\n' +
        `  Underlying error: ${(cause as Error)?.message ?? String(cause)}`,
    );
    this.name = 'PtyUnavailableError';
    this.cause = cause;
  }
}

let ptyModule: typeof import('node-pty') | undefined;

/** Loaded lazily so a missing native module is a message, not an import crash. */
export async function loadPty(): Promise<typeof import('node-pty')> {
  if (ptyModule === undefined) {
    try {
      ptyModule = await import('node-pty');
    } catch (cause) {
      throw new PtyUnavailableError(cause);
    }
  }
  return ptyModule;
}

interface Attached {
  pty: IPty;
  viewers: Set<Viewer>;
}

/**
 * One attach at a time per session: two viewers opening the same session at once
 * must not each spawn a PTY, and a detach must not race the spawn it cancels.
 */
function serializer(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const queues = new Map<string, Promise<unknown>>();
  return (key, fn) => {
    const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    queues.set(
      key,
      next.catch(() => {}),
    );
    return next;
  };
}

export interface Terminals {
  /**
   * Replay the session into `viewer`, then stream it live. Resolves to the
   * detach function; calling it twice is harmless.
   */
  attach(session: string, viewer: Viewer): Promise<() => void>;
  /** Last viewer's dimensions win. */
  resize(session: string, cols: number, rows: number): Promise<void>;
  /** Message text: pasted (newline-safe), then submitted. Returns false if replayed. */
  input(session: string, clientId: string, seq: number, text: string): Promise<boolean>;
  /** Raw keystrokes, by tmux key name. Returns false if replayed. */
  key(session: string, clientId: string, seq: number, keys: readonly string[]): Promise<boolean>;
  /** Tear down every attach. For shutdown and for tests. */
  closeAll(): void;
}

export function createTerminals(socket: string, historyLines = DEFAULT_HISTORY_LINES): Terminals {
  const attached = new Map<string, Attached>();
  const serialize = serializer();

  /**
   * Highest input sequence applied, keyed by session and client. Outside
   * `attached`: a client whose socket dropped before its ACK arrived retries on a
   * new socket, and forgetting on detach would let that retry through twice.
   *
   * ponytail: never pruned, so it holds one small integer per (session, client)
   * pair the process has ever seen. Prune on session deletion once PR #5 gives
   * this module a session lifecycle to hang it off.
   */
  const applied = new Map<string, number>();

  function drop(session: string, entry: Attached): void {
    if (attached.get(session) !== entry) return;
    attached.delete(session);
    entry.pty.kill();
  }

  /**
   * The replay recipe, report section 3 with both corrections from the spike:
   * the trailing newline is stripped *before* the `\r\n` expansion (one extra row
   * per reconnect otherwise), and the scrollback comes from `-E -1` so it
   * composes with the viewport with no overlap and no gap.
   *
   * The padding pushes the history into xterm's scrollback and leaves a blank
   * viewport, which the attach repaint — `ESC[H ESC[2J` and an absolutely
   * positioned redraw — then fills. That repaint *is* the resync.
   */
  async function replay(session: string, rows: number): Promise<Uint8Array> {
    const history = await captureScrollback(socket, session, historyLines);
    const expanded = history.replace(/\n$/, '').replace(/\r?\n/g, '\r\n');
    // A fresh filter: this is its own stream, and a held-back tail must never
    // cross between the capture and the live attach.
    const filtered = createEscapeFilter()(Buffer.from(expanded, 'utf8'));
    return Buffer.concat([filtered, Buffer.from('\r\n'.repeat(rows), 'utf8')]);
  }

  function detacher(session: string, entry: Attached, viewer: Viewer): () => void {
    return () => {
      if (!entry.viewers.delete(viewer)) return;
      if (entry.viewers.size === 0) drop(session, entry);
    };
  }

  async function open(session: string, viewer: Viewer): Promise<Attached> {
    const { spawn } = await loadPty();
    const size = await paneSize(socket, session);
    // Captured before the attach exists, so the repaint the attach emits lands
    // strictly after the history it is meant to sit below.
    viewer(await replay(session, size.rows));

    const pty = spawn('tmux', tmuxArgv(socket, ['attach-session', '-t', session]), {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      // Buffers, not strings: a multi-byte glyph split across a chunk boundary
      // corrupts silently the moment anything in this path decodes.
      encoding: null,
    });
    const entry: Attached = { pty, viewers: new Set([viewer]) };
    attached.set(session, entry);

    const filter = createEscapeFilter();
    pty.onData((chunk) => {
      // node-pty's typings only describe the decoded-string case; `encoding: null`
      // makes it emit Buffers, and keeping them as bytes is the whole point.
      const bytes = filter(chunk as unknown as Buffer);
      for (const each of entry.viewers) each(bytes);
    });
    pty.onExit(() => drop(session, entry));
    return entry;
  }

  return {
    attach(session, viewer) {
      return serialize(session, async () => {
        const existing = attached.get(session);
        if (existing === undefined) {
          return detacher(session, await open(session, viewer), viewer);
        }
        const size = await paneSize(socket, session);
        const head = await replay(session, size.rows);
        // The capture is deliberately taken *before* subscribing — the other
        // order replays whatever scrolled past in between twice — but that means
        // the last viewer can leave and take the PTY with it while we capture.
        // Joining that corpse would leave this viewer permanently blank.
        if (attached.get(session) !== existing) {
          return detacher(session, await open(session, viewer), viewer);
        }
        viewer(head);
        existing.viewers.add(viewer);
        // The first viewer's repaint came free with `attach-session`; a later one
        // has to ask for the same absolutely-positioned redraw.
        await refreshClients(socket, session);
        return detacher(session, existing, viewer);
      });
    },

    async resize(session, cols, rows) {
      // The window first: with `window-size manual` the PTY's size alone changes
      // nothing, which is exactly what keeps one viewer off another's pane.
      await resizeWindow(socket, session, cols, rows);
      attached.get(session)?.pty.resize(cols, rows);
    },

    async input(session, clientId, seq, text) {
      if (!accept(applied, session, clientId, seq)) return false;
      await pasteText(socket, session, text);
      await new Promise((r) => setTimeout(r, SUBMIT_DELAY_MS));
      await sendKeys(socket, session, ['Enter']);
      return true;
    },

    async key(session, clientId, seq, keys) {
      if (!accept(applied, session, clientId, seq)) return false;
      await sendKeys(socket, session, keys);
      return true;
    },

    closeAll() {
      for (const [session, entry] of [...attached]) {
        entry.viewers.clear();
        drop(session, entry);
      }
    },
  };
}

/**
 * The whole of input exactly-once: a per-client monotonic sequence and the
 * highest one applied. The client retries until it is ACKed, so a retry that
 * arrives after the original — or out of order behind it — is dropped here and
 * ACKed anyway.
 *
 * Recorded before the tmux call rather than after it: a paste that fails partway
 * may still have reached the pane, and of the two failures a lost prompt is much
 * the better one.
 */
function accept(
  applied: Map<string, number>,
  session: string,
  clientId: string,
  seq: number,
): boolean {
  if (!Number.isInteger(seq) || seq < 1) return false;
  // A space separates them unambiguously: a tmux session name cannot contain one.
  const key = `${session} ${clientId}`;
  if (seq <= (applied.get(key) ?? 0)) return false;
  applied.set(key, seq);
  return true;
}
