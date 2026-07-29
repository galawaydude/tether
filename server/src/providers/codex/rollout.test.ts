/**
 * Finding the rollout: with the hook, and — the case that has to keep working —
 * without it. Following the file once found is `../tail.test.ts`.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { hookLogPath, hookLogDir } from './hooks.ts';
import { findRollout, rolloutSessionId } from './rollout.ts';
import { sessionsDir } from './spawn.ts';

const A = '019fac90-fbcb-7121-a9dc-5b4e866eb680';
const B = '019fac91-0000-4000-8000-000000000000';

/**
 * The `<Y>/<M>/<D>` Codex would file a rollout begun at `at` under. Derived
 * rather than hard-coded, because discovery now bounds its walk by that date:
 * a fixture in a fixed directory would only be looked at on one day of the year.
 */
function day(at: number): [string, string, string] {
  const when = new Date(at);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return [String(when.getFullYear()), pad(when.getMonth() + 1), pad(when.getDate())];
}

async function lab(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tether-rollout-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, 'codex');
  const stateDir = join(root, 'state');
  const cwd = join(root, 'work');
  await mkdir(cwd, { recursive: true });
  await mkdir(join(sessionsDir(codexHome), ...day(Date.now())), { recursive: true });
  await mkdir(hookLogDir(stateDir), { recursive: true });
  return { root, codexHome, stateDir, cwd };
}

