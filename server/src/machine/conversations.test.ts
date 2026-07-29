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

import { sessionStatusPath } from '../providers/claude-code/status.ts';
import { projectDir } from '../providers/claude-code/transcript.ts';
import { Conversations, stderrWarn, TAIL_EVENTS } from './conversations.ts';
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
    // No status poller: it would shell out to the real tmux on the default
    // socket. The registry file's own mapping is `status.test.ts`.
    statusPollMs: 0,
    warn: (message) => warnings.push(message),
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
  const send = (frame: ServerFrame) => {
    if (frame.c === 'state') states.push(frame);
    else if (frame.c === 'pending') pendings.push(frame);
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
  return { frames, states, pendings, send, waitFor, waitForOther };
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

async function codexHarness(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tether-conv-codex-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, 'codex');
  const stateDir = join(root, 'state');
  const cwd = join(root, 'work');
  await mkdir(cwd);
  const day = join(codexHome, 'sessions', '2026', '07', '29');
  await mkdir(day, { recursive: true });
  await mkdir(join(stateDir, 'codex-hooks'), { recursive: true });
  const rollout = join(day, `rollout-2026-07-29T12-00-10-${CODEX_SESSION}.jsonl`);
  const hookLog = join(stateDir, 'codex-hooks', `${CODEX_SESSION}.ndjson`);

  const db = new DatabaseSync(':memory:');
  applyRegistrySchema(db);
  const createdAt = Date.now() - 1000;
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

  const conversations = new Conversations(db, { codexHome, stateDir, pollMs: POLL });
  t.after(() => conversations.closeAll());
  return { db, session, conversations, rollout, hookLog };
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
 * `readSessionStatus` is "tether cannot say"; reading it as `idle` would erase
 * the `waiting` a `Notification` hook had just set, one tick after the banner
 * this whole feature exists for appeared.
 */
async function polling(t: TestContext, statusPollMs: number) {
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
  });
  t.after(() => conversations.closeAll());
  return { ...h, conversations, pid };
}

/** A registry file for `pid`, as Claude Code 2.1.220 writes one. */
async function writeStatus(
  home: string,
  pid: number,
  fields: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(join(home, '.claude', 'sessions'), { recursive: true });
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  await writeFile(
    sessionStatusPath(pid, home),
    JSON.stringify({
      pid,
      sessionId: PROVIDER_SESSION,
      procStart: stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19],
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
  await writeStatus(p.home, p.pid, { status: 'busy' });
  await writeFile(p.transcript, userRecord(1));

  const client = sink();
  await p.conversations.subscribe(p.session, 0, client.send);
  await waitForState(client.states, 'busy');

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
  await rm(sessionStatusPath(p.pid, p.home));
  await new Promise((resolve) => setTimeout(resolve, POLL * 6));
  await writeStatus(p.home, p.pid, { status: 'compacting' });
  await new Promise((resolve) => setTimeout(resolve, POLL * 6));
  assert.equal(client.states.length, announced, 'nothing was announced over the hook');
  assert.equal(client.states[announced - 1]?.detail, 'Claude needs your permission');

  // A state the file really does carry still moves it, and takes the sentence
  // that belonged to the state it replaced with it.
  await writeStatus(p.home, p.pid, { status: 'idle' });
  const idle = await waitForState(client.states, 'idle');
  assert.equal(idle.detail, undefined);
});

test('a pane that is not running this session cannot be adopted by it', async (t) => {
  // The poller is off: what is under test is the lookup the hook route asks
  // before it binds a provider session id to a row that has none.
  const p = await polling(t, 0);
  await writeStatus(p.home, p.pid, {});

  assert.equal(await p.conversations.ownsProviderSession(p.session, PROVIDER_SESSION), true);
  assert.equal(
    await p.conversations.ownsProviderSession(p.session, '00000000-0000-4000-8000-000000000000'),
    false,
    'the pane is running a different session',
  );

  // An agent the user started by hand writes no registry file for tether's own
  // pane, so there is nothing to confirm it with and nothing is adopted.
  await rm(sessionStatusPath(p.pid, p.home));
  assert.equal(await p.conversations.ownsProviderSession(p.session, PROVIDER_SESSION), false);
});
