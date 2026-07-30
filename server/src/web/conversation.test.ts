/**
 * The conversation routes, on a real server: the default-deny posture applies to
 * them, and the `conv` socket really does resume from `since` over a real
 * WebSocket — including the part that is easy to get wrong, that `since` arrives
 * as a string because `buildServer` turns ajv's `coerceTypes` off.
 */

import type { ServerFrame } from '@tether/shared';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import { Conversations } from '../machine/conversations.ts';
import { applyRegistrySchema, createSession, getSession } from '../machine/registry.ts';
import { createTerminals } from '../machine/terminal.ts';
import { projectDir } from '../providers/claude-code/transcript.ts';
import { createAuthStore } from './auth.ts';
import { defaultAllowedHosts } from './guards.ts';
import { SESSION_COOKIE, buildServer } from './server.ts';

const PASSWORD = 'correct horse battery staple';
const ID = '99999999-8888-4777-8666-555555555555';
const PROVIDER_SESSION = '11111111-2222-4333-8444-555555555555';

/**
 * Stamped from the clock rather than a fixed instant, because `findTranscript`
 * identifies a transcript by when its records begin and a session's own must not
 * begin before the session did — but from one instant the assertions can name,
 * so what reaches the wire is still checked exactly.
 */
const STAMPED_AT = Date.now();

function userRecord(n: number): string {
  return `${JSON.stringify({
    type: 'user',
    uuid: `uuid-${n}`,
    timestamp: new Date(STAMPED_AT + n).toISOString(),
    version: '2.1.220',
    message: { role: 'user', content: `message ${n}` },
  })}\n`;
}

async function harness(t: TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'tether-convapi-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = join(home, 'work');
  await mkdir(cwd);
  await mkdir(projectDir(cwd, home), { recursive: true });
  const transcript = join(projectDir(cwd, home), `${PROVIDER_SESSION}.jsonl`);

  const db = new DatabaseSync(':memory:');
  applyRegistrySchema(db);
  createSession(db, {
    id: ID,
    provider: 'claude-code',
    cwd,
    title: 'work',
    tmuxName: 'tether-99999999',
    now: Date.now() - 1000,
  });
  const auth = createAuthStore(db);
  await auth.setPassword(PASSWORD);

  const conversations = new Conversations(db, {
    home,
    pollMs: 15,
    // No status poller: it would shell out to the real tmux on the default socket.
    statusPollMs: 0,
    permissionTimeoutMs: 60_000,
  });
  const app = buildServer({
    auth,
    db,
    // Never attached to here; `app.close()` takes it down either way.
    terminals: createTerminals(`tether-test-${ID.slice(0, 8)}`),
    conversations,
    allowedHosts: defaultAllowedHosts('127.0.0.1'),
    loginDelayMs: 0,
  });
  t.after(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const host = `127.0.0.1:${port}`;

  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { host, origin: `http://${host}` },
    payload: { password: PASSWORD },
  });
  const token = login.cookies[0]?.value;
  assert.ok(token, 'logged in');

  const get = (url: string, cookie = true) =>
    app.inject({
      method: 'GET',
      url,
      headers: { host, ...(cookie ? { cookie: `${SESSION_COOKIE}=${token}` } : {}) },
    });

  const post = (url: string, payload: unknown, cookie = true) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        host,
        origin: `http://${host}`,
        ...(cookie ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
      },
      payload: payload as object,
    });

  return { app, host, token, transcript, get, post, conversations, db };
}

test('the history route is behind the same default-deny hook as everything else', async (t) => {
  const h = await harness(t);
  assert.equal((await h.get(`/api/sessions/${ID}/conversation`, false)).statusCode, 401);
  assert.equal((await h.get('/api/sessions/not-a-uuid/conversation')).statusCode, 400);
  assert.equal(
    (await h.get(`/api/sessions/00000000-0000-4000-8000-000000000000/conversation`)).statusCode,
    404,
  );
});

