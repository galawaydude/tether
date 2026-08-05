/**
 * The CLI as a user runs it: a real child process, a real database file under a
 * temporary state directory, and — for the session commands — a real tmux server
 * on its own socket.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { listSessions, openRegistry, setProviderSessionId } from './machine/registry.ts';
import { PROVIDER_COMMANDS, PROVIDER_RESUME } from './machine/sessions.ts';
import { killServer, listSessions as listTmuxSessions } from './machine/tmux.ts';
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
async function cli(
  args: string[],
  stateDir: string,
  stdin = '',
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  const child = run(process.execPath, [CLI, ...args], {
    // These sessions start in temporary directories, not under the default root.
    env: {
      ...process.env,
      TETHER_STATE_DIR: stateDir,
      TETHER_ALLOWED_ROOTS: tmpdir(),
      ...extraEnv,
    },
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

// ── --funnel: the composition, and the password rule it may not escape ──

const FUNNEL = 'my-box.tailnet-1234.ts.net';

test('--funnel composes the three flags it replaces', () => {
  const config = resolveServeConfig({ funnelHost: FUNNEL }, true);
  // Loopback, so the port is unreachable from anywhere but this machine — which
  // is what makes believing that proxy's X-Forwarded-* safe. Verified against a
  // real Funnel: it sends `Host: <name>` with no port, and X-Forwarded-Proto.
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.allowedHosts.has(FUNNEL), true);
  assert.deepEqual(config.trustedProxies, ['127.0.0.1']);
  assert.equal(config.funnelHost, FUNNEL);
});

test('--funnel still takes extra allowed hosts and proxies rather than replacing them', () => {
  const config = resolveServeConfig(
    { funnelHost: FUNNEL, allowedHosts: ['tether.example'], trustedProxies: ['10.0.0.1'] },
    true,
  );
  assert.equal(config.allowedHosts.has(FUNNEL), true);
  assert.equal(config.allowedHosts.has('tether.example'), true);
  assert.deepEqual(config.trustedProxies, ['127.0.0.1', '10.0.0.1']);
});

test('--funnel without a password refuses, though it binds loopback', () => {
  // The whole point of the rule, and the one case "off-loopback" would miss:
  // the bind is loopback and the audience is the internet.
  assert.throws(
    () => resolveServeConfig({ funnelHost: FUNNEL }, false),
    /refusing to publish this machine on the internet/,
  );
});

test('--funnel with --host is refused rather than silently picking one', () => {
  assert.throws(
    () => resolveServeConfig({ funnelHost: FUNNEL, host: '0.0.0.0' }, true),
    /drop --host/,
  );
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

test('the banner hands back the public URL, and says what arms it', () => {
  const banner = formatBanner(resolveServeConfig({ funnelHost: FUNNEL, port: '8787' }, true), true);
  assert.match(banner, new RegExp(`public URL:\\s+https://${FUNNEL}/`));
  // The URL is only live once Funnel is pointed at the port, and tether never
  // does that itself — so the banner may not imply that it has.
  assert.match(banner, /tailscale funnel --bg 8787/);
});

test('a Funnel bind warns about the internet, not about plain HTTP', () => {
  // Loopback, so the off-loopback branch would have returned null here.
  const warning = offLoopbackWarning(resolveServeConfig({ funnelHost: FUNNEL }, true)) ?? '';
  assert.match(warning, new RegExp(`public internet at https://${FUNNEL}/`));
  assert.match(warning, /shell on this machine/);
  // Promoting Funnel does not make its risks quieter: the address is in the
  // certificate-transparency logs, so it is not a second factor.
  assert.match(warning, /not a secret/);
  assert.match(warning, /funnel --bg off/);
  assert.doesNotMatch(warning, /plain HTTP/);
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

test('run through a symlink, the way npm’s bin link is, the CLI still runs', async (t) => {
  const stateDir = tempState(t);
  const link = join(tempState(t), 'tether.ts');
  symlinkSync(CLI, link);

  const { stdout } = await run(process.execPath, [link, 'ls'], {
    env: { ...process.env, TETHER_STATE_DIR: stateDir },
  });
  assert.match(stdout, /^ID\s+STATE\s+PROVIDER/, 'a symlinked entry point must not be a no-op');
  assert.equal(statSync(join(stateDir, 'tether.sqlite')).mode & 0o777, 0o600, 'it did real work');
});

test('an unknown command fails and prints usage', async (t) => {
  const stateDir = tempState(t);
  const result = await cli(['definitely-not-a-command'], stateDir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command/);
});

test('access is read-only and accepts only its status action', async (t) => {
  const stateDir = tempState(t);
  const result = await cli(['access', 'publish'], stateDir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /tether access status/);
  assert.equal(statSync(stateDir).isDirectory(), true, 'the temporary harness made the directory');
  assert.throws(
    () => statSync(join(stateDir, 'tether.sqlite')),
    /ENOENT/,
    'diagnosis never opens or creates the registry',
  );
});

// ── ls | new | kill, against a real tmux server ──

interface Tether {
  (...args: string[]): Promise<CliResult>;
  state: string;
  socket: string;
}

/** A CLI bound to a throwaway state directory and tmux server, cleaned up after. */
async function tetherFor(t: TestContext): Promise<Tether> {
  const state = tempState(t);
  const socket = `tether-test-${randomUUID().slice(0, 8)}`;
  t.after(async () => {
    await killServer(socket);
    await rm(join(tmpdir(), `tmux-${process.getuid?.() ?? ''}`, socket), { force: true });
  });

  const tether = ((...args: string[]) =>
    cli(args, state, '', { TETHER_TMUX_SOCKET: socket })) as Tether;
  tether.state = join(state, 'tether.sqlite');
  tether.socket = socket;
  return tether;
}

