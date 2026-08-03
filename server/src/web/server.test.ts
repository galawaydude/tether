import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { applyRegistrySchema, createSession, markDead } from '../machine/registry.ts';
import { createTerminals } from '../machine/terminal.ts';
import type { Terminals } from '../machine/terminal.ts';
import {
  UnsafeArgumentError,
  captureViewport,
  killServer,
  newSession,
  paneSize,
  pasteText,
  resizeWindow,
  sendKeys,
} from '../machine/tmux.ts';
import { createAuthStore } from './auth.ts';
import { defaultAllowedHosts } from './guards.ts';
import { SESSION_COOKIE, buildServer } from './server.ts';
import type { ServerOptions } from './server.ts';
import { CLOSE_NO_SESSION, CLOSE_SESSION_ENDED } from './term-socket.ts';

const PASSWORD = 'correct horse battery staple';
const HOST = 'localhost:8787';

/**
 * A `Terminals` that records instead of driving tmux. What is under test here is
 * the socket's guards and framing; `machine/terminal.test.ts` drives the real
 * thing against a real tmux.
 */
function recordingTerminals(refusedKey?: string, refreshGate?: Promise<void>) {
  const calls: string[] = [];
  let emit: ((bytes: Uint8Array) => void) | undefined;
  let ended: (() => void) | undefined;
  const terminals: Terminals = {
    async attach(session, viewer, onEnd, initialReplay = true) {
      if (session === 'missing') throw new Error('no such session');
      calls.push(`attach ${session}`);
      emit = viewer;
      ended = onEnd;
      if (initialReplay) viewer(Buffer.from('replay-héllo', 'utf8'));
      return () => calls.push(`detach ${session}`);
    },
    async refresh(session, viewer, replay) {
      calls.push(`refresh ${session}`);
      await refreshGate;
      assert.equal(viewer, emit);
      replay(Buffer.from('replay-héllo', 'utf8'));
      emit?.(Buffer.from('repaint'));
    },
    async resize(session, cols, rows) {
      calls.push(`resize ${session} ${cols}x${rows}`);
    },
    async input(session, clientId, seq, text) {
      calls.push(`input ${session} ${clientId} ${seq} ${JSON.stringify(text)}`);
      return true;
    },
    async text(session, clientId, seq, text) {
      calls.push(`text ${session} ${clientId} ${seq} ${JSON.stringify(text)}`);
      return true;
    },
    async key(session, clientId, seq, keys) {
      // What the real driver does with a key name tmux's lexer would eat.
      if (refusedKey !== undefined && keys.includes(refusedKey)) {
        throw new UnsafeArgumentError(refusedKey);
      }
      calls.push(`key ${session} ${clientId} ${seq} ${keys.join('+')}`);
      return true;
    },
    closeAll() {},
  };
  return {
    terminals,
    calls,
    push: (bytes: Uint8Array) => emit?.(bytes),
    end: () => ended?.(),
  };
}

async function harness(
  overrides: Partial<ServerOptions> = {},
  refusedKey?: string,
  refreshGate?: Promise<void>,
) {
  // One database for both, as in production: the auth store and the registry share
  // the single SQLite file.
  const db = new DatabaseSync(':memory:');
  applyRegistrySchema(db);
  const auth = createAuthStore(db);
  await auth.setPassword(PASSWORD);
  const recorder = recordingTerminals(refusedKey, refreshGate);
  const app = buildServer({
    auth,
    db,
    terminals: recorder.terminals,
    allowedHosts: defaultAllowedHosts('127.0.0.1'),
    // Tests must not spend 250ms per login attempt; the delay itself is
    // asserted separately.
    loginDelayMs: 0,
    ...overrides,
  });
  return { auth, app, db, terminal: recorder };
}

function login(app: ReturnType<typeof buildServer>, password = PASSWORD, headers = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { host: HOST, origin: `http://${HOST}`, ...headers },
    payload: { password },
  });
}

test('login with the right password sets a session cookie and opens the door', async (t) => {
  const { app } = await harness();
  t.after(() => app.close());

  const res = await login(app);
  assert.equal(res.statusCode, 200);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  assert.ok(token, 'a session cookie was set');

  const after = await app.inject({
    method: 'GET',
    url: '/api/session',
    headers: { host: HOST, cookie: `${SESSION_COOKIE}=${token}` },
  });
  assert.equal(after.statusCode, 200);
  assert.deepEqual(after.json(), { authenticated: true });
});

