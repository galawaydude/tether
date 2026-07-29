/**
 * Installing tether's hook into a project.
 *
 * The file being written belongs to the user and lives inside their repository,
 * so most of what is asserted here is restraint: what tether preserves, what it
 * refuses to touch, and above all that the secret never lands in it.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  HOOK_EVENTS,
  SettingsFileError,
  ensureHookSecret,
  hookSecretPath,
  hookShimPath,
  hookTimeoutSeconds,
  installHook,
  permissionTimeoutMs,
  readHookSecret,
  settingsBackupPath,
  settingsPath,
  writeHookEndpoint,
} from './hooks.ts';

async function dirs() {
  const root = await mkdtemp(join(tmpdir(), 'tether-hooks-'));
  const cwd = join(root, 'project');
  const stateDir = join(root, 'state');
  await mkdir(cwd, { recursive: true });
  return { root, cwd, stateDir };
}

async function settings(cwd: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(settingsPath(cwd), 'utf8')) as Record<string, unknown>;
}

async function mode(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o777).toString(8);
}

test('a fresh project gets both events, and the shim by absolute path', async () => {
  const { cwd, stateDir } = await dirs();
  const result = await installHook({ cwd, stateDir });

  assert.deepEqual(result.added, [...HOOK_EVENTS]);
  assert.equal(result.backupPath, undefined, 'there was no file to back up');

  const file = await settings(cwd);
  const hooks = file['hooks'] as Record<
    string,
    { matcher?: string; hooks: { command: string }[] }[]
  >;
  assert.deepEqual(Object.keys(hooks).sort(), ['Notification', 'PreToolUse']);
  assert.equal(hooks['PreToolUse']![0]!.hooks[0]!.command, `'${hookShimPath(stateDir)}'`);
  assert.equal(hooks['PreToolUse']![0]!.matcher, '*', 'a tool matcher, where tools exist');
  assert.equal(hooks['Notification']![0]!.matcher, undefined, 'and none where they do not');
});

test('the secret is a 0600 file, and never a literal in the user’s repo', async () => {
  const { cwd, stateDir } = await dirs();
  await installHook({ cwd, stateDir });

  const secret = await readHookSecret(stateDir);
  assert.ok(secret && secret.length >= 32, 'a real secret was generated');
  assert.equal(await mode(hookSecretPath(stateDir)), '600');

  // The whole point: `.claude/settings.local.json` is inside the user's own
  // repository, so a token written into it is one `git add` from being pushed.
  const text = await readFile(settingsPath(cwd), 'utf8');
  assert.ok(!text.includes(secret), 'the settings file does not contain the secret');
  assert.ok(text.includes(hookShimPath(stateDir)), 'only a path to where it is read from');

  // The shim reads it at hook time rather than carrying a copy.
  const shim = await readFile(hookShimPath(stateDir), 'utf8');
  assert.ok(!shim.includes(secret), 'nor does the shim');
  assert.match(shim, /claude-hook\.secret/);
  assert.equal(await mode(hookShimPath(stateDir)), '700');
});

test('the secret survives a second install, because every shim already has it', async () => {
  const { cwd, stateDir } = await dirs();
  await installHook({ cwd, stateDir });
  const first = await readHookSecret(stateDir);

  await installHook({ cwd, stateDir });
  assert.equal(await readHookSecret(stateDir), first, 'regenerating would break every project');
  assert.equal(await ensureHookSecret(stateDir), first);
});

test('installing twice adds nothing the second time', async () => {
  const { cwd, stateDir } = await dirs();
  await installHook({ cwd, stateDir });
  const before = await readFile(settingsPath(cwd), 'utf8');

  // `startSession` calls this on every spawn in the directory, so a second call
  // that appended again would grow the user's file without bound.
  const again = await installHook({ cwd, stateDir });
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.updated, [], 'and nothing had to be reconciled either');
  assert.equal(await readFile(settingsPath(cwd), 'utf8'), before, 'byte-identical');
  assert.equal(again.backupPath, undefined);
  assert.deepEqual(
    (await readdir(join(cwd, '.claude'))).filter((n) => n.includes('backup')),
    [],
    'and made no backup, because it changed nothing',
  );
});

test('a reinstall at a new hold moves the timeout instead of leaving a stale one', async () => {
  const { cwd, stateDir } = await dirs();
  await mkdir(join(cwd, '.claude'), { recursive: true });
  const original = {
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'their-own-hook' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
    },
  };
  await writeFile(settingsPath(cwd), JSON.stringify(original, null, 2));

  await installHook({ cwd, stateDir, holdMs: 5000 });
  // The upgrade path, which is where everyone ends up: the shim is rewritten on
  // every spawn with an abort derived from the *current* hold, so a settings file
  // still carrying the old number means Claude Code kills the hook and asks in
  // the terminal while tether goes on showing a live countdown and live buttons.
  const again = await installHook({
    cwd,
    stateDir,
    holdMs: 20_000,
    now: new Date('2026-07-29T08:30:00.000Z'),
  });
  assert.deepEqual(again.added, [], 'nothing was added — it was already installed');
  assert.deepEqual(again.updated, [...HOOK_EVENTS], 'and the result says so rather than lying');
  assert.equal(
    again.backupPath,
    settingsBackupPath(stateDir, cwd, '2026-07-29T08-30-00-000Z'),
    'backed up first, exactly as a fresh install does',
  );

  const file = await settings(cwd);
  const hooks = file['hooks'] as Record<
    string,
    { matcher?: string; hooks: Record<string, unknown>[] }[]
  >;
  assert.equal(hooks['PreToolUse']!.length, 2, 'still one tether entry, not a second one');
  assert.equal(
    hooks['PreToolUse']![1]!.hooks[0]!['timeout'],
    hookTimeoutSeconds(20_000),
    'tether’s own entry moved with the hold',
  );
  // The file belongs to the user, and reconciling one field of one handler is
  // the whole of what tether is allowed to do to it.
  assert.deepEqual(file['permissions'], original.permissions, 'an unrelated key is untouched');
  assert.deepEqual(hooks['Stop'], original.hooks.Stop, 'an unrelated event is untouched');
  assert.deepEqual(
    hooks['PreToolUse']![0],
    original.hooks.PreToolUse[0],
    'and another party’s handler, timeout-less as they wrote it',
  );

  // And a third spawn at that same hold is back to changing nothing.
  const before = await readFile(settingsPath(cwd), 'utf8');
  const third = await installHook({ cwd, stateDir, holdMs: 20_000 });
  assert.deepEqual([third.added, third.updated], [[], []]);
  assert.equal(await readFile(settingsPath(cwd), 'utf8'), before);
});

test('an update-only install reconciles its own entry and adds nothing anywhere', async () => {
  const { cwd, stateDir } = await dirs();
  await installHook({ cwd, stateDir, holdMs: 5000 });
  const reconciled = await installHook({ cwd, stateDir, holdMs: 20_000, updateOnly: true });

  assert.deepEqual(reconciled.added, []);
  assert.deepEqual(reconciled.updated, [...HOOK_EVENTS], 'the entry it owns still follows the hold');
  const hooks = (await settings(cwd))['hooks'] as Record<
    string,
    { hooks: Record<string, unknown>[] }[]
  >;
  assert.equal(hooks['PreToolUse']![0]!.hooks[0]!['timeout'], hookTimeoutSeconds(20_000));
});

test('an update-only install never reasserts tether’s presence', async () => {
  // A user who deleted tether's entry from their own repository has given an
  // answer. Same for a project directory they have since removed.
  const theirs = { permissions: { allow: ['Bash(npm test)'] } };

  for (const [what, prepare] of [
    ['no settings file at all', async () => {}],
    [
      'a settings file with no tether entry',
      async (cwd: string) => {
        await mkdir(join(cwd, '.claude'), { recursive: true });
        await writeFile(settingsPath(cwd), JSON.stringify(theirs, null, 2));
      },
    ],
    ['a project directory that is gone', async (cwd: string) => rm(cwd, { recursive: true })],
  ] as const) {
    const { cwd, stateDir } = await dirs();
    await prepare(cwd);
    const before = await readFile(settingsPath(cwd), 'utf8').catch(() => undefined);

    const result = await installHook({ cwd, stateDir, updateOnly: true });
    assert.deepEqual([result.added, result.updated], [[], []], what);
    assert.equal(result.backupPath, undefined, `${what}: nothing changed, so nothing to back up`);
    assert.equal(
      await readFile(settingsPath(cwd), 'utf8').catch(() => undefined),
      before,
      `${what}: not one byte`,
    );
    // Not even the directory: a project the user removed is not tether's to
    // recreate, and a repository with no tether entry stays that way.
    if (before === undefined) await assert.rejects(() => stat(join(cwd, '.claude')), what);
    await assert.rejects(() => readdir(join(stateDir, 'claude-settings-backups')), what);
  }
});

test('raising TETHER_PERMISSION_TIMEOUT reaches a project that was already installed', async (t) => {
  const { cwd, stateDir } = await dirs();
  const before = process.env['TETHER_PERMISSION_TIMEOUT'];
  t.after(() => {
    if (before === undefined) delete process.env['TETHER_PERMISSION_TIMEOUT'];
    else process.env['TETHER_PERMISSION_TIMEOUT'] = before;
  });

  process.env['TETHER_PERMISSION_TIMEOUT'] = '5';
  await installHook({ cwd, stateDir });
  process.env['TETHER_PERMISSION_TIMEOUT'] = '45';
  assert.deepEqual((await installHook({ cwd, stateDir })).updated, [...HOOK_EVENTS]);

  const hooks = (await settings(cwd))['hooks'] as Record<
    string,
    { hooks: Record<string, unknown>[] }[]
  >;
  assert.equal(hooks['PreToolUse']![0]!.hooks[0]!['timeout'], hookTimeoutSeconds(45_000));
});

test('the user’s own settings are preserved, and backed up before being touched', async () => {
  const { cwd, stateDir } = await dirs();
  await mkdir(join(cwd, '.claude'), { recursive: true });
  const original = {
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'their-own-hook' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
    },
  };
  await writeFile(settingsPath(cwd), JSON.stringify(original, null, 2));

  const result = await installHook({ cwd, stateDir, now: new Date('2026-07-29T08:30:00.000Z') });
  const backupPath = result.backupPath;
  assert.ok(backupPath !== undefined, 'an existing file is backed up before it is changed');
  assert.equal(
    backupPath,
    settingsBackupPath(stateDir, cwd, '2026-07-29T08-30-00-000Z'),
    'under tether’s own state directory',
  );
  assert.deepEqual(JSON.parse(await readFile(backupPath, 'utf8')), original);

  // The conventional gitignore entry is the literal path
  // `.claude/settings.local.json`, so a backup beside it would be an untracked,
  // unignored copy of the user's settings that `git add .` sweeps up.
  assert.deepEqual(await readdir(join(cwd, '.claude')), ['settings.local.json']);

  const file = await settings(cwd);
  assert.deepEqual(file['permissions'], original.permissions, 'an unrelated key is untouched');
  const hooks = file['hooks'] as Record<string, { hooks: { command: string }[] }[]>;
  assert.deepEqual(hooks['Stop'], original.hooks.Stop, 'an unrelated event is untouched');
  assert.equal(hooks['PreToolUse']!.length, 2, 'appended beside theirs, not replacing it');
  assert.equal(hooks['PreToolUse']![0]!.hooks[0]!.command, 'their-own-hook', 'and after it');
  assert.equal(hooks['PreToolUse']![1]!.hooks[0]!.command, `'${hookShimPath(stateDir)}'`);
});

test('a state directory with a space in it still runs the hook', async () => {
  const { root, cwd } = await dirs();
  // Reachable through `$HOME` alone — `/Users/First Last/.local/state/tether` —
  // and Claude Code runs a hook's command through a shell, so an unquoted path
  // is word-split and the hook silently never fires.
  const stateDir = join(root, 'state dir');
  await installHook({ cwd, stateDir });

  const hooks = (await settings(cwd))['hooks'] as Record<
    string,
    { hooks: { command: string }[] }[]
  >;
  const command = hooks['PreToolUse']![0]!.hooks[0]!.command;
  assert.equal(command, `'${hookShimPath(stateDir)}'`);
  // Proof rather than assertion: the shell this is handed to finds the file.
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', `test -x ${command} && echo ok`]);
  assert.equal(stdout.trim(), 'ok');

  // And the quoted form is still recognised as tether's own on the next spawn.
  assert.deepEqual((await installHook({ cwd, stateDir })).added, []);
});

test('a settings file tether does not understand is left exactly as it was', async () => {
  for (const body of ['{ not json', '[]', '"a string"', '{"hooks": 7}', '{"hooks":{"Stop":7}}']) {
    const { cwd, stateDir } = await dirs();
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(settingsPath(cwd), body);

    await assert.rejects(() => installHook({ cwd, stateDir }), SettingsFileError, body);
    assert.equal(await readFile(settingsPath(cwd), 'utf8'), body, 'not one byte changed');
    // Validated before anything is written, so a refusal leaves no shim behind
    // in a state directory tether had not otherwise created.
    await assert.rejects(() => stat(hookShimPath(stateDir)));
  }
});

test('an empty or absent settings file is a fresh install, not a refusal', async () => {
  for (const body of [undefined, '', '   \n']) {
    const { cwd, stateDir } = await dirs();
    if (body !== undefined) {
      await mkdir(join(cwd, '.claude'), { recursive: true });
      await writeFile(settingsPath(cwd), body);
    }
    const result = await installHook({ cwd, stateDir });
    assert.deepEqual(result.added, [...HOOK_EVENTS], JSON.stringify(body));
  }
});

/**
 * The shim itself, run as Claude Code runs it.
 *
 * This is the one file in tether where stdout is a security boundary: on
 * `PreToolUse` that channel *is* the permission decision, so a stray write
 * silently allows or blocks a tool call on the user's machine. Nothing short of
 * executing the installed file and reading its bytes proves what it says, so
 * these tests do exactly that against a stub tether.
 */
