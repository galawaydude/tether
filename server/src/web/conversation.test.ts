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
import { applyRegistrySchema, createSession } from '../machine/registry.ts';
import { createTerminals } from '../machine/terminal.ts';
import { projectDir } from '../providers/claude-code/transcript.ts';
import { createAuthStore } from './auth.ts';
import { defaultAllowedHosts } from './guards.ts';
import { SESSION_COOKIE, buildServer } from './server.ts';

const PASSWORD = 'correct horse battery staple';
const ID = '99999999-8888-4777-8666-555555555555';
const PROVIDER_SESSION = '11111111-2222-4333-8444-555555555555';

function userRecord(n: number): string {
  return `${JSON.stringify({
    type: 'user',
    uuid: `uuid-${n}`,
    timestamp: '2026-07-29T04:53:41.000Z',
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

  const app = buildServer({
    auth,
    db,
    // Never attached to here; `app.close()` takes it down either way.
    terminals: createTerminals(`tether-test-${ID.slice(0, 8)}`),
    conversations: new Conversations(db, { home, pollMs: 15 }),
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

  return { app, host, token, transcript, get };
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
    frames.push(JSON.parse(String(event.data)) as ServerFrame);
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
      at: Date.parse('2026-07-29T04:53:41.000Z'),
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
