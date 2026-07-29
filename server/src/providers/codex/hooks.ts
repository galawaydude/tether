/**
 * tether's Codex hook: installing it, removing it, and reading what it wrote.
 *
 * Codex only publishes one thing tether cannot get from a file it already
 * follows — that the session is **waiting for the user** — so this whole module
 * exists to buy one badge. That is the frame for every decision in it.
 *
 * `~/.codex/hooks.json` is a file tether does not own, and Codex trust-gates
 * each entry in it by sha256, so installing means asking the user to accept a
 * security prompt on their own machine. The captain's decision
 * (`tether-codex-spike-decision-codex-hook-trust-install`) is option A — write
 * the entry and let the user accept the prompt once — with obligations that are
 * the reason this module looks the way it does:
 *
 * - **Merge, never overwrite, and back up first.** A hooks.json that is not
 *   valid JSON, or whose shape is not what is expected, is left untouched and
 *   reported; refusing is always better than rewriting a file whose contents
 *   tether did not understand.
 * - **Append, never insert.** Codex keys its trust state by *position* —
 *   `<hooks.json path>:<event>:<group index>:<hook index>` — so adding tether's
 *   group anywhere but the end would renumber the user's existing entries and
 *   silently re-prompt them for hooks they had already trusted.
 * - **Marked, so it can be found and removed.** tether's entry is the only one
 *   whose `command` is the shim path under tether's own state directory, and
 *   `remove` deletes exactly those.
 * - **Declining is a supported configuration.** `status.ts` derives `busy` and
 *   `idle` from the rollout file, which is always there. Nothing here is on the
 *   path of anything else, and nothing anywhere nags.
 *
 * `--dangerously-bypass-hook-trust` is not used, mentioned as a fallback, or
 * documented. It disables a user-facing security control on the user's own
 * machine to save one prompt.
 *
 * Nothing in `providers/` may import from `web/` (report §5).
 */

import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The events tether registers. `PreToolUse`/`PostToolUse` bracket
 * `PermissionRequest` so the badge clears, `SessionStart` carries the
 * `session_id` that back-fills the provisional registry row, and `SessionEnd`
 * says the session is over. Codex offers more (`PreCompact`, `SubagentStart`,
 * `UserPromptSubmit`, …) and tether asks for none of them: every event
 * registered is another thing the user is asked to trust.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SessionEnd',
] as const;

/**
 * Codex clamps a `SessionEnd` hook to 3s and warns on screen when it has to, so
 * this is 3 everywhere: the shim parses one JSON object and appends one line.
 */
const TIMEOUT_SECONDS = 3;

/** The shim tether installs. Its own directory is where the log lands. */
export function hookShimPath(stateDir: string): string {
  return join(stateDir, 'codex-hook.mjs');
}

/** One append-only NDJSON file per Codex session id. */
export function hookLogDir(stateDir: string): string {
  return join(stateDir, 'codex-hooks');
}

export function hookLogPath(stateDir: string, providerSessionId: string): string {
  return join(hookLogDir(stateDir), `${providerSessionId}.ndjson`);
}

export function hooksJsonPath(codexHome: string): string {
  return join(codexHome, 'hooks.json');
}

/**
 * The shim's source.
 *
 * A file with a shebang rather than a shell one-liner, because the join in
 * `SessionStart` depends on it: Codex runs a `command` with no shell
 * metacharacters directly, so the hook process's parent *is* the Codex process,
 * which *is* the tmux pane's pid. Put a `|`, a `>` or a `$` in the `command` and
 * Codex interposes a shell, `process.ppid` becomes that shell, and the pane can
 * no longer be identified.
 *
 * It finds its own log directory relative to itself, so nothing has to be
 * interpolated in and the installed file is the same bytes every time.
 *
 * It cannot fail. A hook that exits non-zero or hangs is a hook that interferes
 * with the user's session, and this one is only there to make a badge live.
 */
const SHIM_SOURCE = `#!/usr/bin/env node
// tether's Codex hook. Installed by \`tether codex-hook install\`, removed by
// \`tether codex-hook remove\`. It appends one JSON line per hook event and does
// nothing else — it never writes to stdout, never blocks and never fails.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const id = String(payload.session_id ?? '');
  // A session id becomes a file name, so it is checked rather than trusted.
  if (/^[A-Za-z0-9._-]+$/.test(id)) {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'codex-hooks');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ ...payload, at: Date.now(), ppid: process.ppid });
    appendFileSync(join(dir, id + '.ndjson'), line + '\\n', { mode: 0o600 });
  }
} catch {
  // Deliberately silent: see above.
}
`;

