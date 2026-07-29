/**
 * `POST /internal/hook`: the three gates, and what gets through them.
 *
 * This route is the one place tether accepts something that did not come from a
 * logged-in browser, so the tests that matter most here are the refusals. A
 * regression in any of them turns a loopback accelerator into an unauthenticated
 * way to inject conversation events.
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { Conversations } from '../machine/conversations.ts';
import { createSession, applyRegistrySchema, getSession } from '../machine/registry.ts';
import type { Terminals } from '../machine/terminal.ts';
import { createAuthStore } from './auth.ts';
import { defaultAllowedHosts } from './guards.ts';
import { ensureHookSecret } from '../providers/claude-code/hooks.ts';
import { buildServer } from './server.ts';

const HOST = 'localhost:8787';
const PROVIDER_SESSION = '261d15fb-c568-41fa-ae66-917b107857bd';
const CWD = '/tmp/hookspike';

const noTerminals: Terminals = {
  async attach() {
    return () => {};
  },
  async resize() {},
  async input() {
    return true;
  },
  async text() {
    return true;
  },
  async key() {
    return true;
  },
  closeAll() {},
};

/**
 * A server whose state directory is a fresh temp dir, so the secret under test
 * is never the developer's real one.
 */
async function harness(t: { after: (fn: () => unknown) => void }) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tether-hook-'));
  const db = new DatabaseSync(':memory:');
  applyRegistrySchema(db);
  const auth = createAuthStore(db);
  await auth.setPassword('correct horse battery staple');

  const seen: { sessionId: string; payload: unknown }[] = [];
  /**
   * Which session the pane tether spawned is really running, as Claude Code's
   * own session file would say. Unset is the honest default: a hand-run agent
   * writes no such file for tether's pane. `conversations.test.ts` drives the
   * real lookup against real tmux.
   */
  const pane: { running?: string } = {};
  /** What the user tapped, where a test is about the decision coming back. */
  const answer: { decision?: 'allow' | 'deny' } = {};
  const conversations = {
    async hook(session: { id: string }, payload: unknown) {
      seen.push({ sessionId: session.id, payload });
      return answer.decision;
    },
    async ownsProviderSession(_session: { id: string }, providerSessionId: string) {
      return pane.running === providerSessionId;
    },
    closeAll: async () => {},
  } as unknown as Conversations;

  const app = buildServer({
    auth,
    db,
    terminals: noTerminals,
    conversations,
    allowedHosts: defaultAllowedHosts('127.0.0.1'),
    stateDir,
    loginDelayMs: 0,
  });
  t.after(() => app.close());

  const secret = await ensureHookSecret(stateDir);
  return { app, db, stateDir, secret, seen, pane, answer };
}

