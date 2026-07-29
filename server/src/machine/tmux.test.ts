/**
 * Integration tests against a real tmux. No mocks: the value of this module is
 * entirely in what tmux actually does, and every fact asserted here was reproduced
 * by hand in the design spike (report sections 2 and 3).
 *
 * Every test gets its own socket and kills its server in `t.after`, which runs on
 * failure too — a leaked tmux server poisons the next run.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import {
  InvalidCwdError,
  UnsafeArgumentError,
  captureScrollback,
  captureViewport,
  killServer,
  killSession,
  listPanes,
  listSessions,
  newSession,
  pasteText,
  resolveCwd,
  sendKeys,
  sendText,
  showOption,
} from './tmux.ts';

/**
 * A socket nobody else is using, torn down when the test ends however it ends.
 * tmux leaves the socket file behind after `kill-server`, so unlink it too — a
 * stale socket is inert, but littering /tmp on every local run is rude.
 */
function socketFor(t: TestContext): string {
  const socket = `tether-test-${randomUUID().slice(0, 8)}`;
  t.after(async () => {
    await killServer(socket);
    await rm(join(tmpdir(), `tmux-${process.getuid?.() ?? ''}`, socket), { force: true });
  });
  return socket;
}

/** A shell that sits there until we kill it, so the pane stays alive. */
const IDLE_SHELL = ['/bin/sh'] as const;

