/**
 * The cursor: what a reconnecting client is sent, and what it is told when the
 * gap is wider than the server's memory. A silent partial history is the bug
 * this whole mechanism exists to make impossible.
 */

import type { ServerFrame } from '@tether/shared';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import { projectDir } from '../providers/claude-code/transcript.ts';
import { Conversations, stderrWarn, TAIL_EVENTS } from './conversations.ts';
import { applyRegistrySchema, createSession, getSession, type Session } from './registry.ts';

const PROVIDER_SESSION = '11111111-2222-4333-8444-555555555555';
const POLL = 15;

/**
 * Stamped from the clock rather than a fixed instant: `findTranscript` identifies
 * a transcript by when its records begin, so a session's own must not begin
 * before the session did.
 */
function userRecord(n: number): string {
  return `${JSON.stringify({
    type: 'user',
    uuid: `uuid-${n}`,
    timestamp: new Date(Date.now() + n).toISOString(),
    version: '2.1.220',
    message: { role: 'user', content: `message ${n}` },
  })}\n`;
}

async function harness(t: TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'tether-conv-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = join(home, 'work');
  await mkdir(cwd);
  const dir = projectDir(cwd, home);
  await mkdir(dir, { recursive: true });
  const transcript = join(dir, `${PROVIDER_SESSION}.jsonl`);

  const db = new DatabaseSync(':memory:');
  applyRegistrySchema(db);
  const session: Session = createSession(db, {
    id: '99999999-8888-4777-8666-555555555555',
    provider: 'claude-code',
    cwd,
    title: 'work',
    tmuxName: 'tether-99999999',
    now: Date.now() - 1000,
  });

  const warnings: string[] = [];
  const conversations = new Conversations(db, {
    home,
    pollMs: POLL,
    warn: (message) => warnings.push(message),
  });
  t.after(() => conversations.closeAll());

  return { db, session, conversations, transcript, warnings };
}

