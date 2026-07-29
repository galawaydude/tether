/**
 * Installing tether's hook into a project.
 *
 * The file being written belongs to the user and lives inside their repository,
 * so most of what is asserted here is restraint: what tether preserves, what it
 * refuses to touch, and above all that the secret never lands in it.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  HOOK_EVENTS,
  SettingsFileError,
  ensureHookSecret,
  hookSecretPath,
  hookShimPath,
  installHook,
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
  assert.equal(await readFile(settingsPath(cwd), 'utf8'), before);
  assert.deepEqual(
    (await readdir(join(cwd, '.claude'))).filter((n) => n.includes('backup')),
    [],
    'and made no backup, because it changed nothing',
  );
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

test('the endpoint is a file beside the shim, so a restart on a new port still works', async () => {
  const { stateDir } = await dirs();
  await writeHookEndpoint(stateDir, 'http://127.0.0.1:8787/internal/hook');
  const path = join(stateDir, 'claude-hook.endpoint');
  assert.equal((await readFile(path, 'utf8')).trim(), 'http://127.0.0.1:8787/internal/hook');

  await writeHookEndpoint(stateDir, 'http://127.0.0.1:9999/internal/hook');
  assert.equal((await readFile(path, 'utf8')).trim(), 'http://127.0.0.1:9999/internal/hook');
});
