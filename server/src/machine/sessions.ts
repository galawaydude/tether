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

import { stateDir } from '../db.ts';
import { installHook } from '../providers/claude-code/hooks.ts';
import { CODEX, CODEX_COMMAND, codexResume } from '../providers/codex/spawn.ts';
import {
  DEFAULT_PROVIDER,
  type Session,
  createSession,
  getSession,
  markDead,
  revive,
} from './registry.ts';
import { isSessionGone, killSession, newSession, resolveCwd } from './tmux.ts';

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
 * Put tether's hook in the project before the agent reads its settings.
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

  // Before the pane exists: Claude Code reads `.claude/settings.local.json` at
  // startup, so a hook installed afterwards would miss this session entirely.
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
