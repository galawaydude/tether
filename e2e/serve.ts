/**
 * The server Playwright's `webServer` starts, and the sandbox it runs in.
 *
 * Everything tether would otherwise touch on the real machine is redirected here
 * by `playwright.config.ts`: `HOME`, `RCAGENT_STATE_DIR`, `RCAGENT_ALLOWED_ROOTS`
 * and a private `RCAGENT_TMUX_SOCKET`. This file only creates the directories,
 * puts the stub agent on `PATH` as `claude`, sets the password, and then calls
 * the CLI's own `serve` — the same code path `npx tether serve` runs, so what the
 * spec drives is the product and not a test harness wearing its clothes.
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { main } from '../server/src/cli.ts';
import { openRegistry } from '../server/src/machine/registry.ts';
import { killServer } from '../server/src/machine/tmux.ts';
import { createAuthStore } from '../server/src/web/auth.ts';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set — start this through Playwright`);
  return value;
}

const dir = required('TETHER_E2E_DIR');
const socket = required('RCAGENT_TMUX_SOCKET');

// From scratch every run, both halves. A registry row or a pane left behind by a
// previous run would put a second session in the list, and the spec asserts on
// counts — a stale sandbox is exactly how this test would start "flaking".
await killServer(socket);
rmSync(dir, { recursive: true, force: true });
const bin = join(dir, 'bin');
for (const path of [bin, join(dir, 'project'), join(dir, 'state')]) {
  mkdirSync(path, { recursive: true });
}

// tmux runs `claude` through `execvp`, so a shim on PATH is all it takes. `sh`
// rather than a symlink because the stub is TypeScript and needs node's flags.
//
// The same stub stands in for `codex` too. It writes a Claude-Code-shaped
// transcript either way, so a Codex session driven through it has no
// conversation — which is all `options.spec.ts` needs, because what that spec
// asserts is the *keystrokes* a Codex composer sends, read back from the pane.
// Anything that needs Codex's own records belongs in a unit test with the
// captured fixtures, not here.
for (const name of ['claude', 'codex']) {
  const shim = join(bin, name);
  writeFileSync(
    shim,
    `#!/bin/sh\nexec node --disable-warning=ExperimentalWarning ${join(import.meta.dirname, 'stub-agent.ts')} "$@"\n`,
  );
  chmodSync(shim, 0o755);
}

const db = openRegistry();
await createAuthStore(db).setPassword(required('TETHER_E2E_PASSWORD'));
db.close();

// The tmux server outlives this process — it is the whole point of tether — so
// the sandbox socket has to be torn down explicitly when Playwright stops us.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void killServer(socket).finally(() => process.exit(0));
  });
}

process.exitCode = await main(['serve', '--port', required('TETHER_E2E_PORT')]);