test('the history route returns the conversation with its sequence numbers', async (t) => {
  const h = await harness(t);
  await writeFile(h.transcript, userRecord(1) + userRecord(2));

  const response = await h.get(`/api/sessions/${ID}/conversation`);
  assert.equal(response.statusCode, 200);
  const body = response.json() as { seq: number; version: string; events: { seq: number }[] };
  assert.equal(body.seq, 2);
  assert.equal(body.version, '2.1.220');
  assert.deepEqual(
    body.events.map((e) => e.seq),
    [1, 2],
  );
});

/** Frames from a real socket, in order. */
async function connect(
  t: TestContext,
  h: Awaited<ReturnType<typeof harness>>,
  since: number,
): Promise<{ frames: ServerFrame[]; waitFor: (n: number) => Promise<void> }> {
  const socket = new WebSocket(`ws://${h.host}/api/sessions/${ID}/conv?since=${since}`, {
    headers: { cookie: `${SESSION_COOKIE}=${h.token}` },
  } as unknown as string[]);
  t.after(() => socket.close());
  const frames: ServerFrame[] = [];
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as ServerFrame;
    // `state` and `pending` carry no `seq`; this test is about the cursor.
    if (frame.c !== 'state' && frame.c !== 'pending') frames.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('the upgrade failed')));
  });
  return {
    frames,
    waitFor: async (n) => {
      for (let i = 0; i < 200 && frames.length < n; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(frames.length, n, JSON.stringify(frames));
    },
  };
}

test('the conv socket resumes from `since` and then streams', async (t) => {
  const h = await harness(t);
  await writeFile(h.transcript, userRecord(1) + userRecord(2));

  // `since=1`: the client holds event 1 and must be sent 2, and nothing else.
  const client = await connect(t, h, 1);
  await client.waitFor(1);
  assert.deepEqual(client.frames[0], {
    c: 'conv',
    seq: 2,
    e: {
      kind: 'user',
      id: 'uuid-2',
      at: STAMPED_AT + 2,
      text: 'message 2',
    },
  });

  await appendFile(h.transcript, userRecord(3));
  await client.waitFor(2);
  assert.equal(client.frames[1]?.c === 'conv' && client.frames[1].seq, 3);
});

test('a conv socket for a session that does not exist is closed, not left open', async (t) => {
  const h = await harness(t);
  const socket = new WebSocket(
    `ws://${h.host}/api/sessions/00000000-0000-4000-8000-000000000000/conv`,
    { headers: { cookie: `${SESSION_COOKIE}=${h.token}` } } as unknown as string[],
  );
  const code = await new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => resolve(event.code));
  });
  assert.equal(code, 4404);
});

test('an unauthenticated conv socket never upgrades', async (t) => {
  const h = await harness(t);
  const socket = new WebSocket(`ws://${h.host}/api/sessions/${ID}/conv`);
  const failed = await new Promise<boolean>((resolve) => {
    socket.addEventListener('error', () => resolve(true));
    socket.addEventListener('open', () => resolve(false));
  });
  assert.ok(failed, 'the default-deny hook covers the upgrade');
});

/**
 * Answering a permission prompt over HTTP.
 *
 * The posture is the point: an unauthenticated approve is an unauthenticated
 * tool execution on the machine, so this route is behind exactly the same
 * default-deny hook as the rest of the API and is not special-cased anywhere.
 */
const CALL_ID = 'toolu_012hUcdAk6Z4RcnbNgrC7PH4';

function preToolUse(callId = CALL_ID): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: PROVIDER_SESSION,
    tool_name: 'Bash',
    tool_use_id: callId,
    tool_input: { command: 'rm -rf ./build' },
  };
}

