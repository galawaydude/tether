/**
 * Claude Code's transcript file: where it is, and how to follow it.
 *
 * Claude Code appends NDJSON to `~/.claude/projects/<sanitised cwd>/<session
 * uuid>.jsonl`, flushed on a timer — so a read lands mid-write routinely and a
 * trailing partial line is normal, not an error. This module tracks a byte
 * offset and only ever reads forward from it; it never re-reads the file to find
 * what is new.
 *
 * Two rules here are easy to remove by accident:
 *
 * - **The carry is bytes, not a string.** A flush can split a multi-byte UTF-8
 *   glyph across two reads, and decoding each read separately corrupts it
 *   silently. Only complete lines are decoded.
 * - **`fs.watch` is the fast path, not the mechanism.** It is unreliable on
 *   network and container filesystems and silently delivers nothing, so a stat
 *   poll runs alongside it. Losing the watcher costs latency; losing the poll
 *   costs the conversation.
 *
 * Nothing in `providers/` may import from `web/` (report §5).
 */

import { watch } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The version this module's fixtures were captured from. See `fixtures/`. */
export const CAPTURED_VERSION = '2.1.220';

/** How often the fallback poll asks the filesystem what it already told us. */
export const DEFAULT_POLL_MS = 1000;

/**
 * How much before its session's `createdAt` a transcript's own first record may
 * be stamped and still belong to that session. The registry row is stamped after
 * tmux has already started the provider, so the provider can legitimately write
 * its first record a few milliseconds earlier.
 *
 * Generous where a tolerance against mtime had to be stingy, and safe for the
 * reason that one was not: this is measured against the moment the file *began*,
 * not the moment it was last touched. An unrelated session's transcript began
 * minutes or hours ago and no plausible tolerance here admits it, whereas its
 * mtime is whenever it last flushed — which can be a moment ago.
 */
const START_SLACK_MS = 10_000;

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

type Candidate = FoundTranscript & { mtimeMs: number };

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
 * Find the transcript of the Claude Code session tether started in `cwd`.
 *
 * With a known `providerSessionId` this is a single path. Without one, the
 * transcript is identified by **when its own records begin**, not by when the
 * file was last written: `mtime` answers "when did this last flush", which is
 * rounded down by coarse-granularity filesystems and says nothing about whose
 * session the file is. A transcript's records carry ISO timestamps from the
 * provider's clock, so they are immune to both. mtime survives only as an
 * ordering hint — candidates are considered newest first, so the ordinary case
 * reads exactly one file.
 *
 * A candidate with nothing timestamped in its prefix is unverifiable rather than
 * disqualified: it is skipped, and `Conversations`' existing retry loop looks
 * again once more has been flushed — the same path a session with no transcript
 * at all already takes. Erring towards waiting is the point, because the binding
 * is permanent: the registry row is back-filled on the first hit and never
 * re-checked, so adopting a neighbouring session's transcript would show its
 * conversation under this session's name for good.
 *
 * ponytail: PR #10's `SessionStart` hook delivers `transcript_path` outright and
 * retires the guess entirely.
 */
export async function findTranscript(session: {
  cwd: string;
  createdAt: number;
  providerSessionId?: string | null;
  home?: string;
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
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) continue;
    candidates.push({
      path,
      providerSessionId: name.slice(0, -'.jsonl'.length),
      mtimeMs: info.mtimeMs,
    });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    const began = await startedAt(candidate.path);
    if (began === undefined) continue;
    if (began < session.createdAt - START_SLACK_MS) continue;
    return { path: candidate.path, providerSessionId: candidate.providerSessionId };
  }
  return undefined;
}

export type Tail = { stop: () => Promise<void> };

export type TailOptions = {
  pollMs?: number;
  /** Anything that went wrong while reading. Never thrown at the caller. */
  onError?: (error: unknown) => void;
};

/**
 * Follow `path`, delivering complete lines as they are appended.
 *
 * Resolves once the file has been read to its current end, so a caller can
 * finish catching up before it starts fanning anything out. The initial read is
 * the same code path as every later one — there is no "load then tail" split to
 * disagree with itself.
 */
export async function tailLines(
  path: string,
  onLines: (lines: string[]) => void,
  options: TailOptions = {},
): Promise<Tail> {
  const handle = await open(path, 'r');
  const onError = options.onError ?? (() => {});
  let offset = 0;
  /** The bytes after the last newline: an incomplete line, held until it is not. */
  let carry = Buffer.alloc(0);
  let reading = false;
  let closed = false;

  async function read(): Promise<void> {
    if (reading || closed) return;
    reading = true;
    try {
      for (;;) {
        const { size } = await handle.stat();
        // `stop()` waits for an in-flight operation to settle before it closes
        // the handle, so without this the loop resumes onto a closed one and
        // reports an EBADF that means nothing but "the viewer left".
        if (closed) return;
        if (size < offset) {
          // The file shrank, so it is not the one we were reading. Claude Code
          // appends and never rewrites, so this is a replaced file; start over
          // rather than decode a new file at an old offset.
          offset = 0;
          carry = Buffer.alloc(0);
        }
        if (size <= offset) return;

        const buffer = Buffer.allocUnsafe(size - offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (closed) return;
        if (bytesRead === 0) return;
        offset += bytesRead;

        const data = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
        const lines: string[] = [];
        let start = 0;
        for (;;) {
          const end = data.indexOf(0x0a, start);
          if (end === -1) break;
          lines.push(data.subarray(start, end).toString('utf8'));
          start = end + 1;
        }
        carry = Buffer.from(data.subarray(start));
        if (lines.length > 0) onLines(lines);
      }
    } finally {
      reading = false;
    }
  }

  const poke = () => void read().catch(onError);
  await read();

  // Best effort: some filesystems refuse to watch, and the poll below is what
  // makes that survivable rather than fatal.
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(path, poke);
    watcher.on('error', onError);
  } catch (error) {
    onError(error);
  }

  const timer = setInterval(poke, options.pollMs ?? DEFAULT_POLL_MS);
  timer.unref();

  return {
    stop: async () => {
      closed = true;
      clearInterval(timer);
      watcher?.close();
      await handle.close().catch(() => {});
    },
  };
}
