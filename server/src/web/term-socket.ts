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
import type { ClientFrame, ServerFrame } from '@tether/shared';

import type { Terminals } from '../machine/terminal.ts';

/** Enough for a pasted prompt; short enough that a socket cannot be a memory hog. */
const MAX_TEXT = 64 * 1024;
const MAX_KEYS = 64;

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
    properties: { client: NAME },
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
      return seqOk && typeof frame['text'] === 'string' && frame['text'].length <= MAX_TEXT
        ? { c: 'input', seq: seq as number, text: frame['text'] }
        : null;
    case 'key':
      return seqOk &&
        Array.isArray(frame['keys']) &&
        frame['keys'].length >= 1 &&
        frame['keys'].length <= MAX_KEYS &&
        frame['keys'].every((k) => typeof k === 'string' && k.length > 0 && k.length <= 32)
        ? { c: 'key', seq: seq as number, keys: frame['keys'] as string[] }
        : null;
    case 'resize':
      return Number.isInteger(frame['cols']) && Number.isInteger(frame['rows'])
        ? { c: 'resize', cols: frame['cols'] as number, rows: frame['rows'] as number }
        : null;
    default:
      return null;
  }
}

/** Close codes above 4000 are application-defined; these are tether's. */
export const CLOSE_NO_SESSION = 4404;
export const CLOSE_ATTACH_FAILED = 4500;

export function registerTermSocket(app: FastifyInstance, terminals: Terminals): void {
  app.get<{ Params: { name: string }; Querystring: { client: string } }>(
    '/api/sessions/:name/term',
    { websocket: true, schema: TERM_SCHEMA },
    async (socket, request) => {
      const session = request.params.name;
      const clientId = request.query.client;

      const detach = await terminals
        .attach(session, (bytes) => socket.send(bytes))
        .catch((error: unknown) => {
          app.log.warn({ err: error, session }, 'terminal attach failed');
          socket.close(CLOSE_NO_SESSION, 'cannot attach to this session');
          return null;
        });
      if (detach === null) return;
      socket.on('close', detach);

      const send = (frame: ServerFrame) => socket.send(JSON.stringify(frame));

      // Serialized: two prompts arriving back to back must not interleave their
      // paste-then-Enter pairs, which would garble both.
      let queue: Promise<unknown> = Promise.resolve();
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        // Terminal input is a `key` or `input` frame by design, never raw bytes:
        // sequencing is what makes it exactly-once. Decoding here is safe and
        // decoding the *output* is not, because `ws` delivers whole messages —
        // the chunk boundary that splits a glyph only exists on the PTY side.
        if (isBinary) return;
        const frame = parseClientFrame(data.toString());
        if (frame === null) return;
        queue = queue.then(async () => {
          try {
            if (frame.c === 'resize') {
              await terminals.resize(session, frame.cols, frame.rows);
              return;
            }
            if (frame.c === 'input')
              await terminals.input(session, clientId, frame.seq, frame.text);
            else await terminals.key(session, clientId, frame.seq, frame.keys);
            // ACKed whether or not it was applied: a replay is already durable,
            // and the client must stop retrying it either way.
            send({ c: 'ack', seq: frame.seq });
          } catch (error) {
            app.log.warn({ err: error, session }, 'terminal frame failed');
            socket.close(CLOSE_ATTACH_FAILED, 'terminal command failed');
          }
        });
      });
    },
  );
}
