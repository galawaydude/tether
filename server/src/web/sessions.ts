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

import type { Session, SessionState } from '@tether/shared';

import { LOCAL_MACHINE, getSession, listSessions, reconcileWithTmux } from '../machine/registry.ts';
import {
  MODES,
  setPermissionMode,
  type PermissionMode,
} from '../providers/claude-code/permission-mode.ts';
import { readSessionStatus } from '../providers/claude-code/status.ts';
import { DEFAULT_PROVIDER } from '../machine/registry.ts';
import {
  NoProviderSessionError,
  PROVIDER_COMMANDS,
  resumeSession,
  startSession,
  stopSession,
} from '../machine/sessions.ts';
import { DEFAULT_SOCKET, InvalidCwdError, listPanes } from '../machine/tmux.ts';

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

/** The four modes the pane's Shift+Tab cycle passes through. `dontAsk` and
 *  `bypassPermissions` are `--permission-mode` values the cycle never reaches,
 *  so they are not offered — the enum is what the cycle can actually deliver. */
const MODE_BODY = {
  type: 'object',
  required: ['mode'],
  additionalProperties: false,
  properties: { mode: { type: 'string', enum: [...MODES] } },
} as const;

type MachineParams = { machineId: string };
type SessionParams = MachineParams & { id: string };
type CreateBody = { cwd: string; title?: string; provider?: string };
type ModeBody = { mode: PermissionMode };

/**
 * `busy` / `idle` / `waiting` per live session, from the provider's own session
 * registry file (report §4e). Sent beside the sessions rather than on them: the
 * row shape *is* the wire shape, declared once in `shared/`, and this is derived
 * from a file the registry knows nothing about.
 *
 * Absent for a session whose file is missing or stale — the caller shows no
 * badge rather than a wrong one, and the pid guards live in `status.ts`.
 */
async function statesFor(
  sessions: readonly Session[],
  socket: string,
): Promise<Record<string, { state: SessionState }>> {
  const live = sessions.filter((session) => session.deadAt === null);
  if (live.length === 0) return {};
  const panes = await listPanes(socket).catch(() => []);
  const pids = new Map(panes.filter((pane) => !pane.dead).map((pane) => [pane.session, pane.pid]));
  const states: Record<string, { state: SessionState }> = {};
  await Promise.all(
    live.map(async (session) => {
      const pid = pids.get(session.tmuxName);
      if (pid === undefined) return;
      // The re-bind that keeps a row naming what its pane is really running lives
      // in the conversation poller, which only a conversation subscriber starts.
      // So a `/resume` typed with no conversation view open anywhere leaves this
      // badge blank — `waiting` included — until one is opened, which re-binds the
      // row and heals it. Deliberately deferred: the alternatives are dropping
      // `expectSessionId` here, which is the pid-reuse guard, or giving this hot
      // route a bind of its own.
      const state = await readSessionStatus(pid, { expectSessionId: session.providerSessionId });
      if (state === undefined) return;
      states[session.id] = { state };
    }),
  );
  return states;
}

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
      const sessions = listSessions(db);
      return { sessions, states: await statesFor(sessions, socket) };
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

  /**
   * Set the permission mode of a running Claude Code pane, and answer with what
   * was **confirmed by reading the pane back** — never with what was asked for.
   *
   * It is a route rather than a keystroke frame like the composer's other option
   * controls because it is the one axis that needs a *read*: Shift+Tab cycles,
   * so reaching a chosen mode means knowing where the pane is now and checking
   * where it ended up, and only this side can see the screen. The browser
   * therefore learns the outcome from the response and has nothing to poll.
   *
   * 409 rather than 500 for both failures: the request was well formed and the
   * caller could not have known. `unreadable` means nothing was pressed at all.
   */
  app.post<{ Params: SessionParams; Body: ModeBody }>(
    '/api/machines/:machineId/sessions/:id/permission-mode',
    { schema: { params: SESSION_PARAMS, body: MODE_BODY } },
    async (request, reply) => {
      const session = getSession(db, request.params.id);
      if (session === undefined) return reply.code(404).send({ error: 'no_such_session' });
      // Codex has its own permission vocabulary and its own picker; pressing
      // Shift+Tab at it would do something unrelated, so this is a 400 rather
      // than an attempt.
      if (session.provider !== DEFAULT_PROVIDER) {
        return reply.code(400).send({ error: 'wrong_provider' });
      }
      if (session.deadAt !== null) return reply.code(409).send({ error: 'session_dead' });

      const result = await setPermissionMode(socket, session.tmuxName, request.body.mode);
      if (result.ok) return reply.send({ mode: result.mode, changed: result.changed });
      // Where it actually ended up, when the screen still says — the browser
      // reports that rather than the mode nobody reached.
      const landed = result.reason === 'not_confirmed' ? (result.mode ?? null) : null;
      return reply.code(409).send({ error: result.reason, mode: landed });
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
