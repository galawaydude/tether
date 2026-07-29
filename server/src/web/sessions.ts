/**
 * The session API: list, read, create, delete.
 *
 * Nothing here opts out of the default-deny hook in `server.ts`, so every route
 * below needs a valid session cookie. Validation is declared as JSON Schema on the
 * body and on the route parameters rather than hand-written in the handlers — that
 * is what Fastify was chosen for, and `buildServer` has already turned off the ajv
 * options that would silently repair a bad request instead of rejecting it.
 */

import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

import { LOCAL_MACHINE, getSession, listSessions, reconcileWithTmux } from '../machine/registry.ts';
import {
  NoProviderSessionError,
  PROVIDER_COMMANDS,
  resumeSession,
  startSession,
  stopSession,
} from '../machine/sessions.ts';
import { DEFAULT_SOCKET, InvalidCwdError } from '../machine/tmux.ts';

export type SessionRoutesOptions = {
  /** The registry database, schema already applied. */
  db: DatabaseSync;
  /** tmux socket to drive. Tests point this at a server of their own. */
  socket?: string | undefined;
  /** Directories a session may be started in; defaults to `allowedRoots()`. */
  allowedRoots?: readonly string[] | undefined;
};

/**
 * Every session is addressed as `(machineId, sessionId)` from day one, with
 * `machineId` always `'local'` in M1. It costs one path segment and it is what makes
 * a second machine a later split rather than a rewrite (report §5). Nothing else in
 * tether knows about machines, and nothing else here should.
 */
const MACHINE_PARAMS = {
  type: 'object',
  required: ['machineId'],
  additionalProperties: false,
  properties: { machineId: { type: 'string', enum: [LOCAL_MACHINE] } },
} as const;

/**
 * The full id, not the prefix the CLI accepts: a browser always has the whole one,
 * and requiring it makes the ambiguous-prefix case unrepresentable rather than
 * something a handler has to answer for.
 */
const SESSION_PARAMS = {
  type: 'object',
  required: ['machineId', 'id'],
  additionalProperties: false,
  properties: {
    machineId: { type: 'string', enum: [LOCAL_MACHINE] },
    id: {
      type: 'string',
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    },
  },
} as const;

/** `cwd` is checked for real by `resolveCwd`; the schema only bounds the string. */
const CREATE_BODY = {
  type: 'object',
  required: ['cwd'],
  additionalProperties: false,
  properties: {
    cwd: { type: 'string', minLength: 1, maxLength: 4096 },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    provider: { type: 'string', enum: [...PROVIDER_COMMANDS.keys()] },
  },
} as const;

type MachineParams = { machineId: string };
type SessionParams = MachineParams & { id: string };
type CreateBody = { cwd: string; title?: string; provider?: string };

export function registerSessionRoutes(app: FastifyInstance, options: SessionRoutesOptions): void {
  const { db } = options;
  const socket = options.socket ?? DEFAULT_SOCKET;
  const roots = options.allowedRoots;

  app.get<{ Params: MachineParams }>(
    '/api/machines/:machineId/sessions',
    { schema: { params: MACHINE_PARAMS } },
    async () => {
      // Reconcile first, exactly as `tether ls` does, so the list never reports a
      // session that died while tether was not running.
      await reconcileWithTmux(db, socket);
      return { sessions: listSessions(db) };
    },
  );

  app.get<{ Params: SessionParams }>(
    '/api/machines/:machineId/sessions/:id',
    { schema: { params: SESSION_PARAMS } },
    async (request, reply) => {
      await reconcileWithTmux(db, socket);
      const session = getSession(db, request.params.id);
      if (session === undefined) return reply.code(404).send({ error: 'no_such_session' });
      return reply.send({ session });
    },
  );

  app.post<{ Params: MachineParams; Body: CreateBody }>(
    '/api/machines/:machineId/sessions',
    { schema: { params: MACHINE_PARAMS, body: CREATE_BODY } },
    async (request, reply) => {
      try {
        const session = await startSession(db, socket, {
          cwd: request.body.cwd,
          title: request.body.title,
          provider: request.body.provider,
          roots,
        });
        return reply.code(201).send({ session });
      } catch (error) {
        // A refused directory is the caller's mistake, not a server fault. The
        // message names the roots: the account behind this request already has a
        // shell, so there is nothing to withhold and a mystery 400 helps nobody.
        if (error instanceof InvalidCwdError) {
          return reply.code(400).send({ error: 'invalid_cwd', message: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: SessionParams }>(
    '/api/machines/:machineId/sessions/:id/resume',
    { schema: { params: SESSION_PARAMS } },
    async (request, reply) => {
      // Reconciled first for the same reason the reads are: a row that looks live
      // but whose tmux session died while tether was down is exactly the row a
      // caller means when it asks to resume.
      await reconcileWithTmux(db, socket);
      const session = getSession(db, request.params.id);
      if (session === undefined) return reply.code(404).send({ error: 'no_such_session' });
      try {
        return reply.send({ session: await resumeSession(db, socket, session, roots) });
      } catch (error) {
        // 409, not 400: the request is well formed and the caller could not have
        // known. The message says what to do instead, and the UI must not dress
        // this up as a resume that worked.
        if (error instanceof NoProviderSessionError) {
          return reply.code(409).send({ error: 'no_provider_session', message: error.message });
        }
        if (error instanceof InvalidCwdError) {
          return reply.code(400).send({ error: 'invalid_cwd', message: error.message });
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: SessionParams }>(
    '/api/machines/:machineId/sessions/:id',
    { schema: { params: SESSION_PARAMS } },
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (session === undefined) return reply.code(404).send({ error: 'no_such_session' });
      // Idempotent: rows are marked dead and never deleted, so a second delete finds
      // the same row, asks tmux to kill a session that is already gone, and answers
      // the same way. PR #12 resumes from those rows.
      await stopSession(db, socket, session);
      return reply.send({ session: getSession(db, session.id) });
    },
  );
}
