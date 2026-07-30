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
 * - **HTTP, not a file.** A `PreToolUse` hook *answers* the permission prompt by
 *   writing a decision on stdout, and that needs a request/response channel —
 *   which is why the transport was chosen before there was anything to answer
 *   with. tether now holds that request open while the user taps Approve or
 *   Deny in the conversation view; a log file could never have become this.
 *
 * ## The secret
 *
 * `settings.local.json` lives in the user's repo, so a token written into it is
 * one `git add` away from being published (report §7). The secret is therefore a
 * `0600` file in tether's own state directory, **read by the shim at hook
 * execution time**, and what goes in the settings file is only a path. Same rule
 * for the endpoint URL, which also means a session spawned under one
 * `tether serve` reaches the next one on a different port. Both files, and the
 * timeout contract below, are `../permission.ts` — shared with the Codex hook
 * because a second copy of either is a way for one provider to be less safe.
 *
 * Nothing in `providers/` may import from `web/` (report §5).
 */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ABORT_MARGIN_MS,
  ensureHookSecret,
  hookTimeoutSeconds,
  permissionTimeoutMs,
} from '../permission.ts';

/**
 * The two events tether registers, and no more. Every hook installed in someone
 * else's repository is a thing they did not ask for, and the transcript already
 * carries everything else — `PostToolUse` and `Stop` would only re-report what
 * arrives moments later by the honest route.
 */
export const HOOK_EVENTS = ['PreToolUse', 'Notification'] as const;

export function hookShimPath(stateDir: string): string {
  return join(stateDir, 'claude-hook.mjs');
}

export function settingsPath(cwd: string): string {
  return join(cwd, '.claude', 'settings.local.json');
}

/**
 * The shim's source.
 *
 * It finds the secret and the endpoint beside itself, so neither is interpolated
 * in — the secret must never be written into the user's repository, and the
 * endpoint changes whenever tether is restarted on another port. Only the abort
 * is baked in, because it has to stay ordered against the hold the server was
 * configured with.
 *
 * ## What it is allowed to say
 *
 * On `PreToolUse`, **stdout is the permission decision**. That makes this the
 * one file in tether where an accidental write is a tool call silently allowed
 * or silently blocked, so the rule is narrow: it writes a decision only when
 * tether returned one, in the shape tether built, and it writes nothing at all
 * on every other path. It still always exits 0 — a non-zero exit is itself a
 * decision (code 2 blocks the call), and a crashing hook must never be able to
 * stop the user's agent.
 *
 * ## When tether cannot be reached
 *
 * The fallback is **neither allow nor deny: it falls through to Claude Code's
 * own permission rules**, which is what a hook that says nothing does. The
 * reasoning, because a silent choice either way is the worst outcome:
 *
 * - Not `allow`. A tether that cannot be reached must not be able to approve
 *   anything; "the server was down so we ran it" is unauthenticated tool
 *   execution wearing a fallback's clothes.
 * - Not `deny`. tether is an accessory to the user's own agent, not its gate.
 *   Denying would make a tether outage break every session on the machine —
 *   including sessions nobody is watching from a phone — and leave the user no
 *   way forward but to uninstall the hook mid-task.
 * - Falling through hands the question back to the permission system that
 *   existed before tether and is always correct. The outage costs the
 *   *convenience* of answering on a phone, and nothing else.
 *
 * It is observable, and observably in proportion. A request that reached tether
 * and then failed — a timeout mid-flight, a refusal — puts one sentence in the
 * user's session through `systemMessage`, because that is the case where
 * somebody may be staring at a card whose buttons are dead. A connection
 * refused is *silent*: tether not running is the ordinary state of a project
 * whose shim is still installed, the browser cannot be showing a card either,
 * and a note on every tool call would be nagging about a working setup.
 */
