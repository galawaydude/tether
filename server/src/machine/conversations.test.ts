/**
 * The cursor: what a reconnecting client is sent, and what it is told when the
 * gap is wider than the server's memory. A silent partial history is the bug
 * this whole mechanism exists to make impossible.
 */

import type { ServerFrame } from '@tether/shared';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import { mapLines as mapClaudeLines } from '../providers/claude-code/events.ts';
import { processStart, sessionStatusPath } from '../providers/claude-code/status.ts';
import { projectDir } from '../providers/claude-code/transcript.ts';
import { mapLines as mapCodexLines } from '../providers/codex/events.ts';
import {
  hooksJsonPath,
  installHook,
  MAX_HOLD_MS,
  PERMISSION_TIMEOUT_SECONDS,
} from '../providers/codex/hooks.ts';
import { Conversations, mapperFor, stderrWarn, TAIL_EVENTS } from './conversations.ts';
import { applyRegistrySchema, createSession, getSession, type Session } from './registry.ts';
import { killServer, listPanes, newSession } from './tmux.ts';

const PROVIDER_SESSION = '11111111-2222-4333-8444-555555555555';
const POLL = 15;

/**
 * The poller tests below start a real tmux session in a temporary directory, and
 * `resolveCwd` confines sessions to the user's home unless this widens it. The
 * confinement itself is `tmux.test.ts`'s subject; nothing here bypasses it.
 */
process.env['TETHER_ALLOWED_ROOTS'] = tmpdir();

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

async function harness(t: TestContext, options: { permissionTimeoutMs?: number } = {}) {
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
    // No status poller: it would shell out to the real tmux on the default
    // socket. The registry file's own mapping is `status.test.ts`.
    statusPollMs: 0,
    warn: (message) => warnings.push(message),
    ...options,
  });
  t.after(() => conversations.closeAll());

  return { db, session, conversations, transcript, warnings, home, cwd };
}

/**
 * Collects frames, and waits for a given number of them to arrive.
 *
 * `state` and `pending` are collected apart from `frames` on purpose: they carry
 * no `seq` and are not part of the cursor contract most of these tests are
 * about, so counting them in would make every assertion here a statement about
 * the badge as well.
 */
