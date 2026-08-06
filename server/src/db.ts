import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Runtime state lives outside the repo (report §7): a path that is not in the
 * repository cannot be committed accidentally, which is stronger than an
 * ignore rule. `TETHER_STATE_DIR` remains an alias so existing installations
 * and their provider hooks continue to use the directory they already know.
 */
export function stateDir(): string {
  const override = process.env['RCAGENT_STATE_DIR'] ?? process.env['TETHER_STATE_DIR'];
  if (override) return override;
  const xdg = process.env['XDG_STATE_HOME'];
  const root = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'state');
  const current = join(root, 'remote-control-agent');
  const legacy = join(root, 'tether');
  return existsSync(legacy) ? legacy : current;
}

export function databasePath(): string {
  return join(stateDir(), 'tether.sqlite');
}

/**
 * Open (creating if needed) the one SQLite file tether owns. The password hash
 * lives here, so the file is `0600` and its directory `0700`. The default
 * rollback journal is used rather than WAL: WAL's `-shm`/`-wal` sidecars are
 * created by SQLite under the process umask, and there is no concurrency in M1
 * that would pay for them.
 *
 * `timeout` because the default is 0: two `tether` invocations at once, or an
 * `ls` overlapping a login write from a running `tether serve`, would otherwise
 * fail instantly with a raw `database is locked` instead of waiting their turn.
 */
export function openDatabase(path: string = databasePath()): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: 5000 });
  chmodSync(path, 0o600);
  return db;
}
