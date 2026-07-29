/**
 * Claude Code's transcript file: where it is, and how to find the right one.
 *
 * Claude Code appends NDJSON to `~/.claude/projects/<sanitised cwd>/<session
 * uuid>.jsonl`, flushed on a timer — so a read lands mid-write routinely and a
 * trailing partial line is normal, not an error. Following it is `../tail.ts`,
 * which both providers share; what is Claude-Code-specific is everything below.
 *
 * Nothing in `providers/` may import from `web/` (report §5).
 */

import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The version this module's fixtures were captured from. See `fixtures/`. */
export const CAPTURED_VERSION = '2.1.220';

/**
 * How much before its session's `createdAt` a transcript's own first record may
 * be stamped and still belong to that session. The registry row is stamped after
 * tmux has already started the provider, so the provider can legitimately write
 * its first record a few milliseconds earlier.
 *
 * Generous where a tolerance against mtime had to be stingy, and safe for the
 * reason that one was not: this is measured against the moment the file *began*,
 * not the moment it was last touched. A transcript left behind by an earlier
 * session began minutes or hours ago and no plausible tolerance here admits it,
 * whereas its mtime is whenever it last flushed — which can be a moment ago.
 *
 * It does admit a *concurrent* neighbour, which is what `claimed` is for.
 */
const START_SLACK_MS = 10_000;

/**
 * How far below `createdAt` a candidate's mtime may sit before it is dropped
 * without being opened at all.
 *
 * Sound in the direction that matters: a file's first record cannot have been
 * written after its last, so `began <= mtimeMs` give or take the same filesystem
 * granularity this module already allows for, and a candidate below this floor
 * therefore could not have passed the `began` test either. It can only skip
 * reads that were going to be rejected.
 *
 * Deliberately generous by a wide margin rather than tuned to that bound: this
 * session's own transcript is being appended to as the search runs, so its mtime
 * is seconds old, while the granularity error that motivated all of this is a
 * couple of seconds. Tightening this is how a cheap pre-filter starts excluding
 * the one file it was looking for.
 */
const STALE_MTIME_MS = 5 * 60_000;

/** How much of a transcript is read to find out when it began. */
const PREFIX_BYTES = 64 * 1024;

/**
 * Claude Code's own `sanitizePath` (`utils/sessionStoragePortable.ts`): every
 * non-alphanumeric byte becomes a hyphen.
 *
 * ponytail: Claude Code additionally truncates and hash-suffixes names past 255
 * bytes. A cwd that long has other problems; tether finds no transcript for it
 * and the conversation view is empty while the terminal still works. Add the
 * hash if anyone ever hits it.
 */