function sink() {
  const frames: ServerFrame[] = [];
  const states: Extract<ServerFrame, { c: 'state' }>[] = [];
  const pendings: Extract<ServerFrame, { c: 'pending' }>[] = [];
  const answers: Extract<ServerFrame, { c: 'answer' }>[] = [];
  const send = (frame: ServerFrame) => {
    if (frame.c === 'state') states.push(frame);
    else if (frame.c === 'pending') pendings.push(frame);
    else if (frame.c === 'answer') answers.push(frame);
    else frames.push(frame);
  };
  const waitFor = async (count: number) => {
    for (let i = 0; i < 200 && frames.length < count; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(frames.length, count, `expected ${count} frames, got ${JSON.stringify(frames)}`);
  };
  /** Waits for `count` frames of a kind that is not part of the `seq` stream. */
  const waitForOther = async (list: readonly unknown[], count: number) => {
    for (let i = 0; i < 200 && list.length < count; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(list.length, count, `expected ${count}, got ${JSON.stringify(list)}`);
  };
  return { frames, states, pendings, answers, send, waitFor, waitForOther };
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

test('history keeps an absolute cursor and pages backward in bounded slices', async (t) => {
  const h = await harness(t);
  const total = TAIL_EVENTS * 2 + 10;
  await writeFile(
    h.transcript,
    Array.from({ length: total }, (_, index) => userRecord(index + 1)).join(''),
  );

  const history = await h.conversations.history(h.session);
  assert.equal(history.seq, total);
  assert.equal(history.events.length, TAIL_EVENTS);
  assert.equal(history.truncated, true);
  assert.equal(history.events[0]?.seq, TAIL_EVENTS + 11);
  assert.equal(history.events.at(-1)?.seq, total);

  const earlier = await h.conversations.history(h.session, TAIL_EVENTS + 11);
  assert.equal(earlier.seq, total, 'an archive page never becomes the live cursor');
  assert.equal(earlier.events.length, TAIL_EVENTS);
  assert.equal(earlier.events[0]?.seq, 11);
  assert.equal(earlier.events.at(-1)?.seq, TAIL_EVENTS + 10);
  assert.equal(earlier.truncated, true);

  const first = await h.conversations.history(h.session, 11);
  assert.deepEqual(seqsOf(first.events), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(first.truncated, undefined, 'the first page says there is nothing before it');
});

test('history pages do not split a tool call from its result', async (t) => {
  const h = await harness(t);
  await writeFile(
    h.transcript,
    toolUseRecord(1) +
      toolResultRecord(2) +
      Array.from({ length: TAIL_EVENTS - 1 }, (_, index) => userRecord(index + 3)).join(''),
  );

  const latest = await h.conversations.history(h.session);
  assert.equal(latest.events[0]?.seq, 3);
  assert.ok(latest.events.length <= TAIL_EVENTS);

  const earlier = await h.conversations.history(h.session, 3);
  assert.deepEqual(
    earlier.events.map(({ e }) => e.kind),
    ['tool_call', 'tool_result'],
  );
});

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

// ── the other provider ───────────────────────────────────────────────────────
//
// Two directories and one switch (report §4): the cursor, the tail and the
// fan-out above are the same code for both, and what changes is which mapper
// reads which file. What is genuinely new for Codex is `state`, which is not
// numbered — see the `ServerFrame` comment for why it cannot be.

const CODEX_SESSION = '019fac90-fbcb-7121-a9dc-5b4e866eb680';

function rolloutLine(payload: Record<string, unknown>, at = Date.now()): string {
  return `${JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload })}\n`;
}

/**
 * Where Codex would file a rollout begun at `at`: `sessions/<Y>/<M>/<D>` and a
 * `rollout-<local ts>-<uuid>.jsonl` inside it, both in **local** time, as
 * `rollout.ts` reads them.
 *
 * Derived from the session's own clock rather than written out, because
 * `findRollout` walks day directories from `createdAt - STALE_MTIME_MS` down and
 * stops there: a fixture stamped with the day it was authored on is invisible to
 * the search from the next midnight onwards.
 */
function rolloutPath(codexHome: string, at: number): { day: string; path: string } {
  const when = new Date(at);
  const pad = (part: number): string => String(part).padStart(2, '0');
  const [y, m, d] = [String(when.getFullYear()), pad(when.getMonth() + 1), pad(when.getDate())];
  const day = join(codexHome, 'sessions', y, m, d);
  const clock = `${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
  return { day, path: join(day, `rollout-${y}-${m}-${d}T${clock}-${CODEX_SESSION}.jsonl`) };
}

async function codexHarness(t: TestContext, options: { permissionTimeoutMs?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tether-conv-codex-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, 'codex');
  const stateDir = join(root, 'state');
  const cwd = join(root, 'work');
  await mkdir(cwd);
  const createdAt = Date.now() - 1000;
  const { day, path: rollout } = rolloutPath(codexHome, createdAt);
  await mkdir(day, { recursive: true });
  await mkdir(join(stateDir, 'codex-hooks'), { recursive: true });
  const hookLog = join(stateDir, 'codex-hooks', `${CODEX_SESSION}.ndjson`);
  // The real installer, into a scratch CODEX_HOME. tether will not hold a Codex
  // turn unless the `timeout` on disk is the one the hold is sized against (the
  // invariant in `providers/permission.ts`), so a session that can be answered
  // is one whose hook is really installed — writing the log by hand is not it.
  await installHook({ codexHome, stateDir });

  const db = new DatabaseSync(':memory:');
  applyRegistrySchema(db);
  const session: Session = createSession(db, {
    id: '77777777-8888-4777-8666-555555555555',
    provider: 'codex',
    cwd,
    title: 'work',
    tmuxName: 'tether-77777777',
    now: createdAt,
  });
  // `session_meta` is what identifies a rollout when the hook was declined, and
  // it has to be there before anything else in the file.
  await writeFile(
    rollout,
    `${JSON.stringify({
      timestamp: new Date(createdAt + 10).toISOString(),
      type: 'session_meta',
      payload: {
        session_id: CODEX_SESSION,
        cwd,
        timestamp: new Date(createdAt + 10).toISOString(),
        cli_version: '0.145.0',
      },
    })}\n`,
  );

  const conversations = new Conversations(db, { codexHome, stateDir, pollMs: POLL, ...options });
  t.after(() => conversations.closeAll());
  return { db, session, conversations, rollout, hookLog, codexHome, stateDir };
}

test('a codex session is read by the codex mapper and back-fills its own row', async (t) => {
  const h = await codexHarness(t);
  await appendFile(h.rollout, rolloutLine({ type: 'user_message', message: 'hello codex' }));

  const history = await h.conversations.history(h.session);
  assert.equal(history.version, '0.145.0', 'from `session_meta`, not from a Claude Code field');
  assert.deepEqual(
    history.events.map((e) => e.e.kind),
    ['user'],
  );
  assert.equal(
    getSession(h.db, h.session.id)?.providerSessionId,
    CODEX_SESSION,
    'the provisional row Codex left null is back-filled once the rollout exists',
  );
});

test('a codex subscriber is told the state, and told again when it moves', async (t) => {
  const h = await codexHarness(t);
  const client = sink();
  const leave = await h.conversations.subscribe(h.session, 0, client.send);
  t.after(leave);

  await client.waitForOther(client.states, 1);
  assert.deepEqual(client.states[0], { c: 'state', state: 'idle' }, 'on arrival, unnumbered');

  // busy and idle come out of the rollout, which is there whether or not the
  // user accepted the hook.
  await appendFile(h.rollout, rolloutLine({ type: 'task_started', turn_id: 't1' }));
  await client.waitForOther(client.states, 2);
  assert.deepEqual(client.states[1], { c: 'state', state: 'busy' });

  // `waiting` is the one thing that needs the hook, and it arrives on the same
  // channel without ever taking a `seq`.
  await appendFile(
    h.hookLog,
    `${JSON.stringify({
      session_id: CODEX_SESSION,
      turn_id: 't1',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
      at: Date.now(),
      ppid: 1,
    })}\n`,
  );
  await client.waitForOther(client.states, 3);
  assert.deepEqual(client.states[2], { c: 'state', state: 'waiting', detail: 'Bash' });

  await appendFile(h.rollout, rolloutLine({ type: 'user_message', message: 'go on' }));
  await client.waitFor(1);
  const conv = client.frames[0];
  assert.ok(conv?.c === 'conv' && conv.e.kind === 'user');
  assert.deepEqual(seqs(client.frames), [1], 'three state frames took no sequence numbers');
});

test('a codex session with no hook log at all still works, and says nothing about it', async (t) => {
  const h = await codexHarness(t);
  const warnings: string[] = [];
  const conversations = new Conversations(h.db, {
    codexHome: join(h.rollout, '..', '..', '..', '..', '..'),
    stateDir: '/nonexistent/tether-state',
    pollMs: POLL,
    warn: (message) => warnings.push(message),
  });
  t.after(() => conversations.closeAll());

  const client = sink();
  const leave = await conversations.subscribe(h.session, 0, client.send);
  t.after(leave);
  await appendFile(h.rollout, rolloutLine({ type: 'task_started', turn_id: 't1' }));
  await client.waitForOther(client.states, 2);

  assert.deepEqual(client.states[1], { c: 'state', state: 'busy' }, 'busy without any hook');
  // Declining is a supported configuration, not an error state: nothing warns,
  // nothing retries, and there is nothing for the user to be nagged about.
  assert.deepEqual(warnings, []);
});

/**
 * The hook edge (report §4, risk 2).
 *
 * A tool call proposed by `PreToolUse` and the transcript record that follows it
 * are the same call twice. The contract these tests hold is that it is shown
 * once: the proposal is retired the moment the record exists, whichever of the
 * two the client learned about first.
 */
const CALL_ID = 'toolu_012hUcdAk6Z4RcnbNgrC7PH4';

function preToolUse(callId = CALL_ID): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: PROVIDER_SESSION,
    tool_name: 'Write',
    tool_use_id: callId,
    tool_input: { file_path: '/tmp/out.txt', content: 'hello\n' },
  };
}

function toolUseRecord(n: number, callId = CALL_ID): string {
  return `${JSON.stringify({
    type: 'assistant',
    uuid: `uuid-${n}`,
    timestamp: new Date(Date.now() + n).toISOString(),
    version: '2.1.220',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: callId, name: 'Write', input: { file_path: '/tmp/out.txt' } },
      ],
    },
  })}\n`;
}

function toolResultRecord(n: number, callId = CALL_ID): string {
  return `${JSON.stringify({
    type: 'user',
    uuid: `uuid-${n}`,
    timestamp: new Date(Date.now() + n).toISOString(),
    version: '2.1.220',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: callId, content: 'done' }],
    },
  })}\n`;
}

test('PreToolUse reaches a watching client as a pending card, with no seq', async (t) => {
  const h = await harness(t);
  await writeFile(h.transcript, userRecord(1));
  const client = sink();
  await h.conversations.subscribe(h.session, 0, client.send);
  await client.waitFor(1);

  h.conversations.hook(h.session, preToolUse());
  await client.waitForOther(client.pendings, 1);
  assert.deepEqual(client.pendings[0]?.e.callId, CALL_ID);
  assert.equal(client.pendings[0]?.e.tool, 'Write');
  // The cursor did not move: a proposal is not a transcript event.
  assert.deepEqual(seqs(client.frames), [1]);
});

test('a proposal made before anyone was watching is there when they arrive', async (t) => {
  const h = await harness(t);
  await writeFile(h.transcript, userRecord(1));
  // Nobody subscribed: this is a phone that is still in a pocket, which is the
  // normal case for a permission prompt.
  h.conversations.hook(h.session, preToolUse());

  const client = sink();
  await h.conversations.subscribe(h.session, 0, client.send);
  await client.waitForOther(client.pendings, 1);
  assert.equal(client.pendings[0]?.e.callId, CALL_ID);
});

test('the transcript record retires the proposal rather than repeating it', async (t) => {
  const h = await harness(t);
  await writeFile(h.transcript, userRecord(1));
  const first = sink();
  const leave = await h.conversations.subscribe(h.session, 0, first.send);
  await first.waitFor(1);

  h.conversations.hook(h.session, preToolUse());
  await first.waitForOther(first.pendings, 1);

  // The turn commits and the same call lands in the transcript.
  await appendFile(h.transcript, toolUseRecord(2));
  await first.waitFor(2);
  leave();

  // A client arriving now is told about the call exactly once, as an event.
  const second = sink();
  await h.conversations.subscribe(h.session, 0, second.send);
  await second.waitFor(2);
  assert.deepEqual(second.pendings, [], 'the proposal is not replayed beside its own record');
  assert.equal(second.frames.filter((f) => f.c === 'conv' && f.e.kind === 'tool_call').length, 1);
});

test('a proposal for a call the transcript already carries is never sent', async (t) => {
  const h = await harness(t);
  await writeFile(h.transcript, userRecord(1) + toolUseRecord(2));
  const client = sink();
  await h.conversations.subscribe(h.session, 0, client.send);
  await client.waitFor(2);

  // The other ordering: on Claude Code 2.1.220 the transcript was measured
  // landing ~150ms *after* the hook, but nothing promises it stays there.
  h.conversations.hook(h.session, preToolUse());
  await new Promise((resolve) => setTimeout(resolve, POLL * 2));
  assert.deepEqual(client.pendings, []);
});

/**
 * Holding the agent, which is what turns tether from an observer of a permission
 * prompt into a participant in it.
 *
 * The contract, in one sentence per test below: a call is held only when someone
 * could answer it and the tool is worth stopping for; the first answer wins and
 * there is never a second; and every way of not answering — the timer, the last
 * viewer leaving, the server stopping — releases the agent to its *own*
 * permission rules rather than denying anything on the user's behalf.
 */
async function held(t: TestContext, options: { permissionTimeoutMs?: number } = {}) {
  const h = await harness(t, options);
  await writeFile(h.transcript, userRecord(1));
  const client = sink();
  const leave = await h.conversations.subscribe(h.session, 0, client.send);
  await client.waitFor(1);
  return { ...h, client, leave };
}

test('a held call blocks the agent until the user taps, and Approve is the answer', async (t) => {
  const h = await held(t);
  const decision = h.conversations.hook(h.session, preToolUse());

  await h.client.waitForOther(h.client.pendings, 1);
  const deadline = h.client.pendings[0]?.deadline;
  assert.ok(deadline !== undefined, 'a held card carries the deadline that puts buttons on it');
  assert.ok(deadline > Date.now(), 'and it is in the future');
  // Still blocked: nothing has been answered, so the agent is waiting.
  assert.deepEqual(h.client.answers, []);

  assert.equal(h.conversations.answer(h.session.id, CALL_ID, 'allow'), true);
  assert.equal(await decision, 'allow');
  await h.client.waitForOther(h.client.answers, 1);
  assert.deepEqual(h.client.answers[0], { c: 'answer', callId: CALL_ID, outcome: 'allow' });
});

test('Deny is the answer too, and it is the hook that carries it back', async (t) => {
  const h = await held(t);
  const decision = h.conversations.hook(h.session, preToolUse());
  await h.client.waitForOther(h.client.pendings, 1);

  h.conversations.answer(h.session.id, CALL_ID, 'deny');
  assert.equal(await decision, 'deny');
  assert.equal(h.client.answers[0]?.outcome, 'deny');
});

test('a hold nobody answers hands the question back — it never denies for them', async (t) => {
  const h = await held(t, { permissionTimeoutMs: 60 });
  // `undefined` is the whole policy: the hook says nothing, so Claude Code's own
  // permission rules decide, which is where the question started.
  assert.equal(await h.conversations.hook(h.session, preToolUse()), undefined);
  await h.client.waitForOther(h.client.answers, 1);
  assert.equal(h.client.answers[0]?.outcome, 'timeout');
});

test('a read-only tool is reported and never held, so a burst of them does not stall', async (t) => {
  const h = await held(t);
  const before = Date.now();
  const decision = await h.conversations.hook(h.session, {
    ...preToolUse(),
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/note.txt' },
  });

  assert.equal(decision, undefined);
  assert.ok(Date.now() - before < 1000, 'it returned at once rather than waiting out the hold');
  await h.client.waitForOther(h.client.pendings, 1);
  // The card is still there — that is PR #10's whole point — but with no
  // deadline, so it offers no button tether could not honour.
  assert.equal(h.client.pendings[0]?.deadline, undefined);
});

test('nothing is held with nobody watching: a background session never pauses', async (t) => {
  const h = await harness(t);
  await writeFile(h.transcript, userRecord(1));
  const before = Date.now();
  assert.equal(await h.conversations.hook(h.session, preToolUse()), undefined);
  assert.ok(Date.now() - before < 1000);
});

test('a timeout of zero turns holding off entirely, and tether is an observer again', async (t) => {
  const h = await held(t, { permissionTimeoutMs: 0 });
  assert.equal(await h.conversations.hook(h.session, preToolUse()), undefined);
  await h.client.waitForOther(h.client.pendings, 1);
  assert.equal(h.client.pendings[0]?.deadline, undefined);
});

test('the first answer wins and there is never a second', async (t) => {
  const h = await held(t);
  const decision = h.conversations.hook(h.session, preToolUse());
  await h.client.waitForOther(h.client.pendings, 1);

  assert.equal(h.conversations.answer(h.session.id, CALL_ID, 'allow'), true);
  // The reflex tap, the second viewer, the answer that raced the timer: all the
  // same shape, and all refused rather than sent at a prompt that has moved on.
  assert.equal(h.conversations.answer(h.session.id, CALL_ID, 'deny'), false);
  assert.equal(h.conversations.answer(h.session.id, CALL_ID, 'allow'), false);
  assert.equal(await decision, 'allow');
  assert.equal(h.client.answers.length, 1);
});

test('an answer for a call that was never held is refused, not invented', async (t) => {
  const h = await held(t);
  assert.equal(h.conversations.answer(h.session.id, 'toolu_never_seen', 'allow'), false);
});

test('a hook whose caller has gone stops being answerable at once', async (t) => {
  // The general invariant (`providers/permission.ts`): tether must never show an
  // answerable card for a decision that cannot land. The hook's request dying is
  // the earliest thing that says so, and it says so without tether knowing whose
  // timeout — a provider's, a Ctrl-C, a kill — ended it.
  const h = await held(t, { permissionTimeoutMs: 60_000 });
  const gone = new AbortController();
  const decision = h.conversations.hook(h.session, preToolUse(), gone.signal);
  await h.client.waitForOther(h.client.pendings, 1);
  assert.ok(
    (h.client.pendings[0]?.deadline ?? 0) > Date.now(),
    'answerable while the caller waits',
  );

  const before = Date.now();
  gone.abort();
  assert.equal(await decision, undefined, 'released, and never a denial');
  // The hold was a minute long, so anything but "at once" means the timer ended
  // it and the abort did nothing.
  assert.ok(Date.now() - before < 1000, 'the abort is what released it');
  await h.client.waitForOther(h.client.answers, 1);
  assert.deepEqual(h.client.answers[0], { c: 'answer', callId: CALL_ID, outcome: 'timeout' });
  assert.equal(
    h.conversations.answer(h.session.id, CALL_ID, 'allow'),
    false,
    'and this is the property: nothing can report an approval nobody received',
  );
});

test('a caller already gone is reported and never held', async (t) => {
  const h = await held(t, { permissionTimeoutMs: 60_000 });
  const gone = new AbortController();
  gone.abort();

  const before = Date.now();
  assert.equal(await h.conversations.hook(h.session, preToolUse(), gone.signal), undefined);
  assert.ok(Date.now() - before < 1000, 'it did not wait out a hold nobody could answer');
  await h.client.waitForOther(h.client.pendings, 1);
  assert.equal(h.client.pendings[0]?.deadline, undefined, 'reported, with no button to offer');
  assert.equal(h.conversations.answer(h.session.id, CALL_ID, 'allow'), false);
});

test('a hook that is answered leaves nothing listening on its signal', async (t) => {
  const h = await held(t, { permissionTimeoutMs: 60_000 });
  const gone = new AbortController();
  const decision = h.conversations.hook(h.session, preToolUse(), gone.signal);
  await h.client.waitForOther(h.client.pendings, 1);
  h.conversations.answer(h.session.id, CALL_ID, 'allow');
  assert.equal(await decision, 'allow');

  // A `close` follows every ordinary reply too, so the settled hold must not
  // hear it — one `answer` frame, and no listener left over per prompt.
  gone.abort();
  await new Promise((resolve) => setTimeout(resolve, POLL * 2));
  assert.equal(h.client.answers.length, 1, 'no second answer for a call already settled');
  assert.equal(h.client.answers[0]?.outcome, 'allow');
});

test('the last viewer leaving releases the agent rather than stranding it', async (t) => {
  // A long hold, so that only the leaving can be what ends it.
  const h = await held(t, { permissionTimeoutMs: 60_000 });
  const decision = h.conversations.hook(h.session, preToolUse());
  await h.client.waitForOther(h.client.pendings, 1);

  h.leave();
  assert.equal(await decision, undefined, 'the phone went away, so the terminal has the question');
});

test('a subscriber looking at the terminal pane does not stall the agent', async (t) => {
  const h = await held(t, { permissionTimeoutMs: 60_000 });
  // Both panes stay mounted (`web/src/app.tsx`), so the socket is subscribed for
  // the whole time a user works in the terminal — which is where the provider's
  // own prompt already is. Holding then would stall every Edit, Write and Bash
  // in front of the very surface that answers them.
  h.conversations.watch(h.session.id, h.client.send, false);

  const before = Date.now();
  assert.equal(await h.conversations.hook(h.session, preToolUse()), undefined);
  assert.ok(Date.now() - before < 1000, 'it returned at once rather than waiting out the hold');
  await h.client.waitForOther(h.client.pendings, 1);
  assert.equal(h.client.pendings[0]?.deadline, undefined, 'reported, with no button to offer');
});

test('summoning the terminal mid-hold releases the agent rather than denying for it', async (t) => {
  const h = await held(t, { permissionTimeoutMs: 60_000 });
  const decision = h.conversations.hook(h.session, preToolUse());
  await h.client.waitForOther(h.client.pendings, 1);

  // Exactly what the last viewer leaving does: the question goes back to the
  // provider's own prompt, which is on the terminal the user has just summoned.
  h.conversations.watch(h.session.id, h.client.send, false);
  assert.equal(await decision, undefined, 'no decision, so Claude Code’s own rules apply');
  assert.equal(h.client.answers[0]?.outcome, 'timeout', 'released, never denied');

  // And dismissing it holds again: the socket never dropped, so there is
  // nothing to re-establish.
  h.conversations.watch(h.session.id, h.client.send, true);
  const second = h.conversations.hook(h.session, preToolUse('toolu_second'));
  await h.client.waitForOther(h.client.pendings, 2);
  assert.ok(h.client.pendings[1]?.deadline !== undefined, 'held again');
  assert.equal(h.conversations.answer(h.session.id, 'toolu_second', 'allow'), true);
  assert.equal(await second, 'allow');
});

test('a hold that ended while the socket was down comes back as the answer, not as buttons', async (t) => {
  const h = await held(t, { permissionTimeoutMs: 60_000 });
  const decision = h.conversations.hook(h.session, preToolUse());
  await h.client.waitForOther(h.client.pendings, 1);

  // The phone's screen locked. The last viewer leaving releases the agent.
  h.leave();
  assert.equal(await decision, undefined);

  const again = sink();
  const stop = await h.conversations.subscribe(h.session, 1, again.send);
  t.after(stop);
  await again.waitForOther(again.pendings, 1);
  assert.equal(again.pendings[0]?.deadline, undefined, 'no deadline: the hold is long over');
  // Without this the card comes back with live-looking buttons over an expired
  // countdown, and a tap on it is a 409 the user has no way to have predicted.
  await again.waitForOther(again.answers, 1);
  assert.equal(again.answers[0]?.outcome, 'timeout', 'and it says how it ended');
});

test('a reconnect mid-hold gets the buttons back, deadline and all', async (t) => {
  const h = await held(t, { permissionTimeoutMs: 60_000 });
  void h.conversations.hook(h.session, preToolUse());
  await h.client.waitForOther(h.client.pendings, 1);
  const deadline = h.client.pendings[0]?.deadline;

  // The same phone after a screen lock: a second subscriber on the same live
  // session, which is what a reconnect is.
  const again = sink();
  await h.conversations.subscribe(h.session, 1, again.send);
  await again.waitForOther(again.pendings, 1);
  assert.equal(again.pendings[0]?.deadline, deadline, 'the same deadline, not a fresh one');
});

test('Notification flips the session to waiting, and says what for', async (t) => {
  const h = await harness(t);
  await writeFile(h.transcript, userRecord(1));
  const client = sink();
  await h.conversations.subscribe(h.session, 0, client.send);
  await client.waitForOther(client.states, 1);
  assert.deepEqual(client.states[0], { c: 'state', state: 'idle' });

  h.conversations.hook(h.session, {
    hook_event_name: 'Notification',
    session_id: PROVIDER_SESSION,
    message: 'Claude needs your permission',
  });
  await client.waitForOther(client.states, 2);
  assert.deepEqual(client.states[1], {
    c: 'state',
    state: 'waiting',
    detail: 'Claude needs your permission',
  });

  // Said once, not once per repeat: the badge is a state, not a stream.
  h.conversations.hook(h.session, {
    hook_event_name: 'Notification',
    session_id: PROVIDER_SESSION,
    message: 'Claude needs your permission',
  });
  await new Promise((resolve) => setTimeout(resolve, POLL * 2));
  assert.equal(client.states.length, 2);
});

// ── the switch itself ────────────────────────────────────────────────────────
//
// Two arms and a default, asserted by identity rather than by behaviour: which
// mapper runs is the whole of the routing decision, and a test that only checked
// the events would pass on a build that routed by luck.

test('the mapper switch has two arms, and an unknown provider takes the default', () => {
  assert.equal(mapperFor('codex'), mapCodexLines);
  assert.equal(mapperFor('claude-code'), mapClaudeLines);
  // Reachable two ways, so this arm is not theoretical: `startSession` skips the
  // `PROVIDER_COMMANDS` lookup when it is given an explicit command, so
  // `tether new <dir> --provider anything -- somecmd` writes that string; and so
  // does a row written by a newer tether and read by an older one. The answer
  // must be a conversation this build can read rather than a crash.
  assert.equal(mapperFor('nonesuch'), mapClaudeLines);
  assert.equal(mapperFor(''), mapClaudeLines);
  assert.equal(mapperFor('constructor'), mapClaudeLines, 'not a prototype member');
});

test('a session whose provider this build does not know is read, not dropped', async (t) => {
  const h = await harness(t);
  const session = createSession(h.db, {
    id: '66666666-8888-4777-8666-555555555555',
    provider: 'some-future-agent',
    cwd: h.session.cwd,
    title: 'work',
    tmuxName: 'tether-66666666',
  });
  await writeFile(h.transcript, userRecord(1));

  const history = await h.conversations.history(session);
  assert.equal(history.events.length, 1, 'read through the default arm');
  const client = sink();
  const leave = await h.conversations.subscribe(session, 0, client.send);
  t.after(leave);
  await client.waitFor(1);
});

test('a hook payload the mapper cannot use changes nothing and does not throw', async (t) => {
  const h = await harness(t);
  await writeFile(h.transcript, userRecord(1));
  const client = sink();
  await h.conversations.subscribe(h.session, 0, client.send);
  await client.waitFor(1);

  h.conversations.hook(h.session, { hook_event_name: 'SubagentStop' });
  h.conversations.hook(h.session, 'not an object');
  await new Promise((resolve) => setTimeout(resolve, POLL * 2));
  assert.deepEqual(client.pendings, []);
  assert.equal(client.states.length, 1);
  assert.deepEqual(h.warnings, [
    'unknown hook event SubagentStop',
    'hook payload is not an object',
  ]);
});

/**
 * The status poller, against a real tmux pane and a real registry file.
 *
 * Everything above turns it off (`statusPollMs: 0`) because it shells out to
 * tmux, so this is the only place the path runs at all — and the case that
 * matters is the one where the file says nothing. `undefined` from
 * `readSession` is "tether cannot say"; reading it as `idle` would erase
 * the `waiting` a `Notification` hook had just set, one tick after the banner
 * this whole feature exists for appeared.
 */
async function polling(
  t: TestContext,
  statusPollMs: number,
  options: { syncDelay?: () => Promise<void> } = {},
) {
  const h = await harness(t);
  const socket = `tether-conv-${randomUUID().slice(0, 8)}`;
  t.after(async () => {
    await killServer(socket);
    await rm(join(tmpdir(), `tmux-${process.getuid?.() ?? ''}`, socket), { force: true });
  });
  await newSession(socket, { name: h.session.tmuxName, cwd: h.cwd, command: ['/bin/sh'] });
  const pid = (await listPanes(socket)).find((pane) => pane.session === h.session.tmuxName)?.pid;
  assert.ok(pid !== undefined, 'the pane tether would have spawned');

  const conversations = new Conversations(h.db, {
    home: h.home,
    pollMs: POLL,
    socket,
    statusPollMs,
    warn: (message) => h.warnings.push(message),
    ...options,
  });
  t.after(() => conversations.closeAll());
  return { ...h, conversations, pid, socket };
}

/**
 * Another tether session in the *same* directory: a registry row and the tmux
 * pane tether would have spawned for it, announcing `providerSessionId` through
 * Claude Code's own registry file.
 *
 * This is the shape of the bug: every row here has an identical `cwd`, so the
 * `cwd` can only ever say "one of these" — and the adoption it once gated on it
 * therefore refused every directory that held more than one, which left the
 * second and every later session in it without a conversation at all.
 */
async function neighbour(
  p: Awaited<ReturnType<typeof polling>>,
  n: number,
  providerSessionId: string,
): Promise<Session> {
  const digits = `${n}`.repeat(8);
  const session = createSession(p.db, {
    id: `${digits}-8888-4777-8666-555555555555`,
    provider: 'claude-code',
    cwd: p.session.cwd,
    title: 'work',
    tmuxName: `tether-${digits}`,
  });
  await newSession(p.socket, { name: session.tmuxName, cwd: p.cwd, command: ['/bin/sh'] });
  const pid = (await listPanes(p.socket)).find((pane) => pane.session === session.tmuxName)?.pid;
  assert.ok(pid !== undefined, `the pane tether would have spawned for session ${n}`);
  await writeStatus(p.home, pid, { sessionId: providerSessionId });
  return session;
}

/** A registry file for `pid`, as Claude Code 2.1.220 writes one. */
async function writeStatus(
  home: string,
  pid: number,
  fields: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(join(home, '.claude', 'sessions'), { recursive: true });
  const procStart = await processStart(pid);
  assert.ok(procStart, 'this platform publishes a process start identity tether understands');
  await writeFile(
    sessionStatusPath(pid, home),
    JSON.stringify({
      pid,
      sessionId: PROVIDER_SESSION,
      procStart,
      status: 'busy',
      ...fields,
    }),
  );
}

/** The last state announced, once it is the one being waited for. */
async function waitForState(
  states: readonly Extract<ServerFrame, { c: 'state' }>[],
  state: string,
): Promise<Extract<ServerFrame, { c: 'state' }>> {
  for (let i = 0; i < 200 && states[states.length - 1]?.state !== state; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const last = states[states.length - 1];
  assert.equal(last?.state, state, `expected ${state}, got ${JSON.stringify(states)}`);
  return last!;
}

test('a file the poller cannot read leaves the waiting it found alone', async (t) => {
  const p = await polling(t, POLL);
  await writeFile(p.transcript, userRecord(1));

  // No registry file exists yet, and none that says anything is written until
  // the assertion below has been made. That ordering is the test, not a detail:
  // a file the poller *can* read is one it may truthfully announce, so leaving
  // one readable anywhere before the count is taken races the tick timer for it
  // — and the announcement that wins is a real `busy`, not the bug this guards.
  const client = sink();
  await p.conversations.subscribe(p.session, 0, client.send);
  await client.waitForOther(client.states, 1);

  p.conversations.hook(p.session, {
    hook_event_name: 'Notification',
    session_id: PROVIDER_SESSION,
    message: 'Claude needs your permission',
  });
  const waiting = await waitForState(client.states, 'waiting');
  assert.equal(waiting.detail, 'Claude needs your permission');
  const announced = client.states.length;

  // The two ways the file says nothing: gone, and a status this build does not
  // know. Both are "tether cannot say", and neither may answer for the hook.
  // Whatever the poller does across these ticks, only silence is correct.
  await new Promise((resolve) => setTimeout(resolve, POLL * 6));
  await writeStatus(p.home, p.pid, { status: 'compacting' });
  await new Promise((resolve) => setTimeout(resolve, POLL * 6));
  assert.equal(client.states.length, announced, 'nothing was announced over the hook');
  assert.equal(client.states[announced - 1]?.detail, 'Claude needs your permission');

  // A state the file really does carry still moves it, and takes the sentence
  // that belonged to the state it replaced with it. This is also what proves
  // the poller was alive for all of the above rather than quietly stopped.
  await writeStatus(p.home, p.pid, { status: 'idle' });
  const idle = await waitForState(client.states, 'idle');
  assert.equal(idle.detail, undefined);
});

const SECOND_SESSION = '22222222-2222-4222-8222-222222222222';
const THIRD_SESSION = '33333333-3333-4333-8333-333333333333';
const FOREIGN_SESSION = '00000000-0000-4000-8000-000000000000';

test('three sessions in one directory each bind to their own, by pane and not by cwd', async (t) => {
  // The poller is off: what is under test is the lookup the hook route makes
  // before it binds a provider session id to a row.
  const p = await polling(t, 0);
  await writeStatus(p.home, p.pid, {});
  const second = await neighbour(p, 2, SECOND_SESSION);
  const third = await neighbour(p, 3, THIRD_SESSION);

  // Every row below has the same cwd and none of them has been identified yet.
  // The panes are what tell them apart, and they do it exactly.
  for (const [id, session] of [
    [PROVIDER_SESSION, p.session],
    [SECOND_SESSION, second],
    [THIRD_SESSION, third],
  ] as const) {
    assert.equal((await p.conversations.bindProviderSession(id))?.id, session.id, id);
    assert.equal(getSession(p.db, session.id)?.providerSessionId, id, 'and the row is bound');
  }
});

test('an agent no tether pane is running binds to nothing', async (t) => {
  const p = await polling(t, 0);
  await writeStatus(p.home, p.pid, {});
  await neighbour(p, 2, SECOND_SESSION);

  // A `claude` the user started by hand in a tether-managed directory. It writes
  // its own registry file under its own pid, and that pid is in none of tether's
  // panes — so no pane names it and no row may take it. A row bound to a foreign
  // transcript is a `resume` that hands back somebody else's conversation.
  assert.equal(await p.conversations.bindProviderSession(FOREIGN_SESSION), undefined);
  assert.equal(getSession(p.db, p.session.id)?.providerSessionId, null, 'and nothing was bound');

  // The same answer when tether's own pane publishes nothing at all — no procfs,
  // a file not written yet, a pane already gone. Unverifiable is never a guess.
  await rm(sessionStatusPath(p.pid, p.home));
  assert.equal(await p.conversations.bindProviderSession(PROVIDER_SESSION), undefined);
});

test('a session id that changes mid-session is re-bound, and the view refetches', async (t) => {
  // `/resume` in the terminal moves Claude Code to a different session id and a
  // different transcript. Nothing announces it; the poller notices because the
  // file it already reads once a second names the session as well as its state.
  const p = await polling(t, POLL);
  await writeFile(p.transcript, userRecord(1));
  await writeStatus(p.home, p.pid, {});

  const client = sink();
  await p.conversations.subscribe(p.session, 0, client.send);
  await client.waitFor(1);
  assert.deepEqual(seqs(client.frames), [1]);

  const resumed = join(projectDir(p.cwd, p.home), `${SECOND_SESSION}.jsonl`);
  await writeFile(resumed, userRecord(2) + userRecord(3));
  await writeStatus(p.home, p.pid, { sessionId: SECOND_SESSION });

  // Refetch rather than more `conv` frames: the new transcript is not a
  // continuation of the old numbering, and its own event 1 would collide with
  // one the client already holds.
  await client.waitFor(4);
  assert.equal(client.frames[1]?.c, 'refetch');
  assert.deepEqual(seqs(client.frames), [1, 1, 2], 'the new transcript, from its own start');
  assert.equal(
    getSession(p.db, p.session.id)?.providerSessionId,
    SECOND_SESSION,
    'and the row follows the pane, so `resume` and the history route agree with it',
  );
});

test('a first identification racing the search re-sends nothing, and asks for nothing', async (t) => {
  // The load-dependent one. With no id on the row yet, `#start` finds the
  // transcript through `findTranscript`'s own fallback and delivers from it
  // immediately — so the poller's first tick can bind the id *after* a client
  // already holds event 1. Restarting on that re-numbered from 0 and re-sent it
  // with no refetch: the browser drops the duplicate, the server still emitted
  // one. `syncDelay` holds the window open so the poller wins every run rather
  // than two runs in twelve on a loaded machine.
  const p = await polling(t, POLL, {
    syncDelay: () => new Promise((resolve) => setTimeout(resolve, POLL * 4)),
  });
  await writeFile(p.transcript, userRecord(1));
  await writeStatus(p.home, p.pid, {});

  const client = sink();
  await p.conversations.subscribe(p.session, 0, client.send);
  await client.waitFor(1);

  // Long enough for a restart to have run, ingested and fanned out.
  await new Promise((resolve) => setTimeout(resolve, POLL * 8));
  assert.deepEqual(seqs(client.frames), [1], 'once, and not again by a restart');
  assert.deepEqual(
    client.frames.filter((f) => f.c === 'refetch'),
    [],
    'and no refetch either: an ordinary start has cost a phone nothing',
  );
  assert.equal(getSession(p.db, p.session.id)?.providerSessionId, PROVIDER_SESSION);
});

