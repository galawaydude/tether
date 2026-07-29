import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultAllowedHosts,
  isHostAllowed,
  isLoopbackHost,
  isOriginAllowed,
  isStateChanging,
  parseHost,
} from './guards.ts';

const ALLOWED = defaultAllowedHosts('127.0.0.1');

test('Host allowlist accepts the loopback names the server is reachable at', () => {
  for (const host of [
    'localhost:8787',
    '127.0.0.1:8787',
    'LOCALHOST:8787',
    '[::1]:8787',
    'localhost',
  ]) {
    assert.equal(isHostAllowed(host, ALLOWED), true, host);
  }
});

test('Host allowlist rejects a rebinding hostname that resolves to loopback', () => {
  // The DNS-rebinding attack: attacker.example resolves to 127.0.0.1, so the
  // connection is genuinely local — only the Host header exposes it.
  for (const host of ['attacker.example:8787', 'evil.localhost:8787', 'localhost.evil.example']) {
    assert.equal(isHostAllowed(host, ALLOWED), false, host);
  }
});

test('Host allowlist rejects a missing or malformed Host', () => {
  for (const host of [
    undefined,
    '',
    ' ',
    'localhost/../evil',
    'evil.example@localhost',
    'local host',
  ]) {
    assert.equal(isHostAllowed(host, ALLOWED), false, String(host));
  }
});

test('Host allowlist widens only to explicitly configured names', () => {
  const allowed = defaultAllowedHosts('100.64.0.1', ['box.tail-scale.ts.net']);
  assert.equal(isHostAllowed('box.tail-scale.ts.net', allowed), true);
  assert.equal(isHostAllowed('100.64.0.1:8787', allowed), true);
  assert.equal(isHostAllowed('other.example', allowed), false);
});

test('a wildcard bind is never itself an allowed Host', () => {
  assert.equal(defaultAllowedHosts('0.0.0.0').has('0.0.0.0'), false);
  assert.equal(defaultAllowedHosts('::').has('::'), false);
  // Loopback still reaches a wildcard-bound server, so it stays allowed.
  assert.equal(isHostAllowed('localhost:8787', defaultAllowedHosts('0.0.0.0')), true);
});

// ── The Origin truth table from report §7, every row ──

test('Origin present and foreign → reject', () => {
  assert.equal(isOriginAllowed('https://evil.example', 'localhost:8787'), false);
  // Same hostname, different port: a different app on the same machine.
  assert.equal(isOriginAllowed('http://localhost:3000', 'localhost:8787'), false);
  // Same port, different hostname.
  assert.equal(isOriginAllowed('http://evil.example:8787', 'localhost:8787'), false);
});

test('Origin null (opaque) → reject', () => {
  assert.equal(isOriginAllowed('null', 'localhost:8787'), false);
});

test('Origin absent → allow, because non-browser clients omit it', () => {
  assert.equal(isOriginAllowed(undefined, 'localhost:8787'), true);
});

test('Origin present and matching the request Host → allow', () => {
  assert.equal(isOriginAllowed('http://localhost:8787', 'localhost:8787'), true);
  assert.equal(isOriginAllowed('http://LOCALHOST:8787', 'localhost:8787'), true);
  assert.equal(isOriginAllowed('http://[::1]:8787', '[::1]:8787'), true);
  // A TLS-terminating reverse proxy changes the scheme but not the authority.
  assert.equal(isOriginAllowed('https://tether.example', 'tether.example'), true);
  // Default ports are equivalent to no port.
  assert.equal(isOriginAllowed('http://tether.example:80', 'tether.example'), true);
});

test('Origin is rejected when the Host it is compared against is unusable', () => {
  assert.equal(isOriginAllowed('http://localhost:8787', undefined), false);
});

test('Origin with a non-HTTP scheme or embedded credentials → reject', () => {
  assert.equal(isOriginAllowed('file://localhost:8787', 'localhost:8787'), false);
  assert.equal(isOriginAllowed('http://user:pw@localhost:8787', 'localhost:8787'), false);
  assert.equal(isOriginAllowed('not a url', 'localhost:8787'), false);
  assert.equal(isOriginAllowed('', 'localhost:8787'), false);
});

test('state-changing methods are exactly the ones a form can send cross-origin', () => {
  for (const method of ['POST', 'put', 'PATCH', 'DELETE']) {
    assert.equal(isStateChanging(method), true, method);
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(isStateChanging(method), false, method);
  }
});

test('parseHost normalises the authority used for the Origin comparison', () => {
  assert.deepEqual(parseHost('Localhost:8787'), {
    hostname: 'localhost',
    authority: 'localhost:8787',
  });
  assert.deepEqual(parseHost('[::1]:8787'), { hostname: '::1', authority: '::1:8787' });
  assert.equal(parseHost('localhost:notaport'), null);
});

test('isLoopbackHost covers the whole 127/8 block and ::1', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.10', '128.0.0.1', 'example.com']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});
