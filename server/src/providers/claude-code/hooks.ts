/**
 * tether's Claude Code hook: installing it, and the shim that delivers it.
 *
 * The hook buys the one thing the transcript cannot give in time. Claude Code
 * does not write a tool call to its transcript until the turn commits, so during
 * a permission prompt — the moment a user reaches for their phone — a
 * transcript-only view shows nothing at all (report §4, risk 2). `PreToolUse`
 * fires *before* the prompt with the full `tool_name` and `tool_input`, and
 * `Notification` fires with "Claude needs your permission". That is the gap,
 * closed by two events.
 *
 * ## Why this looks nothing like the Codex hook
 *
 * `providers/codex/hooks.ts` writes one entry into a *global*, trust-gated
 * `~/.codex/hooks.json` and its shim appends to a log file tether tails. None of
 * that transfers, and the differences are structural rather than cosmetic
 * (report §4), so the two stay separate rather than sharing an abstraction
 * invented from two examples:
 *
 * - **Where it goes.** Claude Code reads `<cwd>/.claude/settings.local.json`,
 *   which is inside the *user's own repository*, and it is installed per project
 *   at spawn rather than once per machine.
 * - **No trust gate.** Claude Code runs what the settings file says, so there is
 *   no prompt to respect and no reason to ask the user for anything.
 * - **HTTP, not a file.** A `PreToolUse` hook can *answer* the permission prompt
 *   by writing a decision on stdout, and that needs a request/response channel.
 *   Answering is PR #14 and deliberately not here — but a log file could never
 *   grow into it, so the transport is chosen now. This shim reads the response
 *   and ignores it; that is the clean room.
 *
 * ## The secret
 *
 * `settings.local.json` lives in the user's repo, so a token written into it is
 * one `git add` away from being published (report §7). The secret is therefore a
 * `0600` file in tether's own state directory, **read by the shim at hook
 * execution time**, and what goes in the settings file is only a path. Same rule
 * for the endpoint URL, which also means a session spawned under one
 * `tether serve` reaches the next one on a different port.
 *
 * The secret is per *installation*, not per session: Claude Code generates its
 * own session id and tether does not know it until the session speaks, so there
 * is nothing to key a per-session secret by at install time. It costs nothing —
 * every such file would be one mode and one owner, so a reader of one is a
 * reader of all. Per-session *authorisation* is real and lives at the endpoint:
 * a payload is accepted only for a session tether has a live row for.
 *
 * Nothing in `providers/` may import from `web/` (report §5).
 */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The two events tether registers, and no more. Every hook installed in someone
 * else's repository is a thing they did not ask for, and the transcript already
 * carries everything else — `PostToolUse` and `Stop` would only re-report what
 * arrives moments later by the honest route.
 */
export const HOOK_EVENTS = ['PreToolUse', 'Notification'] as const;

/**
 * Claude Code kills a hook that outlives its timeout. This one does a loopback
 * POST, so it is generous already: the only way to spend it is a server that is
 * gone, and the shim's own abort fires first.
 */
const TIMEOUT_SECONDS = 5;

/** The shim's own abort, comfortably inside `TIMEOUT_SECONDS`. */
const FETCH_TIMEOUT_MS = 3000;

export function hookShimPath(stateDir: string): string {
  return join(stateDir, 'claude-hook.mjs');
}

/** `0600`, never in the repo, and read at hook execution time — not embedded. */
export function hookSecretPath(stateDir: string): string {
  return join(stateDir, 'claude-hook.secret');
}

/** Written after `listen`, so it names a port that is actually bound. */
export function hookEndpointPath(stateDir: string): string {
  return join(stateDir, 'claude-hook.endpoint');
}

export function settingsPath(cwd: string): string {
  return join(cwd, '.claude', 'settings.local.json');
}

/**
 * The shim's source.
 *
 * It finds the secret and the endpoint beside itself, so nothing is interpolated
 * in and the installed file is the same bytes every time — which is also what
 * makes `isOurs` a path comparison.
 *
 * It cannot fail and it cannot speak. A hook that exits non-zero, hangs, or
 * writes to stdout interferes with the user's own session, and a *stdout* write
 * is the loud one: on `PreToolUse` that channel is how a hook allows or denies
 * the call. Answering the prompt is PR #14's, and until then this must say
 * nothing at all — so it never writes stdout and always exits 0, including when
 * tether is not running.
 */
const SHIM_SOURCE = `#!/usr/bin/env node
// tether's Claude Code hook. Installed into a project's .claude/settings.local.json
// by tether when it starts a session there. It POSTs one hook payload to tether
// over loopback and does nothing else — it never writes to stdout, so it never
// allows or denies a tool call, and it never fails.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8').trim();

try {
  const payload = readFileSync(0, 'utf8');
  // Both beside the shim, both read now rather than baked in at install time:
  // the secret must never be written into the user's repo, and the endpoint
  // changes whenever tether is restarted on another port.
  const secret = read('claude-hook.secret');
  const endpoint = read('claude-hook.endpoint');
  await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tether-hook': secret },
    body: payload,
    signal: AbortSignal.timeout(${FETCH_TIMEOUT_MS}),
  });
} catch {
  // Deliberately silent: tether not running, or not listening yet, is a normal
  // state and must cost the user's session nothing.
}
`;

/** A settings file tether will not rewrite, and why. */
export class SettingsFileError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`refusing to change ${path}: ${reason}. tether has changed nothing.`);
    this.name = 'SettingsFileError';
    this.path = path;
  }
}