test('login with the wrong password is rejected and sets no cookie', async (t) => {
  const { app } = await harness();
  t.after(() => app.close());

  const res = await login(app, 'not the password');
  assert.equal(res.statusCode, 401);
  assert.equal(res.cookies.length, 0);
  assert.equal(res.json().error, 'invalid_credentials');
});

test('the session cookie is HttpOnly, SameSite=Strict, Path=/ and expiring', async (t) => {
  const { app } = await harness();
  t.after(() => app.close());

  const cookie = (await login(app)).cookies[0];
  assert.equal(cookie?.httpOnly, true);
  assert.equal(cookie?.sameSite, 'Strict');
  assert.equal(cookie?.path, '/');
  assert.ok(cookie?.expires instanceof Date && cookie.expires.getTime() > Date.now());
});

test('Secure is set only when the request genuinely arrived over HTTPS', async (t) => {
  const untrusted = await harness();
  t.after(() => untrusted.app.close());
  // A client can always send X-Forwarded-Proto. With no trusted proxy configured
  // it must not be able to make the cookie Secure (which would strand it on
  // plain HTTP), nor to influence any other decision.
  const spoofed = await login(untrusted.app, PASSWORD, { 'x-forwarded-proto': 'https' });
  assert.equal(spoofed.cookies[0]?.secure, undefined);

  const trusted = await harness({ trustedProxies: ['127.0.0.1'] });
  t.after(() => trusted.app.close());
  const proxied = await trusted.app.inject({
    method: 'POST',
    url: '/api/login',
    remoteAddress: '127.0.0.1',
    headers: { host: HOST, origin: `https://${HOST}`, 'x-forwarded-proto': 'https' },
    payload: { password: PASSWORD },
  });
  assert.equal(proxied.statusCode, 200);
  assert.equal(proxied.cookies[0]?.secure, true);
});

test('every route is denied by default without a valid session', async (t) => {
  const { app, auth } = await harness();
  t.after(() => app.close());

  for (const cookie of [undefined, `${SESSION_COOKIE}=nonsense`, `${SESSION_COOKIE}=`]) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: cookie === undefined ? { host: HOST } : { host: HOST, cookie },
    });
    assert.equal(res.statusCode, 401, String(cookie));
  }

  // An expired token is no better than a forged one.
  const { token } = auth.createSession(Date.now() - 400 * 24 * 60 * 60 * 1000);
  const expired = await app.inject({
    method: 'GET',
    url: '/api/session',
    headers: { host: HOST, cookie: `${SESSION_COOKIE}=${token}` },
  });
  assert.equal(expired.statusCode, 401);
});

test('default-deny reaches routes that do not exist yet', async (t) => {
  const { app } = await harness();
  t.after(() => app.close());

  // The guarantee this PR exists to make: a route added later is protected
  // unless it opts out, and an unauthenticated caller cannot even learn which
  // paths are real.
  for (const method of ['GET', 'POST'] as const) {
    const res = await app.inject({
      method,
      url: '/api/sessions',
      headers: { host: HOST, origin: `http://${HOST}` },
    });
    assert.equal(res.statusCode, 401, method);
  }

  // …and the header guards still run ahead of it.
  const rebound = await app.inject({
    method: 'GET',
    url: '/api/sessions',
    headers: { host: 'attacker.example' },
  });
  assert.equal(rebound.statusCode, 403);
});

test('default-deny runs before the body is parsed or validated', async (t) => {
  const { app } = await harness();
  t.after(() => app.close());

  // A schema-violating body on a real route. A 400 here would be an oracle:
  // it distinguishes /api/logout from a path that does not exist.
  const real = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ surprise: true }),
  });
  assert.equal(real.statusCode, 401);

  const unmatched = await app.inject({
    method: 'POST',
    url: '/api/does-not-exist',
    headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ surprise: true }),
  });
  assert.equal(unmatched.statusCode, 401);
});

