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

/** Every `rollout-*.jsonl` under `$CODEX_HOME/sessions`, at any depth. */
async function rolloutFiles(codexHome: string): Promise<string[]> {
  const root = sessionsDir(codexHome);
  const names = await readdir(root, { recursive: true }).catch(() => [] as string[]);
  return names
    .filter((name) => name.endsWith('.jsonl') && name.includes('rollout-'))
    .map((name) => join(root, name));
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

/** The rollout for a session id tether already knows, without reading anything. */
async function byProviderSessionId(
  codexHome: string,
  providerSessionId: string,
): Promise<FoundRollout | undefined> {
  const suffix = `-${providerSessionId}.jsonl`;
  for (const path of await rolloutFiles(codexHome)) {
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
 */
async function byPanePid(
  stateDir: string,
  panePid: number,
  claimed: ReadonlySet<string> | undefined,
): Promise<FoundRollout | undefined> {
  for (const record of await sessionStarts(stateDir)) {
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
    const found = await byPanePid(session.stateDir, session.panePid, session.claimed);
    // Only if the file is really there: `SessionStart` fires as the rollout is
    // created, and a path that does not exist yet is not one to bind to.
    if (found !== undefined && (await stat(found.path).catch(() => undefined)) !== undefined) {
      return found;
    }
  }

  // Resolved, because `session_meta.cwd` is the path Codex resolved for itself.
  const cwd = await realpath(session.cwd).catch(() => session.cwd);
  const candidates: { path: string; providerSessionId: string; mtimeMs: number }[] = [];
  for (const path of await rolloutFiles(session.codexHome)) {
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
