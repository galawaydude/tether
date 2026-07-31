/**
 * Can a terminal actually start on this machine?
 *
 * Everything else the installer checks is a prerequisite — Node, tmux, a
 * toolchain. This is the product, and it is the one thing nothing checked: on
 * macOS, node-pty's prebuild ships `spawn-helper` **without its executable
 * bit**, macOS starts every child process through that helper, so `posix_spawnp`
 * refuses and *every* terminal attach fails. Found on a Mac after three hours of
 * blind debugging, because the install had said it was done and the failure
 * arrived later as node-pty's own stack trace in the server log.
 *
 * The root package's `postinstall` sets that bit on every `npm ci`. This is what
 * proves it, and `install.sh` fails the install rather than handing over a tether
 * whose terminal cannot open. Run by CI too, on the same command.
 *
 * Two checks, because the one that matters cannot be executed where it matters.
 * The **bit** is asserted on every platform — a Linux CI run carries the darwin
 * prebuilds, so it can prove the postinstall reached them, which is the only
 * evidence about macOS obtainable without a Mac. The **spawn** is the end-to-end
 * one, and it is the check that would have caught this in seconds.
 */

import { accessSync, constants, globSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { loadPty } from './terminal.ts';

/**
 * Where node-pty looks for its native module, in its own order — `build/Release`,
 * `build/Debug`, then `prebuilds/<platform>-<arch>`; see its `lib/utils.js`.
 * `spawn-helper` sits beside whichever one wins, so all of them are checked
 * rather than working out which resolved: the platform and the architecture are
 * deliberately not spelled out here, and a second prebuild for an architecture
 * this machine does not run costs nothing to check.
 */
const HELPER_DIRS = '{build/Release,build/Debug,prebuilds/*}';

/** A PTY that has not exited by now is as broken as one that failed to start. */
const SPAWN_TIMEOUT_MS = 20_000;

function fail(lines: readonly string[]): never {
  process.stderr.write(
    `tether cannot open a terminal on this machine.\n${lines.map((l) => `  ${l}\n`).join('')}`,
  );
  process.exit(1);
}

function helpers(): string[] {
  const root = dirname(dirname(createRequire(import.meta.url).resolve('node-pty')));
  return globSync(`${HELPER_DIRS}/spawn-helper`, { cwd: root }).map((rel) => join(root, rel));
}

/**
 * Finding none is a failure, not a pass. node-pty has shipped this helper for
 * every release tether has run on, so an empty list means its layout changed
 * under us — which is the moment to re-read this file, not to go quiet.
 */
function checkHelperBit(): void {
  const found = helpers();
  if (found.length === 0) {
    fail([
      'node-pty ships no `spawn-helper` in any of its native-module directories,',
      `which is not a layout tether has seen (looked in ${HELPER_DIRS}).`,
      'On macOS every process starts through that helper. Re-check node-pty.',
    ]);
  }
  for (const helper of found) {
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      fail([
        `node-pty's spawn-helper is not executable: ${helper}`,
        'On macOS every process tether starts goes through it, so every terminal',
        'attach fails with `posix_spawnp failed`. Fix it with:',
        '',
        `  chmod +x ${helper}`,
      ]);
    }
  }
}

/**
 * The end-to-end. `process.execPath` rather than any command on PATH: node-pty
 * reports a refused `posix_spawnp` and a missing binary with the same message,
 * and the file being run here provably exists — it is what is running.
 */
async function checkSpawn(): Promise<void> {
  const { spawn } = await loadPty().catch((cause: unknown) => {
    fail([String((cause as Error)?.message ?? cause)]);
  });
  const pty = spawn(process.execPath, ['-e', ''], { cols: 80, rows: 24 });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    pty.kill();
  }, SPAWN_TIMEOUT_MS);
  const { exitCode, signal } = await new Promise<{ exitCode: number; signal?: number }>((resolve) =>
    pty.onExit(resolve),
  );
  clearTimeout(timer);
  // node-pty reports an ordinary exit as signal 0 rather than as no signal, so
  // the two spellings of "died on nothing" both have to read as clean here.
  if (exitCode !== 0 || (signal ?? 0) !== 0) {
    fail([
      timedOut
        ? `A process started through node-pty was still running after ${SPAWN_TIMEOUT_MS}ms.`
        : `A process started through node-pty exited ${exitCode}, signal ${signal ?? 0}, rather than 0.`,
      `The command was: ${process.execPath} -e ''`,
    ]);
  }
}

checkHelperBit();
await checkSpawn();
process.stdout.write('a terminal starts here\n');