/** A pane that sits there until it is killed, so the session stays live. */
const IDLE = ['--', '/bin/sh'];

/**
 * `resume` runs the provider's own command, so it needs a `claude` on PATH. This
 * one idles like the panes above and tests nothing about Claude Code — only that
 * the CLI starts a pane again and the row goes back to live.
 */
const STUB_BIN = mkdtempSync(join(tmpdir(), 'tether-bin-'));
writeFileSync(join(STUB_BIN, 'claude'), '#!/bin/sh\nexec /bin/sh\n', { mode: 0o755 });
process.env['PATH'] = `${STUB_BIN}${delimiter}${process.env['PATH'] ?? ''}`;
process.on('exit', () => rmSync(STUB_BIN, { recursive: true, force: true }));

test('new starts a real tmux session, ls lists it, kill ends it', async (t) => {
  const tether = await tetherFor(t);
  const dir = await mkdtemp(join(tmpdir(), 'tether-proj-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal((await tether('ls')).stdout.trim().split('\n').length, 1, 'header only');

  const created = await tether('new', dir, '--title', 'my project', ...IDLE);
  assert.equal(created.code, 0, created.stderr);
  const [id, tmuxName] = created.stdout.trim().split('\t');
  assert.match(id!, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await listTmuxSessions(tether.socket), [tmuxName]);

  const listed = await tether('ls');
  assert.match(
    listed.stdout,
    new RegExp(`${id!.slice(0, 8)}\\s+live\\s+claude-code\\s+my project`),
  );
  assert.match(listed.stdout, new RegExp(dir));

  // Any unambiguous prefix identifies the session.
  const killed = await tether('kill', id!.slice(0, 8));
  assert.equal(killed.code, 0, killed.stderr);
  assert.deepEqual(await listTmuxSessions(tether.socket), []);
  assert.match((await tether('ls')).stdout, new RegExp(`${id!.slice(0, 8)}\\s+dead`));

  // Dead, not deleted.
  const db = openRegistry(tether.state);
  t.after(() => db.close());
  assert.equal(listSessions(db).length, 1);
  assert.equal(listSessions(db)[0]!.providerSessionId, null);
});

test('ls reconciles: a session killed behind tether’s back shows as dead', async (t) => {
  const tether = await tetherFor(t);
  const dir = await mkdtemp(join(tmpdir(), 'tether-proj-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const id = (await tether('new', dir, ...IDLE)).stdout.trim().split('\t')[0]!;
  assert.match((await tether('ls')).stdout, new RegExp(`${id.slice(0, 8)}\\s+live`));

  await killServer(tether.socket);
  assert.match((await tether('ls')).stdout, new RegExp(`${id.slice(0, 8)}\\s+dead`));
});

test('new titles the session after its directory by default', async (t) => {
  const tether = await tetherFor(t);
  const dir = join(await mkdtemp(join(tmpdir(), 'tether-proj-')), 'widget');
  await mkdir(dir);
  t.after(() => rm(dir, { recursive: true, force: true }));

  await tether('new', dir, ...IDLE);
  assert.match((await tether('ls')).stdout, /widget/);
});

test('bad input fails with a message and leaves nothing behind', async (t) => {
  const tether = await tetherFor(t);

  const missing = await tether('new', join(tmpdir(), `no-such-dir-${randomUUID()}`), ...IDLE);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /refusing to start a session in/);
  assert.deepEqual(await listTmuxSessions(tether.socket), []);
  assert.equal((await tether('ls')).stdout.trim().split('\n').length, 1);

  const unknown = await tether('kill', 'nope');
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /no such session/);

  const badProvider = await tether('new', tmpdir(), '--provider', 'nonesuch');
  assert.equal(badProvider.code, 1);
  assert.match(badProvider.stderr, /unknown provider/);

  for (const argv of [[], ['nonsense'], ['kill'], ['new']]) {
    const result = await tether(...argv);
    assert.equal(result.code, 1, `expected \`tether ${argv.join(' ')}\` to fail`);
    // No argv prints usage on stdout; the rest fail with it on stderr.
    assert.match(result.stdout + result.stderr, /Usage:/);
  }
});

test('resume brings a dead session back, and refuses when there is nothing to resume', async (t) => {
  const tether = await tetherFor(t);
  const dir = await mkdtemp(join(tmpdir(), 'tether-proj-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const id = (await tether('new', dir, ...IDLE)).stdout.trim().split('\t')[0]!;
  const db = openRegistry(tether.state);
  t.after(() => db.close());

  // The row is still provisional: nothing to resume yet, and saying so is the
  // whole point — a fresh pane here would be a different conversation.
  await killServer(tether.socket);
  const nothing = await tether('resume', id.slice(0, 8));
  assert.equal(nothing.code, 1);
  assert.match(nothing.stderr, /no provider session id to resume/);
  assert.deepEqual(await listTmuxSessions(tether.socket), []);

  // With an identity — what the transcript tail back-fills — it resumes.
  const providerSessionId = randomUUID();
  setProviderSessionId(db, id, providerSessionId);
  const resumed = await tether('resume', id.slice(0, 8));
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.match(resumed.stdout, new RegExp(`resumed ${id}`));
  assert.match((await tether('ls')).stdout, new RegExp(`${id.slice(0, 8)}\\s+live`));
  assert.equal(listSessions(db).length, 1, 'the same row, not a second one');
  assert.equal(listSessions(db)[0]!.providerSessionId, providerSessionId);
  assert.deepEqual(await listTmuxSessions(tether.socket), [listSessions(db)[0]!.tmuxName]);
});

// ── `tether codex-hook`: the one command that writes to a file tether does not own ──

test('codex-hook explains before it touches anything, and undoes cleanly', async (t) => {
  const stateDir = tempState(t);
  const codexHome = mkdtempSync(join(tmpdir(), 'tether-codex-'));
  t.after(() => rmSync(codexHome, { recursive: true, force: true }));
  const hooksJson = join(codexHome, 'hooks.json');
  const existing = `${JSON.stringify(
    { hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'gh-axi' }] }] } },
    null,
    2,
  )}\n`;
  writeFileSync(hooksJson, existing);
  const env = { CODEX_HOME: codexHome };

  const before = await cli(['codex-hook'], stateDir, '', env);
  assert.equal(before.code, 0);
  assert.match(before.stdout, /not installed/);
  assert.equal(readFileSync(hooksJson, 'utf8'), existing, 'reporting changes nothing');

  const install = await cli(['codex-hook', 'install'], stateDir, '', env);
  assert.equal(install.code, 0);
  // The user is told what is being added and what declining costs, before the
  // prompt Codex will put in front of them — not after.
  assert.match(install.stdout, /about to add one entry/);
  assert.match(install.stdout, /Declining is a perfectly good answer/);
  assert.match(install.stdout, /Backed up/);
  assert.match(install.stdout, /hooks = true/, 'and told the one thing that is theirs to do');
  assert.ok(
    !/dangerously/i.test(install.stdout + install.stderr),
    'the trust gate is never offered as something to bypass',
  );

  const file = JSON.parse(readFileSync(hooksJson, 'utf8')) as {
    hooks: Record<string, { hooks: { command?: string }[] }[]>;
  };
  assert.equal(file.hooks['SessionStart']?.[0]?.hooks[0]?.command, 'gh-axi', 'still first');
  assert.equal(file.hooks['SessionStart']?.length, 2);

  const remove = await cli(['codex-hook', 'remove'], stateDir, '', env);
  assert.equal(remove.code, 0);
  assert.match(remove.stdout, /Removed tether’s hook/);
  const after = JSON.parse(readFileSync(hooksJson, 'utf8')) as typeof file;
  assert.deepEqual(after.hooks['SessionStart'], [
    { matcher: '', hooks: [{ type: 'command', command: 'gh-axi' }] },
  ]);
});

test('codex-hook refuses an action it does not have', async (t) => {
  const stateDir = tempState(t);
  const result = await cli(['codex-hook', 'bypass-trust'], stateDir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Usage:/);
});

test('a codex session starts codex, and resumes with codex resume', async (t) => {
  const stateDir = tempState(t);
  const dir = await mkdtemp(join(tmpdir(), 'tether-codex-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const socket = `tether-test-${randomUUID().slice(0, 8)}`;
  t.after(() => killServer(socket));
  const env = { TETHER_TMUX_SOCKET: socket };

  // `sleep` stands in for the real CLI: what is under test is that tether knows
  // how to spell Codex's own argv, not that Codex is installed on the runner.
  const created = await cli(
    ['new', dir, '--provider', 'codex', '--', 'sleep', '30'],
    stateDir,
    '',
    env,
  );
  assert.equal(created.code, 0, created.stderr);
  const [id] = created.stdout.trim().split('\t');

  const listed = await cli(['ls'], stateDir, '', env);
  assert.match(listed.stdout, /codex/, 'the row records which provider it is');

  assert.deepEqual(PROVIDER_COMMANDS.get('codex'), ['codex']);
  assert.deepEqual(PROVIDER_RESUME.get('codex')?.('abc-123'), ['codex', 'resume', 'abc-123']);

  await cli(['kill', id!], stateDir, '', env);
  // A Codex session that never got a first message has no conversation to
  // restore, and resume says so rather than starting a fresh one that looks
  // resumed — the row's `provider_session_id` is still null.
  const resumed = await cli(['resume', id!], stateDir, '', env);
  assert.equal(resumed.code, 1);
  assert.match(resumed.stderr, /no provider session id to resume/);
});