test('logout revokes the session server-side and clears the cookie', async (t) => {
  const { app } = await harness();
  t.after(() => app.close());

  const token = (await login(app)).cookies[0]?.value;
  const headers = { host: HOST, origin: `http://${HOST}`, cookie: `${SESSION_COOKIE}=${token}` };

  const out = await app.inject({ method: 'POST', url: '/api/logout', headers });
  assert.equal(out.statusCode, 204);
  assert.equal(out.cookies[0]?.value, '');

  // Replaying the same token after logout must fail — this is what a stateless
  // signed token could not give us.
  const replay = await app.inject({ method: 'GET', url: '/api/session', headers });
  assert.equal(replay.statusCode, 401);
});

test('login bodies are validated against the schema', async (t) => {
  const { app } = await harness();
  t.after(() => app.close());

  const bad = [
    {},
    { password: 123 },
    { password: '' },
    { password: PASSWORD, extra: true },
    { password: 'a'.repeat(1025) },
    'not an object',
    null,
  ];
  for (const payload of bad) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test('logout rejects a body it does not expect', async (t) => {
  const { app } = await harness();
  t.after(() => app.close());

  const token = (await login(app)).cookies[0]?.value;
  const res = await app.inject({
    method: 'POST',
    url: '/api/logout',
    headers: {
      host: HOST,
      origin: `http://${HOST}`,
      cookie: `${SESSION_COOKIE}=${token}`,
      'content-type': 'application/json',
    },
    payload: JSON.stringify({ surprise: true }),
  });
  assert.equal(res.statusCode, 400);
});

test('a disallowed Host is refused before anything else happens', async (t) => {
  const { app } = await harness();
  t.after(() => app.close());

  for (const host of ['attacker.example:8787', 'evil.localhost', 'not a host']) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { host },
      payload: { password: PASSWORD },
    });
    assert.equal(res.statusCode, 403, host);
    assert.equal(res.json().error, 'forbidden_host');
    assert.equal(res.cookies.length, 0, 'a rebinding attacker never gets a cookie');
  }

  // It applies to reads too, not only to state-changing methods.
  const read = await app.inject({
    method: 'GET',
    url: '/api/session',
    headers: { host: 'attacker.example' },
  });
  assert.equal(read.statusCode, 403);
});

test('the Origin truth table is enforced on state-changing requests', async (t) => {
  const { app } = await harness();
  t.after(() => app.close());

  const rows: [string | undefined, number][] = [
    ['http://evil.example', 403], // present and foreign
    ['http://localhost:3000', 403], // same host, another local app
    ['null', 403], // opaque origin (sandboxed iframe, some redirects)
    [undefined, 200], // absent: curl and the hook receiver
    [`http://${HOST}`, 200], // present and allowed
  ];
  for (const [origin, expected] of rows) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: origin === undefined ? { host: HOST } : { host: HOST, origin },
      payload: { password: PASSWORD },
    });
    assert.equal(res.statusCode, expected, `Origin: ${String(origin)}`);
  }
});

test('a foreign Origin does not block safe methods', async (t) => {
  const { app } = await harness();
  t.after(() => app.close());

  const token = (await login(app)).cookies[0]?.value;
  const res = await app.inject({
    method: 'GET',
    url: '/api/session',
    headers: { host: HOST, origin: 'http://evil.example', cookie: `${SESSION_COOKIE}=${token}` },
  });
  // SameSite=Strict is what protects reads; the Origin guard exists for the
  // methods a cross-site form can actually send.
  assert.equal(res.statusCode, 200);
});

test('rate limiting engages after repeated failures from one IP', async (t) => {
  const { app } = await harness({ loginMaxFailures: 3, loginWindowMs: 60_000 });
  t.after(() => app.close());

  const attempt = (password: string, ip = '10.0.0.1') =>
    app.inject({
      method: 'POST',
      url: '/api/login',
      remoteAddress: ip,
      headers: { host: HOST, origin: `http://${HOST}` },
      payload: { password },
    });

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await attempt('wrong')).statusCode, 401, `attempt ${i + 1}`);
  }

  const locked = await attempt('wrong');
  assert.equal(locked.statusCode, 429);
  assert.ok(Number(locked.headers['retry-after']) > 0);

  // Locked out even with the correct password — otherwise the counter would be
  // a hint rather than a limit.
  assert.equal((await attempt(PASSWORD)).statusCode, 429);

  // Another client is unaffected.
  assert.equal((await attempt(PASSWORD, '10.0.0.2')).statusCode, 200);
});

