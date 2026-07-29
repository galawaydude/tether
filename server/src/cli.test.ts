import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createAuthStore } from './web/auth.ts';
import { formatBanner, offLoopbackWarning, resolveServeConfig } from './cli.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const run = promisify(execFile);

function tempState(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'tether-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type CliResult = { code: number; stdout: string; stderr: string };

/** `node server/src/cli.ts …` with an isolated state directory. */
async function cli(args: string[], stateDir: string, stdin = ''): Promise<CliResult> {
  const child = run(process.execPath, [CLI, ...args], {
    env: { ...process.env, TETHER_STATE_DIR: stateDir },
  });
  child.child.stdin?.end(stdin);
  try {
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const error = cause as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

// ── The bind rule: loopback by default, off-loopback needs a password ──

test('the default bind is loopback', () => {
  const config = resolveServeConfig({}, false);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
});

test('binding off-loopback without a password refuses to start', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'tether.example']) {
    assert.throws(() => resolveServeConfig({ host }, false), /refusing to bind/, host);
  }
});

test('binding off-loopback is allowed once a password is set', () => {
  const config = resolveServeConfig({ host: '0.0.0.0', port: '9000' }, true);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 9000);
});

test('loopback still starts without a password, so the password can be set later', () => {
  assert.doesNotThrow(() => resolveServeConfig({ host: '127.0.0.1' }, false));
  assert.doesNotThrow(() => resolveServeConfig({ host: 'localhost' }, false));
});

test('a nonsense port is refused', () => {
  for (const port of ['0', '70000', 'http', '-1', '80.5']) {
    assert.throws(() => resolveServeConfig({ port }, true), /invalid --port/, port);
  }
});

test('an empty --host is refused rather than binding every interface', () => {
  // `--host=` would otherwise reach listen() as "any address" while the banner
  // printed http://:8787 — the silent wildcard bind the default rules out.
  for (const host of ['', ' ', '\t']) {
    assert.throws(() => resolveServeConfig({ host }, true), /invalid --host/, JSON.stringify(host));
  }
});

test('--allowed-host and --trusted-proxy reach the config', () => {
  const config = resolveServeConfig(
    { host: '0.0.0.0', allowedHosts: ['tether.example'], trustedProxies: ['10.0.0.1'] },
    true,
  );
  assert.equal(config.allowedHosts.has('tether.example'), true);
  assert.deepEqual(config.trustedProxies, ['10.0.0.1']);
});

// ── The banner ──

test('the banner states the bind address and whether a password is set', () => {
  const banner = formatBanner(resolveServeConfig({ port: '8787' }, true), true);
  assert.match(banner, /http:\/\/127\.0\.0\.1:8787/);
  assert.match(banner, /password:\s+set/);
  assert.match(banner, /X-Forwarded-\* ignored/);

  const noPassword = formatBanner(resolveServeConfig({}, false), false);
  assert.match(noPassword, /NOT SET/);
});

test('an off-loopback bind warns loudly, and loopback does not', () => {
  assert.equal(offLoopbackWarning(resolveServeConfig({}, true)), null);
  const warning = offLoopbackWarning(resolveServeConfig({ host: '0.0.0.0' }, true));
  assert.match(warning ?? '', /plain HTTP/);
  assert.match(warning ?? '', /shell on this machine/);
});

// ── The command, end to end ──

test('`tether set-password` stores a verifiable password in a 0600 database', async (t) => {
  const stateDir = tempState(t);
  const result = await cli(['set-password'], stateDir, 'correct horse battery staple\n');
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /correct horse/, 'the password is never printed');

  const dbPath = join(stateDir, 'tether.sqlite');
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);

  const auth = createAuthStore(new DatabaseSync(dbPath));
  assert.equal(await auth.verifyPassword('correct horse battery staple'), true);
  assert.equal(await auth.verifyPassword('wrong'), false);
});

test('`tether set-password` refuses a short password without storing anything', async (t) => {
  const stateDir = tempState(t);
  const result = await cli(['set-password'], stateDir, 'short\n');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /at least 8 characters/);
  assert.equal(
    createAuthStore(new DatabaseSync(join(stateDir, 'tether.sqlite'))).hasPassword(),
    false,
  );
});

test('`tether serve --host 0.0.0.0` exits rather than exposing a passwordless shell', async (t) => {
  const stateDir = tempState(t);
  const result = await cli(['serve', '--host', '0.0.0.0'], stateDir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing to bind 0\.0\.0\.0/);
  assert.match(result.stderr, /tether set-password/);
});

test('an unknown command fails and prints usage', async (t) => {
  const stateDir = tempState(t);
  const result = await cli(['definitely-not-a-command'], stateDir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command/);
});