// ── answering a Codex prompt ─────────────────────────────────────────────────
//
// The other half of "one interface, full stop". The hold, the deadline, the
// single settle and the release-rather-than-deny policy above are the same code
// for both providers; what is new here is the two things Codex does differently.
//
// It writes the `function_call` to the rollout *before* it puts the dialog up
// (report risk #2 does not exist for Codex), so the card is already on the
// client's screen and the `pending` frame's job is to put buttons on it — which
// is why "the transcript already has this call" cannot mean "drop it".
//
// And its `PermissionRequest` carries no `tool_use_id`, so which card that is has
// to be correlated from the `PreToolUse` before it. That correlation can fail,
// and a failure must cost the buttons rather than answer somebody else's call.

const CODEX_TURN = '019fac91-dcc4-7492-9d4a-6d796117fa13';
const CODEX_CALL = 'call_LNqehXWH97jZ5YJI1FphTgBz';
const CODEX_COMMAND = { command: 'rm -rf ./build' };

/** A hook log line, as tether's own shim writes it: the payload plus `at`/`ppid`. */
function hookLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ ...payload, at: Date.now(), ppid: 1 })}\n`;
}

function codexPreToolUse(turnId = CODEX_TURN, callId = CODEX_CALL): Record<string, unknown> {
  return {
    session_id: CODEX_SESSION,
    turn_id: turnId,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: CODEX_COMMAND,
    tool_use_id: callId,
  };
}

/** As Codex delivers it, and as the shim POSTs it: no `tool_use_id` anywhere. */
function codexPermissionRequest(turnId = CODEX_TURN): Record<string, unknown> {
  return {
    session_id: CODEX_SESSION,
    turn_id: turnId,
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: CODEX_COMMAND,
  };
}

/**
 * A Codex session at a permission prompt, arranged exactly as one really is: the
 * `function_call` already in the rollout and delivered to the client, and the
 * `PreToolUse` and `PermissionRequest` lines already in the hook log — because
 * the shim appends its line before it POSTs, which is what makes the correlation
 * a fact rather than a race with the tailer.
 */
async function codexHeld(t: TestContext, options: { permissionTimeoutMs?: number } = {}) {
  const h = await codexHarness(t, options);
  const client = sink();
  const leave = await h.conversations.subscribe(h.session, 0, client.send);
  t.after(leave);

  await appendFile(
    h.rollout,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: CODEX_CALL,
        name: 'exec_command',
        arguments: '{}',
      },
    })}\n`,
  );
  await client.waitFor(1);
  assert.equal(client.frames[0]?.c === 'conv' && client.frames[0].e.kind, 'tool_call');
  return { ...h, client, leave };
}

