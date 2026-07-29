/**
 * Claude Code's own live session registry: `~/.claude/sessions/<pid>.json`.
 *
 * Claude Code writes one of these per top-level session for its own concurrency
 * bookkeeping, and its `status` takes exactly the three values tether's badge
 * needs — `idle`, `busy`, and `waiting` while a permission dialog is up (report
 * §4e). The file is named by the provider process's pid, which *is* the tmux
 * `pane_pid`, so the join from a tmux pane to a session costs nothing and there
 * is no bookkeeping to keep in step.
 *
 * The whole of the difficulty is that **the file outlives the process**. It is
 * deleted on a graceful exit, but a `SIGKILL`, an OOM kill or a reboot leaves it
 * behind, and pids are reused — so a stale file plus an unlucky pid means
 * reporting some unrelated process's shell as a busy agent. Two guards, and
 * neither is optional:
 *
 * 1. **Liveness** — `kill(pid, 0)`, which is what Claude Code's own
 *    `isProcessRunning` does.
 * 2. **Identity** — `procStart`, which Claude Code records for exactly this
 *    reason. It is the kernel's own start time for that pid, so a recycled pid
 *    has a different one and is rejected. Verified on 2.1.220: the value is
 *    `/proc/<pid>/stat` field 22 (`starttime`, in clock ticks since boot) as a
 *    decimal string.
 *
 * Anything unreadable, unrecognised or unverifiable is `undefined` — "tether
 * cannot say" — never a guess. The caller shows no badge rather than a wrong
 * one, which matters more here than anywhere else in the conversation view: a
 * session wrongly reported `waiting` is a phone notification that should not
 * have fired.
 */

import type { SessionState } from '@tether/shared';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The three values Claude Code publishes, and the three the badge renders. */
const STATES = new Set<string>(['busy', 'idle', 'waiting']);

export function sessionsDir(home = homedir()): string {
  return join(home, '.claude', 'sessions');
}

export function sessionStatusPath(pid: number, home = homedir()): string {
  return join(sessionsDir(home), `${pid}.json`);
}

/**
 * The kernel's start time for a pid, as Claude Code records it in `procStart`.
 *
 * `/proc/<pid>/stat` field 2 is the executable name in parentheses and may
 * itself contain spaces *and* a `)`, so the fields after it are found from the
 * **last** `") "` rather than by splitting on whitespace. Field 22 overall is
 * the 20th of what follows.
 *
 * `undefined` where there is no procfs — this is a Linux-shaped check, and a
 * platform without it falls back to liveness alone rather than to trusting a
 * pid it cannot verify.
 */
async function procStart(pid: number): Promise<string | undefined> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
  if (stat === undefined) return undefined;
  const after = stat.slice(stat.lastIndexOf(') ') + 2);
  return after.split(' ')[19];
}

/** Whether the pid exists at all. `EPERM` is someone else's process, so: yes. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * What the session on `pid` is doing, or `undefined` if that cannot be
 * established. Never throws: it is called once a second per live session.
 *
 * `expectSessionId` is the registry row's `provider_session_id` where tether
 * has one. It is the last guard — a pid that is alive, whose start time matches
 * and whose file names a *different* session is not this session's status.
 */
export async function readSessionStatus(
  pid: number,
  options: { home?: string; expectSessionId?: string | null } = {},
): Promise<SessionState | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;

  const text = await readFile(sessionStatusPath(pid, options.home ?? homedir()), 'utf8').catch(
    () => undefined,
  );
  if (text === undefined) return undefined;

  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    // A file being rewritten as this read landed. The next tick gets it whole.
    return undefined;
  }
  if (typeof record !== 'object' || record === null) return undefined;
  const fields = record as Record<string, unknown>;

  // The file is named by pid, so a file whose contents disagree is not one
  // tether understands — the shape has moved, and guessing is how a wrong badge
  // gets shown.
  if (fields['pid'] !== pid) return undefined;

  const expected = options.expectSessionId;
  if (expected != null && fields['sessionId'] !== expected) return undefined;

  const state = fields['status'];
  if (typeof state !== 'string' || !STATES.has(state)) return undefined;

  // Liveness and identity last: they cost a syscall and a small read, and every
  // check above is cheaper. Both must pass — a live pid alone proves nothing
  // once pids are reused, which is the failure this file is most prone to.
  if (!alive(pid)) return undefined;
  const started = await procStart(pid);
  if (started !== undefined && fields['procStart'] !== started) return undefined;

  return state as SessionState;
}
