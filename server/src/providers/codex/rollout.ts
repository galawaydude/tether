/**
 * Which rollout file belongs to which tether session.
 *
 * Codex writes **nothing at all** until the first user message — no rollout, no
 * registry row of its own, no `SessionStart` — so a session tether has just
 * started has no provider identity to find. That is why `provider_session_id` is
 * nullable: the row is provisional from spawn and back-filled here, on the first
 * discovery that succeeds.
 *
 * There are two ways to succeed, and the difference between them is exactly what
 * accepting or declining tether's hook buys:
 *
 * - **With the hook**, `SessionStart` names the session id and the rollout path
 *   outright, joined to the pane by the hook process's parent pid. Nothing is
 *   inferred.
 * - **Without it**, the rollout's own `session_meta` record — always the first
 *   line, carrying `cwd` and the session's start time — identifies it, the same
 *   way the Claude Code transcript is identified by where its records begin.
 *   Slower to be sure, and with a genuine ambiguity window (below), but the
 *   conversation view works.
 *
 * Following the file once found is `../tail.ts`, shared with Claude Code.
 *
 * Nothing in `providers/` may import from `web/` (report §5).
 */

import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { sessionStarts } from './hooks.ts';
import { sessionsDir } from './spawn.ts';

/**
 * How much before its session's `createdAt` a rollout's own `session_meta` may
 * be stamped and still belong to that session. The registry row is written after
 * tmux has already started Codex, so Codex can legitimately stamp its first
 * record slightly earlier.
 */
const START_SLACK_MS = 10_000;

/**
 * How far below `createdAt` a candidate's mtime may sit before it is dropped
 * without being opened. A file's first record cannot have been written after its
 * last, so anything below this floor would fail the `session_meta` test anyway;
 * it can only skip reads that were going to be rejected. Deliberately generous:
 * this session's own rollout is being appended to while the search runs.
 *
 * It is also the floor on which *day directories* are walked at all, which is
 * the same bound one level up: a rollout below the floor is in a day directory
 * below the floor, and discovery retries once a second for as long as a new
 * session waits for its first prompt.
 */
const STALE_MTIME_MS = 5 * 60_000;

/** How much of a rollout is read to find its `session_meta`. */
const PREFIX_BYTES = 64 * 1024;

export type FoundRollout = {
  path: string;
  /** Codex's own session id — which tether back-fills into the registry row. */
  providerSessionId: string;
};

/**
 * The session id out of a rollout's file name — `rollout-<local ts>-<uuid>.jsonl`.
 *
 * The name is the only place the id appears without opening the file, and the
 * timestamp in it is *local* time while every timestamp inside is UTC, so the
 * name is read for the id and never for the time.
 */
export function rolloutSessionId(path: string): string | undefined {
  const match = /rollout-.*-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/.exec(path);
  return match?.[1];
}

/** Codex files a rollout under `sessions/<Y>/<M>/<D>`: three levels of directory. */
const DAY_DEPTH = 3;