test('a codex prompt puts buttons on the card the rollout has already written', async (t) => {
  const h = await codexHeld(t, { permissionTimeoutMs: 60_000 });
  await appendFile(h.hookLog, hookLine(codexPreToolUse()) + hookLine(codexPermissionRequest()));

  const decision = h.conversations.hook(h.session, codexPermissionRequest());
  await h.client.waitForOther(h.client.pendings, 1);

  // The same `callId` the `tool_call` event carries, so the client replaces its
  // own card rather than drawing a second one — and a `deadline`, which is what
  // puts Approve and Deny on it.
  const pending = h.client.pendings[0];
  assert.equal(pending?.e.callId, CODEX_CALL);
  assert.ok((pending?.deadline ?? 0) > Date.now(), 'held, so answerable');
  assert.equal(pending?.e.tool, 'Bash');
  assert.deepEqual(pending?.e.input, CODEX_COMMAND, 'the command, in full, at the right edge');

  assert.equal(h.conversations.answer(h.session.id, CODEX_CALL, 'allow'), true);
  assert.equal(await decision, 'allow', 'and the hook the agent is blocked on carries it back');
  await h.client.waitForOther(h.client.answers, 1);
  assert.deepEqual(h.client.answers[0], { c: 'answer', callId: CODEX_CALL, outcome: 'allow' });
});

