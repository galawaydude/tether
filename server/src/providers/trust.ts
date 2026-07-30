/**
 * Whether the agent already trusts a directory — the shared half of asking
 * before the agent is started.
 *
 * The first session in any directory otherwise meets the agent's own *"do you
 * trust this folder?"* prompt inside the terminal, which is the kind of moment
 * the single-interface plan exists to remove. So tether asks the question itself,
 * in the New session sheet, and records the answer where the agent will honour
 * it — **it does not mirror the agent's dialog**, which would mean parsing the
 * terminal (report §4c, rejected).
 *
 * ## What is shared and what is not
 *
 * This module is the tri-state, the git resolution both providers happen to
 * perform, and the one write primitive. Where each provider stores its answer,
 * and in what format, is per provider and lives in each provider's own
 * `trust.ts`; the switch between them is beside the other two in
 * `machine/sessions.ts`. The two are not variants of one scheme, and every fact
 * below was established by running the installed CLIs rather than read off a
 * document:
 *
 * | | Claude Code 2.1.220 | codex-cli 0.145.0 |
 * | --- | --- | --- |
 * | file | `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json` | `$CODEX_HOME/config.toml` |
 * | shape | `projects["<dir>"].hasTrustDialogAccepted` | `[projects."<dir>"] trust_level` |
 * | matches | the directory, **any path ancestor**, or the main repo root | the main repo root **only**, exactly |
 *
 * `unknown` is a first-class answer and never a guess. A configuration file that
 * exists and cannot be read or understood means tether says it cannot tell,
 * because the alternatives are both worse than admitting it: claiming *trusted*
 * hides the question, and claiming *untrusted* offers to write into a file tether
 * has just failed to understand. An **absent** file is not that case — nothing is
 * trusted, which is `untrusted` and perfectly determinable.
 *
 * ## The one rule with no exceptions
 *
 * **A folder is trusted only because the user said so.** No write happens without
 * an explicit affirmative answer carried on the create request, and declining
 * writes nothing at all — not an `untrusted` entry, not a marker. Silently
 * pre-trusting to smooth the flow would be worse than leaving the prompt in the
 * terminal.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { dirname, parse } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// The tri-state and the report are the wire shape, so they are declared once in
// `shared/` and re-exported here for the modules that only ever see this one.
export type { FolderTrust, TrustReport } from '@tether/shared';

/** Where each provider keeps its answer. Defaults are the real locations; tests pass their own. */
export type TrustLocations = {
  /** Claude Code's `.claude.json`. */
  claudeConfigPath?: string | undefined;
  /** Codex's `$CODEX_HOME`. */
  codexHome?: string | undefined;
  /** Where a copy of the file goes before tether writes to it. Defaults to `stateDir()`. */
  stateDir?: string | undefined;
};

/** What a write reports: the key it wrote, and the copy it took first. */
export type TrustWrite = { path: string; backupPath?: string };

/**
 * A file tether will not, or could not, write — said in a sentence the user can
 * act on.
 *
 * Recording trust is not best-effort the way installing a hook is. A hook that
 * fails to install costs a badge; a trust write that fails silently drops the
 * user into the terminal prompt they had just answered to avoid, with nothing
 * left to tell them with. So this reaches the create route and the session is not
 * started at all.
 */
export class FolderTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FolderTrustError';
  }
}

/**
 * The **main** repository root, from anywhere inside a repository — the parent of
 * the common git directory, not `--show-toplevel`.
 *
 * That distinction is the whole reason this is not one line at each call site,
 * and it was found by running both agents from a linked worktree: neither asked,
 * although the worktree's own path was in no configuration file. Both resolve a
 * worktree back to the repository it belongs to, so `--show-toplevel` (which
 * answers with the worktree) would have tether writing an entry the agent then
 * ignores — and worktrees are exactly where this product gets used.
 *
 * `undefined` for anything not in a repository, and for a machine with no `git`:
 * the caller then keys on the directory itself, which is what both agents do.
 */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  try {
    // `--path-format=absolute` because `--git-common-dir` is otherwise answered
    // relative to the cwd (`.git`), whose dirname is the empty string.
    const { stdout } = await run(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8' },
    );
    const dir = stdout.trim();
    return dir === '' ? undefined : dirname(dir);
  } catch {
    return undefined;
  }
}

/** A directory and every path ancestor of it, nearest first. */
export function selfAndAncestors(dir: string): string[] {
  const chain: string[] = [];
  const { root } = parse(dir);
  for (let at = dir; ; at = dirname(at)) {
    chain.push(at);
    if (at === root || dirname(at) === at) break;
  }
  return chain;
}

/**
 * Same directory, so the rename is atomic, and a unique temporary name so two
 * creates at once cannot interleave into one scratch file.
 *
 * Both files this is used on are read by a *running* agent — Claude Code rewrites
 * `.claude.json` throughout a session — so a half-written one is a parse error in
 * somebody's live session rather than a problem tether gets to see.
 */
export async function writeAtomically(path: string, text: string, mode: number): Promise<void> {
  const temporary = `${path}.tether-tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(temporary, text, { mode });
  await rename(temporary, path);
}

/** `2026-07-30T12-00-00-000Z`, for a backup name that sorts. */
export function backupStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}