/** A `hooks.json` that tether will not rewrite, and why. */
export class HooksFileError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`refusing to change ${path}: ${reason}. tether has changed nothing.`);
    this.name = 'HooksFileError';
    this.path = path;
  }
}

type HookHandler = { type: string; command?: string; [key: string]: unknown };
type HookGroup = { matcher?: string; hooks: HookHandler[]; [key: string]: unknown };
type HooksFile = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the file, or say why it will not be touched.
 *
 * A missing file is `{}` — there is nothing to preserve. Anything else that is
 * not the shape below throws: the obligation is to merge, and a merge into a
 * shape tether does not recognise is a rewrite wearing a merge's name.
 */
async function readHooksFile(path: string): Promise<HooksFile> {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new HooksFileError(path, `it could not be read (${error.message})`);
  });
  if (text === undefined) return {};
  if (text.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new HooksFileError(path, `it is not valid JSON (${(error as Error).message})`);
  }
  if (!isObject(parsed)) throw new HooksFileError(path, 'its top level is not an object');
  const hooks = parsed['hooks'];
  if (hooks !== undefined) {
    if (!isObject(hooks)) throw new HooksFileError(path, '`hooks` is not an object');
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups))
        throw new HooksFileError(path, `\`hooks.${event}\` is not an array`);
      for (const group of groups) {
        if (!isObject(group) || !Array.isArray(group['hooks'])) {
          throw new HooksFileError(
            path,
            `an entry under \`hooks.${event}\` is not the expected shape`,
          );
        }
      }
    }
  }
  return parsed as HooksFile;
}

/** Same directory, so the rename is atomic and the mode is the caller's umask. */
async function writeAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.tether-tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

/** tether's own entry: the only one whose command is tether's shim. */
function isOurs(handler: HookHandler, shim: string): boolean {
  return handler.command === shim;
}

export type InstallResult = {
  hooksPath: string;
  shimPath: string;
  /** Where the previous hooks.json was copied, or undefined if there was none. */
  backupPath?: string;
  /** Events tether's entry was added to; empty when it was already on all of them. */
  added: string[];
  /** True when nothing had to change in hooks.json. */
  alreadyInstalled: boolean;
};

/**
 * Write the shim and merge tether's entry into `hooks.json`.
 *
 * Idempotent: a second install re-writes the shim (so an upgrade updates it) and
 * adds nothing to hooks.json. `now` is only for tests, which need a backup name
 * they can predict.
 */
export async function installHook(options: {
  codexHome: string;
  stateDir: string;
  now?: Date;
}): Promise<InstallResult> {
  const path = hooksJsonPath(options.codexHome);
  const shim = hookShimPath(options.stateDir);
  // Read and validate before writing anything at all, so a file tether refuses
  // to touch also leaves no shim behind.
  const file = await readHooksFile(path);
  const existing = await readFile(path, 'utf8').catch(() => undefined);

  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  await writeFile(shim, SHIM_SOURCE, { mode: 0o700 });
  await chmod(shim, 0o700);
  await mkdir(hookLogDir(options.stateDir), { recursive: true, mode: 0o700 });

  const hooks: Record<string, HookGroup[]> = { ...(file.hooks ?? {}) };
  const added: string[] = [];
  for (const event of HOOK_EVENTS) {
    const groups = [...(hooks[event] ?? [])];
    if (groups.some((group) => group.hooks.some((handler) => isOurs(handler, shim)))) continue;
    // Appended, never inserted: Codex's trust state is keyed by group index, and
    // renumbering the user's entries would re-prompt them for hooks they trust.
    groups.push({
      matcher: '',
      hooks: [{ type: 'command', command: shim, timeout: TIMEOUT_SECONDS }],
    });
    hooks[event] = groups;
    added.push(event);
  }

  if (added.length === 0) {
    return { hooksPath: path, shimPath: shim, added, alreadyInstalled: true };
  }

  let backupPath: string | undefined;
  if (existing !== undefined) {
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    backupPath = `${path}.tether-backup-${stamp}`;
    await writeFile(backupPath, existing, { mode: 0o600 });
  }

  await mkdir(options.codexHome, { recursive: true, mode: 0o700 });
  await writeAtomically(path, `${JSON.stringify({ ...file, hooks }, null, 2)}\n`);
  return {
    hooksPath: path,
    shimPath: shim,
    ...(backupPath === undefined ? {} : { backupPath }),
    added,
    alreadyInstalled: false,
  };
}

export type RemoveResult = {
  hooksPath: string;
  /** Events tether's entry was removed from. */
  removed: string[];
};

