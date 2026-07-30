/**
 * Where Claude Code records that a folder is trusted, and how to read it.
 *
 * `$CLAUDE_CONFIG_DIR/.claude.json` (else `~/.claude.json`), under
 * `projects["<dir>"].hasTrustDialogAccepted`. All of it verified against Claude
 * Code 2.1.220 by running it under a scratch `HOME` and reading the pane:
 *
 * - **An ancestor counts.** A session in `a/b/c` finds nothing prompted when `a`
 *   is accepted, and `a/b/c`'s own entry stays `false`. So the read walks the
 *   directory and its path ancestors, and an exact-path check — the obvious
 *   implementation — would report *untrusted* for a directory Claude Code is
 *   perfectly happy in and put a question in front of the user that its own CLI
 *   would not have asked.
 * - **The main repository root counts too**, from inside a linked worktree,
 *   whose own path appears in no configuration file. Only the root itself: a
 *   worktree of a repository whose *parent* is accepted still prompts.
 * - **Accepting writes one field.** The dialog leaves a full entry behind, but a
 *   hand-written `{"hasTrustDialogAccepted": true}` suppresses the prompt on its
 *   own, so the merge below adds that field and nothing else.
 * - **Declining writes nothing** — it exits. Neither does tether.
 *
 * The file is Claude Code's, not tether's, and a *running* Claude Code rewrites
 * it throughout a session. So: read, merge one field, write atomically, and back
 * it up first. Every other key, every other project, and the file's own 2-space
 * formatting come out as they went in.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { FolderTrust } from '@tether/shared';

import { stateDir as defaultStateDir } from '../../db.ts';
import {
  FolderTrustError,
  type TrustLocations,
  type TrustWrite,
  backupStamp,
  selfAndAncestors,
  writeAtomically,
} from '../trust.ts';

/**
 * `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`.
 *
 * Verified rather than assumed: with `CLAUDE_CONFIG_DIR` set, a trust entry in
 * *that* directory's `.claude.json` is honoured and `$HOME/.claude.json` is not
 * consulted at all. The state directory moves with it; the config file is the
 * part that matters here.
 */
export function claudeConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env['CLAUDE_CONFIG_DIR'];
  const dir = configured !== undefined && configured.trim() !== '' ? configured : home;
  return join(dir, '.claude.json');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A read that keeps the exact bytes, so a backup is what the merge was computed from. */
async function readConfig(
  path: string,
): Promise<{ file: Record<string, unknown>; text: string | undefined; why?: string }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    // Absent is not undeterminable: there is nothing trusted, which is an answer.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file: {}, text: undefined };
    return { file: {}, text: undefined, why: `it could not be read (${(error as Error).message})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { file: {}, text, why: `it is not valid JSON (${(error as Error).message})` };
  }
  if (!isObject(parsed)) return { file: {}, text, why: 'its top level is not an object' };
  if (parsed['projects'] !== undefined && !isObject(parsed['projects'])) {
    return { file: {}, text, why: '`projects` is not an object' };
  }
  return { file: parsed, text };
}

/**
 * Is `cwd` trusted? `repoRoot` is the main repository root when there is one —
 * the caller resolves it once for both providers.
 */
export async function readTrust(
  cwd: string,
  repoRoot: string | undefined,
  configPath: string = claudeConfigPath(),
): Promise<FolderTrust> {
  const { file, why } = await readConfig(configPath);
  if (why !== undefined) return 'unknown';
  const projects = (file['projects'] ?? {}) as Record<string, unknown>;
  const candidates = selfAndAncestors(cwd);
  // Exactly the root, not its ancestors: verified above.
  if (repoRoot !== undefined) candidates.push(repoRoot);
  for (const dir of candidates) {
    const entry = projects[dir];
    if (isObject(entry) && entry['hasTrustDialogAccepted'] === true) return 'trusted';
  }
  return 'untrusted';
}

/**
 * Where `.claude.json` is copied before tether merges into it. Under tether's own
 * state directory, never beside the original — the same rule as the settings
 * backups, and here the original sits in the user's home rather than a repository.
 */
export function configBackupPath(stateDir: string, stamp: string): string {
  return join(stateDir, 'claude-config-backups', `claude-${stamp}.json`);
}

/**
 * Record that the user trusts `cwd`.
 *
 * The directory itself, never the repository root: the read walks ancestors, so
 * the cwd is the smallest entry that answers the question, and an entry on the
 * root would trust every other directory in the repository too — more than was
 * asked for, in a file tether does not own.
 *
 * Idempotent, and it refuses rather than repairs: a config file tether cannot
 * parse, or whose entry for this directory is not an object, is left completely
 * alone and reported. `now` is only for tests, which need a predictable backup name.
 */
export async function writeTrust(
  cwd: string,
  where: TrustLocations & { now?: Date } = {},
): Promise<TrustWrite> {
  const path = where.claudeConfigPath ?? claudeConfigPath();
  const { file, text, why } = await readConfig(path);
  if (why !== undefined) {
    throw new FolderTrustError(`tether will not rewrite ${path}: ${why}`);
  }

  const projects = { ...((file['projects'] ?? {}) as Record<string, unknown>) };
  const entry = projects[cwd];
  if (entry !== undefined && !isObject(entry)) {
    throw new FolderTrustError(
      `tether will not rewrite ${path}: its entry for ${cwd} is not an object`,
    );
  }
  if (isObject(entry) && entry['hasTrustDialogAccepted'] === true) {
    // Already there. Nothing is written and nothing is backed up: this file is
    // rewritten by a running Claude Code, and a no-op write is a chance to lose
    // whatever it wrote between this read and this write, for no gain.
    return { path: cwd };
  }

  let backupPath: string | undefined;
  if (text !== undefined) {
    backupPath = configBackupPath(where.stateDir ?? defaultStateDir(), backupStamp(where.now));
    await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeAtomically(backupPath, text, 0o600);
  }

  const merged = {
    ...file,
    projects: { ...projects, [cwd]: { ...(entry ?? {}), hasTrustDialogAccepted: true } },
  };
  // 2-space indent is what Claude Code itself writes, and the trailing newline is
  // matched rather than imposed: this is the user's file and a reformat of all
  // 90-odd kilobytes of it is not tether's to make.
  const tail = text === undefined || text.endsWith('\n') ? '\n' : '';
  await writeAtomically(path, `${JSON.stringify(merged, null, 2)}${tail}`, 0o600);
  return { path: cwd, ...(backupPath === undefined ? {} : { backupPath }) };
}