/** A rollout as Codex names and starts one: `session_meta` first, then a turn. */
async function rollout(
  codexHome: string,
  id: string,
  opts: { cwd: string; began: number; local?: string; filedAt?: number },
): Promise<string> {
  const dir = join(sessionsDir(codexHome), ...day(opts.filedAt ?? Date.now()));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-${opts.local ?? '2026-07-29T12-00-10'}-${id}.jsonl`);
  await writeFile(
    path,
    `${JSON.stringify({
      timestamp: new Date(opts.began).toISOString(),
      type: 'session_meta',
      payload: {
        session_id: id,
        id,
        timestamp: new Date(opts.began).toISOString(),
        cwd: opts.cwd,
        cli_version: '0.145.0',
      },
    })}\n`,
  );
  return path;
}

test('a rollout’s file name is where its session id comes from', () => {
  assert.equal(rolloutSessionId(`/s/2026/07/29/rollout-2026-07-29T12-00-10-${A}.jsonl`), A);
  assert.equal(rolloutSessionId('/s/rollout-2026-07-29T12-00-10-not-a-uuid.jsonl'), undefined);
  assert.equal(rolloutSessionId('/s/notes.jsonl'), undefined);
});

test('a known provider session id is one lookup, with nothing to infer', async (t) => {
  const lb = await lab(t);
  const path = await rollout(lb.codexHome, A, { cwd: lb.cwd, began: Date.now() });
  await rollout(lb.codexHome, B, { cwd: lb.cwd, began: Date.now() });

  assert.deepEqual(
    await findRollout({
      cwd: '/somewhere/else/entirely',
      createdAt: 0,
      providerSessionId: A,
      codexHome: lb.codexHome,
    }),
    { path, providerSessionId: A },
    'the id decides it — cwd and time are not consulted at all',
  );
});

test('a session revived long after it began still finds its rollout', async (t) => {
  const lb = await lab(t);
  // Filed under last year's day directory, which is where a session started then
  // and revived now keeps its conversation. Discovery's walk is bounded by date;
  // this lookup deliberately is not, because the id leaves nothing to infer.
  const old = Date.now() - 400 * 24 * 60 * 60_000;
  const path = await rollout(lb.codexHome, A, { cwd: lb.cwd, began: old, filedAt: old });

  assert.deepEqual(
    await findRollout({
      cwd: lb.cwd,
      createdAt: old,
      providerSessionId: A,
      codexHome: lb.codexHome,
    }),
    { path, providerSessionId: A },
  );

  assert.equal(
    await findRollout({ cwd: lb.cwd, createdAt: Date.now(), codexHome: lb.codexHome }),
    undefined,
    'and a session starting now does not walk back to it, let alone adopt it',
  );
});

test('the SessionStart hook names the session, joined to the pane by ppid', async (t) => {
  const lb = await lab(t);
  const path = await rollout(lb.codexHome, A, { cwd: lb.cwd, began: Date.now() });
  await writeFile(
    hookLogPath(lb.stateDir, A),
    `${JSON.stringify({
      session_id: A,
      transcript_path: path,
      cwd: lb.cwd,
      hook_event_name: 'SessionStart',
      at: Date.now(),
      ppid: 4242,
    })}\n`,
  );

  assert.deepEqual(
    await findRollout({
      cwd: lb.cwd,
      createdAt: Date.now(),
      providerSessionId: null,
      codexHome: lb.codexHome,
      stateDir: lb.stateDir,
      panePid: 4242,
    }),
    { path, providerSessionId: A },
    'this is the back-fill: a provisional row learns its provider session id here',
  );

  assert.equal(
    (
      await findRollout({
        cwd: lb.cwd,
        createdAt: Date.now(),
        providerSessionId: null,
        codexHome: lb.codexHome,
        stateDir: lb.stateDir,
        panePid: 9999,
      })
    )?.providerSessionId,
    A,
    'another pane’s hook is not this pane’s join — but session_meta still finds it',
  );
});

test('without the hook the rollout identifies itself, which is the declined path', async (t) => {
  const lb = await lab(t);
  const createdAt = Date.now();
  const mine = await rollout(lb.codexHome, A, { cwd: lb.cwd, began: createdAt + 20 });
  // A neighbour in another directory, newer, so mtime order alone would pick it.
  const other = join(lb.root, 'other');
  await mkdir(other, { recursive: true });
  await rollout(lb.codexHome, B, { cwd: other, began: createdAt + 40 });

  assert.deepEqual(
    await findRollout({
      cwd: lb.cwd,
      createdAt,
      providerSessionId: null,
      codexHome: lb.codexHome,
      // No stateDir and no panePid: exactly what a user who declined the hook has.
    }),
    { path: mine, providerSessionId: A },
  );
});

test('a rollout another session already holds is not adopted by this one', async (t) => {
  const lb = await lab(t);
  const createdAt = Date.now();
  const first = await rollout(lb.codexHome, A, { cwd: lb.cwd, began: createdAt + 10 });
  const second = await rollout(lb.codexHome, B, {
    cwd: lb.cwd,
    began: createdAt + 20,
    local: '2026-07-29T12-00-20',
  });
  // Both are the same session's directory and both are in time; only `claimed`
  // can separate them, and the binding is permanent once made.
  await utimes(first, new Date(), new Date(createdAt + 9000));
  await utimes(second, new Date(), new Date(createdAt + 8000));

  assert.equal(
    (await findRollout({ cwd: lb.cwd, createdAt, codexHome: lb.codexHome }))?.providerSessionId,
    A,
    'newest first, with nothing claimed',
  );
  assert.equal(
    (
      await findRollout({
        cwd: lb.cwd,
        createdAt,
        codexHome: lb.codexHome,
        claimed: new Set([A]),
      })
    )?.providerSessionId,
    B,
  );
});

test('a rollout from before this session began is never adopted', async (t) => {
  const lb = await lab(t);
  const createdAt = Date.now();
  await rollout(lb.codexHome, A, { cwd: lb.cwd, began: createdAt - 60_000 });

  assert.equal(
    await findRollout({ cwd: lb.cwd, createdAt, codexHome: lb.codexHome }),
    undefined,
    'a session started in the same directory an hour ago is not this one',
  );
});

test('a session with nothing written yet is waited for, not answered wrongly', async (t) => {
  const lb = await lab(t);
  // Codex writes nothing at all until the first user message — no rollout, no
  // hook, no registry row of its own. That window is the whole reason
  // `provider_session_id` is nullable.
  assert.equal(
    await findRollout({
      cwd: lb.cwd,
      createdAt: Date.now(),
      codexHome: lb.codexHome,
      stateDir: lb.stateDir,
      panePid: 4242,
    }),
    undefined,
  );

  // A hook that names a rollout which is not on disk yet is not one to bind to.
  await writeFile(
    hookLogPath(lb.stateDir, A),
    `${JSON.stringify({
      session_id: A,
      transcript_path: join(lb.codexHome, 'sessions/2026/07/29/rollout-nope.jsonl'),
      hook_event_name: 'SessionStart',
      at: Date.now(),
      ppid: 4242,
    })}\n`,
  );
  assert.equal(
    await findRollout({
      cwd: lb.cwd,
      createdAt: Date.now(),
      codexHome: lb.codexHome,
      stateDir: lb.stateDir,
      panePid: 4242,
    }),
    undefined,
  );
});

test('a codex home that does not exist is empty, not an error', async (t) => {
  const lb = await lab(t);
  assert.equal(
    await findRollout({
      cwd: lb.cwd,
      createdAt: Date.now(),
      codexHome: join(lb.root, 'no-such-home'),
    }),
    undefined,
  );
});
