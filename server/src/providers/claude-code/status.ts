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
 *    has a different one and is rejected. Verified on 2.1.220: Linux uses
 *    `/proc/<pid>/stat` field 22 (`starttime`); macOS uses UTC `ps -o lstart=`.
 *
 * Anything unreadable, unrecognised or unverifiable is `undefined` — "tether
 * cannot say" — never a guess. The caller shows no badge rather than a wrong
 * one, which matters more here than anywhere else in the conversation view: a
 * session wrongly reported `waiting` is a phone notification that should not
 * have fired.
 */

import type { SessionState } from '@tether/shared';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
 * On macOS Claude Code records the UTC rendering of `ps -o lstart=` instead —
 * verified against 2.1.220 on an Apple Silicon Mac. Falling back to liveness
 * alone there silently removes the pid-reuse guard from every Mac session, so
 * both forms are read here and nowhere else.
 *
 * `undefined` on a platform whose process identity Claude Code has not been
 * observed to publish. That platform falls back to liveness alone rather than
 * comparing against a value tether invented.
 */
export async function processStart(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => undefined);
    if (stat === undefined) return undefined;
    const after = stat.slice(stat.lastIndexOf(') ') + 2);
    return after.split(' ')[19];
  }
  if (process.platform === 'darwin') {
    const result = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
      // Claude Code's value is UTC even when the Mac is not. `C` also keeps the
      // weekday/month words stable under a non-English login locale.
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).catch(() => undefined);
    const started = result?.stdout.trim();
    return started === undefined || started === '' ? undefined : started;
  }
  return undefined;
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
 * The record for `pid`, once it has passed every guard, or `undefined` where it
 * cannot be believed. Both readers below go through here, so the liveness and
 * pid-reuse checks are asked in one place rather than once per question.
 *
 * Never throws: it is called once a second per live session.
 */
async function readRecord(pid: number, home: string): Promise<Record<string, unknown> | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;

  const text = await readFile(sessionStatusPath(pid, home), 'utf8').catch(() => undefined);
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

  // Both must pass — a live pid alone proves nothing once pids are reused,
  // which is the failure this file is most prone to.
  if (!alive(pid)) return undefined;
  const started = await processStart(pid);
  if (started !== undefined && fields['procStart'] !== started) return undefined;

  return fields;
}

/**
 * Both facts the file carries about `pid`, from **one** read: which session it is
 * running and what that session is doing.
 *
 * One snapshot rather than two, because the two are read together and a
 * `/resume` rewrites both at once — a status taken from a later read than the id
 * it is filed under is a status filed under the wrong session.
 *
 * Either field is absent where the file does not carry it in a shape this build
 * recognises; the whole result is `undefined` where the file cannot be believed
 * at all.
 */
export async function readSession(
  pid: number,
  options: { home?: string } = {},
): Promise<{ sessionId?: string; state?: SessionState } | undefined> {
  const fields = await readRecord(pid, options.home ?? homedir());
  if (fields === undefined) return undefined;
  const sessionId = fields['sessionId'];
  const state = fields['status'];
  return {
    ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
    ...(typeof state === 'string' && STATES.has(state) ? { state: state as SessionState } : {}),
  };
}

/**
 * Which session Claude Code says is running on `pid` — the same guards asked the
 * other way round, and the only evidence tether has about *which process* a hook
 * payload came from. A hook carries a `cwd`, and a `cwd` is not proof: an agent
 * a user started by hand in a directory tether once managed posts the same one,
 * and two tether sessions started in one directory post it identically.
 */
export async function readSessionId(
  pid: number,
  options: { home?: string } = {},
): Promise<string | undefined> {
  return (await readSession(pid, options))?.sessionId;
}