type HookHandler = { type?: string; command?: string; [key: string]: unknown };
type HookGroup = { matcher?: string; hooks: HookHandler[]; [key: string]: unknown };
type SettingsFile = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the settings file, or say why it will not be touched.
 *
 * A missing or empty file is `{}`. Anything else that is not the shape below
 * throws: this file belongs to the user and holds their own permissions and
 * hooks, so a merge into a shape tether does not recognise is a rewrite wearing
 * a merge's name. The caller treats a refusal as "no accelerator", not "no
 * session".
 */
async function readSettings(path: string): Promise<SettingsFile> {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new SettingsFileError(path, `it could not be read (${error.message})`);
  });
  if (text === undefined || text.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SettingsFileError(path, `it is not valid JSON (${(error as Error).message})`);
  }
  if (!isObject(parsed)) throw new SettingsFileError(path, 'its top level is not an object');
  const hooks = parsed['hooks'];
  if (hooks !== undefined) {
    if (!isObject(hooks)) throw new SettingsFileError(path, '`hooks` is not an object');
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) {
        throw new SettingsFileError(path, `\`hooks.${event}\` is not an array`);
      }
      for (const group of groups) {
        if (!isObject(group) || !Array.isArray(group['hooks'])) {
          throw new SettingsFileError(path, `an entry under \`hooks.${event}\` is not the expected shape`);
        }
      }
    }
  }
  return parsed as SettingsFile;
}

/** Same directory, so the rename is atomic. */
async function writeAtomically(path: string, text: string, mode: number): Promise<void> {
  const temporary = `${path}.tether-tmp`;
  await writeFile(temporary, text, { mode });
  await rename(temporary, path);
}

/** tether's own entry: the only one whose command is tether's shim. */
function isOurs(handler: HookHandler, shim: string): boolean {
  return handler.command === shim;
}

/**
 * The shared secret, created on first use.
 *
 * Written `0600` inside tether's own `0700` state directory, and returned so the
 * endpoint can compare against it. Regenerating it would silently break every
 * shim already installed in every project, so an existing one is kept.
 */
export async function ensureHookSecret(stateDir: string): Promise<string> {
  const path = hookSecretPath(stateDir);
  const existing = await readFile(path, 'utf8').catch(() => undefined);
  if (existing !== undefined && existing.trim() !== '') return existing.trim();

  const secret = randomBytes(32).toString('base64url');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeAtomically(path, `${secret}\n`, 0o600);
  await chmod(path, 0o600);
  return secret;
}

/** What the endpoint compares against, without creating one if there is none. */
export async function readHookSecret(stateDir: string): Promise<string | undefined> {
  const text = await readFile(hookSecretPath(stateDir), 'utf8').catch(() => undefined);
  const secret = text?.trim();
  return secret === undefined || secret === '' ? undefined : secret;
}

/**
 * Tell the shim where to POST. Called by `tether serve` after `listen`, so the
 * URL names a port that is actually bound.
 *
 * Always loopback — `/internal/hook` refuses anything else. A server bound only
 * to a non-loopback address simply gets no hooks, which is the same as no server
 * at all and is something the shim already survives silently.
 */
export async function writeHookEndpoint(stateDir: string, url: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeAtomically(hookEndpointPath(stateDir), `${url}\n`, 0o600);
}

export type InstallResult = {
  settingsPath: string;
  shimPath: string;
  /** Where the previous settings file was copied, or undefined if there was none. */
  backupPath?: string;
  /** Events tether's entry was added to; empty when it was already on all of them. */
  added: string[];
};

/**
 * Put tether's hook in a project, and make sure the shim and the secret exist.
 *
 * Idempotent, and it has to be: `startSession` calls this on every spawn in the
 * directory, so a second call re-writes the shim (an upgrade updates it) and adds
 * nothing to the settings file. Appended rather than inserted, and every other
 * key of the file is preserved — this file is the user's, and it commonly holds
 * their own `permissions` block.
 *
 * `now` is only for tests, which need a backup name they can predict.
 */
export async function installHook(options: {
  cwd: string;
  stateDir: string;
  now?: Date;
}): Promise<InstallResult> {
  const path = settingsPath(options.cwd);
  const shim = hookShimPath(options.stateDir);
  // Read and validate before writing anything, so a file tether refuses to touch
  // also leaves no shim and no secret behind.
  const file = await readSettings(path);
  const existing = await readFile(path, 'utf8').catch(() => undefined);

  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  await writeFile(shim, SHIM_SOURCE, { mode: 0o700 });
  await chmod(shim, 0o700);
  await ensureHookSecret(options.stateDir);

  const hooks: Record<string, HookGroup[]> = { ...(file.hooks ?? {}) };
  const added: string[] = [];
  for (const event of HOOK_EVENTS) {
    const groups = [...(hooks[event] ?? [])];
    if (groups.some((group) => group.hooks.some((handler) => isOurs(handler, shim)))) continue;
    groups.push({
      // `matcher` selects tools, so it is meaningful for `PreToolUse` and not
      // for `Notification`, which has none.
      ...(event === 'PreToolUse' ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command: shim, timeout: TIMEOUT_SECONDS }],
    });
    hooks[event] = groups;
    added.push(event);
  }

  if (added.length === 0) return { settingsPath: path, shimPath: shim, added };

  let backupPath: string | undefined;
  if (existing !== undefined) {
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    backupPath = `${path}.tether-backup-${stamp}`;
    await writeFile(backupPath, existing, { mode: 0o600 });
  }

  await mkdir(join(options.cwd, '.claude'), { recursive: true });
  await writeAtomically(path, `${JSON.stringify({ ...file, hooks }, null, 2)}\n`, 0o600);
  return {
    settingsPath: path,
    shimPath: shim,
    ...(backupPath === undefined ? {} : { backupPath }),
    added,
  };
}