/** A held proposal, with a live socket so that there is somebody to hold for. */
async function holding(t: TestContext, h: Awaited<ReturnType<typeof harness>>) {
  await writeFile(h.transcript, userRecord(1));
  const client = await connect(t, h, 0);
  await client.waitFor(1);
  // Wrapped, not returned: `return somePromise` from an async function awaits
  // it, and the whole point here is that the hook is still hanging.
  return { decision: h.conversations.hook(getSession(h.db, ID)!, preToolUse()) };
}

test('an unauthenticated caller cannot approve a tool call', async (t) => {
  const h = await harness(t);
  const response = await h.post(
    `/api/sessions/${ID}/permission`,
    { callId: CALL_ID, decision: 'allow' },
    false,
  );
  assert.equal(response.statusCode, 401);
});

test('the answer route rejects everything that is not one of the two answers', async (t) => {
  const h = await harness(t);
  for (const body of [
    { callId: CALL_ID },
    { decision: 'allow' },
    { callId: CALL_ID, decision: 'yes' },
    { callId: CALL_ID, decision: 'allow', andAlso: 'run this' },
    { callId: '', decision: 'allow' },
  ]) {
    assert.equal((await h.post(`/api/sessions/${ID}/permission`, body)).statusCode, 400);
  }
  assert.equal(
    (
      await h.post('/api/sessions/00000000-0000-4000-8000-000000000000/permission', {
        callId: CALL_ID,
        decision: 'allow',
      })
    ).statusCode,
    404,
  );
});

test('an approve reaches the held hook, and a second answer is refused', async (t) => {
  const h = await harness(t);
  const { decision } = await holding(t, h);

  const first = await h.post(`/api/sessions/${ID}/permission`, {
    callId: CALL_ID,
    decision: 'allow',
  });
  assert.equal(first.statusCode, 204);
  assert.equal(await decision, 'allow');

  // The reflex second tap, or a second phone. One hold, one settle: this must
  // never become a second answer aimed at whatever the agent is doing now.
  const second = await h.post(`/api/sessions/${ID}/permission`, {
    callId: CALL_ID,
    decision: 'deny',
  });
  assert.equal(second.statusCode, 409);
  assert.equal((second.json() as { error: string }).error, 'not_awaiting_answer');
});

test('a deny reaches the held hook as a deny', async (t) => {
  const h = await harness(t);
  const { decision } = await holding(t, h);
  assert.equal(
    (await h.post(`/api/sessions/${ID}/permission`, { callId: CALL_ID, decision: 'deny' }))
      .statusCode,
    204,
  );
  assert.equal(await decision, 'deny');
});

test('the client saying the terminal has been summoned is what stops the hold', async (t) => {
  const h = await harness(t);
  await writeFile(h.transcript, userRecord(1));
  const socket = new WebSocket(`ws://${h.host}/api/sessions/${ID}/conv?since=0`, {
    headers: { cookie: `${SESSION_COOKIE}=${h.token}` },
  } as unknown as string[]);
  t.after(() => socket.close());
  // The first frame, not the handshake: the route subscribes before it starts
  // reading, so a frame sent between the two would be shouted at nobody.
  await new Promise<void>((resolve) => socket.addEventListener('message', () => resolve()));

  // Both panes stay mounted, so summoning the terminal is a frame rather than
  // a close — and everything that is not that frame is dropped in silence.
  socket.send('not json');
  socket.send(JSON.stringify({ c: 'watch', watching: 'no' }));
  socket.send(JSON.stringify({ c: 'watch' }));
  socket.send(JSON.stringify({ c: 'watch', watching: false }));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const before = Date.now();
  assert.equal(await h.conversations.hook(getSession(h.db, ID)!, preToolUse()), undefined);
  assert.ok(Date.now() - before < 2000, 'the agent was not stalled behind a card nobody is on');
});

test('an answer for a call nothing is waiting on is a 409, not a decision', async (t) => {
  const h = await harness(t);
  const response = await h.post(`/api/sessions/${ID}/permission`, {
    callId: 'toolu_never_proposed',
    decision: 'allow',
  });
  assert.equal(response.statusCode, 409);
});