function shimSource(abortMs: number): string {
  return `#!/usr/bin/env node
// tether's Claude Code hook. Installed into a project's .claude/settings.local.json
// by tether when it starts a session there. It POSTs one hook payload to tether
// over loopback and writes back whatever tether decided — nothing else. On
// PreToolUse, stdout IS the permission decision, so every path that is not a
// decision tether actually made writes nothing, and every path exits 0.
import { readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8').trim();
const say = (value) => writeSync(1, JSON.stringify(value) + '\\n');
// tether is simply not running here: no secret or endpoint beside the shim, or
// nothing listening on the port they name. Ordinary, and silent.
const QUIET = new Set(['ENOENT', 'ECONNREFUSED']);
const quiet = (error) => QUIET.has(error?.code) || QUIET.has(error?.cause?.code);

try {
  const payload = readFileSync(0, 'utf8');
  // Both beside the shim, both read now rather than baked in at install time:
  // the secret must never be written into the user's repo, and the endpoint
  // changes whenever tether is restarted on another port.
  const secret = read('claude-hook.secret');
  const endpoint = read('claude-hook.endpoint');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tether-hook': secret },
    body: payload,
    signal: AbortSignal.timeout(${abortMs}),
  });
  if (!response.ok) throw new Error('tether refused the hook (' + response.status + ')');
  // 204 is the ordinary answer and the body is empty. A decision is the only
  // thing that ever comes back with one, and it is re-built here rather than
  // echoed: this process owns the shape of what lands on the decision channel,
  // so no reply tether could send is able to put arbitrary bytes there.
  const text = response.status === 204 ? '' : await response.text();
  const decision = text.trim() === '' ? undefined : JSON.parse(text).decision;
  if (decision === 'allow' || decision === 'deny') {
    say({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason:
          decision === 'allow' ? 'Approved in tether.' : 'Denied in tether.',
      },
    });
  }
} catch (error) {
  // No decision, so Claude Code's own permission rules apply — see the comment
  // on shimSource for why the fallback is neither allow nor deny. Said out loud
  // only when tether was reachable and then failed; a refused connection is
  // tether simply not running, which is normal and stays quiet.
  if (!quiet(error)) {
    say({
      systemMessage:
        'tether could not answer this permission request (' +
        (error?.message ?? error) +
        '). Claude Code’s own permission rules apply.',
    });
  }
}
`;
}

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
async function readSettings(path: string): Promise<{ file: SettingsFile; text?: string }> {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new SettingsFileError(path, `it could not be read (${error.message})`);
  });
  if (text === undefined) return { file: {} };
  if (text.trim() === '') return { file: {}, text };

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
          throw new SettingsFileError(
            path,
            `an entry under \`hooks.${event}\` is not the expected shape`,
          );
        }
      }
    }
  }
  // The text comes back with the parse, so the backup below is the same bytes
  // the merge was computed from rather than a second, possibly newer, read.
  return { file: parsed as SettingsFile, text };
}

/**
 * Same directory, so the rename is atomic. The temporary name is unique per
 * call: two sessions spawning at once install the same shim, and a shared
 * scratch name would let them interleave into it.
 */
async function writeAtomically(path: string, text: string, mode: number): Promise<void> {
  const temporary = `${path}.tether-tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(temporary, text, { mode });
  await rename(temporary, path);
}

/**
 * What goes in the settings file's `command`. Claude Code runs it through a
 * shell, so the path is quoted: a state directory under a home with a space in
 * it — `/Users/First Last/...`, or any `TETHER_STATE_DIR` — would otherwise be
 * word-split, and the hook would silently never run.
 */
function shimCommand(shim: string): string {
  return `'${shim.replaceAll("'", `'\\''`)}'`;
}

/** tether's own entry: the only one whose command is tether's shim. */
function isOurs(handler: HookHandler, shim: string): boolean {
  return handler.command === shimCommand(shim) || handler.command === shim;
}

/**
 * Where a project's settings file is copied before tether appends to it.
 *
 * Deliberately not beside the original. The conventional gitignore entry is the
 * literal path `.claude/settings.local.json`, which does not match a suffixed
 * name — so a backup written there is an untracked, unignored copy of the user's
 * settings sitting in their repository, one `git add .` from being committed. A
 * path that is not in the repository cannot be committed by accident.
 */
export function settingsBackupPath(stateDir: string, cwd: string, stamp: string): string {
  const project = cwd.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return join(stateDir, 'claude-settings-backups', `${project}-${stamp}.json`);
}

export type InstallResult = {
  settingsPath: string;
  shimPath: string;
  /**
   * Where the previous settings file was copied — under tether's state
   * directory, never beside the original — or undefined if there was none.
   */
  backupPath?: string;
  /** Events tether's entry was added to; empty when it was already on all of them. */
  added: string[];
  /**
   * Events where tether's *existing* entry was reconciled rather than appended —
   * today that is only its `timeout`, which has to move when the hold does.
   * Separate from `added` because "tether put a hook in your repository" and
   * "tether corrected the one it had already put there" are different sentences.
   */
  updated: string[];
};

