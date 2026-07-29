/**
 * How tether starts Codex, and where Codex keeps its files.
 *
 * Deliberately thin. tether does not set `CODEX_HOME` for the pane: it launches
 * the user's own CLI as the user's own OS user, reading the user's own
 * credentials (README, "never sees, stores, brokers or proxies provider
 * credentials"). Pointing the pane at a home of tether's own would mean a second
 * credential store, which is the one thing this product promises not to have.
 * So the pane gets no extra environment at all, and this module's job is to read
 * `CODEX_HOME` the same way Codex itself does, so tether looks for the rollout
 * where the session actually wrote it.
 *
 * Nothing in `providers/` may import from `web/` (report §5).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** The registry's name for this provider. `sessions.ts` switches on it. */
export const CODEX = 'codex';

/** The version this directory's fixtures were captured from. See `fixtures/`. */
export const CAPTURED_VERSION = '0.145.0';

/** Starting a fresh conversation. */
export const CODEX_COMMAND: readonly string[] = ['codex'];

/**
 * Continuing an existing one after a reboot. Verified idempotent in the spike:
 * `codex resume <id>` keeps the session id, appends to the same rollout file and
 * adds no second row to Codex's own `threads` table — which is what makes
 * `provider_session_id` enough to survive a reboot.
 */
export function codexResume(providerSessionId: string): readonly string[] {
  return ['codex', 'resume', providerSessionId];
}

/**
 * Codex's own home, read exactly as Codex reads it: `$CODEX_HOME`, else
 * `~/.codex`. `env` and `home` are parameters so tests never touch the real one.
 */
export function codexHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env['CODEX_HOME'];
  return configured !== undefined && configured.trim() !== '' ? configured : join(home, '.codex');
}

/** `$CODEX_HOME/sessions`, under which the day directories live. */
export function sessionsDir(home: string): string {
  return join(home, 'sessions');
}
