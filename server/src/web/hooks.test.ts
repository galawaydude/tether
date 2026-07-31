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
import {
  applyRegistrySchema,
  createSession,
  getSession,
  listSessions,
  setProviderSessionId,
} from '../machine/registry.ts';
import type { Terminals } from '../machine/terminal.ts';
import { createAuthStore } from './auth.ts';
import { defaultAllowedHosts } from './guards.ts';
import { ensureHookSecret } from '../providers/permission.ts';
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

  const seen: { sessionId: string; payload: unknown; gone: AbortSignal | undefined }[] = [];
  /**
   * Turns the stub into a hold: `hook` does not resolve until the test releases
   * it or the route abandons it, which is what a real `PreToolUse` or
   * `PermissionRequest` does while the user is deciding.
   */
  const hold: { blocking: boolean; release?: (decision?: 'allow' | 'deny') => void } = {
    blocking: false,
  };
  /**
   * Which session each of tether's own panes is running, by tmux name — what
   * Claude Code's per-pid registry file says, and the exact join the real
   * `bindProviderSession` makes. Empty is the honest default: an agent the user
   * started by hand is in no tether pane and so appears here for nothing.
   * `conversations.test.ts` drives that lookup against real tmux and real
   * registry files; what is under test here is the route.
   */
  const pane = new Map<string, string>();
  /** What the user tapped, where a test is about the decision coming back. */
  const answer: { decision?: 'allow' | 'deny' } = {};
  const conversations = {
    async hook(session: { id: string }, payload: unknown, gone?: AbortSignal) {
      seen.push({ sessionId: session.id, payload, gone });
      if (!hold.blocking) return answer.decision;
      return await new Promise<'allow' | 'deny' | undefined>((resolve) => {
        hold.release = resolve;
        // The real `Conversations.hook` settles its hold as `timeout` here and
        // so returns `undefined`; this only has to stop waiting.
        gone?.addEventListener('abort', () => resolve(undefined), { once: true });
        if (gone?.aborted === true) resolve(undefined);
      });
    },
    async bindProviderSession(providerSessionId: string) {
      const session = listSessions(db).find(
        (row) => row.deadAt === null && pane.get(row.tmuxName) === providerSessionId,
      );
      if (session === undefined) return undefined;
      setProviderSessionId(db, session.id, providerSessionId);
      return getSession(db, session.id);
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
  /**
   * A real loopback socket, which `app.inject` is not — and the abort tests need
   * one, because what is under test is the request dying underneath the handler.
   */
  const listen = async (): Promise<string> => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    return `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  };
  return { app, db, stateDir, secret, seen, pane, answer, hold, listen };
}

/** Poll until `ready`, so nothing here depends on a fixed sleep. */
async function until(ready: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
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
  options: {
    secret?: string | undefined;
    remoteAddress?: string;
    payload?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const secret = 'secret' in options ? options.secret : h.secret;
  return h.app.inject({
    method: 'POST',
    url: '/internal/hook',
    headers: {
      host: HOST,
      'content-type': 'application/json',
      ...(secret === undefined ? {} : { 'x-tether-hook': secret }),
      ...options.headers,
    },
    remoteAddress: options.remoteAddress ?? '127.0.0.1',
    payload: options.payload ?? preToolUse(),
  });
}

/**
 * A live row that already knows its provider session id. `n` distinguishes the
 * several a directory can hold — which is the whole of the bug this route's
 * adoption once had, so making more than one is deliberately cheap.
 */
function liveSession(db: DatabaseSync, providerSessionId: string | null = PROVIDER_SESSION, n = 1) {
  const id = `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`;
  createSession(db, {
    id,
    provider: 'claude-code',
    cwd: CWD,
    title: 'hookspike',
    tmuxName: `tether-${n}${n}${n}${n}${n}${n}${n}${n}`,
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

/**
 * Under `--funnel` the proxy is on this machine, so a loopback peer address no
 * longer means a local caller. These four headers are what a real Funnel adds
 * (tailscale 1.98.10) and what the shim, POSTing to `127.0.0.1`, never sends.
 */
test('a loopback peer that came through a proxy is refused as well', async (t) => {
  const h = await harness(t);
  liveSession(h.db);

  for (const header of [
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'tailscale-funnel-request',
  ]) {
    const res = await post(h, { headers: { [header]: '203.0.113.9' } });
    assert.equal(res.statusCode, 403, header);
  }
  assert.deepEqual(h.seen, []);

  // And the shim's own request, which sets none of them, still gets through.
  assert.equal((await post(h)).statusCode, 204);
  assert.equal(h.seen.length, 1);
});

test('a valid secret is still not permission to speak for an unknown session', async (t) => {
  const h = await harness(t);
  // No row at all: Claude Code run by hand in a directory tether once managed,
  // with the shim still installed there. Not an error, and not accepted either.
  const res = await post(h);
  assert.equal(res.statusCode, 204);
  assert.deepEqual(h.seen, []);
});

test('a hook for a session tether has not identified yet adopts the row whose pane runs it', async (t) => {
  const h = await harness(t);
  // The first tool call of a new session: `PreToolUse` can arrive before the
  // transcript scan has claimed the row. The row's own pane states which session
  // it is running, and that is the join.
  const id = liveSession(h.db, null);
  h.pane.set('tether-11111111', PROVIDER_SESSION);

  const res = await post(h);
  assert.equal(res.statusCode, 204);
  assert.equal(h.seen[0]?.sessionId, id);
  assert.equal(
    getSession(h.db, id)?.providerSessionId,
    PROVIDER_SESSION,
    'and the row is back-filled, so the next hook takes the direct join',
  );
});

test('three sessions in one directory each adopt their own, not the first one found', async (t) => {
  const h = await harness(t);
  // The bug this route shipped with, and the reason the conversation view was
  // empty for most real sessions: the cwd was the join, so a second row in a
  // directory made every row in it ambiguous and adoption could only refuse.
  // Every one of these posts an identical cwd; only their panes tell them apart.
  const ids = [1, 2, 3].map((n) => liveSession(h.db, null, n));
  const running = [
    '11111111-1111-4111-8111-aaaaaaaaaaaa',
    PROVIDER_SESSION,
    '33333333-3333-4333-8333-cccccccccccc',
  ];
  ids.forEach((_, i) => h.pane.set(`tether-${`${i + 1}`.repeat(8)}`, running[i]!));

  for (const [i, id] of ids.entries()) {
    const res = await post(h, { payload: preToolUse({ session_id: running[i] }) });
    assert.equal(res.statusCode, 204);
    assert.equal(h.seen[i]?.sessionId, id, `session ${i + 1} reached its own row`);
    assert.equal(getSession(h.db, id)?.providerSessionId, running[i]);
  }
});

test('an agent run by hand in the same directory does not take a row', async (t) => {
  const h = await harness(t);
  // The shim stays installed in a project after tether is done with it, so a
  // `claude` started by hand there posts a matching cwd and an unknown session
  // id. Binding a row to it would point the conversation view at a foreign
  // transcript and make `resume` restore somebody else's session. It is in no
  // tether pane, so no pane names it and nothing is bound — which holds however
  // many rows the directory has.
  const ids = [liveSession(h.db, null, 1), liveSession(h.db, null, 2)];
  h.pane.set('tether-22222222', '22222222-2222-4222-8222-bbbbbbbbbbbb');

  const res = await post(h);
  assert.equal(res.statusCode, 204, 'dropped as an unknown session, which is not an error');
  assert.deepEqual(h.seen, [], 'and nothing reached the conversation');
  for (const id of ids) {
    assert.equal(
      getSession(h.db, id)?.providerSessionId,
      null,
      'the rows are still unclaimed, and their own transcripts can still claim them',
    );
  }
});

test('a row already bound to another session id still follows its own pane', async (t) => {
  const h = await harness(t);
  // `/resume` in the terminal moves Claude Code to a different session id, so
  // the first hook after one names a session no row holds. Re-binding is what
  // stops the conversation view sitting on a transcript nothing writes to.
  const id = liveSession(h.db, '00000000-0000-4000-8000-000000000000');
  h.pane.set('tether-11111111', PROVIDER_SESSION);

  const res = await post(h);
  assert.equal(res.statusCode, 204);
  assert.equal(h.seen[0]?.sessionId, id);
  assert.equal(getSession(h.db, id)?.providerSessionId, PROVIDER_SESSION);
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

/**
 * A hold whose caller leaves.
 *
 * These are the two tests that need a real socket rather than `app.inject`: what
 * is under test is the request dying underneath a handler that is still waiting.
 * A shim a provider killed at its own `timeout` is indistinguishable from here
 * — same dead socket, same nothing to reply to — so an abandoned `fetch` is a
 * faithful stand-in and needs no subprocess.
 */
async function askAndAbandon(h: Harness, url: string) {
  const gone = new AbortController();
  const request = fetch(`${url}/internal/hook`, {
    method: 'POST',
    headers: { host: HOST, 'content-type': 'application/json', 'x-tether-hook': h.secret },
    body: JSON.stringify(preToolUse()),
    signal: gone.signal,
  }).then(
    () => 'answered',
    () => 'abandoned',
  );
  await until(() => h.seen.length > 0, 'the hook to reach the conversation');
  gone.abort();
  return await request;
}

test('a hook whose caller goes away is told so, rather than waited on', async (t) => {
  const h = await harness(t);
  liveSession(h.db);
  h.hold.blocking = true;
  const url = await h.listen();

  assert.equal(await askAndAbandon(h, url), 'abandoned');
  // The signal is the whole of what the route contributes: `Conversations.hook`
  // settles the hold on it, so no card is left wearing buttons for a decision
  // that can no longer land.
  await until(() => h.seen[0]?.gone?.aborted === true, 'the hold to be abandoned');
});

test('an ordinary reply is not mistaken for a caller that went away', async (t) => {
  const h = await harness(t);
  liveSession(h.db);
  h.answer.decision = 'allow';
  const url = await h.listen();

  const res = await fetch(`${url}/internal/hook`, {
    method: 'POST',
    headers: { host: HOST, 'content-type': 'application/json', 'x-tether-hook': h.secret },
    body: JSON.stringify(preToolUse()),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { decision: 'allow' });

  // `close` fires on every finished reply too, which is the regression the
  // `writableFinished` guard exists to prevent: a decision the user really made
  // must not be followed by an abort that would settle a hold behind it.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(h.seen[0]?.gone?.aborted, false, 'a completed hook was never abandoned');
});
