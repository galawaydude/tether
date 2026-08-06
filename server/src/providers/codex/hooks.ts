/**
 * tether's Codex hook: installing it, removing it, and reading what it wrote.
 *
 * Codex publishes two things tether cannot get from a file it already follows:
 * that the session is **waiting for the user**, and — on `PermissionRequest`,
 * and only there — a channel to *answer* on. So this module buys one badge and
 * one pair of buttons. That is the frame for every decision in it.
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
 *   `idle` from the rollout file, which is always there, and the conversation
 *   and the terminal never needed a hook at all. Declining costs the live badge
 *   and the Approve/Deny buttons; the prompt is still answered where it has
 *   always been answered, in the pane. Nothing here is on the path of anything
 *   else, and nothing anywhere nags.
 *
 * `--dangerously-bypass-hook-trust` is not used, mentioned as a fallback, or
 * documented. It disables a user-facing security control on the user's own
 * machine to save one prompt.
 *
 * ## Answering, and why only one event does it
 *
 * Four of the five events tether registers are fire-and-forget: the shim
 * appends one line to a log tether tails, and that is the whole transport.
 * `PermissionRequest` is different, because Codex reads a decision back off the
 * hook's **stdout** — so that one, and only that one, also POSTs to
 * `/internal/hook` and blocks there while the user taps in the conversation
 * view. It still writes the log line first: that line is what sets the badge if
 * tether is not listening, and the `PreToolUse` line before it is what the
 * server correlates against (`CodexStatus#correlate`).
 *
 * ## Why the timeout here is a constant, when Claude Code's is not
 *
 * The nesting the whole safety argument rests on is
 *
 *   server hold  <  the shim's own abort  <  Codex's `timeout`
 *
 * and Claude Code keeps it by *reconciling* the outermost value in the settings
 * file whenever the hold moves. That is exactly what must not happen here.
 * Codex's trust hash covers the entry, so a `timeout` that followed
 * `RCAGENT_PERMISSION_TIMEOUT` would put a security prompt in front of a user
 * every time an operator changed an environment variable — for a hook they had
 * already reviewed and trusted. So the outermost net and the shim's abort are
 * both fixed and generous, and the *hold* is clamped beneath them instead
 * ({@link MAX_HOLD_MS}, applied in `machine/conversations.ts`). Nothing tether
 * writes to `hooks.json` ever depends on a runtime value, so in steady state
 * tether never rewrites a trusted entry at all.
 *
 * The other side of that bargain is that this file can go out of date and
 * nothing may quietly fix it. Nothing rewrites a Codex installation behind the
 * user's back, so after an upgrade the shim and the `timeout` on disk are still
 * whichever ones the last `codex-hook install` wrote. Two things follow, and
 * they are the whole of the answer: `machine/conversations.ts` reads the
 * `timeout` before it holds anything ({@link installedPermissionTimeout}), so a
 * stale installation reports prompts without buttons rather than reporting an
 * answer nobody received; and {@link hookStatus} says so, inside a command the
 * user typed. Not in a banner, not at startup, not beside a running session.
 *
 * Nothing in `providers/` may import from `web/` (report §5).
 */

import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ABORT_MARGIN_MS,
  ensureHookSecret,
  KILL_MARGIN_MS,
  writeAtomically,
} from '../permission.ts';

/**
 * The events tether registers. `PreToolUse`/`PostToolUse` bracket
 * `PermissionRequest` so the badge clears — and `PreToolUse` is also the only
 * record carrying the `tool_use_id` a `PermissionRequest` has to be correlated
 * to — `SessionStart` carries the `session_id` that back-fills the provisional
 * registry row, and `SessionEnd` says the session is over. Codex offers more
 * (`PreCompact`, `SubagentStart`, `UserPromptSubmit`, …) and tether asks for
 * none of them: every event registered is another thing the user is asked to
 * trust.
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
 * this is 3 for the four log-only events: the shim parses one JSON object and
 * appends one line.
 */
const TIMEOUT_SECONDS = 3;

/**
 * The `timeout` on tether's `PermissionRequest` entry, in seconds. A constant —
 * see the head of this module for why it may not be derived from the hold.
 *
 * Five minutes is far above any hold worth configuring and far below anything a
 * user would sit through; it is a net that should never fire, since the server's
 * own timer settles first and the shim's abort settles after that.
 */
export const PERMISSION_TIMEOUT_SECONDS = 300;

/** The longest tether may hold a Codex turn and still return before Codex gives up. */
export const MAX_HOLD_MS = PERMISSION_TIMEOUT_SECONDS * 1000 - KILL_MARGIN_MS;

/** The shim's own abort: after the hold could have expired, before Codex kills it. */
const SHIM_ABORT_MS = PERMISSION_TIMEOUT_SECONDS * 1000 - ABORT_MARGIN_MS;

