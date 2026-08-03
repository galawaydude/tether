/**
 * The `term` channel: one WebSocket per open session view.
 *
 * Terminal output goes down it as **binary** frames — the PTY's bytes, unchanged,
 * for `term.write(Uint8Array)` on the other end. Control goes down it as JSON
 * text frames. Nothing decodes the terminal path, because a multi-byte UTF-8
 * glyph split across a chunk boundary corrupts silently if anything does.
 *
 * Authentication is not repeated here: this route is an ordinary Fastify route,
 * so `buildServer`'s default-deny `preParsing` hook and its `Host`/`Origin`
 * guards cover it. `server.ts` extends the Origin guard to upgrades, which are
 * `GET` and therefore not otherwise state-changing — an unauthenticated upgrade
 * would be an unauthenticated shell (report section 7).
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { ClientFrame, ServerFrame, Session } from '@tether/shared';

import { getSessionByTmuxName, reconcileWithTmux } from '../machine/registry.ts';
import type { Terminals } from '../machine/terminal.ts';
import { DEFAULT_SOCKET, UnsafeArgumentError } from '../machine/tmux.ts';

/** Enough for a pasted prompt; short enough that a socket cannot be a memory hog. */
const MAX_TEXT = 64 * 1024;
const MAX_KEYS = 64;

/**
 * The same range `resizeWindow` enforces, applied here so an out-of-range frame
 * is one dropped frame rather than a thrown command that tears the socket down:
 * xterm.js legitimately reports 0x0 before it has been laid out, and a viewer
 * losing its terminal over that would be a real bug. `resizeWindow`
 * keeps its own check — this one is about which failure the client sees.
 */
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 1000;

/** tmux rejects `:`, `.` and whitespace in session names; so does this. */
const NAME = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } as const;

const TERM_SCHEMA = {
  params: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: { name: NAME },
  },
  querystring: {
    type: 'object',
    required: ['client'],
    additionalProperties: false,
    // The client's identity for input de-duplication, not a credential: the
    // session cookie is what authenticates, and it has already been checked.
    // `output=0` keeps the composer's socket but skips the hidden replay.
    properties: { client: NAME, output: { type: 'string', enum: ['0', '1'] } },
  },
} as const;

/**
 * Frames are attacker-controlled — reaching this route is equivalent to a shell
 * — so they are validated by hand rather than trusted after `JSON.parse`.
 */
export function parseClientFrame(raw: string): ClientFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const frame = value as Record<string, unknown>;
  const seq = frame['seq'];
  const seqOk = typeof seq === 'number' && Number.isInteger(seq) && seq >= 1;

  switch (frame['c']) {
    case 'input':
    case 'text':
      return seqOk && typeof frame['text'] === 'string' && frame['text'].length <= MAX_TEXT
        ? { c: frame['c'], seq: seq as number, text: frame['text'] }
        : null;
    case 'key':
      return seqOk &&
        Array.isArray(frame['keys']) &&
        frame['keys'].length >= 1 &&
        frame['keys'].length <= MAX_KEYS &&
        frame['keys'].every((k) => typeof k === 'string' && k.length > 0 && k.length <= 32)
        ? { c: 'key', seq: seq as number, keys: frame['keys'] as string[] }
        : null;
    case 'output':
      return typeof frame['enabled'] === 'boolean'
        ? { c: 'output', enabled: frame['enabled'] }
        : null;
    case 'resize':
      return [frame['cols'], frame['rows']].every(
        (n) =>
          Number.isInteger(n) && (n as number) >= MIN_DIMENSION && (n as number) <= MAX_DIMENSION,
      )
        ? { c: 'resize', cols: frame['cols'] as number, rows: frame['rows'] as number }
        : null;
    default:
      return null;
  }
}

/** Close codes above 4000 are application-defined; these are tether's. */
export const CLOSE_NO_SESSION = 4404;
/** The registry says this session is over — it is not coming back on a retry. */
export const CLOSE_SESSION_ENDED = 4410;
/**
 * The attach threw for some other reason. The client settles on this rather
 * than reconnecting — which is why the mid-life frame failure below closes
 * without a code instead of borrowing it. The exception is in the server log
 * and never in the reason string, because this side cannot name the cause.
 */
export const CLOSE_ATTACH_FAILED = 4500;

