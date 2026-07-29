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

import type { PermissionDecision } from '@tether/shared';
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

/**
 * The answer to a held permission prompt.
 *
 * `callId` is the provider's own `tool_use_id`, so it is not tether's to
 * validate beyond "a printable identifier of a sane length" — the authorisation
 * is that it names a call *this* session is currently holding, which only
 * `Conversations` can say. `enum` on the decision rather than a boolean: a
 * request that meant to deny and arrived malformed must be a 400, never the
 * other answer.
 */
const ANSWER_SCHEMA = {
  params: PARAMS,
  body: {
    type: 'object',
    required: ['callId', 'decision'],
    additionalProperties: false,
    properties: {
      callId: { type: 'string', minLength: 1, maxLength: 200 },
      decision: { type: 'string', enum: ['allow', 'deny'] },
    },
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
      // A transcript that exists and cannot be read is a fault, not an empty
      // conversation; the reason is on the server's stderr, not in this reply.
      const history = await conversations.history(session).catch(() => undefined);
      if (history === undefined) return reply.code(500).send({ error: 'transcript_unreadable' });
      return reply.send(history);
    },
  );

  /**
   * Approve or deny a proposed tool call — the tap the captain's decision is
   * about (`decision-permission-answer-surface.md`).
   *
   * Authenticated exactly like every other route, by saying nothing: the
   * default-deny hook in `server.ts` covers it because it does not opt out. That
   * is not a formality here. An unauthenticated approve is an unauthenticated
   * tool execution on the user's machine, and it would be reachable by anyone
   * who could reach the port — the guard is the same one that keeps the rest of
   * the API from being a shell, and it is not relaxed to make this path simpler.
   *
   * `409` is a real answer and the client renders it as one: the hold has
   * already been settled — by the timer, by another viewer, or by this user
   * tapping twice — and the prompt has moved on. Answering twice is exactly what
   * this route must not let happen, so it reports rather than retries.
   */
  app.post<{ Params: Params; Body: { callId: string; decision: PermissionDecision } }>(
    '/api/sessions/:id/permission',
    { schema: ANSWER_SCHEMA },
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (session === undefined) return reply.code(404).send({ error: 'no_such_session' });
      const answered = conversations.answer(session.id, request.body.callId, request.body.decision);
      if (!answered) return reply.code(409).send({ error: 'not_awaiting_answer' });
      return reply.code(204).send();
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
