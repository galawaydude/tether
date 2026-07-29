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

import { DEFAULT_PROVIDER, type Session, createSession, markDead } from './registry.ts';
import { isSessionGone, killSession, newSession, resolveCwd } from './tmux.ts';

/**
 * What a provider is started with when no explicit command is given. A `Map` rather
 * than an object literal so `--provider constructor` is an unknown provider and not
 * `Object.prototype`'s member.
 */
export const PROVIDER_COMMANDS = new Map<string, readonly string[]>([
  [DEFAULT_PROVIDER, ['claude']],
]);

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