export function sanitizePath(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The directory Claude Code keeps a project's transcripts in. */
export function projectDir(cwd: string, home = homedir()): string {
  return join(home, '.claude', 'projects', sanitizePath(cwd));
}

export type FoundTranscript = {
  path: string;
  /** Claude Code's own session id — the file's name, which tether back-fills. */
  providerSessionId: string;
};

type Candidate = FoundTranscript & { mtimeMs: number; size: number };

/**
 * What a previous scan already worked out, keyed by path. A file whose size and
 * mtime have not moved has not changed its answer, so the identification read is
 * skipped — discovery runs once a second for as long as a new session waits for
 * its first prompt, and re-reading the same unchanged files each time is the
 * cost that buys nothing.
 *
 * The caller owns one and scopes it to a single session's discovery, so it can
 * never hold more than that session's project directory lists.
 */
export type StartMemo = Map<string, { size: number; mtimeMs: number; began: number | undefined }>;

/**
 * When the transcript at `path` begins: the timestamp of the first record that
 * carries a parseable one, or `undefined` while nothing usable is on disk yet.
 *
 * A one-off identification read, and deliberately not a second tailing path —
 * `tailLines` owns following a file. Bounded, because a transcript reaches
 * hundreds of megabytes; only whole lines are decoded, since the budget and the
 * flush timer both cut the last one mid-record and mid-glyph. The first record
 * is routinely a type with no `timestamp` at all, so this scans forward rather
 * than reading line one and giving up.
 */
async function startedAt(path: string): Promise<number | undefined> {
  const handle = await open(path, 'r').catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const buffer = Buffer.allocUnsafe(PREFIX_BYTES);
    // A candidate that cannot be read — a directory of that name, a mode that
    // changed — is unverifiable like any other, never an error at the caller.
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
      const stamp = (record as Record<string, unknown>)['timestamp'];
      const at = Date.parse(typeof stamp === 'string' ? stamp : '');
      if (!Number.isNaN(at)) return at;
    }
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * The identification read for one candidate, skipped when a previous scan
 * already answered for the same bytes.
 */
async function beganAt(candidate: Candidate, memo?: StartMemo): Promise<number | undefined> {
  const cached = memo?.get(candidate.path);
  if (cached?.size === candidate.size && cached.mtimeMs === candidate.mtimeMs) return cached.began;
  const began = await startedAt(candidate.path);
  memo?.set(candidate.path, { size: candidate.size, mtimeMs: candidate.mtimeMs, began });
  return began;
}

/**
 * Find the transcript of the Claude Code session tether started in `cwd`.
 *
 * With a known `providerSessionId` this is a single path. Without one, two
 * things decide it, and neither is the file's mtime.
 *
 * **When its own records begin.** `mtime` answers "when did this last flush",
 * which coarse-granularity filesystems round down and which says nothing about
 * whose session the file is. A transcript's records carry ISO timestamps from
 * the provider's clock, so they are immune to both. mtime survives as an
 * ordering hint and as the `STALE_MTIME_MS` pre-filter, neither of which can
 * accept a file the record check would reject.
 *
 * **Whether another session already has it.** `claimed` is the provider session
 * ids the registry has already bound to other rows, and a transcript that is
 * spoken for is not a candidate at any timestamp. Nothing in a clock can settle
 * two sessions started in the same directory seconds apart — both transcripts
 * begin inside the other's `START_SLACK_MS` — so this is what settles it.
 *
 * A candidate with nothing timestamped in its prefix is unverifiable rather than
 * disqualified: it is skipped, and `Conversations`' existing retry loop looks
 * again once more has been flushed — the same path a session with no transcript
 * at all already takes. Erring towards waiting is the point, because the binding
 * is permanent: the registry row is back-filled on the first hit and never
 * re-checked, so adopting a neighbour's transcript would show its conversation
 * under this session's name for good.
 *
 * ponytail: the window left is two sessions started in the same directory within
 * `START_SLACK_MS` of each other while *neither* has been back-filled yet, so
 * neither is claimed and both files qualify on time alone; mtime order picks.
 * PR #10's `SessionStart` hook delivers `transcript_path` outright and retires
 * the guess, and this window with it.
 */
export async function findTranscript(session: {
  cwd: string;
  createdAt: number;
  providerSessionId?: string | null;
  home?: string;
  /** Provider session ids other registry rows already hold. */
  claimed?: ReadonlySet<string>;
  /** Carried between the retry loop's calls; see `StartMemo`. */
  memo?: StartMemo;
}): Promise<FoundTranscript | undefined> {
  // Resolved, because that is what Claude Code sanitises: it canonicalises the
  // directory before naming it, so a symlinked cwd hashes to the real path.
  const cwd = await realpath(session.cwd).catch(() => session.cwd);
  const dir = projectDir(cwd, session.home);

  if (session.providerSessionId != null && session.providerSessionId !== '') {
    const path = join(dir, `${session.providerSessionId}.jsonl`);
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    return exists ? { path, providerSessionId: session.providerSessionId } : undefined;
  }

  const names = await readdir(dir).catch(() => []);
  const candidates: Candidate[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const providerSessionId = name.slice(0, -'.jsonl'.length);
    if (session.claimed?.has(providerSessionId) === true) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) continue;
    if (info.mtimeMs < session.createdAt - STALE_MTIME_MS) continue;
    candidates.push({ path, providerSessionId, mtimeMs: info.mtimeMs, size: info.size });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    const began = await beganAt(candidate, session.memo);
    if (began === undefined) continue;
    if (began < session.createdAt - START_SLACK_MS) continue;
    return { path: candidate.path, providerSessionId: candidate.providerSessionId };
  }
  return undefined;
}