test('Deny is the answer too, and it reaches the same blocked hook', async (t) => {
  const h = await codexHeld(t, { permissionTimeoutMs: 60_000 });
  await appendFile(h.hookLog, hookLine(codexPreToolUse()) + hookLine(codexPermissionRequest()));

  const decision = h.conversations.hook(h.session, codexPermissionRequest());
  await h.client.waitForOther(h.client.pendings, 1);
  h.conversations.answer(h.session.id, CODEX_CALL, 'deny');

  assert.equal(await decision, 'deny');
  assert.equal(h.client.answers[0]?.outcome, 'deny');
});

test('a codex hold nobody answers hands the question back to Codex', async (t) => {
  const h = await codexHeld(t, { permissionTimeoutMs: 60 });
  await appendFile(h.hookLog, hookLine(codexPreToolUse()) + hookLine(codexPermissionRequest()));

  // `undefined` is the whole policy, and it is the same policy as Claude Code's:
  // the hook says nothing, so Codex's own approval prompt decides — which is
  // where the question started and where the user can still answer it.
  assert.equal(await h.conversations.hook(h.session, codexPermissionRequest()), undefined);
  await h.client.waitForOther(h.client.answers, 1);
  assert.equal(h.client.answers[0]?.outcome, 'timeout', 'and the expiry is observable');
});