async function waitFor(predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('create, discover through list-panes, kill', async (t) => {
  const socket = socketFor(t);
  const cwd = await mkdtemp(join(tmpdir(), 'tether-cwd-'));

  const resolved = await newSession(socket, { name: 's1', cwd, command: IDLE_SHELL });
  assert.deepEqual(await listSessions(socket), ['s1']);

  const panes = await listPanes(socket);
  assert.equal(panes.length, 1);
  const pane = panes[0]!;
  assert.equal(pane.session, 's1');
  assert.match(pane.paneId, /^%\d+$/);
  assert.ok(pane.pid > 0);
  assert.equal(pane.command, 'sh');
  assert.equal(pane.path, resolved);
  assert.equal(pane.dead, false);

  await killSession(socket, 's1');
  assert.deepEqual(await listSessions(socket), []);
  assert.deepEqual(await listPanes(socket), []);
});

test('listing a server that is not running is empty, not an error', async (t) => {
  const socket = socketFor(t);
  assert.deepEqual(await listSessions(socket), []);
  assert.deepEqual(await listPanes(socket), []);
});

test('scrollback and viewport compose with no overlap and no lost line', async (t) => {
  const socket = socketFor(t);
  // Above tmux's stock 2000-line history-limit, so this also fails if tether.conf
  // did not raise it.
  const count = 2500;
  await newSession(socket, { name: 's', cwd: tmpdir(), command: IDLE_SHELL });
  await sendText(socket, 's', `for i in $(seq 1 ${count}); do echo LINE-$i; done`);
  await sendKeys(socket, 's', ['Enter']);
  await waitFor(
    async () => (await captureViewport(socket, 's')).includes(`LINE-${count}`),
    'the generator to finish',
  );

  const composed =
    (await captureScrollback(socket, 's', 100_000)) + (await captureViewport(socket, 's'));
  const seen = [...composed.matchAll(/LINE-(\d+)/g)].map((m) => Number(m[1]));

  // Exact sequence 1..count: anything lost at the boundary shortens it, anything
  // duplicated repeats a number, and either shows up as an inequality.
  assert.deepEqual(
    seen,
    Array.from({ length: count }, (_, i) => i + 1),
  );
});

test('multi-line input survives into the pane with its newline intact', async (t) => {
  const socket = socketFor(t);
  const dir = await mkdtemp(join(tmpdir(), 'tether-paste-'));
  const sink = join(dir, 'received');
  // `sh -c '…' sh <arg>` — argv, no interpolation, $1 is the sink path.
  await newSession(socket, {
    name: 'p',
    cwd: dir,
    command: ['/bin/sh', '-c', 'cat > "$1"', 'sh', sink],
  });

  await pasteText(socket, 'p', 'first line\nsecond line');
  await sendKeys(socket, 'p', ['Enter', 'C-d']);
  await waitFor(
    async () => (await readFile(sink, 'utf8').catch(() => '')).includes('second line'),
    'the pasted text to reach the pane',
  );

  // The regression: `send-keys -l $'a\nb'` delivers `ab`.
  assert.match(await readFile(sink, 'utf8'), /first line\r?\nsecond line/);
  await assert.rejects(() => sendText(socket, 'p', 'a\nb'), /use pasteText/);
});

test('tether.conf is applied and the user’s ~/.tmux.conf is not', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tether-home-'));
  await writeFile(join(home, '.tmux.conf'), 'set -g history-limit 42\nset -g status on\n');

  const previous = { HOME: process.env['HOME'], XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'] };
  process.env['HOME'] = home;
  process.env['XDG_CONFIG_HOME'] = join(home, '.config');
  t.after(() => {
    process.env['HOME'] = previous.HOME;
    process.env['XDG_CONFIG_HOME'] = previous.XDG_CONFIG_HOME;
  });

  // Control: a server started the way tmux starts by default really does read that
  // file. Without this the test below could pass by reading nothing at all.
  const control = `tether-test-${randomUUID().slice(0, 8)}`;
  t.after(async () => {
    await promisify(execFile)('tmux', ['-L', control, 'kill-server']).catch(() => {});
    await rm(join(tmpdir(), `tmux-${process.getuid?.() ?? ''}`, control), { force: true });
  });
  await promisify(execFile)('tmux', ['-L', control, 'new-session', '-d', '-s', 'c', '/bin/sh']);
  const leaked = await promisify(execFile)('tmux', [
    '-L',
    control,
    'show-options',
    '-g',
    '-v',
    'history-limit',
  ]);
  assert.equal(
    leaked.stdout.trim(),
    '42',
    'the dotfile must be live for this test to mean anything',
  );

  const socket = socketFor(t);
  await newSession(socket, { name: 'c', cwd: tmpdir(), command: IDLE_SHELL });
  assert.equal(await showOption(socket, 'history-limit'), '100000');
  assert.equal(await showOption(socket, 'status'), 'off');
  assert.equal(await showOption(socket, 'window-size'), 'manual');
});

test('cwd is resolved and required to be an existing directory', async (t) => {
  const socket = socketFor(t);
  const dir = await mkdtemp(join(tmpdir(), 'tether-cwd-'));
  const file = join(dir, 'a-file');
  await writeFile(file, '');

  assert.equal(await resolveCwd(join(dir, 'sub', '..')), dir);
  await assert.rejects(() => resolveCwd(join(dir, 'nope')), InvalidCwdError);
  await assert.rejects(() => resolveCwd(file), InvalidCwdError);
  await assert.rejects(
    () => newSession(socket, { name: 'x', cwd: join(dir, 'nope'), command: IDLE_SHELL }),
    InvalidCwdError,
  );
  assert.deepEqual(await listSessions(socket), []);
});

test('tmux command separators in caller arguments are rejected, not executed', async (t) => {
  const socket = socketFor(t);
  await newSession(socket, { name: 'g', cwd: tmpdir(), command: IDLE_SHELL });

  await assert.rejects(
    () =>
      newSession(socket, { name: 'h', cwd: tmpdir(), command: ['/bin/sh', ';', 'kill-server'] }),
    UnsafeArgumentError,
  );
  await assert.rejects(() => sendKeys(socket, 'g', [';', 'kill-server']), UnsafeArgumentError);

  // Embedded separators and format strings are data, and must still go through.
  await sendText(socket, 'g', 'echo "a;b #{pane_id} $NOPE"');
  await sendKeys(socket, 'g', ['Enter']);
  await waitFor(
    async () => (await captureViewport(socket, 'g')).includes('a;b #{pane_id}'),
    'the literal text to appear',
  );
  assert.deepEqual(await listSessions(socket), ['g']);
});