/**
 * Take tether's entry back out, and nothing else.
 *
 * Every other entry, every other key of the file and the order of what is left
 * are preserved. A group is dropped only when removing tether's handler emptied
 * it, which can only happen to a group tether added — an empty group the user
 * wrote stays empty.
 *
 * The shim and its log are left on disk: they are tether's own files, they are
 * what a user would look at to see what the hook had been recording, and
 * deleting a directory is not something this needs to do to stop the hook.
 */
export async function removeHook(options: {
  codexHome: string;
  stateDir: string;
}): Promise<RemoveResult> {
  const path = hooksJsonPath(options.codexHome);
  const shim = hookShimPath(options.stateDir);
  const file = await readHooksFile(path);
  if (file.hooks === undefined) return { hooksPath: path, removed: [] };

  const hooks: Record<string, HookGroup[]> = {};
  const removed: string[] = [];
  for (const [event, groups] of Object.entries(file.hooks)) {
    const kept: HookGroup[] = [];
    for (const group of groups) {
      const handlers = group.hooks.filter((handler) => !isOurs(handler, shim));
      if (handlers.length === group.hooks.length) {
        kept.push(group);
        continue;
      }
      if (!removed.includes(event)) removed.push(event);
      if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
    }
    hooks[event] = kept;
  }

  if (removed.length === 0) return { hooksPath: path, removed };
  await writeAtomically(path, `${JSON.stringify({ ...file, hooks }, null, 2)}\n`);
  return { hooksPath: path, removed };
}

export type HookStatus = {
  hooksPath: string;
  shimPath: string;
  /** Events tether's entry is registered for. */
  installed: string[];
  /**
   * Whether `config.toml` has `features.hooks = true`. Codex runs no hooks at
   * all without it, and tether does not write to `config.toml`: it is TOML that
   * also holds the trust state, and the user turning the feature on themselves
   * is the same informed act as accepting the prompt.
   */
  featureEnabled: boolean;
};

/** What is actually registered right now, for `tether codex-hook status`. */
export async function hookStatus(options: {
  codexHome: string;
  stateDir: string;
}): Promise<HookStatus> {
  const path = hooksJsonPath(options.codexHome);
  const shim = hookShimPath(options.stateDir);
  const file = await readHooksFile(path).catch(() => ({}) as HooksFile);
  const installed = Object.entries(file.hooks ?? {})
    .filter(([, groups]) => groups.some((g) => g.hooks.some((h) => isOurs(h, shim))))
    .map(([event]) => event);
  return {
    hooksPath: path,
    shimPath: shim,
    installed,
    featureEnabled: await featureEnabled(options.codexHome),
  };
}

/**
 * `features.hooks = true` in `config.toml`.
 *
 * Read with a regexp rather than a TOML parser: this is a yes/no answer used to
 * print an instruction, tether never writes the file, and a dependency for one
 * boolean is a dependency too many. A false negative costs the user one line of
 * advice they did not need.
 */
async function featureEnabled(codexHome: string): Promise<boolean> {
  const text = await readFile(join(codexHome, 'config.toml'), 'utf8').catch(() => '');
  const section = text.split(/^\s*\[features\]\s*$/m)[1];
  if (section === undefined) return false;
  return /^\s*hooks\s*=\s*true\s*$/m.test(section.split(/^\s*\[/m)[0] ?? '');
}

/** One hook record, as the shim wrote it: the payload plus `at` and `ppid`. */
export type HookRecord = Record<string, unknown> & { at?: number; ppid?: number };

/**
 * Every `SessionStart` the hook has recorded, newest first.
 *
 * This is the pane→session join, and it is free: the shim's parent process is
 * Codex itself, which is the tmux pane's process, so `ppid` identifies the pane
 * with no bookkeeping, nothing to go stale after a `SIGKILL` and no pid-reuse
 * window — the pid is observed live, at the moment the hook runs.
 *
 * Reading whole files rather than tailing them: one line each, read once per
 * discovery attempt, only for a session that has no `provider_session_id` yet.
 */
export async function sessionStarts(stateDir: string): Promise<HookRecord[]> {
  const dir = hookLogDir(stateDir);
  const names = await readdir(dir).catch(() => []);
  const found: HookRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.ndjson')) continue;
    const text = await readFile(join(dir, name), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (line.trim() === '' || !line.includes('SessionStart')) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (isObject(record) && record['hook_event_name'] === 'SessionStart') {
          found.push(record as HookRecord);
        }
      } catch {
        // A line the shim was writing when this read landed. It will be whole
        // on the next attempt, and discovery already retries.
      }
    }
  }
  return found.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
