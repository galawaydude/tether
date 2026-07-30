/**
 * The tailer both providers share. The two cases that matter are the two every
 * provider's flush timer guarantees will happen: a file that grows under you,
 * and a read that lands mid-line — mid-glyph included.
 */

import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { tailLines } from './tail.ts';

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

test('catchUp delivers what is on disk now, without waiting for a watch or a poll', async (t) => {
  const dir = await temp(t);
  const path = join(dir, 'session.jsonl');
  await writeFile(path, '{"n":1}\n');

  const lines: string[] = [];
  // A poll far longer than this test, and no reliance on `fs.watch` firing: the
  // point is that the read happens because it was asked for. The Codex
  // permission hook needs exactly this — the `PreToolUse` it has to correlate
  // against is certainly on disk, and it is blocking an agent's turn while it
  // waits, so "the watcher will get to it" is a race it cannot afford.
  const tail = await tailLines(path, (batch) => lines.push(...batch), { pollMs: 60_000 });
  t.after(() => tail.stop());
  assert.deepEqual(lines, ['{"n":1}']);

  await appendFile(path, '{"n":2}\n{"n":3}\n');
  await tail.catchUp();
  assert.deepEqual(
    lines,
    ['{"n":1}', '{"n":2}', '{"n":3}'],
    'read to the end, by the time it returns',
  );

  // And it means "to the end" even with a read already in flight: reads are
  // serialised, so awaiting one cannot return while another is still going.
  await appendFile(path, '{"n":4}\n');
  await Promise.all([tail.catchUp(), tail.catchUp(), tail.catchUp()]);
  assert.deepEqual(lines.at(-1), '{"n":4}');
  assert.equal(lines.length, 4, 'and nothing was delivered twice');
});