/** The `<Y>/<M>/<D>` a rollout begun at `at` is filed under — local time, as Codex names them. */
function dayKey(at: number): string {
  const when = new Date(at);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${when.getFullYear()}/${pad(when.getMonth() + 1)}/${pad(when.getDate())}`;
}

/**
 * The day directories under `$CODEX_HOME/sessions`, newest first.
 *
 * Zero-padded `<Y>`, `<M>` and `<D>` sort lexicographically in the order they
 * sort chronologically, so descending name order is descending date order —
 * which is what lets a caller looking for one file stop at the first hit instead
 * of walking a year of history, and what makes `notBefore` a `break` rather than
 * a filter: the first name below the floor puts every later name below it too.
 */
async function dayDirs(codexHome: string, notBefore?: string): Promise<string[]> {
  let level = [{ path: sessionsDir(codexHome), key: '' }];
  for (let depth = 0; depth < DAY_DEPTH; depth += 1) {
    const next: typeof level = [];
    for (const dir of level) {
      const names = await readdir(dir.path, { withFileTypes: true })
        .then((entries) =>
          entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
        )
        .catch(() => [] as string[]);
      names.sort().reverse();
      for (const name of names) {
        const key = dir.key === '' ? name : `${dir.key}/${name}`;
        if (notBefore !== undefined && key < notBefore.slice(0, key.length)) break;
        next.push({ path: join(dir.path, name), key });
      }
    }
    level = next;
  }
  return level.map((dir) => dir.path);
}

/**
 * Every `rollout-*.jsonl` under `$CODEX_HOME/sessions`, newest day first and
 * lazily: a caller that wants one file pays for the days it had to look through
 * to find it, and nothing is stat'd or opened on the way.
 */
async function* rolloutFiles(codexHome: string, notBefore?: string): AsyncGenerator<string> {
  for (const dir of await dayDirs(codexHome, notBefore)) {
    const names = await readdir(dir).catch(() => []);
    for (const name of names) {
      if (name.startsWith('rollout-') && name.endsWith('.jsonl')) yield join(dir, name);
    }
  }
}

/**
 * The `session_meta` at the head of a rollout: when the session began and where.
 *
 * A one-off identification read, bounded because a rollout reaches tens of
 * megabytes, and only whole lines are decoded — the budget cuts the last one
 * mid-record and mid-glyph. `session_meta` is the first line in every rollout
 * this was verified against; the loop scans forward anyway rather than assuming
 * a position the format never promised.
 */
async function sessionMeta(path: string): Promise<{ began: number; cwd: string } | undefined> {
  const handle = await open(path, 'r').catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const buffer = Buffer.allocUnsafe(PREFIX_BYTES);
    const read = await handle.read(buffer, 0, PREFIX_BYTES, 0).catch(() => undefined);
    if (read === undefined) return undefined;
    const lines = buffer.subarray(0, read.bytesRead).toString('utf8').split('\n');
    lines.pop();
    for (const line of lines) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof record !== 'object' || record === null) continue;
      const outer = record as Record<string, unknown>;
      if (outer['type'] !== 'session_meta') continue;
      const payload = outer['payload'];
      if (typeof payload !== 'object' || payload === null) continue;
      const meta = payload as Record<string, unknown>;
      const cwd = meta['cwd'];
      const began = Date.parse(
        typeof meta['timestamp'] === 'string'
          ? meta['timestamp']
          : typeof outer['timestamp'] === 'string'
            ? outer['timestamp']
            : '',
      );
      if (typeof cwd !== 'string' || Number.isNaN(began)) continue;
      return { began, cwd };
    }
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * The rollout for a session id tether already knows, without reading anything.
 *
 * Unbounded by date on purpose, unlike the discovery scan below: a session
 * revived after a reboot keeps the rollout it was started with, however long ago
 * that was, and answering "not found" for it would cost the user the
 * conversation it is there to restore. The walk is newest-first and stops at the
 * first hit, so the common case — a session from today — reads one directory.
 */
async function byProviderSessionId(
  codexHome: string,
  providerSessionId: string,
): Promise<FoundRollout | undefined> {
  const suffix = `-${providerSessionId}.jsonl`;
  for await (const path of rolloutFiles(codexHome)) {
    if (path.endsWith(suffix)) return { path, providerSessionId };
  }
  return undefined;
}

/**
 * The session id from the `SessionStart` this pane's Codex process recorded.
 *
 * `ppid` is the join: the shim has no shell between it and Codex, and Codex is
 * the pane's process. A pane whose Codex has started more than one session —
 * which `codex resume` inside the pane would do — is answered with the newest,
 * which is the one the pane is running.
 *
 * `createdAt` bounds which logs are read at all: a session that began then
 * cannot have recorded its `SessionStart` in a file untouched since long before,
 * and the logs are never pruned. See `sessionStarts`.
 */
async function byPanePid(
  stateDir: string,
  panePid: number,
  createdAt: number,
  claimed: ReadonlySet<string> | undefined,
): Promise<FoundRollout | undefined> {
  for (const record of await sessionStarts(stateDir, createdAt - STALE_MTIME_MS)) {
    if (record['ppid'] !== panePid) continue;
    const id = record['session_id'];
    const path = record['transcript_path'];
    if (typeof id !== 'string' || typeof path !== 'string') continue;
    if (claimed?.has(id) === true) continue;
    return { path, providerSessionId: id };
  }
  return undefined;
}

/**
 * Find the rollout of the Codex session tether started in `cwd`.
 *
 * `claimed` is the provider session ids other registry rows already hold: a
 * rollout that is spoken for is not a candidate at any timestamp, and nothing in
 * a clock could settle two sessions started in the same directory seconds apart.
 * A candidate with no readable `session_meta` yet is skipped rather than
 * rejected — the caller's retry loop looks again — because the binding is
 * permanent, so adopting a neighbour's rollout would show its conversation under
 * this session's name for good.
 *
 * ponytail: without the hook, two Codex sessions started in the same directory
 * within `START_SLACK_MS` of each other, before either is back-filled, are
 * separated only by mtime order. Installing the hook closes that window outright,
 * since `SessionStart` names the pane.
 */
export async function findRollout(session: {
  cwd: string;
  createdAt: number;
  providerSessionId?: string | null;
  codexHome: string;
  /** Where the hook writes. Omit to search the rollout files only. */
  stateDir?: string | undefined;
  /** The tmux pane's pid, which is Codex's own. Omit if it is not known. */
  panePid?: number | undefined;
  claimed?: ReadonlySet<string> | undefined;
}): Promise<FoundRollout | undefined> {
  if (session.providerSessionId != null && session.providerSessionId !== '') {
    return byProviderSessionId(session.codexHome, session.providerSessionId);
  }

  if (session.stateDir !== undefined && session.panePid !== undefined) {
    const found = await byPanePid(
      session.stateDir,
      session.panePid,
      session.createdAt,
      session.claimed,
    );
    // Only if the file is really there: `SessionStart` fires as the rollout is
    // created, and a path that does not exist yet is not one to bind to.
    if (found !== undefined && (await stat(found.path).catch(() => undefined)) !== undefined) {
      return found;
    }
  }

  // Resolved, because `session_meta.cwd` is the path Codex resolved for itself.
  const cwd = await realpath(session.cwd).catch(() => session.cwd);
  const candidates: { path: string; providerSessionId: string; mtimeMs: number }[] = [];
  for await (const path of rolloutFiles(
    session.codexHome,
    dayKey(session.createdAt - STALE_MTIME_MS),
  )) {
    const providerSessionId = rolloutSessionId(path);
    if (providerSessionId === undefined) continue;
    if (session.claimed?.has(providerSessionId) === true) continue;
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) continue;
    if (info.mtimeMs < session.createdAt - STALE_MTIME_MS) continue;
    candidates.push({ path, providerSessionId, mtimeMs: info.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    const meta = await sessionMeta(candidate.path);
    if (meta === undefined) continue;
    if (meta.cwd !== cwd) continue;
    if (meta.began < session.createdAt - START_SLACK_MS) continue;
    return { path: candidate.path, providerSessionId: candidate.providerSessionId };
  }
  return undefined;
}
