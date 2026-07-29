/**
 * The conversation routes: the full history over HTTP, and the `conv` channel.
 *
 * Neither opts out of `server.ts`'s default-deny hook, so both need a session
 * cookie — and the upgrade is covered by the Origin guard there too.
 *
 * The client's contract, which is the whole point of the `seq`:
 *
 *   1. `GET /api/sessions/:id/conversation` → `{ seq, events }`.
 *   2. connect to `/api/sessions/:id/conv?since=<seq>`.
 *   3. every `{c:'conv', seq, e}` from then on is the next event, exactly once.
 *   4. a `{c:'refetch'}` means the gap is wider than the server's memory: go
 *      back to 1. It is a real answer, not an error — a partial history with a
 *      hole in it is what this exists to prevent.
 *
 * A channel of its own rather than a second concern on the `term` socket: that
 * one is addressed by tmux session name and this one by registry id, and one
 * socket carrying both (report §5) is not worth changing a route PR #7 is
 * already built against.
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

import type { Conversations } from '../machine/conversations.ts';
import { getSession } from '../machine/registry.ts';

/** The full registry id, as everywhere else a browser addresses a session. */
const ID = {
  type: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
} as const;

const PARAMS = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: ID },
} as const;

/**
 * A string, not an integer: `buildServer` turns ajv's `coerceTypes` off, so a
 * query parameter arrives as the string it was sent as and an `integer` schema
 * would reject every request. 15 digits is past any real event count and short
 * of anything that would not be an integer.
 */
const CONV_SCHEMA = {
  params: PARAMS,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: { since: { type: 'string', pattern: '^[0-9]{1,15}$' } },
  },
} as const;

/** Close codes above 4000 are application-defined; these match `term-socket.ts`. */
export const CLOSE_NO_SESSION = 4404;

type Params = { id: string };

export function registerConversationRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  conversations: Conversations,
): void {
  app.get<{ Params: Params }>(
    '/api/sessions/:id/conversation',
    { schema: { params: PARAMS } },
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (session === undefined) return reply.code(404).send({ error: 'no_such_session' });
      return reply.send(await conversations.history(session));
    },
  );
}

/**
 * Registered from `app.after()` for the same reason the terminal socket is:
 * `@fastify/websocket` upgrades a route through an `onRoute` hook that does not
 * exist until its own registration has run.
 */
export function registerConvSocket(
  app: FastifyInstance,
  db: DatabaseSync,
  conversations: Conversations,
): void {
  app.get<{ Params: Params; Querystring: { since?: string } }>(
    '/api/sessions/:id/conv',
    { websocket: true, schema: CONV_SCHEMA },
    async (socket, request) => {
      const session = getSession(db, request.params.id);
      if (session === undefined) {
        socket.close(CLOSE_NO_SESSION, 'no such session');
        return;
      }

      const alive = () => socket.readyState === socket.OPEN;
      const unsubscribe = await conversations.subscribe(
        session,
        Number(request.query.since ?? '0'),
        (frame) => {
          if (alive()) socket.send(JSON.stringify(frame));
        },
      );
      // Subscribing spans a file read, and a client that gave up inside that
      // window would otherwise stay subscribed for the life of the process.
      if (!alive()) unsubscribe();
      else socket.on('close', unsubscribe);
    },
  );
}