test('a prompt tether could not correlate does not answer the wrong call', async (t) => {
  const h = await codexHeld(t, { permissionTimeoutMs: 60_000 });
  // A real, supported configuration: the user trusted tether's
  // `PermissionRequest` entry in Codex's review and declined its `PreToolUse`
  // one, so there is no pending call to correlate against. A prompt from a turn
  // tether never saw the calls of looks exactly the same.
  await appendFile(h.hookLog, hookLine(codexPreToolUse()));
  await appendFile(h.hookLog, hookLine(codexPermissionRequest('some-other-turn')));

  assert.equal(
    await h.conversations.hook(h.session, codexPermissionRequest('some-other-turn')),
    undefined,
  );

  // Reported: the badge and the tool's name, which is what a Codex session
  // showed before any of this. Not answered: no deadline anywhere, so no card
  // wears buttons, and nothing is holding the call that *did* correlate before.
  assert.deepEqual(h.client.pendings, []);
  assert.equal(h.client.states.at(-1)?.state, 'waiting');
  assert.equal(h.client.states.at(-1)?.detail, 'Bash');
  assert.equal(
    h.conversations.answer(h.session.id, CODEX_CALL, 'allow'),
    false,
    'and a tap aimed at the call it might have guessed answers nothing at all',
  );
});

