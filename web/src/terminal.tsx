/**
 * The terminal view: xterm.js on one end, the `term` WebSocket on the other.
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
import { useEffect, useRef, useState } from 'preact/hooks';

import { termSocketUrl } from './api.ts';
import { encodeInput, withSeq } from './keys.ts';
import type { InputFrame } from './keys.ts';

/** From `server/src/web/term-socket.ts`; the wire contract, not a guess. */
const CLOSE_NO_SESSION = 4404;
const CLOSE_SESSION_ENDED = 4410;

const RECONNECT_MS = 1500;
/** Long enough to coalesce an orientation change, short enough not to be felt. */
const RESIZE_DEBOUNCE_MS = 120;

type Status = 'connecting' | 'live' | 'retrying' | 'ended';

const STATUS_TEXT: Record<Status, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  retrying: 'Reconnecting…',
  ended: 'Session ended',
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

export function TerminalView({ session, onBack }: { session: Session; onBack: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const send = useRef<(frame: InputFrame) => void>(() => {});
  const focus = useRef<() => void>(() => {});
  const [status, setStatus] = useState<Status>('connecting');

  useEffect(() => {
    const term = new Terminal({
      // Small enough that a phone still gets a workable column count — tmux is
      // resized to whatever fits rather than the browser pretending to be 80x24.
      fontSize: window.innerWidth < 480 ? 12 : 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#000000', foreground: '#eaeaea', cursor: '#7ee787' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current as HTMLDivElement);
    focus.current = () => term.focus();

    // One identity for the whole view, kept across reconnects: the server drops a
    // sequence it has already applied, so a frame resent on a new socket is
    // de-duplicated only while the client id stays the same.
    const clientId = crypto.randomUUID();
    let seq = 0;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let resizing: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const post = (frame: ClientFrame) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    };
    send.current = (frame) => {
      seq += 1;
      post(withSeq(frame, seq));
    };

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
        setStatus('live');
        sendSize();
      };
      ws.onmessage = (event: MessageEvent) => {
        // Bytes in, bytes out. The JSON text frames on this socket are control
        // only — `ack` is the sole one today, and there is nothing to do with it
        // until a composer needs to retry (PR #11).
        if (event.data instanceof ArrayBuffer) term.write(new Uint8Array(event.data));
      };
      ws.onclose = (event: CloseEvent) => {
        socket = null;
        if (closed) return;
        if (event.code === CLOSE_NO_SESSION || event.code === CLOSE_SESSION_ENDED) {
          setStatus('ended');
          return;
        }
        // A phone suspends its sockets the moment the screen locks, so a dropped
        // connection is the normal case, not the exceptional one.
        setStatus('retrying');
        reconnect = setTimeout(connect, RECONNECT_MS);
      };
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
    };
  }, [session.tmuxName]);

  return (
    <div class="screen">
      <header class="bar">
        <button class="ghost" onClick={onBack} aria-label="Back to sessions">
          ‹ Sessions
        </button>
        <div class="bar-title">
          <strong>{session.title}</strong>
          <span class="muted">{session.cwd}</span>
        </div>
        <span class={`chip chip-${status}`} role="status">
          {STATUS_TEXT[status]}
        </span>
      </header>

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
    </div>
  );
}