test('concurrent attempts from one IP cannot outrun the lockout', async (t) => {
  const { app } = await harness({ loginMaxFailures: 3, loginWindowMs: 60_000 });
  t.after(() => app.close());

  // All twelve are in flight before any verification resolves, which is exactly
  // the case a counter incremented on failure would let through.
  const codes = (
    await Promise.all(
      Array.from({ length: 12 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/login',
          remoteAddress: '10.0.0.4',
          headers: { host: HOST, origin: `http://${HOST}` },
          payload: { password: 'wrong' },
        }),
      ),
    )
  ).map((res) => res.statusCode);

  assert.equal(codes.filter((c) => c === 401).length, 3, 'no more guesses than the limit');
  assert.equal(codes.filter((c) => c === 429).length, 9);
});

test('a successful login clears that IP’s failure counter', async (t) => {
  const { app } = await harness({ loginMaxFailures: 3, loginWindowMs: 60_000 });
  t.after(() => app.close());

  const attempt = (password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/login',
      remoteAddress: '10.0.0.3',
      headers: { host: HOST, origin: `http://${HOST}` },
      payload: { password },
    });

  await attempt('wrong');
  await attempt('wrong');
  assert.equal((await attempt(PASSWORD)).statusCode, 200);
  await attempt('wrong');
  await attempt('wrong');
  assert.equal((await attempt('wrong')).statusCode, 401, 'the counter restarted');
});

test('the fixed login delay applies to every attempt', async (t) => {
  const { app } = await harness({ loginDelayMs: 60 });
  t.after(() => app.close());

  const started = process.hrtime.bigint();
  await login(app, 'wrong');
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs >= 55, `login took ${elapsedMs.toFixed(1)}ms`);
});

test('login still fails closed when no password has been set', async (t) => {
  const db = new DatabaseSync(':memory:');
  applyRegistrySchema(db);
  const app = buildServer({
    auth: createAuthStore(db),
    db,
    terminals: recordingTerminals().terminals,
    allowedHosts: defaultAllowedHosts('127.0.0.1'),
    loginDelayMs: 0,
  });
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { host: HOST, origin: `http://${HOST}` },
    payload: { password: '' },
  });
  assert.notEqual(res.statusCode, 200);
  assert.equal(res.cookies.length, 0);
});

// ── The `term` WebSocket ──────────────────────────────────────────────────────
// An upgrade carries cookies but is not a CORS request and is not a
// state-changing method, so it would sail past both browser-side and
// method-based defences. Reaching this route is a shell (report section 7), so
// every rejection below is load-bearing.

const TERM_URL = '/api/sessions/s1/term?client=phone';

async function sessionToken(app: ReturnType<typeof buildServer>): Promise<string> {
  const res = await login(app);
  return res.cookies.find((c) => c.name === SESSION_COOKIE)!.value as string;
}

type Frame = { data: Buffer; binary: boolean };

/**
 * The replay is sent the instant the socket opens, so the listener is attached
 * in `onInit` — before the handshake completes — and frames are queued. A
 * listener added after `injectWS` resolves misses it.
 */
function openTerm(
  app: ReturnType<typeof buildServer>,
  headers: Record<string, string>,
  url = TERM_URL,
) {
  const queued: Frame[] = [];
  const waiting: ((frame: Frame) => void)[] = [];
  const socket = app.injectWS(
    url,
    { headers: { host: HOST, origin: `http://${HOST}`, ...headers } },
    {
      onInit: (ws) =>
        ws.on('message', (data: Buffer, binary: boolean) => {
          const frame = { data: Buffer.from(data), binary };
          const next = waiting.shift();
          if (next === undefined) queued.push(frame);
          else next(frame);
        }),
    },
  );
  const next = async (): Promise<Frame> =>
    queued.shift() ?? (await new Promise<Frame>((resolve) => waiting.push(resolve)));
  return { socket, next };
}

test('an unauthenticated terminal upgrade is refused', async (t) => {
  const { app } = await harness();
  t.after(() => app.close());
  await app.ready();

  await assert.rejects(openTerm(app, {}).socket, /401/, 'no cookie, no shell');
});

