/**
 * Against a real database file in a temporary state directory — never the user's
 * own `~/.local/state/tether`. The reconcile test drives a real tmux server for
 * the same reason `tmux.test.ts` does: what tmux actually does is the whole point.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import { stateDir } from '../db.ts';
import {
  createSession,
  getSession,
  listSessions,
  markDead,
  openRegistry,
  reconcile,
  reconcileWithTmux,
  removeDeadSession,
  revive,
  setProviderSessionId,
} from './registry.ts';
import { killServer, newSession } from './tmux.ts';

/** The sessions here start in temporary directories, not under the default root. */
process.env['TETHER_ALLOWED_ROOTS'] = tmpdir();

/** A database of our own, in a directory removed however the test ends. */
async function dbPathFor(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tether-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'state', 'tether.sqlite');
}

function socketFor(t: TestContext): string {
  const socket = `tether-test-${randomUUID().slice(0, 8)}`;
  t.after(async () => {
    await killServer(socket);
    await rm(join(tmpdir(), `tmux-${process.getuid?.() ?? ''}`, socket), { force: true });
  });
  return socket;
}

function sample(overrides: Partial<Parameters<typeof createSession>[1]> = {}) {
  const id = randomUUID();
  return {
    id,
    provider: 'claude-code',
    cwd: tmpdir(),
    title: 'a title',
    tmuxName: `tether-${id.slice(0, 8)}`,
    ...overrides,
  };
}

