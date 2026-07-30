/**
 * Starting and stopping a session: the tmux side and the registry side, kept
 * consistent, in one place.
 *
 * This is not a service layer over the driver and the registry — it is the exact
 * sequence the CLI already performed, moved so that the HTTP API is a call to it
 * rather than a second copy that drifts. Both orderings below are load-bearing and
 * are why one copy is worth having.
 */

import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { FolderTrust, TrustReport } from '@tether/shared';

import { stateDir } from '../db.ts';
import { installHook } from '../providers/claude-code/hooks.ts';
import * as claudeTrust from '../providers/claude-code/trust.ts';
import { CODEX, CODEX_COMMAND, codexResume } from '../providers/codex/spawn.ts';
import * as codexTrust from '../providers/codex/trust.ts';
import {
  FolderTrustError,
  type TrustLocations,
  type TrustWrite,
  repoRoot,
} from '../providers/trust.ts';
import {
  DEFAULT_PROVIDER,
  type Session,
  createSession,
  getSession,
  listSessions,
  markDead,
  revive,
} from './registry.ts';
import {
  isSessionGone,
  killSession,
  listSessions as listTmuxSessions,
  newSession,
  resolveCwd,
} from './tmux.ts';

/**
 * What a provider is started with when no explicit command is given. A `Map` rather
 * than an object literal so `--provider constructor` is an unknown provider and not
 * `Object.prototype`'s member.
 */
export const PROVIDER_COMMANDS = new Map<string, readonly string[]>([
  [DEFAULT_PROVIDER, ['claude']],
  [CODEX, CODEX_COMMAND],
]);

/**
 * How each provider is told to continue an existing conversation of its own. The
 * providers implement resume; tether only has to spell the argument, and the
 * spelling differs (Codex takes `codex resume <id>`), so it is per provider rather
 * than a flag appended to `PROVIDER_COMMANDS`.
 */
export const PROVIDER_RESUME = new Map<string, (providerSessionId: string) => readonly string[]>([
  [DEFAULT_PROVIDER, (id) => ['claude', '--resume', id]],
  [CODEX, codexResume],
]);

/**
 * Where each provider keeps folder trust, and what it keys it by. The third seam
 * of the same shape as the two above — the mechanisms have nothing in common
 * beyond the question they answer, which is why `providers/trust.ts` holds the
 * tri-state and the git resolution and nothing else.
 *
 * `key` is the directory the provider's answer is *about*: Codex reads only the
 * main repository root, so a session in `repo/sub` is a question about `repo`,
 * and the sheet is told which path it is agreeing to. Claude Code walks
 * ancestors, so the cwd is both what it reads and the smallest thing worth
 * writing.
 */
const PROVIDER_TRUST = new Map<
  string,
  {
    key: (cwd: string, repoRoot: string | undefined) => string;
    read: (
      cwd: string,
      repoRoot: string | undefined,
      where: TrustLocations,
    ) => Promise<FolderTrust>;
    write: (key: string, where: TrustLocations) => Promise<TrustWrite>;
  }
>([
  [
    DEFAULT_PROVIDER,
    {
      key: (cwd) => cwd,
      read: (cwd, repoRoot, where) => claudeTrust.readTrust(cwd, repoRoot, where.claudeConfigPath),
      write: (key, where) => claudeTrust.writeTrust(key, where),
    },
  ],
  [
    CODEX,
    {
      key: (cwd, repoRoot) => repoRoot ?? cwd,
      read: (cwd, repoRoot, where) => codexTrust.readTrust(repoRoot ?? cwd, where.codexHome),
      write: (key, where) => codexTrust.writeTrust(key, where),
    },
  ],
]);

/**
 * Does this provider already trust this directory, and which directory is the
 * answer about?
 *
 * `cwd` must already have been through `resolveCwd` — the answer is about the
 * directory the agent will really run in. A provider this build has not met
 * answers `unknown`, which is the honest one: the sheet then says tether cannot
 * tell rather than offering to write into a file it has never seen.
 */
export async function folderTrust(
  provider: string,
  cwd: string,
  where: TrustLocations = {},
): Promise<TrustReport> {
  const how = PROVIDER_TRUST.get(provider);
  if (how === undefined) return { trust: 'unknown', path: cwd };
  const root = await repoRoot(cwd);
  return { trust: await how.read(cwd, root, where), path: how.key(cwd, root) };
}

/**
 * Put tether's hook in the project before the agent reads its settings.
 *
 * **The creating one**, and the only one: the user has just asked for a session
 * in this directory, so an absent entry is one to add. `reconcileProviderHooks`
 * below is the update-only counterpart and may not create anything.
 *
 * Best-effort on purpose, and this is the whole of its error policy: the hook
 * only makes a pending tool card and a *waiting* badge appear sooner than the
 * transcript can (report §4). A project whose `settings.local.json` tether
 * refuses to rewrite, or a read-only checkout, must still get a session — it
 * gets one without the accelerator, and the operator is told why once.
 */
