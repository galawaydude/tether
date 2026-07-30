/**
 * The terminal pane: xterm.js on one end, the `term` WebSocket on the other.
 * It is the summoned pane inside the session screen (`app.tsx`), which owns the
 * header, the overlay around this and the status chip it reports up through
 * `onStatus`.
 *
 * Two properties this file exists to keep:
 *
 *  1. **Binary end to end.** Frames arrive as `ArrayBuffer` and go into
 *     `term.write(Uint8Array)` untouched. Nothing here decodes terminal output —
 *     a multi-byte glyph split across a chunk boundary corrupts silently if
 *     anything does.
 *  2. **Nothing is remembered.** The server replays the whole terminal on every
 *     attach and keeps no cursor (report §3), so the client resets xterm before
 *     every connect. A client that kept its screen would duplicate the history
 *     on each reconnect, which is exactly the bug the design avoids by
 *     re-deriving instead of resuming.
 */

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { ClientFrame, Session } from '@tether/shared';
import { useEffect, useRef } from 'preact/hooks';

import { ApiError, checkSession, termSocketUrl } from './api.ts';
import { encodeInput, newClientId, withSeq } from './keys.ts';
import type { InputFrame } from './keys.ts';

/** From `server/src/web/term-socket.ts`; the wire contract, not a guess. */
const CLOSE_NO_SESSION = 4404;
const CLOSE_SESSION_ENDED = 4410;

/**
 * Backoff, not a fixed interval: this runs on a phone, and a server that is
 * unreachable for an hour must not be asked every 1.5 seconds for that hour.
 * The floor keeps the common case — a screen lock, a tunnel blip — instant.
 */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/** Long enough to coalesce an orientation change, short enough not to be felt. */
const RESIZE_DEBOUNCE_MS = 120;

/**
 * Shared with the conversation channel, which reaches a subset of these.
 *
 * `ended` and `gone` are one close each and are kept apart rather than merged
 * into "finished": a session that stopped is not a session the server cannot
 * find, and the user can act on the difference. The composer reads them too
 * (`sendBlocked`), because this socket is where a composed message goes — a
 * message accepted after either one could never leave.
 */
export type Status = 'connecting' | 'live' | 'retrying' | 'ended' | 'gone' | 'signedOut';

export const STATUS_TEXT: Record<Status, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  retrying: 'Reconnecting…',
  ended: 'Session ended',
  gone: 'Session not found',
  signedOut: 'Signed out',
};

/**
 * The keys a phone keyboard does not have and the agent's TUI cannot be driven
 * without. Real `<button>`s with real labels: an icon-only bar is unusable with a
 * screen reader and ambiguous without one.
 */
const ACCESSORY: readonly { label: string; name: string; keys: string[] }[] = [
  { label: 'Esc', name: 'Escape', keys: ['Escape'] },
  { label: 'Tab', name: 'Tab', keys: ['Tab'] },
  { label: '↑', name: 'Up arrow', keys: ['Up'] },
  { label: '↓', name: 'Down arrow', keys: ['Down'] },
  { label: '←', name: 'Left arrow', keys: ['Left'] },
  { label: '→', name: 'Right arrow', keys: ['Right'] },
  { label: '⌃C', name: 'Control C', keys: ['C-c'] },
];

/**
 * How the conversation's composer reaches the pane: one function, filled in by
 * the view that owns the socket.
 *
 * The composer lives in the other pane but its message travels on *this*
 * socket, because that socket is where input sequencing lives — a second one
 * would be a second attach, a second full replay, and a second sequence space
 * the server would have no reason to de-duplicate against the first. Both panes
 * are always mounted (`app.tsx`), so this is filled in before anything can call
 * it; the null is only the gap before the first effect runs.
 */
export type Send = { current: ((message: string) => void) | null };