test('a terminal upgrade with a stale session cookie is refused', async (t) => {
  const { app, auth } = await harness();
  t.after(() => app.close());
  await app.ready();

  const token = await sessionToken(app);
  auth.revokeSession(token);
  await assert.rejects(openTerm(app, { cookie: `${SESSION_COOKIE}=${token}` }).socket, /401/);
});

test('a terminal upgrade from a foreign origin is refused', async (t) => {
  const { app } = await harness();
  t.after(() => app.close());
  await app.ready();

  const token = await sessionToken(app);
  await assert.rejects(
    openTerm(app, { cookie: `${SESSION_COOKIE}=${token}`, origin: 'http://evil.example' }).socket,
    /403/,
    'a page on another origin cannot open this socket with the victim cookie',
  );
});

test('a terminal upgrade with an unallowed Host is refused', async (t) => {
  const { app } = await harness();
  t.after(() => app.close());
  await app.ready();

  const token = await sessionToken(app);
  await assert.rejects(
    openTerm(app, { cookie: `${SESSION_COOKIE}=${token}`, host: 'rebind.example' }).socket,
    /403/,
  );
});

test('terminal output arrives as binary frames and input is ACKed', async (t) => {
  const { app, terminal } = await harness();
  t.after(() => app.close());
  await app.ready();

  const token = await sessionToken(app);
  const term = openTerm(app, { cookie: `${SESSION_COOKIE}=${token}` });
  const socket = await term.socket;
  t.after(() => socket.close());

  const replay = await term.next();
  assert.equal(replay.binary, true, 'terminal bytes are binary frames, never text');
  assert.equal(replay.data.toString('utf8'), 'replay-héllo');

  // A glyph split across two PTY chunks must reach the client as the same bytes
  // it left as — nothing in this path may decode.
  const glyph = Buffer.from('─', 'utf8');
  terminal.push(glyph.subarray(0, 1));
  assert.deepEqual((await term.next()).data, Buffer.from([glyph[0]!]));
  terminal.push(glyph.subarray(1));
  assert.deepEqual((await term.next()).data, Buffer.from(glyph.subarray(1)));

  socket.send(JSON.stringify({ c: 'input', seq: 1, text: 'first\nsecond' }));
  const ack = await term.next();
  assert.equal(ack.binary, false);
  assert.deepEqual(JSON.parse(ack.data.toString('utf8')), { c: 'ack', seq: 1 });

  socket.send(JSON.stringify({ c: 'resize', cols: 100, rows: 30 }));
  socket.send(JSON.stringify({ c: 'key', seq: 2, keys: ['C-c'] }));
  assert.deepEqual(JSON.parse((await term.next()).data.toString('utf8')), {
    c: 'ack',
    seq: 2,
  });

  // Typed text is its own frame: it is delivered but never submitted, and it is
  // how a `;` reaches the pane without ever being a tmux argv element.
  socket.send(JSON.stringify({ c: 'text', seq: 3, text: ';' }));
  assert.deepEqual(JSON.parse((await term.next()).data.toString('utf8')), {
    c: 'ack',
    seq: 3,
  });

  assert.deepEqual(terminal.calls, [
    'attach s1',
    'input s1 phone 1 "first\\nsecond"',
    'resize s1 100x30',
    'key s1 phone 2 C-c',
    'text s1 phone 3 ";"',
  ]);
});

test('a hidden terminal sends no replay or live bytes until output is enabled', async (t) => {
  const { app, terminal } = await harness();
  t.after(() => app.close());
  await app.ready();

  const term = openTerm(
    app,
    { cookie: `${SESSION_COOKIE}=${await sessionToken(app)}` },
    `${TERM_URL}&output=0`,
  );
  const socket = await term.socket;
  t.after(() => socket.close());

  // Keep the one waiter: after proving it stayed unresolved, the enable below
  // must resolve this same promise with the fresh replay.
  const first = term.next();
  terminal.push(Buffer.from('live-but-hidden'));
  const arrivedHidden = await Promise.race([
    first.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 30)),
  ]);
  assert.equal(arrivedHidden, false, 'neither the attach replay nor live output crossed the wire');

  socket.send(JSON.stringify({ c: 'output', enabled: true }));
  const replay = await first;
  assert.equal(replay.binary, true);
  assert.equal(replay.data.toString(), 'replay-héllo');
  assert.equal((await term.next()).data.toString(), 'repaint');

  terminal.push(Buffer.from('visible-now'));
  assert.equal((await term.next()).data.toString(), 'visible-now');
  assert.deepEqual(terminal.calls, ['attach s1', 'refresh s1']);
});