test('a codex hold is clamped under the timeout Codex was asked to trust', async (t) => {
  // Codex hashes its hooks.json entries, so tether may not move that `timeout`
  // without re-prompting a review the user already gave. The hold is clamped
  // beneath the fixed one instead — an operator asking for ten minutes gets the
  // longest hold that still returns before Codex stops waiting.
  const h = await codexHeld(t, { permissionTimeoutMs: 10 * 60_000 });
  await appendFile(h.hookLog, hookLine(codexPreToolUse()) + hookLine(codexPermissionRequest()));

  void h.conversations.hook(h.session, codexPermissionRequest());
  await h.client.waitForOther(h.client.pendings, 1);
  const holdMs = (h.client.pendings[0]?.deadline ?? 0) - Date.now();
  assert.ok(holdMs > 0 && holdMs <= MAX_HOLD_MS, `held for ${holdMs}ms`);
  assert.ok(MAX_HOLD_MS < 10 * 60_000, 'the clamp really is the binding constraint here');
});

test('a Codex hook Codex killed leaves no live buttons behind', async (t) => {
  // The case the on-disk gate cannot close: a Codex that loaded `timeout: 3` at
  // startup kills the shim at 3s whatever `hooks.json` says now (verified
  // against 0.145.0 with a probe hook). From tether's side a killed shim is a
  // caller that left, and that is what is watched instead of a number.
  const h = await codexHeld(t, { permissionTimeoutMs: 60_000 });
  await appendFile(h.hookLog, hookLine(codexPreToolUse()) + hookLine(codexPermissionRequest()));
  const gone = new AbortController();

  const decision = h.conversations.hook(h.session, codexPermissionRequest(), gone.signal);
  await h.client.waitForOther(h.client.pendings, 1);
  assert.ok((h.client.pendings[0]?.deadline ?? 0) > Date.now());

  const before = Date.now();
  gone.abort();
  assert.equal(await decision, undefined, 'Codex’s own dialog has the question now');
  assert.ok(Date.now() - before < 1000, 'the abort released it, not the minute-long timer');
  await h.client.waitForOther(h.client.answers, 1);
  assert.deepEqual(h.client.answers[0], { c: 'answer', callId: CODEX_CALL, outcome: 'timeout' });
  assert.equal(
    h.conversations.answer(h.session.id, CODEX_CALL, 'allow'),
    false,
    'so a tap cannot report an approval the agent never received',
  );
});

