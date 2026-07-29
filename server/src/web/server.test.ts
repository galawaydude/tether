import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { applyRegistrySchema } from '../machine/registry.ts';
import { createAuthStore } from './auth.ts';
import { defaultAllowedHosts } from './guards.ts';
import { SESSION_COOKIE, buildServer } from './server.ts';
import type { ServerOptions } from './server.ts';

const PASSWORD = 'correct horse battery staple';
const HOST = 'localhost:8787';

async function harness(overrides: Partial<ServerOptions> = {}) {
  // One database for both, as in production: the auth store and the registry share
  // the single SQLite file.
  const db = new DatabaseSync(':memory:');
  applyRegistrySchema(db);
  const auth = createAuthStore(db);
  await auth.setPassword(PASSWORD);
  const app = buildServer({
    auth,
    db,
    allowedHosts: defaultAllowedHosts('127.0.0.1'),
    // Tests must not spend 250ms per login attempt; the delay itself is
    // asserted separately.
    loginDelayMs: 0,
    ...overrides,
  });
  return { auth, app };
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