test('live bytes stay muted until the refresh replay is sent', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app, terminal } = await harness({}, undefined, gate);
  t.after(() => app.close());
  await app.ready();

  const term = openTerm(
    app,
    { cookie: `${SESSION_COOKIE}=${await sessionToken(app)}` },
    `${TERM_URL}&output=0`,
  );
  const socket = await term.socket;
  t.after(() => socket.close());
  const first = term.next();
  socket.send(JSON.stringify({ c: 'output', enabled: true }));
  await delay(10);
  terminal.push(Buffer.from('newer-live-output'));
  release();

  assert.equal((await first).data.toString(), 'replay-héllo');
  assert.equal((await term.next()).data.toString(), 'repaint');
});

test('a key the argv guard refuses costs one keystroke, not the session', async (t) => {
  // Alt+`;` reaches the driver as the key name `M-;`, which tmux's lexer would
  // eat, so the guard refuses it. That must not read as a dead attach: closing
  // here makes the client reset its terminal and replay the whole pane.
  const { app, terminal } = await harness({}, 'M-;');
  t.after(() => app.close());
  await app.ready();

  const token = await sessionToken(app);
  const term = openTerm(app, { cookie: `${SESSION_COOKIE}=${token}` });
  const socket = await term.socket;
  t.after(() => socket.close());
  await term.next();

  socket.send(JSON.stringify({ c: 'key', seq: 1, keys: ['M-;'] }));
  assert.deepEqual(JSON.parse((await term.next()).data.toString('utf8')), { c: 'ack', seq: 1 });
  assert.equal(socket.readyState, socket.OPEN, 'the socket survives a refused frame');

  socket.send(JSON.stringify({ c: 'key', seq: 2, keys: ['C-c'] }));
  assert.deepEqual(JSON.parse((await term.next()).data.toString('utf8')), { c: 'ack', seq: 2 });

  assert.deepEqual(terminal.calls, ['attach s1', 'key s1 phone 2 C-c']);
});

test('a malformed session name or missing client id never reaches tmux', async (t) => {
  const { app, terminal } = await harness();
  t.after(() => app.close());
  await app.ready();

  const cookie = { cookie: `${SESSION_COOKIE}=${await sessionToken(app)}` };
  // `:` and `.` are tmux target syntax, and an absent client id would collapse
  // every viewer's input sequence into one.
  await assert.rejects(openTerm(app, cookie, '/api/sessions/a:b/term?client=phone').socket, /400/);
  await assert.rejects(openTerm(app, cookie, '/api/sessions/s1/term').socket, /400/);
  assert.deepEqual(terminal.calls, []);
});

test('an out-of-range resize is one dropped frame, not a lost terminal', async (t) => {
  const { app, terminal } = await harness();
  t.after(() => app.close());
  await app.ready();

  const term = openTerm(app, { cookie: `${SESSION_COOKIE}=${await sessionToken(app)}` });
  const socket = await term.socket;
  t.after(() => socket.close());
  await term.next();

  // xterm.js reports 0x0 before it has been laid out, and a hidden tab reports
  // it again. Tearing the socket down over that loses the view for good.
  for (const bad of [
    { cols: 0, rows: 0 },
    { cols: 80, rows: 100_000 },
    { cols: -1, rows: 24 },
  ]) {
    socket.send(JSON.stringify({ c: 'resize', ...bad }));
  }
  socket.send(JSON.stringify({ c: 'key', seq: 1, keys: ['C-c'] }));
  assert.deepEqual(JSON.parse((await term.next()).data.toString('utf8')), { c: 'ack', seq: 1 });
  assert.deepEqual(terminal.calls, ['attach s1', 'key s1 phone 1 C-c'], 'no resize reached tmux');
});