test('the state directory is private, honours XDG and keeps a legacy install', async (t) => {
  const path = await dbPathFor(t);
  const db = openRegistry(path);
  t.after(() => db.close());

  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const previous = {
    xdg: process.env['XDG_STATE_HOME'],
    current: process.env['RCAGENT_STATE_DIR'],
    legacy: process.env['TETHER_STATE_DIR'],
  };
  const root = dirname(path);
  process.env['XDG_STATE_HOME'] = root;
  delete process.env['RCAGENT_STATE_DIR'];
  delete process.env['TETHER_STATE_DIR'];
  t.after(() => {
    for (const [key, value] of [
      ['XDG_STATE_HOME', previous.xdg],
      ['RCAGENT_STATE_DIR', previous.current],
      ['TETHER_STATE_DIR', previous.legacy],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  assert.equal(stateDir(), join(root, 'remote-control-agent'));
  await mkdir(join(root, 'tether'));
  assert.equal(stateDir(), join(root, 'tether'));
  await mkdir(join(root, 'remote-control-agent'));
  assert.equal(stateDir(), join(root, 'tether'));
  process.env['RCAGENT_STATE_DIR'] = join(root, 'chosen');
  assert.equal(stateDir(), join(root, 'chosen'));
});

test('the schema is idempotent on reopen and rows survive', async (t) => {
  const path = await dbPathFor(t);
  const first = openRegistry(path);
  const row = createSession(first, sample({ title: 'survives' }));
  first.close();

  // The second open applies the same schema to a database that already has it.
  const second = openRegistry(path);
  t.after(() => second.close());
  assert.deepEqual(getSession(second, row.id), row);

  const third = openRegistry(path);
  third.close();
});

test('an existing registry gains the nullable removal column in place', async (t) => {
  const path = await dbPathFor(t);
  await mkdir(dirname(path), { recursive: true });
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, provider TEXT NOT NULL,
      provider_session_id TEXT, cwd TEXT NOT NULL, title TEXT NOT NULL,
      tmux_name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, dead_at INTEGER
    )
  `);
  old.close();

  const migrated = openRegistry(path);
  t.after(() => migrated.close());
  const columns = migrated.prepare("PRAGMA table_info('sessions')").all() as unknown as {
    name: string;
  }[];
  assert.ok(columns.some((column) => column.name === 'removed_at'));
  assert.deepEqual(listSessions(migrated), []);
});

test('a session round-trips, with machine_id local and no provider session id yet', async (t) => {
  const db = openRegistry(await dbPathFor(t));
  t.after(() => db.close());

  const created = createSession(db, sample({ cwd: '/tmp', title: 'round trip' }));
  assert.equal(created.machineId, 'local');
  assert.equal(created.provider, 'claude-code');
  assert.equal(created.cwd, '/tmp');
  assert.equal(created.title, 'round trip');
  assert.equal(created.deadAt, null);
  assert.ok(created.createdAt > 0 && created.updatedAt === created.createdAt);

  assert.deepEqual(listSessions(db), [created]);
  assert.deepEqual(getSession(db, created.id), created);
  // An unambiguous prefix is an id, which is what makes the CLI usable by hand.
  assert.deepEqual(getSession(db, created.id.slice(0, 8)), created);
  assert.equal(getSession(db, randomUUID()), undefined);
});

test('provider_session_id starts null and back-fills', async (t) => {
  const db = openRegistry(await dbPathFor(t));
  t.after(() => db.close());

  // Codex creates no session identity until the first user message, so the row is
  // provisional from spawn.
  const created = createSession(db, sample());
  assert.equal(created.providerSessionId, null);

  setProviderSessionId(db, created.id, 'e5e3b179-8644-43df-a5e6-b07d971c82ea');
  const filled = getSession(db, created.id)!;
  assert.equal(filled.providerSessionId, 'e5e3b179-8644-43df-a5e6-b07d971c82ea');
  assert.ok(filled.updatedAt >= created.updatedAt);
});

test('only a dead session can be removed from the list, and its provider claim remains', async (t) => {
  const db = openRegistry(await dbPathFor(t));
  t.after(() => db.close());

  const session = createSession(db, sample({ title: 'remove me' }));
  setProviderSessionId(db, session.id, 'provider-conversation');
  assert.equal(removeDeadSession(db, session.id), false, 'a running session is never removed');
  assert.equal(listSessions(db).length, 1);

  markDead(db, session.id);
  assert.equal(removeDeadSession(db, session.id), true);
  assert.deepEqual(listSessions(db), []);
  assert.equal(getSession(db, session.id), undefined, 'ordinary APIs no longer see the row');
  assert.equal(removeDeadSession(db, session.id), false, 'removal is single-shot');
  assert.equal(revive(db, session.id), false, 'a removed row cannot be resumed by a stale caller');

  const tombstone = db
    .prepare('SELECT provider_session_id, removed_at FROM sessions WHERE id = ?')
    .get(session.id) as { provider_session_id: string; removed_at: number };
  assert.equal(tombstone.provider_session_id, 'provider-conversation');
  assert.ok(tombstone.removed_at > 0, 'the hidden row keeps the provider identity claimed');
});

test('reconcile marks a row dead when its tmux session is gone', async (t) => {
  const socket = socketFor(t);
  const db = openRegistry(await dbPathFor(t));
  t.after(() => db.close());

  const alive = createSession(db, sample({ title: 'alive' }));
  const doomed = createSession(db, sample({ title: 'doomed' }));
  await newSession(socket, { name: alive.tmuxName, cwd: tmpdir(), command: ['/bin/sh'] });
  await newSession(socket, { name: doomed.tmuxName, cwd: tmpdir(), command: ['/bin/sh'] });

  assert.equal(await reconcileWithTmux(db, socket), 0);
  assert.equal(getSession(db, doomed.id)!.deadAt, null);

  // The drift this exists for: the tmux session dies while tether is not looking.
  await killServer(socket);
  await newSession(socket, { name: alive.tmuxName, cwd: tmpdir(), command: ['/bin/sh'] });

  assert.equal(await reconcileWithTmux(db, socket), 1);
  const dead = getSession(db, doomed.id)!;
  assert.ok(dead.deadAt !== null && dead.deadAt > 0);
  assert.equal(getSession(db, alive.id)!.deadAt, null);

  // Dead, not deleted — PR #12 resumes it from the row.
  assert.equal(listSessions(db).length, 2);
  // Idempotent: a second pass changes nothing and does not move dead_at.
  assert.equal(await reconcileWithTmux(db, socket), 0);
  assert.deepEqual(getSession(db, doomed.id), dead);
});

test('reconcile against no live sessions at all marks every live row dead', async (t) => {
  const db = openRegistry(await dbPathFor(t));
  t.after(() => db.close());

  const a = createSession(db, sample());
  const b = createSession(db, sample());
  markDead(db, b.id);
  const alreadyDead = getSession(db, b.id)!;

  // The empty-list case is its own SQL path — `NOT IN ()` is a syntax error.
  assert.equal(reconcile(db, [], Date.now()), 1);
  assert.ok(getSession(db, a.id)!.deadAt !== null);
  assert.deepEqual(getSession(db, b.id), alreadyDead);
});

test('reconcile never judges a row created after the snapshot it is judging against', async (t) => {
  const db = openRegistry(await dbPathFor(t));
  t.after(() => db.close());

  const snapshotAt = Date.now();
  // The race `tether ls` loses without this: a `tether new` that lands after the
  // pane read has no pane in the snapshot and would otherwise be marked dead.
  const fresh = createSession(db, sample({ now: snapshotAt + 1 }));

  assert.equal(reconcile(db, [], snapshotAt), 0);
  assert.equal(getSession(db, fresh.id)!.deadAt, null);
});

test('reconcile never re-kills a row revived after the snapshot it is judging against', async (t) => {
  const db = openRegistry(await dbPathFor(t));
  t.after(() => db.close());

  const row = createSession(db, sample());
  markDead(db, row.id);

  // The interleaving: `tether ls` reads the panes (this row's is gone) and is then
  // overtaken by a `tether resume`, which starts the pane and revives the row. The
  // stale UPDATE must not undo that — nothing else ever clears dead_at, so the row
  // would be stuck dead with its agent running, and resume could not fix it.
  const snapshotAt = Date.now();
  // Clock resolution, so the revive lands strictly after the snapshot as it would.
  await new Promise((r) => setTimeout(r, 2));
  revive(db, row.id);

  assert.equal(reconcile(db, [], snapshotAt), 0);
  assert.equal(getSession(db, row.id)!.deadAt, null);
});