function preToolUse(overrides: Record<string, unknown> = {}) {
  return {
    session_id: PROVIDER_SESSION,
    cwd: CWD,
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/hookspike/out.txt', content: 'hello\n' },
    tool_use_id: 'toolu_01RMgXSU9fEUYVSU1gccJJKQ',
    ...overrides,
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

function post(
  h: Harness,
  options: { secret?: string | undefined; remoteAddress?: string; payload?: unknown } = {},
) {
  const secret = 'secret' in options ? options.secret : h.secret;
  return h.app.inject({
    method: 'POST',
    url: '/internal/hook',
    headers: {
      host: HOST,
      'content-type': 'application/json',
      ...(secret === undefined ? {} : { 'x-tether-hook': secret }),
    },
    remoteAddress: options.remoteAddress ?? '127.0.0.1',
    payload: options.payload ?? preToolUse(),
  });
}

/** A live row that already knows its provider session id. */
function liveSession(db: DatabaseSync, providerSessionId: string | null = PROVIDER_SESSION) {
  const id = '11111111-1111-4111-8111-111111111111';
  createSession(db, {
    id,
    provider: 'claude-code',
    cwd: CWD,
    title: 'hookspike',
    tmuxName: 'tether-11111111',
  });
  if (providerSessionId !== null) {
    db.prepare('UPDATE sessions SET provider_session_id = ? WHERE id = ?').run(
      providerSessionId,
      id,
    );
  }
  return id;
}

test('a hook with the right secret from loopback reaches the conversation', async (t) => {
  const h = await harness(t);
  const id = liveSession(h.db);

  const res = await post(h);
  assert.equal(res.statusCode, 204);
  // Empty, because this stub `Conversations` decides nothing. An empty reply is
  // not a neutral default — the shim turns it into a hook that says nothing,
  // which is the deliberate "leave the provider's own rules in charge".
  assert.equal(res.body, '');
  assert.equal(h.seen.length, 1);
  assert.equal(h.seen[0]?.sessionId, id);
  assert.deepEqual(h.seen[0]?.payload, preToolUse());
});

test('a wrong or missing secret is refused, and says nothing about the session', async (t) => {
  const h = await harness(t);
  liveSession(h.db);

  for (const secret of [undefined, '', 'not the secret', `${h.secret}x`, h.secret.slice(0, -1)]) {
    const res = await post(h, { secret });
    assert.equal(res.statusCode, 401, JSON.stringify(secret));
    assert.equal(res.body, '');
  }
  assert.deepEqual(h.seen, [], 'nothing reached the conversation');
});

test('an off-loopback caller is refused before the secret is even compared', async (t) => {
  const h = await harness(t);
  liveSession(h.db);

  for (const remoteAddress of ['192.168.1.50', '10.0.0.7', '::ffff:192.168.1.50', '2001:db8::1']) {
    const res = await post(h, { remoteAddress });
    assert.equal(res.statusCode, 403, remoteAddress);
  }
  assert.deepEqual(h.seen, []);

  // The forms loopback genuinely arrives in, including the IPv4-mapped one a
  // dual-stack socket reports.
  for (const remoteAddress of ['127.0.0.1', '127.0.0.53', '::1', '::ffff:127.0.0.1']) {
    const res = await post(h, { remoteAddress });
    assert.equal(res.statusCode, 204, remoteAddress);
  }
  assert.equal(h.seen.length, 4);
});

test('a valid secret is still not permission to speak for an unknown session', async (t) => {
  const h = await harness(t);
  // No row at all: Claude Code run by hand in a directory tether once managed,
  // with the shim still installed there. Not an error, and not accepted either.
  const res = await post(h);
  assert.equal(res.statusCode, 204);
  assert.deepEqual(h.seen, []);
});

test('a hook for a session tether has not identified yet adopts the one row in that cwd', async (t) => {
  const h = await harness(t);
  // The first tool call of a new session: `PreToolUse` can arrive before the
  // transcript scan has claimed the row. The cwd narrows it to one row, and the
  // row's own pane confirms it is running this very session.
  const id = liveSession(h.db, null);
  h.pane.running = PROVIDER_SESSION;

  const res = await post(h);
  assert.equal(res.statusCode, 204);
  assert.equal(h.seen[0]?.sessionId, id);
  assert.equal(
    getSession(h.db, id)?.providerSessionId,
    PROVIDER_SESSION,
    'and the row is back-filled, so the next hook takes the direct join',
  );
});

test('an agent run by hand in the same directory does not take the row', async (t) => {
  const h = await harness(t);
  // The shim stays installed in a project after tether is done with it, so a
  // `claude` started by hand there posts a matching cwd and an unknown session
  // id. Binding the row to it would point the conversation view at a foreign
  // transcript and make `resume` restore somebody else's session — so the cwd
  // is not enough, and tether's own pane is not running this session.
  const id = liveSession(h.db, null);

  const res = await post(h);
  assert.equal(res.statusCode, 204, 'dropped as an unknown session, which is not an error');
  assert.deepEqual(h.seen, [], 'and nothing reached the conversation');
  assert.equal(
    getSession(h.db, id)?.providerSessionId,
    null,
    'the row is still unclaimed, and its own transcript can still claim it',
  );
});

test('a payload with no session id is dropped rather than guessed at', async (t) => {
  const h = await harness(t);
  liveSession(h.db, null);

  for (const payload of [{}, { cwd: CWD }, { session_id: '', cwd: CWD }, { session_id: 7 }]) {
    const res = await post(h, { payload });
    assert.equal(res.statusCode, 204, JSON.stringify(payload));
  }
  assert.deepEqual(h.seen, []);
});

test('the route needs no cookie, and a browser still cannot reach it cross-origin', async (t) => {
  const h = await harness(t);
  liveSession(h.db);

  // No cookie: this is the one route besides /api/login that is `public`.
  const res = await post(h);
  assert.equal(res.statusCode, 204);

  // The Origin guard in server.ts runs on `onRequest`, so it covers this route
  // too — a page on another origin cannot POST here with the user's cookie.
  const cross = await h.app.inject({
    method: 'POST',
    url: '/internal/hook',
    headers: {
      host: HOST,
      origin: 'http://evil.example',
      'content-type': 'application/json',
      'x-tether-hook': h.secret,
    },
    remoteAddress: '127.0.0.1',
    payload: preToolUse(),
  });
  assert.equal(cross.statusCode, 403);
  assert.equal(cross.json().error, 'forbidden_origin');
});

test('a state directory with no secret in it accepts nothing at all', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tether-hook-empty-'));
  const db = new DatabaseSync(':memory:');
  applyRegistrySchema(db);
  const auth = createAuthStore(db);
  await auth.setPassword('correct horse battery staple');
  const app = buildServer({
    auth,
    db,
    terminals: noTerminals,
    allowedHosts: defaultAllowedHosts('127.0.0.1'),
    stateDir,
    loginDelayMs: 0,
  });
  t.after(() => app.close());
  liveSession(db);

  const res = await app.inject({
    method: 'POST',
    url: '/internal/hook',
    headers: { host: HOST, 'content-type': 'application/json', 'x-tether-hook': 'anything' },
    remoteAddress: '127.0.0.1',
    payload: preToolUse(),
  });
  assert.equal(res.statusCode, 401, 'no secret on disk is not the same as no secret required');

  // An empty file is not a secret either — the emptiest possible presented value
  // must not match it.
  await writeFile(join(stateDir, 'claude-hook.secret'), '\n', { mode: 0o600 });
  const empty = await app.inject({
    method: 'POST',
    url: '/internal/hook',
    headers: { host: HOST, 'content-type': 'application/json', 'x-tether-hook': '' },
    remoteAddress: '127.0.0.1',
    payload: preToolUse(),
  });
  assert.equal(empty.statusCode, 401);
});

test('a decision the user tapped is what the hook is answered with', async (t) => {
  const h = await harness(t);
  liveSession(h.db);

  for (const decision of ['allow', 'deny'] as const) {
    h.answer.decision = decision;
    const res = await post(h);
    // 200 with a body is the *only* way a decision leaves tether, and the shim
    // rebuilds Claude Code's own shape from it rather than echoing it — so a
    // reply this route should never send cannot reach the decision channel.
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { decision });
  }
});