/**
 * An attach that exits mid-life asks the registry which failure that was, exactly
 * as a failed attach does — it does not close with a constant.
 *
 * It used to say `CLOSE_SESSION_ENDED` for every PTY exit, and a PTY exits for
 * reasons that are not the session ending: `Ctrl-B d` typed into the web terminal
 * reaches tmux as a real prefix key, and `tmux detach-client` does the same from
 * outside. So a live session told every viewer it had ended. Two rows, two
 * different codes out of the one code path, is what a constant cannot do.
 */
for (const dead of [false, true]) {
  test(`a terminal that ends asks the registry which close that is (dead row: ${dead})`, async (t) => {
    // A socket no tmux server is listening on: the reconcile finds no panes, which
    // is what a session that has really gone looks like, and touches nothing real.
    const tmuxSocket = `tether-close-${randomUUID().slice(0, 8)}`;
    const { app, db, terminal } = await harness({ socket: tmuxSocket });
    t.after(() => app.close());
    await app.ready();
    if (dead) {
      const row = createSession(db, {
        id: randomUUID(),
        provider: 'claude-code',
        cwd: tmpdir(),
        title: 's1',
        tmuxName: 's1',
      });
      markDead(db, row.id);
    }

    const term = openTerm(app, { cookie: `${SESSION_COOKIE}=${await sessionToken(app)}` });
    const socket = await term.socket;
    await term.next();

    // Without this the viewer sits forever on a terminal that will never receive
    // another byte and never hears why.
    const closed = new Promise<number>((resolve) => socket.on('close', resolve));
    terminal.end();
    assert.equal(await closed, dead ? CLOSE_SESSION_ENDED : CLOSE_NO_SESSION);
  });
}