/** The `timeout` on tether's own `PermissionRequest` entry, rewritten in place. */
async function setPermissionTimeout(codexHome: string, seconds: number): Promise<void> {
  const path = hooksJsonPath(codexHome);
  const file = JSON.parse(await readFile(path, 'utf8')) as {
    hooks: Record<string, { hooks: Record<string, unknown>[] }[]>;
  };
  for (const group of file.hooks['PermissionRequest'] ?? []) {
    for (const handler of group.hooks) handler['timeout'] = seconds;
  }
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
}

test('the hold follows the timeout on disk, in both directions', async (t) => {
  // The invariant in `providers/permission.ts`: tether may hold only while
  // Codex's own configuration carries the timeout the hold is sized against.
  // Nothing rewrites a Codex installation on upgrade — the trust gate is not
  // tether's to walk through unasked — so a `hooks.json` an older tether wrote
  // is the ordinary case, and it is read rather than assumed.
  const h = await codexHeld(t, { permissionTimeoutMs: 60_000 });
  const prompt = hookLine(codexPreToolUse()) + hookLine(codexPermissionRequest());

  await appendFile(h.hookLog, prompt);
  void h.conversations.hook(h.session, codexPermissionRequest());
  await h.client.waitForOther(h.client.pendings, 1);
  assert.ok((h.client.pendings[0]?.deadline ?? 0) > Date.now(), 'a real installation holds');
  h.conversations.answer(h.session.id, CODEX_CALL, 'allow');

  // What an older tether left behind. A gate and not a clamp: 3s minus
  // `KILL_MARGIN_MS` is negative, so there is no shorter hold to fall back to —
  // Codex would kill the shim at 3s and raise its own dialog while tether still
  // showed a live deadline, and a tap would report an approval nothing received.
  await setPermissionTimeout(h.codexHome, 3);
  await appendFile(h.hookLog, prompt);
  assert.equal(await h.conversations.hook(h.session, codexPermissionRequest()), undefined);
  const stale = h.client.pendings.at(-1);
  assert.equal(stale?.e.callId, CODEX_CALL, 'the prompt is still reported');
  assert.equal(stale?.deadline, undefined, 'without a deadline, so the card wears no buttons');
  assert.equal(h.client.states.at(-1)?.state, 'waiting', 'and the badge is still the badge');
  assert.equal(
    h.conversations.answer(h.session.id, CODEX_CALL, 'allow'),
    false,
    'nothing is holding it, so nothing can report that it was approved',
  );

  // And back: the gate reads the file every time, so `codex-hook install` puts
  // the buttons back mid-session with nothing to restart and nothing cached.
  await setPermissionTimeout(h.codexHome, PERMISSION_TIMEOUT_SECONDS);
  await appendFile(h.hookLog, prompt);
  void h.conversations.hook(h.session, codexPermissionRequest());
  await h.client.waitForOther(h.client.pendings, 3);
  assert.ok((h.client.pendings[2]?.deadline ?? 0) > Date.now(), 'answerable again');
  h.conversations.answer(h.session.id, CODEX_CALL, 'deny');
});