/** The `timeout` tether's entry carries for an event. */
function timeoutFor(event: string): number {
  return event === 'PermissionRequest' ? PERMISSION_TIMEOUT_SECONDS : TIMEOUT_SECONDS;
}

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
 * It finds its log directory, the secret and the endpoint relative to itself, so
 * nothing has to be interpolated in and the installed file is the same bytes
 * every time. The secret in particular is *read at hook execution time* rather
 * than baked in, and the endpoint has to be, because it names whichever port the
 * current `tether serve` bound.
 *
 * ## What it is allowed to say
 *
 * On `PermissionRequest`, **stdout is the permission decision** — Codex reads a
 * `{behavior: 'allow'|'deny'}` off it. That makes this the one file in tether's
 * Codex path where an accidental write is a tool call silently allowed or
 * silently blocked, so the rule is narrow: it writes a decision only when tether
 * returned one, in the shape this file builds, and nothing at all on every other
 * path and every other event. It always exits 0 — Codex reads exit code 2 as a
 * denial, and a crashing hook must never be able to answer for the user.
 *
 * ## When tether cannot be reached
 *
 * The fallback is **neither allow nor deny: it falls through to Codex's own
 * approval prompt**, which is what a hook that says nothing does, and which is
 * where the question would have been asked anyway. Not `allow`, because a tether
 * that cannot be reached must not be able to approve anything. Not `deny`,
 * because tether is an accessory to the user's own agent and not its gate, and
 * an outage that broke every Codex session on the machine would leave the user
 * no way forward but to uninstall the hook mid-task.
 *
 * It is observable, and observably in proportion. A request that reached tether
 * and then failed puts one sentence in the session through `systemMessage`,
 * because that is the case where somebody may be looking at a card whose buttons
 * are dead. A refused connection is *silent*: tether not running is the ordinary
 * state of a machine whose hook is installed, the browser cannot be showing a
 * card either, and a note on every prompt would be nagging about a working
 * setup — which the captain's decision forbids by name.
 */
const SHIM_SOURCE = `#!/usr/bin/env node
// Remote Control Agent's Codex hook. Installed by \`rcagent codex-hook install\`,
// removed by \`rcagent codex-hook remove\`. It appends one JSON line per event.
// On PermissionRequest — where stdout IS the decision — it asks Remote Control
// Agent and writes back its answer. Every other path writes nothing and exits 0.
import { appendFileSync, mkdirSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8').trim();
const say = (value) => writeSync(1, JSON.stringify(value) + '\\n');
// tether is simply not running here: no secret or endpoint beside the shim, or
// nothing listening on the port they name. Ordinary, and silent.
const QUIET = new Set(['ENOENT', 'ECONNREFUSED']);
const quiet = (error) => QUIET.has(error?.code) || QUIET.has(error?.cause?.code);

let payload;
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
  const id = String(payload.session_id ?? '');
  // A session id becomes a file name, so it is checked rather than trusted.
  if (/^[A-Za-z0-9._-]+$/.test(id)) {
    const dir = join(here, 'codex-hooks');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ ...payload, at: Date.now(), ppid: process.ppid });
    // Before the POST below, always: this line is what sets the badge when
    // tether is not listening, and the PreToolUse line before it is what the
    // server correlates this prompt against.
    appendFileSync(join(dir, id + '.ndjson'), line + '\\n', { mode: 0o600 });
  }
} catch {
  // Deliberately silent, and it does not stop the ask below: a log that could
  // not be written is a badge lost, not a reason to leave the user without
  // buttons.
}

if (payload?.hook_event_name === 'PermissionRequest') {
  try {
    const response = await fetch(read('claude-hook.endpoint'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tether-hook': read('claude-hook.secret') },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(${SHIM_ABORT_MS}),
    });
    if (!response.ok) throw new Error('Remote Control Agent refused the hook (' + response.status + ')');
    // 204 is the ordinary answer and the body is empty. A decision is the only
    // thing that ever comes back with one, and it is re-built here rather than
    // echoed: this process owns the shape of what lands on the decision channel,
    // so no reply tether could send is able to put arbitrary bytes there.
    const text = response.status === 204 ? '' : await response.text();
    const decision = text.trim() === '' ? undefined : JSON.parse(text).decision;
    if (decision === 'allow' || decision === 'deny') {
      say({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: decision,
            message:
              decision === 'allow'
                ? 'Approved in Remote Control Agent.'
                : 'Denied in Remote Control Agent.',
          },
        },
      });
    }
  } catch (error) {
    // No decision, so Codex's own approval prompt applies — see the comment on
    // SHIM_SOURCE for why the fallback is neither allow nor deny. Said out loud
    // only when tether was reachable and then failed; a refused connection is
    // tether simply not running, which is normal and stays quiet.
    if (!quiet(error)) {
      say({
        systemMessage:
          'Remote Control Agent could not answer this permission request (' +
          (error?.message ?? error) +
          '). Codex’s own approval prompt applies.',
      });
    }
  }
}
`;

