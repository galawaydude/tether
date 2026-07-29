/**
 * The tailer. The two cases that matter are the two the flush timer guarantees
 * will happen: a file that grows under you, and a read that lands mid-line.
 */

import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { findTranscript, projectDir, sanitizePath, tailLines } from './transcript.ts';

async function temp(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tether-tail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Poll fast, so a test that depends on the fallback is not a slow test. */
const POLL = 15;

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('the project directory is Claude Code’s own sanitisation of the cwd', () => {
  assert.equal(sanitizePath('/home/u/.treehouse/t-1/x'), '-home-u--treehouse-t-1-x');
  assert.equal(projectDir('/home/u/proj', '/home/u'), '/home/u/.claude/projects/-home-u-proj');
});

test('appended lines are read from the offset, never the file again', async (t) => {
  const dir = await temp(t);
  const path = join(dir, 'session.jsonl');
  await writeFile(path, '{"n":1}\n{"n":2}\n');

  const batches: string[][] = [];
  const tail = await tailLines(path, (lines) => batches.push(lines), { pollMs: POLL });
  t.after(() => tail.stop());

  assert.deepEqual(batches, [['{"n":1}', '{"n":2}']], 'the catch-up read is complete');

  await appendFile(path, '{"n":3}\n');
  await until(() => batches.length === 2, 'the appended line');
  assert.deepEqual(batches[1], ['{"n":3}'], 'only what is new — the first two are not re-read');
});

test('a partial line is not delivered until it is complete', async (t) => {
  const dir = await temp(t);
  const path = join(dir, 'session.jsonl');
  // Exactly what the 100ms flush timer produces: a read landing mid-write.
  await writeFile(path, '{"n":1}\n{"partia');

  const lines: string[] = [];
  const tail = await tailLines(path, (batch) => lines.push(...batch), { pollMs: POLL });
  t.after(() => tail.stop());

  assert.deepEqual(lines, ['{"n":1}']);

  await appendFile(path, 'l":true}\n');
  await until(() => lines.length === 2, 'the completed line');
  assert.deepEqual(lines[1], '{"partial":true}');
});

test('a multi-byte glyph split across two writes survives', async (t) => {
  const dir = await temp(t);
  const path = join(dir, 'session.jsonl');
  const glyph = Buffer.from('héllo… 🌍', 'utf8');
  await writeFile(path, glyph.subarray(0, 3));

  const lines: string[] = [];
  const tail = await tailLines(path, (batch) => lines.push(...batch), { pollMs: POLL });
  t.after(() => tail.stop());

  await appendFile(path, Buffer.concat([glyph.subarray(3), Buffer.from('\n')]));
  await until(() => lines.length === 1, 'the completed line');
  assert.equal(lines[0], 'héllo… 🌍');
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
  await writeFile(join(dir, `${id}.jsonl`), '{"type":"user"}\n');
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

test('the mtime tolerance is a fallback for a coarse filesystem, never a preference', async (t) => {
  const home = await temp(t);
  const cwd = join(home, 'work');
  await mkdir(cwd);
  const dir = projectDir(cwd, home);
  await mkdir(dir, { recursive: true });

  const createdAt = Date.now();
  const stamp = async (id: string, at: number) => {
    const path = join(dir, `${id}.jsonl`);
    await writeFile(path, '{"type":"user"}\n');
    await utimes(path, new Date(at), new Date(at));
  };

  // What a filesystem that rounds an mtime down does to this session's own
  // transcript: written after `createdAt`, stamped before it.
  const rounded = '11111111-1111-4111-8111-111111111111';
  await stamp(rounded, createdAt - 500);
  assert.equal(
    (await findTranscript({ cwd, createdAt, home }))?.providerSessionId,
    rounded,
    'the only candidate there is, rather than no conversation at all',
  );

  // A transcript that genuinely qualifies takes it back.
  const qualifies = '22222222-2222-4222-8222-222222222222';
  await stamp(qualifies, createdAt + 10);
  assert.equal((await findTranscript({ cwd, createdAt, home }))?.providerSessionId, qualifies);

  // And the tolerance is a tolerance: past it, an older session's transcript is
  // still not this one's, and `#start` waits for one that is.
  const stale = new Date(createdAt - 5000);
  await utimes(join(dir, `${qualifies}.jsonl`), stale, stale);
  await utimes(join(dir, `${rounded}.jsonl`), stale, stale);
  assert.equal(await findTranscript({ cwd, createdAt, home }), undefined);
});