/**
 * Which of the three a lost terminal actually was, from the registry row for the
 * session that was asked for.
 *
 * All three used to be `CLOSE_NO_SESSION`, and the client renders that as
 * "Session not found" — so a native module that could not spawn, and a session
 * that had ended perfectly normally, both told the user their work was gone. The
 * screenshot that produced this fix showed the agent's own badge reading *Idle*
 * beside it.
 *
 * The registry is the thing that knows, and it knows all three apart: no row at
 * all is the only case where the server really has lost the session, `deadAt` is
 * a session that ended — which has its own close code and its own correct
 * wording already — and a live row whose terminal went is a fault, whose *cause*
 * this side cannot name and does not try to. That last one is the whole point:
 * the close code says a terminal could not be opened, and nothing more, because
 * anything more would be the guess this bug was made of.
 *
 * Both ways a terminal is lost ask it, which is the general form of the fix: the
 * attach that never opened, and the attach that exits mid-life. The second used
 * to be `CLOSE_SESSION_ENDED` outright — but a PTY exits for reasons that are not
 * the session ending, `Ctrl-B d` in the web terminal among them (`tether.conf`
 * unbinds no prefix key and `keys.ts` maps `\x02` to `C-b`), and so does anyone
 * running `tmux detach-client`. That told every viewer of a perfectly live
 * session that it had ended, and left the composer refusing to send.
 */
export function attachClose(row: Session | undefined): { code: number; reason: string } {
  if (row === undefined) return { code: CLOSE_NO_SESSION, reason: 'no such session' };
  if (row.deadAt !== null) return { code: CLOSE_SESSION_ENDED, reason: 'the session ended' };
  return { code: CLOSE_ATTACH_FAILED, reason: 'could not open a terminal' };
}

