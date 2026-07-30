/**
 * Reboot recovery, against a real tmux server: a reboot is simulated by killing
 * the tmux server out from under the registry, which is exactly what the machine
 * losing power does to it (report §2 — tmux keeps nothing on disk).
 *
 * No real agent runs here. A stub `claude` on PATH stands in for one: it records
 * the argv it was started with, and on `--resume <id>` it prints that id's
 * transcript fixture into the pane. That is enough to prove the two things this PR
 * is actually about — tether asks the provider to continue *that* conversation, and
 * what comes back is the prior conversation rather than an empty one.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import {
  applyRegistrySchema,
  getSession,
  reconcileWithTmux,
  setProviderSessionId,
} from './registry.ts';
import { hookTimeoutSeconds } from '../providers/permission.ts';
import {
  NoProviderSessionError,
  reconcileProviderHooks,
  resumeSession,
  startSession,
} from './sessions.ts';
import {
  captureViewport,
  killServer,
  listPanes,
  listSessions as listTmuxSessions,
} from './tmux.ts';

/** These sessions start in temporary directories, not under the default root. */
process.env['TETHER_ALLOWED_ROOTS'] = tmpdir();

/**
 * Starting a session installs tether's hook, which writes a shim and a secret
 * into the state directory. Pointed at a scratch one so this file never touches
 * the real `~/.local/state/tether`.
 */
const STATE_DIR = mkdtempSync(join(tmpdir(), 'tether-sessions-state-'));
process.env['TETHER_STATE_DIR'] = STATE_DIR;
process.on('exit', () => rmSync(STATE_DIR, { recursive: true, force: true }));

/**
 * The stub provider, and the fixtures it reads. tmux inherits this process's
 * environment, so its panes find both.
 */
const FIXTURES = mkdtempSync(join(tmpdir(), 'tether-fixtures-'));
process.env['TETHER_FIXTURES'] = FIXTURES;
process.env['PATH'] =
  `${FIXTURES}${process.env['PATH'] === undefined ? '' : ':'}${process.env['PATH'] ?? ''}`;
writeFileSync(
  join(FIXTURES, 'claude'),
  [
    '#!/bin/sh',
    'echo "$@" >> "$TETHER_FIXTURES/argv.log"',
    'if [ "$1" = "--resume" ]; then cat "$TETHER_FIXTURES/$2.transcript"; fi',
    // Idles afterwards so the pane stays alive, exactly as a real agent's TUI would.
    'exec /bin/sh',
  ].join('\n'),
  { mode: 0o755 },
);
process.on('exit', () => rmSync(FIXTURES, { recursive: true, force: true }));

const ARGV_LOG = join(FIXTURES, 'argv.log');
/** A line only the resumed conversation can put on screen. */
const PRIOR_TURN = 'tether-probe: the answer from before the reboot';

function socketFor(t: TestContext): string {
  const socket = `tether-test-${randomUUID().slice(0, 8)}`;
  t.after(async () => {
    await killServer(socket);
    await rm(join(tmpdir(), `tmux-${process.getuid?.() ?? ''}`, socket), { force: true });
  });
  return socket;
}