async function installProviderHook(provider: string, cwd: string): Promise<void> {
  if (provider !== DEFAULT_PROVIDER) return;
  await installHook({ cwd, stateDir: stateDir() }).catch((error: unknown) => {
    process.stderr.write(`tether: hook not installed — ${(error as Error).message}\n`);
  });
}

/**
 * Bring every live session's project hook back into step with **this** server.
 *
 * ## The invariant, which is the reason this function exists
 *
 * The `timeout` in a project's `.claude/settings.local.json` must never disagree
 * with the hold this process is configured with. It is the outermost of the
 * three nested timeouts (`hookTimeoutSeconds`), so a stale one means Claude Code
 * kills the hook while tether is still showing a live countdown and live
 * buttons — and a tap then reports an approval the agent stopped waiting for,
 * which is the one silent wrong answer this whole surface exists to prevent.
 *
 * The number therefore lives in two places that can drift: this process's memory
 * and a file on disk. It is reconciled at *every* point where they can, which is
 * exactly two: at spawn (`startSession`, `resumeSession`) and here, at `listen`.
 * This one covers the panes that were already running when the server came back
 * up under a different `TETHER_PERMISSION_TIMEOUT` — surviving a restart is the
 * product's whole point, so that is the ordinary path and not an edge. If you
 * find a third way the two can diverge, reconcile it here rather than adding a
 * patch where the symptom showed up.
 *
 * ## What it may not do
 *
 * **Update only.** Reconciliation exists to stop an entry tether already owns
 * from drifting out of step, never to reassert tether's presence: a project with
 * no tether entry is left completely alone — no `.claude` directory, no settings
 * file, no backup — because a user who deleted that entry from their own
 * repository has given an answer, not left a fault to repair, and a project
 * directory they have since removed is not tether's to recreate. That is the
 * deliberate difference from `installProviderHook`, which may create because the
 * user has just asked for a session there.
 *
 * And only the panes that are actually running: a registry row outlives a
 * reboot, so `deadAt` alone would have this writing into every directory tether
 * ever recorded. Best-effort by the same rule as `installProviderHook` — a
 * project tether refuses to rewrite costs the accelerator, never a `listen`.
 */
export async function reconcileProviderHooks(db: DatabaseSync, socket: string): Promise<void> {
  const running = new Set(await listTmuxSessions(socket).catch(() => []));
  const done = new Set<string>();
  for (const session of listSessions(db)) {
    const key = `${session.provider}\0${session.cwd}`;
    if (session.deadAt !== null || !running.has(session.tmuxName) || done.has(key)) continue;
    done.add(key);
    if (session.provider !== DEFAULT_PROVIDER) continue;
    await installHook({ cwd: session.cwd, stateDir: stateDir(), updateOnly: true }).catch(
      (error: unknown) => {
        process.stderr.write(`tether: hook not reconciled — ${(error as Error).message}\n`);
      },
    );
  }
}

/**
 * Start a provider in a fresh tmux session and record it.
 *
 * `command` overrides the provider's own and is a local-terminal affordance: the
 * HTTP API does not offer it, because "run this argv" is a different capability
 * from "start the agent" even when the account behind both is the same.
 */