export function registerTermSocket(
  app: FastifyInstance,
  terminals: Terminals,
  db: DatabaseSync,
  tmuxSocket: string = DEFAULT_SOCKET,
): void {
  app.get<{
    Params: { name: string };
    Querystring: { client: string; output?: '0' | '1' };
  }>(
    '/api/sessions/:name/term',
    { websocket: true, schema: TERM_SCHEMA },
    async (socket, request) => {
      const session = request.params.name;
      const clientId = request.query.client;
      // Old clients omit it and keep the original full-output behaviour.
      const initialOutput = request.query.output !== '0';
      let output: boolean | 'enabling' = initialOutput;

      // The attach spans two tmux spawns and a PTY spawn, and a client that gives
      // up inside that window would otherwise leave its viewer subscribed and the
      // attach PTY running for the life of the process. `readyState` rather than a
      // flag set from the 'close' event: the socket sits in CLOSING for as long as
      // the peer takes to finish the handshake, and the event that would set the
      // flag has not fired yet.
      const alive = () => socket.readyState === socket.OPEN;

      /**
       * Frames that arrived before the attach finished, in the order they were
       * sent.
       *
       * The listener has to go on *first*, because by the time this handler runs
       * the client is already talking: `@fastify/websocket` completes the
       * handshake and only then calls the route, so the browser's `onopen` has
       * fired — and its first act on open is to send its size and re-send every
       * message it has not seen an ACK for — while the attach here is still two
       * tmux spawns and a PTY away. A frame arriving in that window used to
       * reach no listener at all, and a `ws` message with no listener is
       * discarded: no ACK, so the client keeps it, and it only re-sends on its
       * *next* reconnect. That is one composed message stuck on "Sending…" for
       * the life of a socket that is otherwise working perfectly, and a joining
       * viewer's dimensions never reaching the pane. The window is widest for
       * exactly the case that is hardest to notice — a second viewer, whose
       * attach is a `capture-pane` and a `refresh-client` rather than a plain
       * `attach-session`.
       */
      const queued: ClientFrame[] = [];
      let handle = (frame: ClientFrame): void => void queued.push(frame);

      socket.on('message', (data: Buffer, isBinary: boolean) => {
        // Terminal input is a `key` or `input` frame by design, never raw bytes:
        // sequencing is what makes it exactly-once. Decoding here is safe and
        // decoding the *output* is not, because `ws` delivers whole messages —
        // the chunk boundary that splits a glyph only exists on the PTY side.
        if (isBinary) return;
        const frame = parseClientFrame(data.toString());
        if (frame !== null) handle(frame);
      });

      /**
       * Close this viewer with the code the registry justifies, for either way a
       * terminal is lost — see `attachClose`.
       *
       * tmux is asked first: the commonest reason a terminal goes *is* a tmux
       * session that has gone, and a row is only marked dead when something
       * reconciles. The session list does that every 5s, so the row is usually
       * already right — but "usually" is what would put the wrong sentence on
       * screen for a session that ended a moment ago, and these are failure
       * paths with nothing else to spend.
       *
       * It never rejects, because one caller is a synchronous callback: an
       * unreadable registry cannot be answered with a guess, so it closes with
       * no code at all, which is the client's cue to reconnect and let the next
       * attach say it in the right words.
       */
      const closeFromRegistry = async (): Promise<void> => {
        try {
          await reconcileWithTmux(db, tmuxSocket).catch(() => 0);
          const { code, reason } = attachClose(getSessionByTmuxName(db, session));
          socket.close(code, reason);
        } catch (error) {
          app.log.warn({ err: error, session }, 'terminal close could not read the registry');
          socket.close();
        }
      };

      const viewer = (bytes: Uint8Array) => {
        if (output === true && alive()) socket.send(bytes);
      };
      const detach = await terminals
        .attach(
          session,
          viewer,
          // Exactly once per viewer: `Terminals#end` clears the viewer map
          // before calling back.
          () => void closeFromRegistry(),
          initialOutput,
        )
        .catch(async (error: unknown) => {
          app.log.warn({ err: error, session }, 'terminal attach failed');
          await closeFromRegistry();
          return null;
        });
      if (detach === null) return;
      if (!alive()) {
        detach();
        return;
      }
      socket.on('close', detach);

      const send = (frame: ServerFrame) => socket.send(JSON.stringify(frame));

      // No queue here: `Terminals` serializes per session, which is the boundary
      // that matters — two *viewers* of one session must not interleave their
      // paste-then-Enter pairs either, and one queue per socket cannot see that.
      async function apply(frame: ClientFrame): Promise<void> {
        if (frame.c === 'output') {
          if (frame.enabled === output) return;
          if (frame.enabled) {
            if (output === 'enabling') return;
            output = 'enabling';
            try {
              await terminals.refresh(
                session,
                viewer,
                (bytes) => {
                  if (output === 'enabling' && alive()) socket.send(bytes);
                  if (output === 'enabling') output = true;
                },
              );
            } finally {
              if (output === 'enabling') output = false;
            }
          } else output = false;
          return;
        }
        if (frame.c === 'resize') return terminals.resize(session, frame.cols, frame.rows);
        if (frame.c === 'input') await terminals.input(session, clientId, frame.seq, frame.text);
        else if (frame.c === 'text') await terminals.text(session, clientId, frame.seq, frame.text);
        else await terminals.key(session, clientId, frame.seq, frame.keys);
        // ACKed whether or not it was applied: a replay is already durable,
        // and the client must stop retrying it either way. The same holds for a
        // frame the driver refuses outright, which is ACKed from the caller's
        // error path below rather than here.
        send({ c: 'ack', seq: frame.seq });
      }

      handle = (frame) =>
        void apply(frame).catch((error: unknown) => {
          // Two different failures used to share one outcome. A value the tmux
          // driver's argv guard refuses is an undeliverable *frame* — the pane
          // is untouched and the attach is fine — so it costs one dropped
          // keystroke, not a close the client answers with `term.reset()` and a
          // full replay. Everything else does mean the attach is gone.
          if (error instanceof UnsafeArgumentError) {
            app.log.warn({ err: error, session, frame: frame.c }, 'terminal frame refused');
            if (frame.c !== 'resize' && frame.c !== 'output') {
              send({ c: 'ack', seq: frame.seq });
            }
            return;
          }
          app.log.warn({ err: error, session }, 'terminal frame failed');
          // No application close code, which is what makes the client reconnect
          // rather than settle — and that is the right answer here, unlike at
          // the attach above. This attach is gone, but the *session* may be
          // perfectly fine, and re-attaching is exactly how the terminal
          // recovers; if it is not fine, the reconnect's own attach failure is
          // what says so, in the right words, having asked the registry. That
          // is why this is not `CLOSE_ATTACH_FAILED`: the client now settles on
          // that one, and settling here would cost a working session a reload.
          socket.close();
        });
      // In order, and before anything that arrives from here on: `Terminals`
      // applies sequences in the order it is called and drops the rest.
      for (const frame of queued.splice(0)) handle(frame);
    },
  );
}