/** Collects frames, and waits for a given number of them to arrive. */
function sink() {
  const frames: ServerFrame[] = [];
  const send = (frame: ServerFrame) => frames.push(frame);
  const waitFor = async (count: number) => {
    for (let i = 0; i < 200 && frames.length < count; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(frames.length, count, `expected ${count} frames, got ${JSON.stringify(frames)}`);
  };
  return { frames, send, waitFor };
}

function seqs(frames: readonly ServerFrame[]): number[] {
  return frames.filter((f) => f.c === 'conv').map((f) => f.seq);
}

test('the history route reads the whole transcript and numbers it from 1', async (t) => {
  const h = await harness(t);

  assert.deepEqual(await h.conversations.history(h.session), { seq: 0, events: [] }, 'no file yet');

  await writeFile(h.transcript, userRecord(1) + userRecord(2));
  const history = await h.conversations.history(h.session);
  assert.deepEqual(seqsOf(history.events), [1, 2]);
  assert.equal(history.version, '2.1.220', 'the transcript says which version wrote it');
  assert.equal(
    getSession(h.db, h.session.id)?.providerSessionId,
    PROVIDER_SESSION,
    'the provisional row is back-filled with the provider’s own session id',
  );

  // A record still being written is not part of the history until it is whole.
  await appendFile(h.transcript, '{"type":"user","uuid":"partia');
  assert.deepEqual(seqsOf((await h.conversations.history(h.session)).events), [1, 2]);
});

function seqsOf(events: readonly { seq: number }[]): number[] {
  return events.map((e) => e.seq);
}

test('a live subscriber is sent each new event exactly once, in order', async (t) => {
  const h = await harness(t);
  await writeFile(h.transcript, userRecord(1));

  const client = sink();
  await h.conversations.subscribe(h.session, 0, client.send);
  assert.deepEqual(seqs(client.frames), [1], 'what was already there');

  await appendFile(h.transcript, userRecord(2) + userRecord(3));
  await client.waitFor(3);
  assert.deepEqual(seqs(client.frames), [1, 2, 3]);
  assert.deepEqual(h.warnings, []);
});

test('a reconnect with `since` gets the gap, with no hole and no duplicate', async (t) => {
  const h = await harness(t);
  await writeFile(h.transcript, userRecord(1) + userRecord(2));

  const first = sink();
  const leave = await h.conversations.subscribe(h.session, 0, first.send);
  assert.deepEqual(seqs(first.frames), [1, 2]);

  // The client is gone while the session keeps talking — the tailer is still
  // running for the other viewer, so the events are in memory when it returns.
  const other = sink();
  await h.conversations.subscribe(h.session, 2, other.send);
  leave();
  await appendFile(h.transcript, userRecord(3) + userRecord(4));
  await other.waitFor(2);

  const back = sink();
  await h.conversations.subscribe(h.session, 2, back.send);
  assert.deepEqual(seqs(back.frames), [3, 4], 'exactly what it missed');
});

test('a `since` older than the tail is told to refetch, not sent half a history', async (t) => {
  const h = await harness(t);
  let file = '';
  for (let n = 1; n <= TAIL_EVENTS + 10; n += 1) file += userRecord(n);
  await writeFile(h.transcript, file);

  const client = sink();
  await h.conversations.subscribe(h.session, 1, client.send);
  assert.deepEqual(client.frames, [{ c: 'refetch' }]);

  // And the boundary itself: the oldest event still in the tail is replayable.
  const edge = sink();
  const last = TAIL_EVENTS + 10;
  await h.conversations.subscribe(h.session, last - TAIL_EVENTS, edge.send);
  assert.deepEqual(
    seqs(edge.frames),
    Array.from({ length: TAIL_EVENTS }, (_, i) => last - TAIL_EVENTS + 1 + i),
    'the whole tail, contiguous',
  );
});

test('a `since` ahead of the tailer is caught up, not told to refetch', async (t) => {
  const h = await harness(t);
  await writeFile(h.transcript, userRecord(1) + userRecord(2));

  // The race the documented handshake produces: `history()` reads the file
  // itself, the tailer only moves when its watch or its poll fires, so a client
  // arrives holding a `seq` past what the tailer has ingested. `seq` is
  // absolute, so it subscribes and the stream catches up — refetching it would
  // just lose the same race again, for as long as the session keeps talking.
  const history = await h.conversations.history(h.session);
  assert.equal(history.seq, 2);

  const client = sink();
  await h.conversations.subscribe(h.session, history.seq + 2, client.send);
  assert.deepEqual(client.frames, [], 'no refetch, and nothing it already holds');

  await appendFile(h.transcript, userRecord(3) + userRecord(4) + userRecord(5));
  await client.waitFor(3);
  assert.deepEqual(seqs(client.frames), [3, 4, 5], 'the client drops 3 and 4 as duplicates');
});

test('a transcript that exists and cannot be read is a failure, not an empty history', async (t) => {
  const h = await harness(t);
  await writeFile(h.transcript, userRecord(1));
  // Read once so the row carries the provider's session id, which is how a real
  // session reaches the transcript by name rather than by searching for it.
  await h.conversations.history(h.session);
  const known = getSession(h.db, h.session.id);
  assert.ok(known?.providerSessionId);

  await rm(h.transcript);
  // A directory in its place: it is still there to be named, and reading it fails.
  await mkdir(h.transcript);

  await assert.rejects(() => h.conversations.history(known));
  assert.ok(
    h.warnings.some((w) => w.startsWith('cannot read ')),
    `expected a warning, got ${JSON.stringify(h.warnings)}`,
  );
});

test('a transcript that does not exist yet is waited for, not failed', async (t) => {
  const h = await harness(t);

  const client = sink();
  await h.conversations.subscribe(h.session, 0, client.send);
  assert.deepEqual(client.frames, [], 'nothing to say yet, and no error either');

  await writeFile(h.transcript, userRecord(1));
  await client.waitFor(1);
  assert.deepEqual(seqs(client.frames), [1]);
});

test('a warning with nowhere else to go reaches the operator, once per complaint', (t) => {
  const written: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });

  const warn = stderrWarn();
  warn('unknown transcript record type weather-forecast');
  warn('unknown transcript record type weather-forecast');
  // The same complaint about a different record is still the same complaint —
  // a session full of an unknown type must not be a session full of stderr.
  warn(`user record ${PROVIDER_SESSION} has no usable content`);
  warn('user record 99999999-8888-4777-8666-555555555555 has no usable content');

  assert.equal(written.length, 2, written.join(''));
  assert.match(written[0] ?? '', /weather-forecast/);
});

test('a sink that has gone quiet says so, once, rather than just stopping', (t) => {
  const written: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });

  const warn = stderrWarn();
  for (let n = 0; n < 500; n += 1) warn(`unknown transcript record type type-${n}`);

  const suppressed = written.filter((line) => line.includes('suppressed'));
  assert.equal(suppressed.length, 1, 'said once, not once per dropped warning');
  assert.equal(written.at(-1), suppressed[0], 'and it is the last thing the sink says');
  assert.ok(written.length < 500, `bounded: ${written.length}`);
});

test('the last viewer leaving stops the tailer', async (t) => {
  const h = await harness(t);
  await writeFile(h.transcript, userRecord(1));

  const client = sink();
  const leave = await h.conversations.subscribe(h.session, 0, client.send);
  leave();
  await appendFile(h.transcript, userRecord(2));
  await new Promise((resolve) => setTimeout(resolve, POLL * 4));
  assert.deepEqual(seqs(client.frames), [1], 'nothing is sent to a socket that left');
});
