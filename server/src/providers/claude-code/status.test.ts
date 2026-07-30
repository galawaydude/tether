/**
 * The session registry reader, and the two guards that make it safe to believe.
 *
 * The file outlives the process — deleted on a graceful exit, left behind by a
 * `SIGKILL` or a reboot — and pids are reused, so the interesting cases here are
 * all failures: a pid that is gone, and a pid that is alive but is *somebody
 * else*. Both must read as "tether cannot say" rather than as a state.
 *
 * The live pid used throughout is this test process's own. That is the only way
 * to have a genuinely running process with a genuine `procStart` without
 * spawning one, and it makes the happy path real rather than mocked.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readSession, sessionStatusPath } from './status.ts';

const SESSION_ID = '261d15fb-c568-41fa-ae66-917b107857bd';

/** `/proc/<pid>/stat` field 22, exactly as `procStart` records it. */
async function realProcStart(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const after = stat.slice(stat.lastIndexOf(') ') + 2);
  const started = after.split(' ')[19];
  assert.ok(started, 'this platform has a procfs, which these tests assume');
  return started;
}

/**
 * A registry file as Claude Code 2.1.220 writes one. Captured from a real
 * session during a permission prompt; only `pid`/`procStart`/`status` are ever
 * varied, because those are the three fields anything here depends on.
 */
async function writeStatus(
  home: string,
  pid: number,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(join(home, '.claude', 'sessions'), { recursive: true });
  const record = {
    pid,
    sessionId: SESSION_ID,
    cwd: '/tmp/hookspike',
    startedAt: 1785313667656,
    procStart: await realProcStart(process.pid),
    version: '2.1.220',
    peerProtocol: 1,
    kind: 'interactive',
    entrypoint: 'cli',
    name: 'hookspike-77',
    nameSource: 'derived',
    status: 'waiting',
    updatedAt: 1785313686043,
    statusUpdatedAt: 1785313686043,
    waitingFor: 'permission prompt',
    ...overrides,
  };
  await writeFile(sessionStatusPath(pid, home), JSON.stringify(record));
}

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tether-status-'));
}

/**
 * A pid that is not running. Claimed rather than assumed: a pid this high is
 * beyond any default `pid_max` on a machine that has not wrapped, and the test
 * asserts it really is absent so it can never quietly pass for the wrong reason.
 */
function deadPid(): number {
  const pid = 4_194_303;
  let running = true;
  try {
    process.kill(pid, 0);
  } catch {
    running = false;
  }
  assert.equal(running, false, 'the chosen stale pid is genuinely not running');
  return pid;
}

test('the three states Claude Code publishes are the three tether renders', async () => {
  const dir = await home();
  for (const state of ['busy', 'idle', 'waiting'] as const) {
    await writeStatus(dir, process.pid, { status: state });
    assert.equal((await readSession(process.pid, { home: dir }))?.state, state);
  }
});

test('a stale file left by a hard kill is rejected, not reported', async () => {
  const dir = await home();
  const pid = deadPid();
  // The file is exactly what a graceful exit would have deleted and a SIGKILL
  // did not. Its `procStart` is even self-consistent — liveness is the only
  // thing standing between it and a phantom `busy` session in the list.
  await writeStatus(dir, pid, { status: 'busy' });
  assert.equal((await readSession(pid, { home: dir }))?.state, undefined);
});

test('a live pid whose procStart disagrees is a reused pid, and is rejected', async () => {
  const dir = await home();
  // Alive, readable, well-formed, and about a process that no longer exists:
  // this is the case `kill(pid, 0)` alone cannot catch, and the reason Claude
  // Code records `procStart` at all.
  await writeStatus(dir, process.pid, { status: 'busy', procStart: '1' });
  assert.equal((await readSession(process.pid, { home: dir }))?.state, undefined);

  // Same file, right start time: the guard rejects the mismatch and nothing else.
  await writeStatus(dir, process.pid, { status: 'busy' });
  assert.equal((await readSession(process.pid, { home: dir }))?.state, 'busy');
});

test('which session and what it is doing come from one read', async () => {
  const dir = await home();
  await writeStatus(dir, process.pid, { status: 'busy' });

  // Both, together: a `/resume` rewrites the two at once, and both callers — the
  // status poller and the session list — re-bind the row off the id in the same
  // snapshot the state came from, never off a later read.
  assert.deepEqual(await readSession(process.pid, { home: dir }), {
    sessionId: SESSION_ID,
    state: 'busy',
  });

  // A file this build recognises but that names no session: the state stands on
  // its own, and it is the caller that decides what it can attribute it to.
  await writeStatus(dir, process.pid, { status: 'busy', sessionId: '' });
  assert.deepEqual(await readSession(process.pid, { home: dir }), { state: 'busy' });
});

test('nothing about the file’s contents can make this throw or guess', async () => {
  const dir = await home();
  await mkdir(join(dir, '.claude', 'sessions'), { recursive: true });

  // Missing entirely — the normal case for a provider that is not Claude Code.
  assert.equal((await readSession(process.pid, { home: dir }))?.state, undefined);

  for (const body of ['', '{ not json', 'null', '[]', '"a string"', '42']) {
    await writeFile(sessionStatusPath(process.pid, dir), body);
    assert.equal((await readSession(process.pid, { home: dir }))?.state, undefined, body);
  }

  // A status this build does not know must not be forwarded to the badge.
  await writeStatus(dir, process.pid, { status: 'compacting' });
  assert.equal((await readSession(process.pid, { home: dir }))?.state, undefined);

  // A file whose own `pid` disagrees with its name is a shape tether does not
  // understand, and guessing is how a wrong badge gets shown.
  await writeStatus(dir, process.pid, { pid: process.pid + 1 });
  assert.equal((await readSession(process.pid, { home: dir }))?.state, undefined);
});

test('a pid that is not a pid is refused before anything is read', async () => {
  const dir = await home();
  for (const pid of [0, -1, 1.5, Number.NaN]) {
    assert.equal((await readSession(pid, { home: dir }))?.state, undefined, String(pid));
  }
});