test('a socket that closes during the attach still detaches', async (t) => {
  const db = new DatabaseSync(':memory:');
  applyRegistrySchema(db);
  const auth = createAuthStore(db);
  await auth.setPassword(PASSWORD);
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const terminals: Terminals = {
    // An attach is two tmux spawns and a PTY spawn; a client can give up inside
    // that window, and the viewer and its PTY would then leak for good.
    async attach(session) {
      await gate;
      return () => calls.push(`detach ${session}`);
    },
    async refresh() {},
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
  const app = buildServer({
    auth,
    db,
    terminals,
    allowedHosts: defaultAllowedHosts('127.0.0.1'),
    loginDelayMs: 0,
  });
  t.after(() => app.close());
  await app.ready();

  const term = openTerm(app, { cookie: `${SESSION_COOKIE}=${await sessionToken(app)}` });
  const socket = await term.socket;
  socket.close();
  await new Promise<void>((resolve) => socket.on('close', () => resolve()));
  release();

  for (let i = 0; i < 100 && calls.length === 0; i += 1) await delay(10);
  assert.deepEqual(calls, ['detach s1']);
});

// ── Two viewers of one session, over two real sockets ─────────────────────────
/**
 * The one test in this file that drives a real tmux, and it earns it: everything
 * above stubs `Terminals` because the socket's guards and framing are what they
 * are about, and `machine/terminal.test.ts` drives the real driver — but neither
 * of them ever has *two sockets open on one session at once*, which is the whole
 * product promise (pick a session up on another device) and was the shape a live
 * bug was blamed on. What the second viewer needs and the first never exercises
 * is here: the join branch of `Terminals.attach`, the repaint `attach-session`
 * gives the first viewer for free, and an `ack` for input that arrives on a
 * socket the join could have torn down.
 *
 * It is deliberately not the assertion that caught the reported failure — that
 * one was in the browser and is `web/src/keys.test.ts`. This is the coverage
 * whose absence let the server be suspected for it.
 */
const MARKER = 'TETHER-MARKER-9F3A';

/** Never a hang: the bug this file guards against is a frame that never comes. */
async function nextFrame(term: { next: () => Promise<Frame> }, what: string): Promise<Frame> {
  const frame = await Promise.race([term.next(), delay(15_000, null, { ref: false })]);
  if (frame === null) throw new Error(`timed out waiting for ${what}`);
  return frame;
}

async function frameMatching(
  term: { next: () => Promise<Frame> },
  matches: (frame: Frame) => boolean,
  what: string,
): Promise<Frame> {
  for (let i = 0; i < 60; i += 1) {
    const frame = await nextFrame(term, what);
    if (matches(frame)) return frame;
  }
  throw new Error(`no frame was ${what}`);
}

async function waitFor(predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('a second viewer joins a live session and can drive it, first one still live', async (t) => {
  const socket = `tether-two-${randomUUID().slice(0, 8)}`;
  const cwd = await mkdtemp(join(tmpdir(), 'tether-two-'));
  t.after(async () => {
    await killServer(socket);
    await rm(join(tmpdir(), `tmux-${process.getuid?.() ?? ''}`, socket), { force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  await newSession(socket, { name: 's1', cwd, command: ['/bin/sh'], roots: [cwd] });
  // Before any output: resizing afterwards would reflow what is already there.
  await resizeWindow(socket, 's1', 80, 24);
  await pasteText(socket, 's1', `echo ${MARKER}`);
  await sendKeys(socket, 's1', ['Enter']);
  await waitFor(
    async () => (await captureViewport(socket, 's1')).includes(MARKER),
    'the marker to reach the pane',
  );

  const { app } = await harness({ terminals: createTerminals(socket), socket });
  t.after(() => app.close());
  await app.ready();
  const cookie = { cookie: `${SESSION_COOKIE}=${await sessionToken(app)}` };

  const first = openTerm(app, cookie, '/api/sessions/s1/term?client=laptop');
  await first.socket;
  await nextFrame(first, "the first viewer's replay");

  // ── The join ───────────────────────────────────────────────────────────────
  const second = openTerm(app, cookie, '/api/sessions/s1/term?client=phone');
  // Sent the instant the socket is open and so, deterministically, while the
  // server is still inside the attach — which is where a browser really sends
  // it, because `onopen` fires on the handshake and the attach is several tmux
  // spawns behind it. A frame dropped here is never ACKed and never re-sent
  // until the socket is replaced: "Sending…" for the life of a live socket.
  (await second.socket).send(
    JSON.stringify({ c: 'input', seq: 1, text: `echo phone > ${join(cwd, 'phone.txt')}` }),
  );

  const replay = await nextFrame(second, "the second viewer's replay");
  assert.equal(replay.binary, true, 'terminal bytes are binary frames, never text');
  assert.match(replay.data.toString('latin1'), new RegExp(MARKER), 'the pane is replayed');

  // The replay ends in blank rows that push the history into xterm's scrollback,
  // so without the repaint `refreshClients` asks for, this viewer's viewport
  // stays empty for good. `\x1b[H` is that absolutely-positioned redraw.
  const repaint = await frameMatching(
    second,
    (f) => f.binary && f.data.toString('latin1').includes(`\x1b[H`),
    'the repaint a joining viewer has to be sent',
  );
  assert.match(repaint.data.toString('latin1'), new RegExp(MARKER), 'the repaint carries the pane');

  // ── The second viewer drives the pane ──────────────────────────────────────
  const ack = await frameMatching(second, (f) => !f.binary, "the second viewer's ack");
  assert.deepEqual(JSON.parse(ack.data.toString('utf8')), { c: 'ack', seq: 1 });
  await waitFor(
    async () => (await readFile(join(cwd, 'phone.txt'), 'utf8').catch(() => '')).includes('phone'),
    "the second viewer's message to reach the pane",
  );

  (await second.socket).send(JSON.stringify({ c: 'resize', cols: 100, rows: 30 }));
  await waitFor(async () => {
    const size = await paneSize(socket, 's1');
    return size.cols === 100 && size.rows === 30;
  }, "the pane to take the second viewer's dimensions");

  // ── And the first viewer never stopped being one ───────────────────────────
  (await first.socket).send(
    JSON.stringify({ c: 'input', seq: 1, text: `echo laptop > ${join(cwd, 'laptop.txt')}` }),
  );
  const firstAck = await frameMatching(first, (f) => !f.binary, "the first viewer's ack");
  assert.deepEqual(JSON.parse(firstAck.data.toString('utf8')), { c: 'ack', seq: 1 });
  await waitFor(
    async () =>
      (await readFile(join(cwd, 'laptop.txt'), 'utf8').catch(() => '')).includes('laptop'),
    "the first viewer's message to reach the pane",
  );
});