/**
 * Put tether's hook in a project, and make sure the shim and the secret exist.
 *
 * **This is the creating entry point**, and it is the spawn-time one: the user
 * has just asked for a session in this directory, so an absent entry is one to
 * add. `updateOnly` is the other half — see the option — and a caller that only
 * means to keep an existing entry in step must pass it rather than calling this
 * bare.
 *
 * Idempotent, and it has to be: `startSession` calls this on every spawn in the
 * directory, so a second call re-writes the shim (an upgrade updates it) and
 * never appends a second entry. Appended rather than inserted, and every other
 * key of the file is preserved — this file is the user's, and it commonly holds
 * their own `permissions` block.
 *
 * Idempotent is not the same as untouched, and the difference is the `timeout`.
 * The shim is rewritten on every spawn with an abort derived from the *current*
 * hold, so a settings file still carrying the number some earlier hold wrote
 * breaks the nesting the whole safety argument rests on (see
 * {@link hookTimeoutSeconds}): Claude Code kills the hook first, asks in the
 * terminal, and tether goes on showing live buttons for a hold the agent has
 * stopped waiting on. So tether's own entry is *reconciled* rather than skipped.
 * Only that one field, only on tether's own handler — every other key, event and
 * party's handler comes out byte-for-byte as it went in — and when nothing has
 * to move, nothing is written and nothing is backed up.
 *
 * `now` is only for tests, which need a backup name they can predict.
 */
export async function installHook(options: {
  cwd: string;
  stateDir: string;
  now?: Date;
  /** Overrides `TETHER_PERMISSION_TIMEOUT`. Tests, and nothing else. */
  holdMs?: number;
  /**
   * Update tether's own entry if it is already there, and otherwise **do
   * nothing at all** — no `.claude` directory, no settings file, no backup, and
   * no entry added back.
   *
   * Reconciliation exists to stop an entry tether already owns from drifting out
   * of step, never to reassert tether's presence. A user who deleted tether's
   * hook from their own repository has given an answer, not left a fault to
   * repair, and a directory they have since removed is not tether's to recreate.
   */
  updateOnly?: boolean;
}): Promise<InstallResult> {
  const path = settingsPath(options.cwd);
  const shim = hookShimPath(options.stateDir);
  const holdMs = options.holdMs ?? permissionTimeoutMs();
  // Read and validate before writing anything, so a file tether refuses to touch
  // also leaves no shim and no secret behind.
  const { file, text: existing } = await readSettings(path);

  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  // Atomically: a hook firing in another project at this instant execs this
  // file, and a truncated ESM module is a parse error in the user's session.
  await writeAtomically(shim, shimSource(holdMs + ABORT_MARGIN_MS), 0o700);
  await chmod(shim, 0o700);
  await ensureHookSecret(options.stateDir);

  const timeout = hookTimeoutSeconds(holdMs);
  const hooks: Record<string, HookGroup[]> = { ...(file.hooks ?? {}) };
  const added: string[] = [];
  const updated: string[] = [];
  for (const event of HOOK_EVENTS) {
    const groups = [...(hooks[event] ?? [])];
    const ours = groups.flatMap((group) => group.hooks).filter((handler) => isOurs(handler, shim));
    if (ours.length > 0) {
      // Asked before it is written: a spawn at the same hold must leave the
      // user's file byte-identical, or `startSession` rewrites it on every run.
      if (ours.every((handler) => handler['timeout'] === timeout)) continue;
      for (const handler of ours) handler['timeout'] = timeout;
      hooks[event] = groups;
      updated.push(event);
      continue;
    }
    if (options.updateOnly === true) continue;
    groups.push({
      // `matcher` selects tools, so it is meaningful for `PreToolUse` and not
      // for `Notification`, which has none.
      ...(event === 'PreToolUse' ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command: shimCommand(shim), timeout }],
    });
    hooks[event] = groups;
    added.push(event);
  }

  if (added.length === 0 && updated.length === 0) {
    return { settingsPath: path, shimPath: shim, added, updated };
  }

  let backupPath: string | undefined;
  if (existing !== undefined) {
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    backupPath = settingsBackupPath(options.stateDir, options.cwd, stamp);
    await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeFile(backupPath, existing, { mode: 0o600 });
  }

  await mkdir(join(options.cwd, '.claude'), { recursive: true });
  await writeAtomically(path, `${JSON.stringify({ ...file, hooks }, null, 2)}\n`, 0o600);
  return {
    settingsPath: path,
    shimPath: shim,
    ...(backupPath === undefined ? {} : { backupPath }),
    added,
    updated,
  };
}
