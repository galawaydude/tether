/**
 * Following an append-only file from a byte offset.
 *
 * Both providers store their conversation the same way — Claude Code appends
 * NDJSON to `~/.claude/projects/…/<uuid>.jsonl`, Codex to
 * `$CODEX_HOME/sessions/…/rollout-*.jsonl` — so this is the one piece of
 * provider code that genuinely is shared. It lives here rather than in either
 * provider directory precisely so neither has to import from the other.
 *
 * It knows nothing about records: it delivers complete lines and nothing else.
 * The two rules below are easy to remove by accident, and the spike that added
 * the second provider re-confirmed both against a live Codex session.
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
import { open } from 'node:fs/promises';

/** How often the fallback poll asks the filesystem what it already told us. */
export const DEFAULT_POLL_MS = 1000;

export type Tail = {
  stop: () => Promise<void>;
  /**
   * Read to the file's current end and deliver it, now, rather than when the
   * watch or the poll next fires.
   *
   * The one caller that needs it is the Codex permission hook: the hook process
   * has already appended its own line and is blocked on tether's reply, and the
   * `PreToolUse` it has to be correlated to was appended by an earlier,
   * completed run of the same shim. Both are certainly on disk, so awaiting a
   * read here turns that correlation from a race with the watcher into a fact.
   * Nothing else should reach for it: latency is what the fast path is for.
   */
  catchUp: () => Promise<void>;
};

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
  let closed = false;

  async function readToEnd(): Promise<void> {
    if (closed) return;
    for (;;) {
      const { size } = await handle.stat();
      // `stop()` waits for an in-flight operation to settle before it closes
      // the handle, so without this the loop resumes onto a closed one and
      // reports an EBADF that means nothing but "the viewer left".
      if (closed) return;
      if (size < offset) {
        // The file shrank, so it is not the one we were reading. Both
        // providers append and never rewrite, so this is a replaced file;
        // start over rather than decode a new file at an old offset.
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
  }

  /**
   * Reads are serialised through one chain rather than dropped while another is
   * in flight. Dropping is what a `reading` flag does, and it is nearly right —
   * the loop above would have picked the new bytes up anyway — but it makes
   * `await read()` mean "a read happened" instead of "the file has been read to
   * its end", which is precisely what {@link Tail.catchUp} promises.
   */
  let chain: Promise<void> = Promise.resolve();

  function read(): Promise<void> {
    const next = chain.then(readToEnd, readToEnd);
    chain = next.catch(() => {});
    return next;
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
      // After the in-flight read, or the loop resumes onto a closed handle.
      await chain;
      await handle.close().catch(() => {});
    },
    catchUp: async () => {
      await read().catch(onError);
    },
  };
}
