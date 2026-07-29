/**
 * The session registry: the one thing tether persists (report section 2).
 *
 * `node:sqlite` is the whole storage layer — there is no data-access layer on top
 * of it, no ORM and no migration framework. One schema, applied on open.
 *
 * The file is the one `db.ts` owns — under `~/.local/state/tether/`, never inside
 * the repo: a path that is not in the repo cannot be committed by accident, which
 * is stronger than an ignore rule (report section 7).
 */

import type { Session } from '@tether/shared';
import type { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../db.ts';
import { listPanes } from './tmux.ts';

/** The row shape is the wire shape; it is declared once, in `shared/`. */
export type { Session };

/** The only machine there is in M1 — see the `machine_id` note on the schema. */
export const LOCAL_MACHINE = 'local';

/** The one provider in M1. */
export const DEFAULT_PROVIDER = 'claude-code';

/**
 * `machine_id` is here on day one and is always `'local'`. It costs one column and
 * it makes multiple machines a later split rather than a rewrite; nothing else in
 * tether knows about machines.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id                  TEXT PRIMARY KEY,
    machine_id          TEXT NOT NULL,
    provider            TEXT NOT NULL,
    provider_session_id TEXT,
    cwd                 TEXT NOT NULL,
    title               TEXT NOT NULL,
    tmux_name           TEXT NOT NULL UNIQUE,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    dead_at             INTEGER
  );
`;

/** Every read goes through this, so the column aliases are written once. */
const COLUMNS = `
  id, machine_id AS machineId, provider, provider_session_id AS providerSessionId,
  cwd, title, tmux_name AS tmuxName,
  created_at AS createdAt, updated_at AS updatedAt, dead_at AS deadAt
`;

/**
 * Open (creating if absent) the one database and apply the schema. Idempotent:
 * opening an existing database is the same call. `path` is for tests only.
 */
export function openRegistry(path?: string): DatabaseSync {
  const db = openDatabase(path);
  applyRegistrySchema(db);
  return db;
}

/** The same schema on a database someone else opened. For tests and `:memory:`. */
export function applyRegistrySchema(db: DatabaseSync): void {
  db.exec(SCHEMA);
}

function rows(db: DatabaseSync, sql: string, ...params: string[]): Session[] {
  return db.prepare(sql).all(...params) as unknown as Session[];
}

export function createSession(
  db: DatabaseSync,
  session: {
    id: string;
    provider: string;
    cwd: string;
    title: string;
    tmuxName: string;
    now?: number;
  },
): Session {
  const now = session.now ?? Date.now();
  db.prepare(
    `INSERT INTO sessions (id, machine_id, provider, provider_session_id, cwd, title,
                           tmux_name, created_at, updated_at, dead_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    session.id,
    LOCAL_MACHINE,
    session.provider,
    session.cwd,
    session.title,
    session.tmuxName,
    now,
    now,
  );
  return getSession(db, session.id)!;
}

/** Newest first. Dead rows are included: a dead session is resumable, not gone. */
export function listSessions(db: DatabaseSync): Session[] {
  return rows(db, `SELECT ${COLUMNS} FROM sessions ORDER BY created_at DESC`);
}

/** By full id, or by any prefix that identifies exactly one row. */
export function getSession(db: DatabaseSync, idOrPrefix: string): Session | undefined {
  const matches = rows(
    db,
    `SELECT ${COLUMNS} FROM sessions WHERE id = ? OR id LIKE ? ESCAPE '\\' LIMIT 2`,
    idOrPrefix,
    `${idOrPrefix.replace(/[\\%_]/g, '\\$&')}%`,
  );
  if (matches.length > 1) throw new Error(`session id ${idOrPrefix} is ambiguous`);
  return matches[0];
}

/** Back-fill the provider's own session id once the provider has created one. */
export function setProviderSessionId(
  db: DatabaseSync,
  id: string,
  providerSessionId: string,
): void {
  db.prepare('UPDATE sessions SET provider_session_id = ?, updated_at = ? WHERE id = ?').run(
    providerSessionId,
    Date.now(),
    id,
  );
}

/**
 * The live row that owns this provider session id. What a hook payload joins on:
 * it names the provider's session, and the registry is the only thing that knows
 * which tether session that is.
 */
export function getSessionByProviderSessionId(
  db: DatabaseSync,
  providerSessionId: string,
): Session | undefined {
  return rows(
    db,
    `SELECT ${COLUMNS} FROM sessions WHERE provider_session_id = ? AND dead_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    providerSessionId,
  )[0];
}

/**
 * Bind a provider session id to the one live row in `cwd` that has none yet, and
 * return it. Used only when a hook arrives for a session the transcript scan has
 * not reached — which is the normal case for the *first* tool call, since a
 * `PreToolUse` can precede the transcript's first flush.
 *
 * Exactly one candidate or nothing: two unclaimed sessions in one directory is
 * ambiguous, and guessing there would attach a conversation to the wrong session,
 * which is worse than a card that arrives a second later by the usual route.
 */
export function adoptProviderSessionId(
  db: DatabaseSync,
  cwd: string,
  providerSessionId: string,
): Session | undefined {
  const candidates = rows(
    db,
    `SELECT ${COLUMNS} FROM sessions
     WHERE cwd = ? AND provider_session_id IS NULL AND dead_at IS NULL LIMIT 2`,
    cwd,
  );
  if (candidates.length !== 1) return undefined;
  setProviderSessionId(db, candidates[0]!.id, providerSessionId);
  return getSession(db, candidates[0]!.id);
}

/**
 * Every provider session id already bound to a row other than `exceptId`. What
 * transcript discovery needs and cannot work out from timestamps: a transcript
 * this registry has already given to one session is not available to another.
 */
export function claimedProviderSessionIds(db: DatabaseSync, exceptId: string): Set<string> {
  const claimed = db
    .prepare(
      'SELECT provider_session_id FROM sessions WHERE provider_session_id IS NOT NULL AND id != ?',
    )
    .all(exceptId) as unknown as { provider_session_id: string }[];
  return new Set(claimed.map((row) => row.provider_session_id));
}

/** Idempotent — the first death is the one that is recorded. */
export function markDead(db: DatabaseSync, id: string): void {
  const now = Date.now();
  db.prepare('UPDATE sessions SET dead_at = COALESCE(dead_at, ?), updated_at = ? WHERE id = ?').run(
    now,
    now,
    id,
  );
}

/**
 * Bring a dead row back to life, once its tmux session exists again.
 *
 * The one thing that clears `dead_at`, and only ever after `resumeSession` has
 * started the replacement pane: a row whose `dead_at` is null and whose tmux
 * session is not running is the state reconcile exists to prevent.
 */
export function revive(db: DatabaseSync, id: string): void {
  const now = Date.now();
  db.prepare('UPDATE sessions SET dead_at = NULL, updated_at = ? WHERE id = ?').run(now, id);
}

/**
 * Mark every live row whose tmux session is not in `liveTmuxNames` as dead, and
 * return how many that was.
 *
 * One UPDATE rather than a read, a filter and a write per row: the whole reason
 * the design chose SQLite over a JSON file was atomic update, and a
 * read-modify-write here would hand that back.
 *
 * `snapshotAt` is when `liveTmuxNames` was read, and only rows that were already
 * in their present state then are judged. Atomicity covers the database, not the
 * tmux snapshot the verdict is derived from: without this, a `tether new` that
 * lands between another process's pane read and its UPDATE has its brand-new row
 * marked dead while its agent runs, and a `tether resume` that lands in that same
 * window has its just-revived row re-killed. `updated_at` is what catches the
 * second case — `revive` bumps it — and it subsumes the first, since
 * `createSession` sets it equal to `created_at`. The only thing that clears
 * `dead_at` is `revive`, on an explicit resume — nothing un-kills a row on its
 * own, which is exactly why a false positive here has to be impossible.
 */
export function reconcile(
  db: DatabaseSync,
  liveTmuxNames: readonly string[],
  snapshotAt: number,
): number {
  const alive = liveTmuxNames.length
    ? `AND tmux_name NOT IN (${liveTmuxNames.map(() => '?').join(',')})`
    : '';
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE sessions SET dead_at = ?, updated_at = ?
       WHERE dead_at IS NULL AND created_at <= ? AND updated_at <= ? ${alive}`,
    )
    .run(now, now, snapshotAt, snapshotAt, ...liveTmuxNames);
  return Number(result.changes);
}

/**
 * Reconcile against what tmux actually has right now. A session counts as live
 * only while it still has a pane that is not dead.
 *
 * The `!p.dead` filter is defensive: `tether.conf` does not set `remain-on-exit`
 * and tmux's default is off, so a pane normally dies with its process and no dead
 * pane is ever reported. It is what keeps the answer right if that changes — a
 * pane outliving its process is a shell of a session, not a running agent.
 *
 * The timestamp is taken before the read, so a session created while tmux is being
 * asked is out of scope rather than a false death.
 */
export async function reconcileWithTmux(db: DatabaseSync, socket: string): Promise<number> {
  const snapshotAt = Date.now();
  const live = (await listPanes(socket)).filter((p) => !p.dead).map((p) => p.session);
  return reconcile(db, live, snapshotAt);
}