async function harness(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  applyRegistrySchema(db);
  t.after(() => db.close());
  const cwd = await mkdtemp(join(tmpdir(), 'tether-resume-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await rm(ARGV_LOG, { force: true });
  return { db, cwd, socket: socketFor(t) };
}

/** The transcript the stub replays for `id`, as the provider's own store would. */
function seedTranscript(id: string): void {
  writeFileSync(join(FIXTURES, `${id}.transcript`), `${PRIOR_TURN}\n`);
}

async function waitFor(predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function argvLog(): Promise<string> {
  return readFile(ARGV_LOG, 'utf8').catch(() => '');
}

test('a session lost with the machine reads as dead, and resume restores the same conversation', async (t) => {
  const { db, cwd, socket } = await harness(t);
  const providerSessionId = randomUUID();
  seedTranscript(providerSessionId);

  const started = await startSession(db, socket, { cwd, title: 'before the reboot' });
  // What PR #8's transcript tail will do for real: the provider now has an identity.
  setProviderSessionId(db, started.id, providerSessionId);

  // The reboot. tmux keeps nothing on disk, so the whole server goes with it.
  await killServer(socket);
  assert.equal(await reconcileWithTmux(db, socket), 1);

  const dead = getSession(db, started.id)!;
  assert.ok(dead.deadAt !== null, 'dead, not deleted');
  assert.equal(dead.providerSessionId, providerSessionId);

  const resumed = await resumeSession(db, socket, dead);

  // Identity: the same row, the same conversation — not a fresh session that
  // happens to be in the same directory.
  assert.equal(resumed.id, started.id);
  assert.equal(resumed.providerSessionId, providerSessionId);
  assert.equal(resumed.cwd, started.cwd);
  assert.equal(resumed.deadAt, null);
  assert.deepEqual(await listTmuxSessions(socket), [started.tmuxName]);

  // The provider was asked to continue *that* conversation…
  await waitFor(
    async () => (await argvLog()).includes(`--resume ${providerSessionId}`),
    'the provider to be started with --resume',
  );
  // …and the prior conversation is what came back onto the screen.
  await waitFor(
    async () => (await captureViewport(socket, resumed.tmuxName)).includes(PRIOR_TURN),
    'the prior conversation to be on screen',
  );
});

test('resuming a session that never got a provider session id refuses rather than starting fresh', async (t) => {
  const { db, cwd, socket } = await harness(t);

  // No `setProviderSessionId`: the session died before its first user message, so
  // there is no conversation to go back to. This is why the column is nullable.
  const started = await startSession(db, socket, { cwd });
  await killServer(socket);
  assert.equal(await reconcileWithTmux(db, socket), 1);

  const dead = getSession(db, started.id)!;
  await assert.rejects(() => resumeSession(db, socket, dead), NoProviderSessionError);

  // Refused means refused: no pane was started, and nothing calls itself resumed.
  assert.deepEqual(await listTmuxSessions(socket), []);
  assert.deepEqual(getSession(db, started.id), dead);
  assert.ok(!(await argvLog()).includes('--resume'));
});

/**
 * The restart path, which is the ordinary one: tmux panes outlive `tether serve`,
 * so a server coming back up under a different `TETHER_PERMISSION_TIMEOUT` finds
 * projects whose settings file still names the old hold. Left alone, Claude Code
 * would kill the hook at the old number while tether went on showing a live
 * countdown and live buttons for a call the agent had stopped waiting on.
 */
test('a restart under a different hold moves the settings timeout without a respawn', async (t) => {
  const { db, cwd, socket } = await harness(t);
  const before = process.env['TETHER_PERMISSION_TIMEOUT'];
  t.after(() => {
    if (before === undefined) delete process.env['TETHER_PERMISSION_TIMEOUT'];
    else process.env['TETHER_PERMISSION_TIMEOUT'] = before;
  });

  process.env['TETHER_PERMISSION_TIMEOUT'] = '5';
  const started = await startSession(db, socket, { cwd });
  const settings = join(cwd, '.claude', 'settings.local.json');
  const timeoutOnDisk = async () => {
    const file = JSON.parse(await readFile(settings, 'utf8')) as {
      hooks: Record<string, { hooks: { timeout: number }[] }[]>;
    };
    return file.hooks['PreToolUse']![0]!.hooks[0]!.timeout;
  };
  assert.equal(await timeoutOnDisk(), hookTimeoutSeconds(5000));

  // The whole point: the pane is still running and nothing respawns it.
  process.env['TETHER_PERMISSION_TIMEOUT'] = '45';
  await reconcileProviderHooks(db, socket);
  assert.equal(await timeoutOnDisk(), hookTimeoutSeconds(45_000), 'the on-disk value followed');
  assert.deepEqual(await listTmuxSessions(socket), [started.tmuxName], 'and nothing respawned');

  // A second listen at the same hold writes nothing at all.
  const unchanged = await readFile(settings, 'utf8');
  await reconcileProviderHooks(db, socket);
  assert.equal(await readFile(settings, 'utf8'), unchanged);

  // A row whose pane is gone is not reconciled — with or without the registry
  // having caught up, since `serve` does not reconcile it before listening and a
  // row outlives a reboot.
  await killServer(socket);
  process.env['TETHER_PERMISSION_TIMEOUT'] = '9';
  await reconcileProviderHooks(db, socket);
  assert.equal(await timeoutOnDisk(), hookTimeoutSeconds(45_000), 'a stale live row is skipped');
  await reconcileWithTmux(db, socket);
  await reconcileProviderHooks(db, socket);
  assert.equal(await timeoutOnDisk(), hookTimeoutSeconds(45_000));
});

test('reconciling a project tether has no entry in leaves it exactly as it was', async (t) => {
  const { db, cwd, socket } = await harness(t);
  const started = await startSession(db, socket, { cwd });
  const settings = join(cwd, '.claude', 'settings.local.json');

  // The user took tether's hook out of their own repository, which is an answer
  // and not a fault: a `listen` must not put it back.
  const theirs = `${JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }, null, 2)}\n`;
  await writeFile(settings, theirs);
  await reconcileProviderHooks(db, socket);
  assert.equal(await readFile(settings, 'utf8'), theirs);

  // And a directory they have since removed is not tether's to recreate.
  await rm(cwd, { recursive: true, force: true });
  await reconcileProviderHooks(db, socket);
  await assert.rejects(() => readFile(settings, 'utf8'));
  assert.deepEqual(await listTmuxSessions(socket), [started.tmuxName], 'nothing else moved either');
});

test('resume is idempotent — a second call does not start a second pane', async (t) => {
  const { db, cwd, socket } = await harness(t);
  const providerSessionId = randomUUID();
  seedTranscript(providerSessionId);

  const started = await startSession(db, socket, { cwd });
  setProviderSessionId(db, started.id, providerSessionId);
  await killServer(socket);
  await reconcileWithTmux(db, socket);

  const dead = getSession(db, started.id)!;
  const first = await resumeSession(db, socket, dead);
  // Deliberately the *stale* dead row again: a caller that resumed twice from one
  // listing must not get two panes out of it.
  const second = await resumeSession(db, socket, dead);

  assert.equal(second.id, first.id);
  assert.equal(second.deadAt, null);
  assert.deepEqual(await listTmuxSessions(socket), [started.tmuxName]);
  assert.equal((await listPanes(socket)).filter((p) => p.session === started.tmuxName).length, 1);
  // `new-session -d` returns once tmux has forked the pane, not once the stub has
  // written its line — so wait for the one line, then assert there is only one.
  await waitFor(
    async () => (await argvLog()).includes('--resume'),
    'the provider to be started with --resume',
  );
  assert.equal((await argvLog()).split('\n').filter((l) => l.includes('--resume')).length, 1);
});
