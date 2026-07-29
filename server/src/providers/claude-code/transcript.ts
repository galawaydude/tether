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

/**
 * Find the transcript of the Claude Code session tether started in `cwd`.
 *
 * With a known `providerSessionId` this is a single path. Without one it is the
 * newest transcript in the project directory that was written after tether
 * created the session — the file's own name *is* the provider's session id, so
 * finding it back-fills the registry row and the guess is made once.
 *
 * ponytail: two Claude Code sessions started in the same directory within the
 * same instant would be told apart only by mtime, and the newest wins. PR #10's
 * `SessionStart` hook delivers `transcript_path` outright and retires the guess.
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
  let best: (FoundTranscript & { mtimeMs: number }) | undefined;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || info.mtimeMs < session.createdAt) continue;
    if (best !== undefined && info.mtimeMs <= best.mtimeMs) continue;
    best = { path, providerSessionId: name.slice(0, -'.jsonl'.length), mtimeMs: info.mtimeMs };
  }
  return best === undefined
    ? undefined
    : { path: best.path, providerSessionId: best.providerSessionId };
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
