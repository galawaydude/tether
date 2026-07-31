/**
 * Which close code a failed attach gets, against a real registry.
 *
 * All three used to be `CLOSE_NO_SESSION`, which the browser renders as "Session
 * not found" — so a native module that could not spawn, and a session that had
 * simply ended, both told the user the server had lost their work. The registry
 * is the thing that can tell the three apart, so the test drives the same
 * lookup the socket does rather than hand-building rows.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { DatabaseSync } from 'node:sqlite';

import {
  createSession,
  getSessionByTmuxName,
  markDead,
  openRegistry,
} from '../machine/registry.ts';
import {
  CLOSE_ATTACH_FAILED,
  CLOSE_NO_SESSION,
  CLOSE_SESSION_ENDED,
  attachClose,
} from './term-socket.ts';

async function registry(t: TestContext): Promise<DatabaseSync> {
  const dir = await mkdtemp(join(tmpdir(), 'tether-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = openRegistry(join(dir, 'state', 'tether.sqlite'));
  t.after(() => db.close());
  return db;
}

function seed(db: DatabaseSync) {
  const id = randomUUID();
  return createSession(db, {
    id,
    provider: 'claude-code',
    cwd: tmpdir(),
    title: 'a title',
    tmuxName: `tether-${id.slice(0, 8)}`,
  });
}

test('a dead session says it ended, not that the server lost it', async (t) => {
  const db = await registry(t);
  const row = seed(db);
  markDead(db, row.id);

  const dead = getSessionByTmuxName(db, row.tmuxName);
  assert.notEqual(dead, undefined, 'the row stays: a dead session is resumable, not gone');
  assert.deepEqual(attachClose(dead), { code: CLOSE_SESSION_ENDED, reason: 'the session ended' });
});

test('an attach that failed for another reason does not claim the session is missing', async (t) => {
  const db = await registry(t);
  const row = seed(db);

  // The row is live and the attach threw anyway — node-pty unbuilt, a tmux
  // command that failed, whatever it was. This side never saw the exception, so
  // the close code says a terminal could not be opened and nothing more; the
  // exception itself is on the server's log, which is now on by default.
  const close = attachClose(getSessionByTmuxName(db, row.tmuxName));
  assert.equal(close.code, CLOSE_ATTACH_FAILED);
  assert.notEqual(close.code, CLOSE_NO_SESSION, 'the session is right there in the registry');
});

test('a genuinely missing session is the one case that says so', async (t) => {
  const db = await registry(t);
  seed(db);

  assert.equal(getSessionByTmuxName(db, 'tether-nothing'), undefined);
  assert.deepEqual(attachClose(undefined), { code: CLOSE_NO_SESSION, reason: 'no such session' });
});
