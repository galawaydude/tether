/**
 * What the two providers' permission hooks share: the timeout contract, the
 * secret and endpoint their shims read, and the signal vocabulary they map to.
 *
 * It lives here, beside `tail.ts` and `cap.ts`, for the same reason those do —
 * so that neither provider directory has to import from the other. Report §4
 * chose one `switch` over a `Provider` interface, and this is not that
 * interface: there is no behaviour here that either provider implements. It is
 * the *policy* both are held to, which is exactly what must not be invented
 * twice. A second hold length, a second fallback rule or a second secret would
 * each be a way for one provider to be less safe than the other.
 *
 * What is deliberately **not** here is how each hook is installed, where it
 * goes, and what it may say when it runs. Claude Code writes into a project's
 * own `.claude/settings.local.json` with no trust gate; Codex writes one global,
 * trust-gated entry in `~/.codex/hooks.json`. Those differences are structural,
 * and each directory's `hooks.ts` owns its own.
 *
 * Nothing in `providers/` may import from `web/` (report §5).
 */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ToolCallEvent } from '@tether/shared';

/**
 * How long Remote Control Agent holds a proposed tool call waiting for the user
 * to tap, in milliseconds. `RCAGENT_PERMISSION_TIMEOUT` is in **seconds** because
 * that is how a person says it; `TETHER_PERMISSION_TIMEOUT` remains an alias.
 * `0` turns holding off entirely and leaves Remote Control Agent the
 * observer it was before this — a supported configuration, not a degraded one.
 *
 * One source of truth for three numbers that have to stay ordered (see
 * {@link hookTimeoutSeconds}), read per call rather than captured, because the
 * server and `installHook` run in the same process and a test that sets it must
 * not have to restart anything.
 */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 20_000;