/** A `hooks.json` that tether will not rewrite, and why. */
export class HooksFileError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`refusing to change ${path}: ${reason}. Remote Control Agent changed nothing.`);
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

/** tether's own entry: the only one whose command is tether's shim. */
function isOurs(handler: HookHandler, shim: string): boolean {
  return handler.command === shim;
}

/**
 * The `timeout` Codex will really enforce on tether's `PermissionRequest` hook,
 * or `undefined` when there is no entry of tether's to read one off.
 *
 * The lowest of them if somehow there are several, because every one of them
 * runs and the shortest is the one that kills the shim. `undefined` covers a
 * missing file, a shape `readHooksFile` refuses, tether's entry being absent and
 * a `timeout` that is not a number — all of which mean the same thing to the
 * caller: tether cannot say what Codex is waiting for.
 */
function permissionTimeoutOf(file: HooksFile, shim: string): number | undefined {
  const seconds = (file.hooks?.['PermissionRequest'] ?? [])
    .flatMap((group) => group.hooks)
    .filter((handler) => isOurs(handler, shim))
    .map((handler) => handler['timeout'])
    .filter((timeout): timeout is number => typeof timeout === 'number');
  return seconds.length === 0 ? undefined : Math.min(...seconds);
}

/**
 * The same value, read from disk — the gate `machine/conversations.ts` holds a
 * Codex turn behind, and the fact {@link hookStatus} reports.
 *
 * The invariant is in `../permission.ts`: tether may hold only while the
 * provider's own configuration carries the timeout the hold is sized against.
 * Codex's entry may not be reconciled onto disk (see the head of this module),
 * so it is read instead, and one reader answers both callers.
 */
export async function installedPermissionTimeout(options: {
  codexHome: string;
  stateDir: string;
}): Promise<number | undefined> {
  const file = await readHooksFile(hooksJsonPath(options.codexHome)).catch(() => undefined);
  return file === undefined ? undefined : permissionTimeoutOf(file, hookShimPath(options.stateDir));
}

export type InstallResult = {
  hooksPath: string;
  shimPath: string;
  /** Where the previous hooks.json was copied, or undefined if there was none. */
  backupPath?: string;
  /** Events tether's entry was added to; empty when it was already on all of them. */
  added: string[];
  /**
   * Events where tether's *existing* entry had its `timeout` corrected — today
   * only ever the `PermissionRequest` entry an older tether wrote at 3s, before
   * it had anything to answer. Reported separately because Codex re-hashes a
   * changed entry, so the user will be asked to review that one again: "tether
   * put a hook in your Codex config" and "tether corrected the one you already
   * trusted" are different sentences and only the second needs warning about.
   */
  updated: string[];
  /** True when nothing had to change in hooks.json. */
  alreadyInstalled: boolean;
};