export function TerminalView({
  session,
  onStatus,
  onSignedOut,
  sender,
}: {
  session: Session;
  onStatus: (status: Status) => void;
  onSignedOut: () => void;
  sender?: Send;
}) {
  const host = useRef<HTMLDivElement>(null);
  const send = useRef<(frame: InputFrame) => void>(() => {});
  const focus = useRef<() => void>(() => {});

  // Through refs, because the effect below owns the socket and the xterm instance
  // and must not be torn down and replayed because a parent re-rendered.
  const signOut = useRef(onSignedOut);
  signOut.current = onSignedOut;
  const setStatus = useRef(onStatus);
  setStatus.current = onStatus;

  useEffect(() => {
    const term = new Terminal({
      // Small enough that a phone still gets a workable column count — tmux is
      // resized to whatever fits rather than the browser pretending to be 80x24.
      fontSize: window.innerWidth < 480 ? 12 : 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cursorBlink: true,
      scrollback: 5000,
      // The background matches `.term`'s in `style.css` — any difference shows
      // as a seam around the rows — and the cursor is the app's accent, which
      // is the one colour in the product that means a human is involved.
      theme: { background: '#08080a', foreground: '#e8e8ec', cursor: '#ffb454' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current as HTMLDivElement);
    focus.current = () => term.focus();

    // One identity for the whole view, kept across reconnects: the server drops a
    // sequence it has already applied, so a frame resent on a new socket is
    // de-duplicated only while the client id stays the same. It comes from
    // `keys.ts` because how it is generated is load-bearing — see `newClientId`.
    const clientId = newClientId();
    let seq = 0;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let resizing: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let backoff = RECONNECT_MIN_MS;

    /**
     * Composed messages sent but not yet ACKed, oldest first.
     *
     * Only `input` frames go in here. A dropped keystroke costs one character
     * and the user can see it did not arrive; a dropped *message* is a prompt
     * the user believes they sent, and a phone drops its socket every time the
     * screen locks. Resending is safe precisely because the server keys on the
     * per-client sequence: the retry of one it already applied is dropped there
     * and ACKed anyway.
     */
    const unacked = new Map<number, ClientFrame>();

    const post = (frame: ClientFrame) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };
    send.current = (frame) => {
      seq += 1;
      const framed = withSeq(frame, seq);
      if (framed.c === 'input') unacked.set(framed.seq, framed);
      post(framed);
    };
    if (sender !== undefined) {
      sender.current = (message) => send.current({ c: 'input', text: message });
    }

    const sendSize = () => {
      // `proposeDimensions` returns nothing while the element has no layout, and
      // xterm legitimately reports 0x0 then. Resizing tmux to that would be a
      // real bug for every other viewer of the same session.
      const proposed = fit.proposeDimensions();
      if (proposed === undefined || proposed.cols < 1 || proposed.rows < 1) return;
      fit.fit();
      post({ c: 'resize', cols: term.cols, rows: term.rows });
    };

    const connect = () => {
      // The replay is the whole terminal, every time. Start from nothing.
      term.reset();
      const ws = new WebSocket(termSocketUrl(session.tmuxName, clientId));
      ws.binaryType = 'arraybuffer';
      socket = ws;

      ws.onopen = () => {
        backoff = RECONNECT_MIN_MS;
        setStatus.current('live');
        sendSize();
        // Before anything the user types on this socket, and in the order they
        // were composed: `Map` iterates by insertion, and the server applies
        // sequences in order or not at all.
        for (const frame of unacked.values()) post(frame);
      };
      ws.onmessage = (event: MessageEvent) => {
        // Bytes in, bytes out — nothing decodes terminal output. The JSON text
        // frames on this socket are control only, and `ack` is the sole one:
        // it is what stops a composed message being resent on the next connect.
        if (event.data instanceof ArrayBuffer) return term.write(new Uint8Array(event.data));
        if (typeof event.data !== 'string') return;
        // A text frame that is not JSON is the server's problem, not a crash in
        // an event handler nothing is waiting on.
        try {
          const frame = JSON.parse(event.data) as { c?: unknown; seq?: unknown };
          if (frame.c === 'ack' && typeof frame.seq === 'number') unacked.delete(frame.seq);
        } catch {
          /* ignored */
        }
      };
      ws.onclose = (event: CloseEvent) => {
        socket = null;
        if (closed) return;
        if (event.code === CLOSE_NO_SESSION || event.code === CLOSE_SESSION_ENDED) {
          setStatus.current(event.code === CLOSE_SESSION_ENDED ? 'ended' : 'gone');
          return;
        }
        // A phone suspends its sockets the moment the screen locks, so a dropped
        // connection is the normal case, not the exceptional one.
        setStatus.current('retrying');
        void retry();
      };
    };

    /**
     * The browser reports 1006 both for a lost network and for an upgrade the
     * default-deny hook answered 401, so the close code alone cannot tell them
     * apart — ask the API. An expired cookie is not something retrying fixes, and
     * this view was otherwise the one screen that could not notice a lost session.
     */
    const retry = async () => {
      const expired = await checkSession().then(
        () => false,
        (error: unknown) => error instanceof ApiError && error.status === 401,
      );
      if (closed) return;
      if (expired) {
        setStatus.current('signedOut');
        signOut.current();
        return;
      }
      reconnect = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    };

    term.onData((data) => {
      for (const frame of encodeInput(data)) send.current(frame);
    });

    const scheduleResize = () => {
      clearTimeout(resizing);
      resizing = setTimeout(sendSize, RESIZE_DEBOUNCE_MS);
    };
    // The element's own size covers a rotation and the accessory bar rewrapping;
    // `visualViewport` covers the on-screen keyboard, which on iOS shrinks the
    // visual viewport without resizing anything in the layout.
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(host.current as HTMLDivElement);
    window.visualViewport?.addEventListener('resize', scheduleResize);

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnect);
      clearTimeout(resizing);
      observer.disconnect();
      window.visualViewport?.removeEventListener('resize', scheduleResize);
      socket?.close();
      term.dispose();
      if (sender !== undefined) sender.current = null;
    };
  }, [session.tmuxName, sender]);

  return (
    <>
      <div class="term" ref={host} />

      <nav class="keys" aria-label="Terminal keys">
        {ACCESSORY.map((key) => (
          <button
            key={key.label}
            type="button"
            aria-label={key.name}
            onClick={() => {
              send.current({ c: 'key', keys: key.keys });
              // Keep the on-screen keyboard up: tapping a button blurs xterm's
              // textarea, and on a phone that closes the keyboard under you.
              focus.current();
            }}
          >
            {key.label}
          </button>
        ))}
        <button type="button" aria-label="Show the keyboard" onClick={() => focus.current()}>
          ⌨
        </button>
      </nav>
    </>
  );
}