export function permissionTimeoutMs(env = process.env): number {
  const raw = env['RCAGENT_PERMISSION_TIMEOUT'] ?? env['TETHER_PERMISSION_TIMEOUT'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_PERMISSION_TIMEOUT_MS;
  const seconds = Number(raw);
  // Not a number is the operator's typo, and silently holding for 20s when they
  // asked for none would be the worst reading of it. Refuse to guess: 0.
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.round(seconds * 1000);
}

/**
 * Three timeouts, nested, and the order is the whole safety argument:
 *
 *   server hold  <  the shim's own abort  <  the provider's `timeout`
 *
 * The innermost one always fires first, so the hook returns an *answer* — even
 * if that answer is "no decision" — rather than being killed mid-flight. The
 * outermost is a net rather than a mechanism, and a benign one: verified on
 * Claude Code 2.1.220 and Codex 0.145.0 that a hook killed at its `timeout`
 * falls through to the provider's own permission flow, exactly as a hook that
 * said nothing does. Nothing here can make a tool call fail; the worst case is
 * that tether does not get to answer.
 *
 * Both providers use the two margins. Only Claude Code derives its outermost
 * value from the hold — Codex's is a fixed ceiling, because rewriting its entry
 * would re-prompt a trust review the user has already given
 * (`codex/hooks.ts`).
 *
 * Which leaves one invariant, and it is the one a third provider inherits:
 *
 *   tether may hold an agent's turn only while the provider's own on-disk hook
 *   configuration actually carries the timeout that hold is sized against.
 *   Claude Code satisfies it by reconciling the file; Codex satisfies it by
 *   checking the file. A provider that can do neither may not hold.
 *
 * The nesting above is an argument about three numbers, and it is worth nothing
 * if the outermost one is a number tether merely assumes. An installation an
 * older tether wrote, or a user edited, can carry a `timeout` far below the
 * hold — and then the provider kills the hook and puts its own dialog up while
 * tether is still showing a live deadline, so a tap reports an approval the
 * agent never received. Not holding is always available and always safe: the
 * prompt is reported without buttons and answered in the pane, which is what
 * every session did before it could be answered here.
 *
 * Reading the file is necessary and it is not sufficient, because the file is
 * not what a *running* agent enforces. Verified against codex-cli 0.145.0 with a
 * probe hook and no tether code in the loop: with `hooks.json` moved from
 * `timeout: 3` to `300` under a running Codex, the probe was still killed at ~3s
 * and the dialog still appeared — and it ran at all, though the edit had changed
 * the entry's trust hash. A running provider enforces the timeout it loaded at
 * startup. So the gate above closes the cases it can see and there is a second,
 * wider invariant underneath it:
 *
 *   tether must never show an answerable card for a decision that cannot land,
 *   regardless of *why* it cannot — a provider timeout tether never enumerated,
 *   a Ctrl-C'd pane, a killed agent, a provider tether has not met.
 *
 * The hook's own request dying is the earliest point at which that is knowable,
 * and knowing it requires no knowledge of anyone's timeout, which is precisely
 * what makes it the better boundary. `web/hooks.ts` watches for it and
 * `Conversations.hook` settles the hold on it, for both providers and for any
 * third.
 */
export const ABORT_MARGIN_MS = 3000;
export const KILL_MARGIN_MS = 5000;

export function hookTimeoutSeconds(holdMs = permissionTimeoutMs()): number {
  return Math.ceil((holdMs + KILL_MARGIN_MS) / 1000);
}

/**
 * What a hook told tether, in the vocabulary the hold machinery speaks.
 *
 * Only the events an installer registers produce one. Everything else —
 * including an event a future provider adds and a payload whose fields have
 * moved — is `undefined` and one warning, by the same rule the transcript
 * mappers follow: the hook is an accelerator, and losing one costs a card a
 * moment of lateness, never the session.
 */
export type HookSignal =
  /** A tool call the provider has named, and how far tether may go on it. */
  | { signal: 'pending'; e: ToolCallEvent; hold: HoldBasis }
  /** The agent has stopped and is waiting on the user. */
  | { signal: 'waiting'; detail?: string };

/**
 * Whether tether may hold the agent's turn on a proposed call — and, where it
 * may, on whose evidence. The three cases are not degrees of confidence; they
 * are three different things a provider has actually said.
 *
 * - `never` — a read-only burst tool, skipped whatever the user has open. See
 *   `claude-code/events.ts`'s `NEVER_HELD`.
 * - `perhaps` — a pre-tool hook fired, and the provider said nothing about
 *   whether it was going to prompt. Claude Code's `PreToolUse` is this: it
 *   fires for every call, so the card is a *proposal* that the transcript will
 *   supersede, and a hold on one the transcript already carries would be a
 *   hold on a call that has already run.
 * - `prompting` — the provider has **stated** that it is asking the user right
 *   now. Codex's `PermissionRequest` is this, and it is why Codex needs no
 *   skip list. It also means the transcript having the call already is the
 *   normal case rather than a lost race: Codex flushes the `function_call`
 *   before the dialog goes up (the Codex spike, report risk #2), so the card
 *   exists and what the `pending` frame adds to it is the buttons.
 */
export type HoldBasis = 'never' | 'perhaps' | 'prompting';

/** `0600`, never in the repo, and read by a shim at hook execution time. */
export function hookSecretPath(stateDir: string): string {
  return join(stateDir, 'claude-hook.secret');
}

/** Written after `listen`, so it names a port that is actually bound. */
export function hookEndpointPath(stateDir: string): string {
  return join(stateDir, 'claude-hook.endpoint');
}

/**
 * Same directory, so the rename is atomic. The temporary name is unique per
 * call: two sessions spawning at once install the same shim, and a shared
 * scratch name would let them interleave into it.
 */
export async function writeAtomically(path: string, text: string, mode: number): Promise<void> {
  const temporary = `${path}.tether-tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(temporary, text, { mode });
  await rename(temporary, path);
}

/**
 * The shared secret, created on first use.
 *
 * Written `0600` inside tether's own `0700` state directory, and returned so the
 * endpoint can compare against it. Regenerating it would silently break every
 * shim already installed in every project, so an existing one is kept.
 *
 * One secret for both providers, on purpose. It authenticates *a local process
 * that can read tether's own state directory* and nothing finer — every such
 * file would be one mode and one owner, so a reader of one is a reader of all.
 * Per-session authorisation is real and lives at the endpoint: a payload is
 * accepted only for a session tether has a live row for.
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
 * Tell the shims where to POST. Called by `tether serve` after `listen`, so the
 * URL names a port that is actually bound.
 *
 * Always loopback — `/internal/hook` refuses anything else. A server bound only
 * to a non-loopback address simply gets no hooks, which is the same as no server
 * at all and is something both shims already survive silently.
 */
export async function writeHookEndpoint(stateDir: string, url: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeAtomically(hookEndpointPath(stateDir), `${url}\n`, 0o600);
}