export async function startSession(
  db: DatabaseSync,
  socket: string,
  opts: {
    cwd: string;
    title?: string | undefined;
    provider?: string | undefined;
    command?: readonly string[] | undefined;
    roots?: readonly string[] | undefined;
    /**
     * The user's own answer to tether's folder-trust question, and the only thing
     * that causes trust to be recorded anywhere. Absent and `false` are the same
     * answer and write nothing at all: a folder is trusted because somebody said
     * so, and pre-trusting one to smooth this flow would be worse than leaving
     * the prompt in the terminal.
     */
    trustFolder?: boolean | undefined;
    /** Where the providers keep their trust. Tests pass their own. */
    trustIn?: TrustLocations | undefined;
  },
): Promise<Session> {
  const provider = opts.provider ?? DEFAULT_PROVIDER;
  const command = opts.command?.length ? opts.command : PROVIDER_COMMANDS.get(provider);
  if (command === undefined) {
    throw new Error(`unknown provider ${provider} — pass the command after \`--\``);
  }

  // The one cwd validation in tether lives in the tmux driver; this is a call to
  // it, not a second copy. Doing it before anything is created means a rejected
  // directory leaves no tmux session and no row.
  const cwd = await resolveCwd(opts.cwd, opts.roots);
  const id = randomUUID();
  const tmuxName = `tether-${id.slice(0, 8)}`;

  // Before the pane exists, and before the hook, for the same reason and one
  // more: both agents read their trust configuration at startup, and unlike the
  // hook this is **not** best-effort. A hook that fails to install costs a badge;
  // a trust write that failed silently would drop the user into the very terminal
  // prompt they had just answered to avoid, with nothing left to tell them with.
  // So a refusal aborts the create, having started nothing.
  if (opts.trustFolder === true) {
    const how = PROVIDER_TRUST.get(provider);
    if (how === undefined) {
      throw new FolderTrustError(
        `tether does not know where ${provider} records folder trust, so it cannot record it`,
      );
    }
    await how.write(how.key(cwd, await repoRoot(cwd)), opts.trustIn ?? {});
  }
  await installProviderHook(provider, cwd);
  await newSession(socket, { name: tmuxName, cwd, command, roots: opts.roots });
  try {
    // Provisional from spawn: provider_session_id is null here and is back-filled
    // once the provider creates its own session identity.
    return createSession(db, { id, provider, cwd, title: opts.title ?? basename(cwd), tmuxName });
  } catch (error) {
    // A session tmux is running that the registry does not know about is invisible
    // garbage — nothing would ever list it, let alone kill it.
    await killSession(socket, tmuxName).catch(() => {});
    throw error;
  }
}

/**
 * A dead row that has no conversation to go back to: the provider never got as far
 * as creating a session identity, so `provider_session_id` is still null.
 *
 * Refusing is the point. Starting the provider fresh in the same directory would
 * look exactly like a resume and would be a different conversation — the one
 * failure mode here that silently costs a user work, in their head if not on disk.
 * Starting fresh is still available, spelled as what it is: create a new session.
 */
export class NoProviderSessionError extends Error {
  readonly sessionId: string;

  constructor(session: Session) {
    super(
      `session ${session.id} has no provider session id to resume: it never got a first ` +
        `message, so there is no conversation to restore. Start a new session in ${session.cwd} instead.`,
    );
    this.name = 'NoProviderSessionError';
    this.sessionId = session.id;
  }
}

/**
 * Bring a dead session back: a fresh tmux session running the provider's own
 * resume, under the row that was already there. tmux keeps nothing across a reboot
 * (report §2), so this is the whole of reboot recovery — the conversation lives in
 * the provider's own transcript, and resume is idempotent for both providers, so
 * the resumed process keeps the same provider session id and appends to the same
 * file rather than starting a second one.
 *
 * Idempotent by the same rule as `stopSession`: the row is re-read here, and a row
 * that is already live is already the postcondition. Resuming twice therefore
 * yields one pane, not two, even from a stale listing.
 *
 * The terminal scrollback is genuinely lost; only the conversation comes back.
 */
export async function resumeSession(
  db: DatabaseSync,
  socket: string,
  session: Session,
  roots?: readonly string[] | undefined,
): Promise<Session> {
  const current = getSession(db, session.id);
  if (current === undefined) throw new Error(`no such session: ${session.id}`);
  if (current.deadAt === null) return current;

  if (current.providerSessionId === null) throw new NoProviderSessionError(current);
  const resume = PROVIDER_RESUME.get(current.provider);
  if (resume === undefined) throw new Error(`provider ${current.provider} cannot resume`);

  await installProviderHook(current.provider, current.cwd);
  // The same tmux name: it is derived from the session id, the old session is gone,
  // and reusing it keeps that derivation true. A name that is somehow still taken
  // makes tmux refuse, which is the right answer — it means the row is not dead.
  await newSession(socket, {
    name: current.tmuxName,
    cwd: current.cwd,
    command: resume(current.providerSessionId),
    roots,
  });
  try {
    revive(db, current.id);
  } catch (error) {
    // Same rule as `startSession`: a pane the registry does not point at is
    // invisible garbage — worse here, because the row stays dead and every later
    // resume then trips over the tmux name this one left behind.
    await killSession(socket, current.tmuxName).catch(() => {});
    throw error;
  }
  return getSession(db, current.id)!;
}

/**
 * Kill the tmux session and mark the row dead, so record and reality agree.
 *
 * Safe to call twice: already-gone is the postcondition, not an error, and
 * `markDead` keeps the first death's timestamp. Only already-gone, though — any
 * other tmux failure leaves the pane running, so it must not be reported as a kill
 * and must not record a row dead that nothing ever revives.
 */
export async function stopSession(
  db: DatabaseSync,
  socket: string,
  session: Session,
): Promise<void> {
  await killSession(socket, session.tmuxName).catch((error: unknown) => {
    if (!isSessionGone(error)) throw error;
  });
  markDead(db, session.id);
}
