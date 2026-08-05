/**
 * The conversation routes: the full history over HTTP, and the `conv` channel.
 *
 * Neither opts out of `server.ts`'s default-deny hook, so both need a session
 * cookie — and the upgrade is covered by the Origin guard there too.
 *
 * The client's contract, which is the whole point of the `seq`:
 *
 *   1. `GET /api/sessions/:id/conversation` → latest bounded `{ seq, events }`.
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

import type { ConvClientFrame, PermissionDecision, ServerFrame } from '@tether/shared';
import type { FastifyInstance } from 'fastify';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { stateDir as defaultStateDir } from '../db.ts';
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

/** Images paste as bytes, never base64 JSON. Keep this mirrored in `web/src/api.ts`. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** SVG is deliberately absent: pasted images are inert pixels, never active markup. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

type ImageType = (typeof IMAGE_TYPES)[number];

const IMAGE_EXTENSIONS: Record<ImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const EXTENSION_TYPES: Record<string, ImageType> = Object.fromEntries(
  Object.entries(IMAGE_EXTENSIONS).map(([type, extension]) => [extension, type as ImageType]),
);

const IMAGE_FILE = {
  type: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(?:png|jpg|webp|gif)$',
} as const;

const IMAGE_PARAMS = {
  type: 'object',
  required: ['id', 'file'],
  additionalProperties: false,
  properties: { id: ID, file: IMAGE_FILE },
} as const;

/** Register before routes: Fastify otherwise rejects image bodies as unsupported media. */
export function registerImageParsers(app: FastifyInstance): void {
  for (const type of IMAGE_TYPES) {
    app.addContentTypeParser(
      type,
      { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES },
      (_request, body, done) => done(null, body),
    );
  }
}

function isImage(type: ImageType, bytes: Buffer): boolean {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return false;
  if (type === 'image/png')
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/gif') {
    const signature = bytes.subarray(0, 6).toString('ascii');
    return signature === 'GIF87a' || signature === 'GIF89a';
  }
  return (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

function imageDirectory(root: string, sessionId: string): string {
  return join(root, 'attachments', sessionId);
}

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

const HISTORY_SCHEMA = {
  params: PARAMS,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: { before: { type: 'string', pattern: '^[1-9][0-9]{0,14}$' } },
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

/** The channel's whole client vocabulary, parsed the same way the terminal's is. */
export function parseWatch(raw: string): ConvClientFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const frame = value as Record<string, unknown>;
  if (frame['c'] !== 'watch' || typeof frame['watching'] !== 'boolean') return null;
  return { c: 'watch', watching: frame['watching'] };
}

type Params = { id: string };

export function registerConversationRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  conversations: Conversations,
  options: { stateDir?: string } = {},
): void {
  const attachmentRoot = options.stateDir ?? defaultStateDir();

  app.get<{ Params: Params; Querystring: { before?: string } }>(
    '/api/sessions/:id/conversation',
    { schema: HISTORY_SCHEMA },
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (session === undefined) return reply.code(404).send({ error: 'no_such_session' });
      // A transcript that exists and cannot be read is a fault, not an empty
      // conversation; the reason is on the server's stderr, not in this reply.
      const before = request.query.before === undefined ? undefined : Number(request.query.before);
      const history = await conversations.history(session, before).catch(() => undefined);
      if (history === undefined) return reply.code(500).send({ error: 'transcript_unreadable' });
      return reply.send(history);
    },
  );

  /**
   * A pasted image becomes a private file the provider can read by absolute path.
   * The path goes into the composed prompt; the id is what the browser retains
   * and later uses to draw the image without exposing a filesystem route.
   *
   * The parser is byte-bounded before this handler runs, and the signature is
   * checked rather than trusting Content-Type. SVG is not accepted: an image
   * pasted into a shell supervisor has no reason to become active browser markup.
   */
  app.post<{ Params: Params; Body: Buffer }>(
    '/api/sessions/:id/images',
    { schema: { params: PARAMS }, bodyLimit: MAX_IMAGE_BYTES },
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (session === undefined) return reply.code(404).send({ error: 'no_such_session' });
      if (session.deadAt !== null) return reply.code(409).send({ error: 'session_dead' });
      const type = request.headers['content-type']?.split(';', 1)[0] as ImageType | undefined;
      if (type === undefined || !IMAGE_TYPES.includes(type) || !isImage(type, request.body)) {
        return reply.code(400).send({ error: 'invalid_image' });
      }

      const id = `${randomUUID()}.${IMAGE_EXTENSIONS[type]}`;
      const directory = imageDirectory(attachmentRoot, session.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const path = join(directory, id);
      await writeFile(path, request.body, { mode: 0o600, flag: 'wx' });
      return reply.code(201).send({ id, type, size: request.body.length, path });
    },
  );

  /**
   * Authenticated and session-scoped: knowing a random attachment id is not a
   * second door around the cookie, and a removed registry row exposes nothing.
   * `nosniff` makes the signature check above remain the browser's answer too.
   */
  app.get<{ Params: Params & { file: string } }>(
    '/api/sessions/:id/images/:file',
    { schema: { params: IMAGE_PARAMS } },
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (session === undefined) return reply.code(404).send({ error: 'no_such_session' });
      const extension = request.params.file.split('.').at(-1) ?? '';
      const type = EXTENSION_TYPES[extension];
      if (type === undefined) return reply.code(404).send({ error: 'no_such_image' });
      const bytes = await readFile(
        join(imageDirectory(attachmentRoot, session.id), request.params.file),
      ).catch(() => undefined);
      if (bytes === undefined) return reply.code(404).send({ error: 'no_such_image' });
      return reply
        .header('content-type', type)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, max-age=31536000, immutable')
        .send(bytes);
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
      const send = (frame: ServerFrame) => {
        if (alive()) socket.send(JSON.stringify(frame));
      };
      // The only thing a client says on this channel: which pane is in front.
      // Validated by hand rather than trusted after `JSON.parse`, as on the
      // terminal socket — reaching this route is equivalent to a shell — and
      // anything else is dropped in silence.
      //
      // Listening before subscribing, and remembering the answer: subscribing
      // spans a file read, and a client that says "I am on the terminal" inside
      // that window would otherwise be heard by nobody and have the agent held
      // for it anyway.
      let watching = true;
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        const frame = parseWatch(data.toString());
        if (frame === null) return;
        watching = frame.watching;
        conversations.watch(session.id, send, frame.watching);
      });

      const unsubscribe = await conversations.subscribe(
        session,
        Number(request.query.since ?? '0'),
        send,
      );
      // A client that gave up inside that same window would otherwise stay
      // subscribed for the life of the process.
      if (!alive()) {
        unsubscribe();
        return;
      }
      socket.on('close', unsubscribe);
      if (!watching) conversations.watch(session.id, send, false);
    },
  );
}