async function stubTether(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void>; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push(Buffer.concat(chunks).toString('utf8'));
      handler(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/internal/hook`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Runs the installed shim the way Claude Code does: payload on stdin, read stdout. */
async function runShim(stateDir: string, payload: unknown) {
  const shim = hookShimPath(stateDir);
  return await new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
    const child = execFile(shim, (error) => {
      if (error !== null && error.code === undefined) reject(error);
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: string) => (stdout += chunk));
    child.on('close', (code) => resolve({ stdout, code }));
    child.stdin?.end(JSON.stringify(payload));
  });
}

const PRE_TOOL_USE = {
  session_id: '11111111-2222-4333-8444-555555555555',
  cwd: '/tmp/project',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf ./build' },
  tool_use_id: 'toolu_01Shim',
};

test('a decision tether sends comes back on stdout in Claude Code’s own shape', async () => {
  const { cwd, stateDir } = await dirs();
  await installHook({ cwd, stateDir });

  for (const decision of ['allow', 'deny'] as const) {
    const tether = await stubTether((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ decision }));
    });
    await writeHookEndpoint(stateDir, tether.url);
    const { stdout, code } = await runShim(stateDir, PRE_TOOL_USE);
    await tether.close();

    assert.equal(code, 0, 'a non-zero exit is itself a decision, so never one of these');
    assert.deepEqual(JSON.parse(stdout), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason:
          decision === 'allow' ? 'Approved in tether.' : 'Denied in tether.',
      },
    });
    assert.deepEqual(JSON.parse(tether.seen[0]!), PRE_TOOL_USE, 'the payload reached tether whole');
  }
});

test('the ordinary answer is 204, and it says nothing at all', async () => {
  const { cwd, stateDir } = await dirs();
  await installHook({ cwd, stateDir });
  const tether = await stubTether((_request, response) => response.writeHead(204).end());
  await writeHookEndpoint(stateDir, tether.url);

  const { stdout, code } = await runShim(stateDir, PRE_TOOL_USE);
  await tether.close();
  // Not "safely empty" — deliberately empty. Saying nothing is what leaves
  // Claude Code's own permission rules in charge of the call.
  assert.equal(stdout, '');
  assert.equal(code, 0);
});

test('a reply tether should never send cannot become a decision', async () => {
  const { cwd, stateDir } = await dirs();
  await installHook({ cwd, stateDir });
  // The shim rebuilds the decision rather than echoing the body, so nothing that
  // arrives on this socket can put arbitrary bytes on the decision channel.
  for (const body of ['{"decision":"maybe"}', '{"decision":{"nested":true}}', 'not json at all']) {
    const tether = await stubTether((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(body);
    });
    await writeHookEndpoint(stateDir, tether.url);
    const { stdout, code } = await runShim(stateDir, PRE_TOOL_USE);
    await tether.close();
    const said = stdout.trim() === '' ? {} : (JSON.parse(stdout) as Record<string, unknown>);
    // It may say tether misbehaved — that is a fault worth surfacing — but the
    // decision channel stays empty, so the call is neither allowed nor blocked.
    assert.equal(said['hookSpecificOutput'], undefined, body);
    assert.equal(code, 0, body);
  }
});

test('a tether that cannot be reached falls through, and does so silently', async () => {
  const { cwd, stateDir } = await dirs();
  await installHook({ cwd, stateDir });
  // Nothing listening: the endpoint names a port that was bound and released.
  const tether = await stubTether((_request, response) => response.writeHead(204).end());
  await writeHookEndpoint(stateDir, tether.url);
  await tether.close();

  const { stdout, code } = await runShim(stateDir, PRE_TOOL_USE);
  // Neither allow nor deny: the question goes back to Claude Code's own rules.
  // And silent, because tether not running is the ordinary state of a project
  // whose shim is still installed — a note on every tool call would be nagging.
  assert.equal(stdout, '');
  assert.equal(code, 0);
});

test('a tether that answers with a refusal says so, once, without deciding', async () => {
  const { cwd, stateDir } = await dirs();
  await installHook({ cwd, stateDir });
  const tether = await stubTether((_request, response) => response.writeHead(401).end());
  await writeHookEndpoint(stateDir, tether.url);

  const { stdout, code } = await runShim(stateDir, PRE_TOOL_USE);
  await tether.close();
  const said = JSON.parse(stdout) as Record<string, unknown>;
  // A note, not a decision. This is the case where somebody may be looking at a
  // card whose buttons are dead, so it must not be silent — and it must still
  // not touch the permission decision.
  assert.match(String(said['systemMessage']), /tether could not answer/);
  assert.equal(said['hookSpecificOutput'], undefined);
  assert.equal(code, 0);
});

test('a tether that never replies is bounded by the shim’s own abort', async () => {
  const { cwd, stateDir } = await dirs();
  // The abort is the hold plus a margin, so a short hold makes a short test —
  // and proves the two are wired to the same number.
  await installHook({ cwd, stateDir, holdMs: 0 });
  const tether = await stubTether(() => {
    /* accept the request and never answer it */
  });
  await writeHookEndpoint(stateDir, tether.url);

  const { stdout, code } = await runShim(stateDir, PRE_TOOL_USE);
  await tether.close();
  assert.equal(code, 0);
  assert.match(String((JSON.parse(stdout) as Record<string, unknown>)['systemMessage']), /tether/);
});

test('the three timeouts stay ordered: hold < the shim’s abort < Claude Code’s kill', async () => {
  const { cwd, stateDir } = await dirs();
  // Against a *reinstalled* project, because that is the case a fresh install
  // cannot fail: the shim is rewritten every spawn and the settings entry is not
  // appended again, so only reconciling it keeps the three ordered on the path
  // every user is on after their first upgrade.
  await installHook({ cwd, stateDir, holdMs: 5000 });
  await installHook({ cwd, stateDir, holdMs: 20_000 });
  const hooks = (await settings(cwd))['hooks'] as Record<
    string,
    { hooks: { timeout: number }[] }[]
  >;
  const kill = hooks['PreToolUse']![0]!.hooks[0]!.timeout;
  const abort = Number(
    /AbortSignal\.timeout\((\d+)\)/.exec(await readFile(hookShimPath(stateDir), 'utf8'))![1],
  );

  assert.ok(20_000 < abort, 'the server answers before the shim gives up');
  assert.ok(abort < kill * 1000, 'and the shim answers before Claude Code kills it');
  assert.equal(hookTimeoutSeconds(20_000), kill);
});

test('the hold is configured in seconds, and a value that makes no sense is none', () => {
  assert.equal(permissionTimeoutMs({}), DEFAULT_PERMISSION_TIMEOUT_MS);
  assert.equal(
    permissionTimeoutMs({ TETHER_PERMISSION_TIMEOUT: '' }),
    DEFAULT_PERMISSION_TIMEOUT_MS,
  );
  assert.equal(permissionTimeoutMs({ TETHER_PERMISSION_TIMEOUT: '5' }), 5000);
  assert.equal(permissionTimeoutMs({ TETHER_PERMISSION_TIMEOUT: '0.5' }), 500);
  // Zero is a real setting: tether goes back to being the observer it was, which
  // is supported rather than degraded.
  assert.equal(permissionTimeoutMs({ TETHER_PERMISSION_TIMEOUT: '0' }), 0);
  // Refused rather than guessed. Holding for the default when the operator asked
  // for something tether cannot read would be the worst reading of a typo.
  assert.equal(permissionTimeoutMs({ TETHER_PERMISSION_TIMEOUT: 'thirty' }), 0);
  assert.equal(permissionTimeoutMs({ TETHER_PERMISSION_TIMEOUT: '-1' }), 0);
});

test('the endpoint is a file beside the shim, so a restart on a new port still works', async () => {
  const { stateDir } = await dirs();
  await writeHookEndpoint(stateDir, 'http://127.0.0.1:8787/internal/hook');
  const path = join(stateDir, 'claude-hook.endpoint');
  assert.equal((await readFile(path, 'utf8')).trim(), 'http://127.0.0.1:8787/internal/hook');

  await writeHookEndpoint(stateDir, 'http://127.0.0.1:9999/internal/hook');
  assert.equal((await readFile(path, 'utf8')).trim(), 'http://127.0.0.1:9999/internal/hook');
});
