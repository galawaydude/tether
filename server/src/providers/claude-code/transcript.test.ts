/**
 * Finding the right transcript. Following it is `../tail.test.ts`.
 */

import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { findTranscript, projectDir, sanitizePath, type StartMemo } from './transcript.ts';

async function temp(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tether-tail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A transcript record stamped at `at` — which is what identifies the file. */
function record(at: number): string {
  return `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: new Date(at).toISOString() })}\n`;
}

test('the project directory is Claude Code’s own sanitisation of the cwd', () => {
  assert.equal(sanitizePath('/home/u/.treehouse/t-1/x'), '-home-u--treehouse-t-1-x');
  assert.equal(projectDir('/home/u/proj', '/home/u'), '/home/u/.claude/projects/-home-u-proj');
});

test('finding a transcript names the provider’s own session id', async (t) => {
  const home = await temp(t);
  const cwd = join(home, 'work');
  await mkdir(cwd);
  const dir = projectDir(cwd, home);
  await mkdir(dir, { recursive: true });

  const createdAt = Date.now();
  assert.equal(await findTranscript({ cwd, createdAt, home }), undefined, 'nothing yet');

  const id = '11111111-2222-4333-8444-555555555555';
  await writeFile(join(dir, `${id}.jsonl`), record(createdAt + 5));
  const found = await findTranscript({ cwd, createdAt, home });
  assert.equal(found?.providerSessionId, id);
  assert.equal(found?.path, join(dir, `${id}.jsonl`));

  // A transcript written before tether started the session belongs to an older
  // one, and is not this session's however new the directory looks.
  assert.equal(await findTranscript({ cwd, createdAt: Date.now() + 60_000, home }), undefined);

  // Once the id is known, the directory is not searched at all.
  const known = await findTranscript({ cwd, createdAt: 0, providerSessionId: id, home });
  assert.equal(known?.path, join(dir, `${id}.jsonl`));
  assert.equal(
    await findTranscript({ cwd, createdAt: 0, providerSessionId: 'gone', home }),
    undefined,
  );
});

test('a transcript is identified by where its records begin, not by its mtime', async (t) => {
  const home = await temp(t);
  const cwd = join(home, 'work');
  await mkdir(cwd);
  const dir = projectDir(cwd, home);
  await mkdir(dir, { recursive: true });

  const createdAt = Date.now();
  const write = async (id: string, began: number, mtime: number) => {
    const path = join(dir, `${id}.jsonl`);
    await writeFile(path, record(began));
    await utimes(path, new Date(mtime), new Date(mtime));
  };

  // A filesystem whose mtime granularity rounds the stamp below `createdAt`, on
  // a transcript whose own records begin after it. mtime says no, and mtime is
  // not what is being asked.
  const mine = '11111111-1111-4111-8111-111111111111';
  await write(mine, createdAt + 5, createdAt - 1500);
  assert.equal((await findTranscript({ cwd, createdAt, home }))?.providerSessionId, mine);

  // And the race the whole thing is for: another session's transcript, flushed a
  // moment ago so it sorts first, but begun an hour before this session existed.
  const theirs = '22222222-2222-4222-8222-222222222222';
  await write(theirs, createdAt - 3_600_000, createdAt + 1000);
  assert.equal(
    (await findTranscript({ cwd, createdAt, home }))?.providerSessionId,
    mine,
    'somebody else’s conversation is not this session’s, however fresh the file looks',
  );

  // With nothing else to adopt, the answer is to wait rather than to guess.
  await rm(join(dir, `${mine}.jsonl`));
  assert.equal(await findTranscript({ cwd, createdAt, home }), undefined);
});

test('a transcript another session already holds is not adopted by this one', async (t) => {
  const home = await temp(t);
  const cwd = join(home, 'work');
  await mkdir(cwd);
  const dir = projectDir(cwd, home);
  await mkdir(dir, { recursive: true });

  // Two sessions started in the same directory seconds apart: both transcripts
  // begin inside the other's tolerance, so no timestamp can separate them.
  const createdAt = Date.now();
  const write = async (id: string, began: number, mtime: number) => {
    const path = join(dir, `${id}.jsonl`);
    await writeFile(path, record(began));
    await utimes(path, new Date(mtime), new Date(mtime));
  };
  const theirs = '11111111-1111-4111-8111-111111111111';
  const mine = '22222222-2222-4222-8222-222222222222';
  await write(theirs, createdAt - 2000, createdAt + 1000);
  await write(mine, createdAt + 5, createdAt);

  assert.equal(
    (await findTranscript({ cwd, createdAt, home }))?.providerSessionId,
    theirs,
    'on time alone the newest qualifying one wins, and it is the wrong one',
  );
  assert.equal(
    (await findTranscript({ cwd, createdAt, home, claimed: new Set([theirs]) }))?.providerSessionId,
    mine,
    'what the registry has already bound to another session is not a candidate',
  );
});

test('an unchanged candidate is not read a second time', async (t) => {
  const home = await temp(t);
  const cwd = join(home, 'work');
  await mkdir(cwd);
  const dir = projectDir(cwd, home);
  await mkdir(dir, { recursive: true });

  const createdAt = Date.now();
  const path = join(dir, '44444444-4444-4444-8444-444444444444.jsonl');
  const when = new Date(createdAt - 1000);
  const memo: StartMemo = new Map();

  await writeFile(path, record(createdAt - 3_600_000));
  await utimes(path, when, when);
  assert.equal(await findTranscript({ cwd, createdAt, home, memo }), undefined, 'begun too early');

  // Same size, same mtime, different bytes — a state only a re-read could see,
  // and not re-reading is the whole point while discovery retries every second.
  await writeFile(path, record(createdAt + 5));
  await utimes(path, when, when);
  assert.equal(
    await findTranscript({ cwd, createdAt, home, memo }),
    undefined,
    'answered from the memo, not from the file',
  );
  assert.ok(
    await findTranscript({ cwd, createdAt, home, memo: new Map() }),
    'and a scan that has not seen it before reads what is actually there',
  );
});

test('a transcript far older than the session is never opened', async (t) => {
  const home = await temp(t);
  const cwd = join(home, 'work');
  await mkdir(cwd);
  const dir = projectDir(cwd, home);
  await mkdir(dir, { recursive: true });

  // Records that would qualify, on a file last touched hours ago — which cannot
  // happen for a real transcript, since its records are what move its mtime. It
  // is here to pin the pre-filter: the skip must come from mtime alone.
  const createdAt = Date.now();
  const path = join(dir, '55555555-5555-4555-8555-555555555555.jsonl');
  const old = new Date(createdAt - 6 * 60 * 60 * 1000);
  await writeFile(path, record(createdAt + 5));
  await utimes(path, old, old);

  assert.equal(await findTranscript({ cwd, createdAt, home }), undefined);
});

test('a transcript with nothing timestamped yet is waited for, not adopted', async (t) => {
  const home = await temp(t);
  const cwd = join(home, 'work');
  await mkdir(cwd);
  const dir = projectDir(cwd, home);
  await mkdir(dir, { recursive: true });

  const createdAt = Date.now();
  const path = join(dir, '33333333-3333-4333-8333-333333333333.jsonl');
  // The first flush routinely is a record with no timestamp at all, plus however
  // much of the next one the timer caught.
  await writeFile(path, `${JSON.stringify({ type: 'summary' })}\n{"type":"user","time`);
  assert.equal(
    await findTranscript({ cwd, createdAt, home }),
    undefined,
    'unverifiable is not disqualified — `#start` looks again',
  );

  await appendFile(path, `stamp":"${new Date(createdAt + 5).toISOString()}"}\n`);
  assert.ok(await findTranscript({ cwd, createdAt, home }), 'and it is found once it can be');
});