/**
 * Write the shim and merge tether's entry into `hooks.json`.
 *
 * Idempotent: a second install re-writes the shim (so an upgrade updates it) and
 * adds nothing to hooks.json. Idempotent is not quite untouched — tether's own
 * entries have their `timeout` reconciled, because the value moved when
 * `PermissionRequest` gained a decision to return. Both values are constants, so
 * that can only ever happen once per installation; nothing here depends on a
 * runtime setting, which is the point (see the head of this module).
 *
 * `now` is only for tests, which need a backup name they can predict.
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
  // The shim reads this at hook execution time; `PermissionRequest` cannot POST
  // without it. Shared with the Claude Code shim on purpose — see
  // `../permission.ts`.
  await ensureHookSecret(options.stateDir);

  const hooks: Record<string, HookGroup[]> = { ...(file.hooks ?? {}) };
  const added: string[] = [];
  const updated: string[] = [];
  for (const event of HOOK_EVENTS) {
    const groups = [...(hooks[event] ?? [])];
    const timeout = timeoutFor(event);
    const ours = groups.flatMap((group) => group.hooks).filter((handler) => isOurs(handler, shim));
    if (ours.length > 0) {
      // Asked before it is written: an install at the same timeouts must leave
      // the user's file byte-identical, or every run re-hashes a trusted entry.
      if (ours.every((handler) => handler['timeout'] === timeout)) continue;
      for (const handler of ours) handler['timeout'] = timeout;
      hooks[event] = groups;
      updated.push(event);
      continue;
    }
    // Appended, never inserted: Codex's trust state is keyed by group index, and
    // renumbering the user's entries would re-prompt them for hooks they trust.
    groups.push({
      matcher: '',
      hooks: [{ type: 'command', command: shim, timeout }],
    });
    hooks[event] = groups;
    added.push(event);
  }

  if (added.length === 0 && updated.length === 0) {
    return { hooksPath: path, shimPath: shim, added, updated, alreadyInstalled: true };
  }

  let backupPath: string | undefined;
  if (existing !== undefined) {
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    backupPath = `${path}.tether-backup-${stamp}`;
    await writeFile(backupPath, existing, { mode: 0o600 });
  }

  await mkdir(options.codexHome, { recursive: true, mode: 0o700 });
  await writeAtomically(path, `${JSON.stringify({ ...file, hooks }, null, 2)}\n`, 0o600);
  return {
    hooksPath: path,
    shimPath: shim,
    ...(backupPath === undefined ? {} : { backupPath }),
    added,
    updated,
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
  await writeAtomically(path, `${JSON.stringify({ ...file, hooks }, null, 2)}\n`, 0o600);
  return { hooksPath: path, removed };
}

export type HookStatus = {
  hooksPath: string;
  shimPath: string;
  /** Events tether's entry is registered for. */
  installed: string[];
  /**
   * Why the file could not be read, when it could not be — a trailing comma, a
   * top level that is not an object, a group of a shape tether does not know.
   * `install` refuses for exactly this reason, so `status` is where a user
   * should find it out rather than reading `not installed` and trying anyway.
   */
  unreadable?: string;
  /**
   * Whether `config.toml` has `features.hooks = true`. Codex runs no hooks at
   * all without it, and tether does not write to `config.toml`: it is TOML that
   * also holds the trust state, and the user turning the feature on themselves
   * is the same informed act as accepting the prompt.
   */
  featureEnabled: boolean;
  /**
   * Whether the shim on disk is the one this tether would write.
   *
   * Nothing rewrites it behind the user's back — `installProviderHook` and
   * `reconcileProviderHooks` both skip Codex, because this is a file tether does
   * not own and a trust gate it may not walk through unasked — so an
   * installation from an older tether keeps running that older shim after an
   * upgrade. It still logs, so the badge still works; it does not POST, so
   * nothing can be answered. Reported because `registered: <five events>` on its
   * own says the opposite.
   */
  shimCurrent: boolean;
  /**
   * The `timeout` Codex will enforce on tether's `PermissionRequest` entry, if
   * tether has one. Anything but {@link PERMISSION_TIMEOUT_SECONDS} means tether
   * will not hold a turn on this installation at all — see the invariant in
   * `../permission.ts` and the gate in `machine/conversations.ts`.
   */
  permissionTimeout?: number;
};

/** What is actually registered right now, for `tether codex-hook status`. */
export async function hookStatus(options: {
  codexHome: string;
  stateDir: string;
}): Promise<HookStatus> {
  const path = hooksJsonPath(options.codexHome);
  const shim = hookShimPath(options.stateDir);
  let unreadable: string | undefined;
  const file = await readHooksFile(path).catch((error: unknown) => {
    unreadable = error instanceof Error ? error.message : String(error);
    return {} as HooksFile;
  });
  const installed = Object.entries(file.hooks ?? {})
    .filter(([, groups]) => groups.some((g) => g.hooks.some((h) => isOurs(h, shim))))
    .map(([event]) => event);
  const permissionTimeout = permissionTimeoutOf(file, shim);
  return {
    hooksPath: path,
    shimPath: shim,
    installed,
    ...(unreadable === undefined ? {} : { unreadable }),
    featureEnabled: await featureEnabled(options.codexHome),
    shimCurrent: (await readFile(shim, 'utf8').catch(() => undefined)) === SHIM_SOURCE,
    ...(permissionTimeout === undefined ? {} : { permissionTimeout }),
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
 * `notBefore` is an mtime floor in epoch milliseconds, and it is what keeps this
 * cheap. The logs are one per Codex session, never pruned, and they grow with
 * every tool call — while discovery retries this once a second for as long as a
 * new session sits waiting for its first prompt. A log last written before the
 * floor cannot hold the `SessionStart` of a session that began after it, so it
 * is stat'd and never opened; without the floor a user with a year of Codex
 * sessions re-reads all of them, every second. Omitting it reads everything,
 * which is what a caller with no session to bound it by wants.
 */
export async function sessionStarts(
  stateDir: string,
  notBefore = -Infinity,
): Promise<HookRecord[]> {
  const dir = hookLogDir(stateDir);
  const names = await readdir(dir).catch(() => []);
  const found: HookRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.ndjson')) continue;
    const info = await stat(join(dir, name)).catch(() => undefined);
    if (info !== undefined && info.mtimeMs < notBefore) continue;
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
