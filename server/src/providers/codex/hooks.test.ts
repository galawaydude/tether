/**
 * Installing and removing the hook.
 *
 * `hooks.json` is a file tether does not own, so every test here is about what
 * tether leaves alone. The captain's decision spells the obligations out
 * (`tether-codex-spike-decision-codex-hook-trust-install`); this is where they
 * are enforced rather than described.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { appendFile, mkdir, rm } from 'node:fs/promises';
import {
  HOOK_EVENTS,
  HooksFileError,
  hookLogPath,
  hookShimPath,
  hookStatus,
  hooksJsonPath,
  installHook,
  removeHook,
  sessionStarts,
} from './hooks.ts';

/** The shim reads stdin to EOF, so it is fed one and waited for. */
function runShim(shim: string, input: string): void {
  execFileSync(process.execPath, [shim], { input, timeout: 10_000 });
}

async function lab(t: TestContext): Promise<{ codexHome: string; stateDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tether-codex-hooks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { codexHome: join(dir, 'codex'), stateDir: join(dir, 'state') };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

/**
 * A real `~/.codex/hooks.json`: three unrelated `SessionStart` entries, each its
 * own group. Copied in shape from a live machine, because that is the file this
 * has to not break.
 */
const EXISTING = {
  hooks: {
    SessionStart: [
      { matcher: '', hooks: [{ type: 'command', command: 'gh-axi', timeout: 10 }] },
      { matcher: '', hooks: [{ type: 'command', command: 'chrome-devtools-axi', timeout: 10 }] },
      { matcher: '', hooks: [{ type: 'command', command: 'lavish-axi', timeout: 10 }] },
    ],
  },
};

async function withExisting(codexHome: string, contents: unknown = EXISTING): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  await writeFile(hooksJsonPath(codexHome), `${JSON.stringify(contents, null, 2)}\n`);
}

test('installing preserves every entry that was already there, and appends', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  await withExisting(codexHome);

  const result = await installHook({ codexHome, stateDir });
  assert.deepEqual(result.added, [...HOOK_EVENTS]);

  const file = await readJson(result.hooksPath);
  const hooks = file['hooks'] as Record<string, { hooks: { command?: string }[] }[]>;
  const starts = hooks['SessionStart']!;

  assert.deepEqual(
    starts.slice(0, 3).map((g) => g.hooks[0]?.command),
    ['gh-axi', 'chrome-devtools-axi', 'lavish-axi'],
    'the user’s three entries are untouched and still in their original order',
  );
  // Appended, never inserted: Codex keys its trust state by group index
  // (`hooks.json:session_start:2:0`), so renumbering these would silently
  // re-prompt the user for hooks they had already trusted.
  assert.equal(starts.length, 4);
  assert.equal(starts[3]?.hooks[0]?.command, hookShimPath(stateDir));
});

test('the previous file is backed up before it is changed', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  await withExisting(codexHome);
  const before = await readFile(hooksJsonPath(codexHome), 'utf8');

  const result = await installHook({ codexHome, stateDir, now: new Date(0) });
  assert.equal(
    result.backupPath,
    `${hooksJsonPath(codexHome)}.tether-backup-1970-01-01T00-00-00-000Z`,
  );
  assert.equal(await readFile(result.backupPath!, 'utf8'), before, 'byte for byte');
});

test('removing takes out tether’s entry and nothing else', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  await withExisting(codexHome);
  await installHook({ codexHome, stateDir });

  const removed = await removeHook({ codexHome, stateDir });
  assert.deepEqual(removed.removed, [...HOOK_EVENTS]);

  const file = await readJson(hooksJsonPath(codexHome));
  assert.deepEqual(file['hooks'], {
    ...EXISTING.hooks,
    // The events tether added and then emptied are left as empty arrays rather
    // than deleted: an absent key and an empty one mean the same thing to Codex,
    // and rewriting more of the file than was added is what this must not do.
    PreToolUse: [],
    PermissionRequest: [],
    PostToolUse: [],
    SessionEnd: [],
  });
});

test('an entry sharing a group with the user’s survives its removal', async (t) => {
  // tether only ever adds a group of its own, so this can only arise if a user
  // moved the command into their own group. Removing must take the handler and
  // leave the group.
  const { codexHome, stateDir } = await lab(t);
  const shim = hookShimPath(stateDir);
  await withExisting(codexHome, {
    hooks: {
      SessionStart: [
        {
          matcher: '',
          hooks: [
            { type: 'command', command: 'gh-axi' },
            { type: 'command', command: shim },
          ],
        },
      ],
    },
  });

  await removeHook({ codexHome, stateDir });
  const file = await readJson(hooksJsonPath(codexHome));
  assert.deepEqual(file['hooks'], {
    SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'gh-axi' }] }],
  });
});

test('unrelated top-level keys and settings are carried through untouched', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  await withExisting(codexHome, { version: 3, notes: 'mine', hooks: EXISTING.hooks });

  await installHook({ codexHome, stateDir });
  const file = await readJson(hooksJsonPath(codexHome));
  assert.equal(file['version'], 3);
  assert.equal(file['notes'], 'mine');
});

test('a hooks.json tether cannot make sense of is refused, not rewritten', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  for (const bad of ['{ not json', '[]', '{"hooks": 7}', '{"hooks": {"SessionStart": {}}}']) {
    await withExisting(codexHome, undefined);
    await writeFile(hooksJsonPath(codexHome), bad);
    await assert.rejects(() => installHook({ codexHome, stateDir }), HooksFileError);
    assert.equal(await readFile(hooksJsonPath(codexHome), 'utf8'), bad, 'left exactly as it was');
    assert.deepEqual(
      (await readdir(codexHome)).filter((n) => n !== 'hooks.json'),
      [],
      'and no backup, no temp file, nothing else added',
    );
  }
});

test('installing twice changes hooks.json once', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  await withExisting(codexHome);
  await installHook({ codexHome, stateDir });
  const after = await readFile(hooksJsonPath(codexHome), 'utf8');

  const second = await installHook({ codexHome, stateDir });
  assert.equal(second.alreadyInstalled, true);
  assert.deepEqual(second.added, []);
  assert.equal(second.backupPath, undefined, 'nothing changed, so nothing to back up');
  assert.equal(await readFile(hooksJsonPath(codexHome), 'utf8'), after);
});

test('there is no hooks.json to preserve when there is no hooks.json', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  const result = await installHook({ codexHome, stateDir });
  assert.equal(result.backupPath, undefined);
  const file = await readJson(result.hooksPath);
  assert.deepEqual(Object.keys(file['hooks'] as object), [...HOOK_EVENTS]);
});

test('status reports what is registered and whether Codex will run it at all', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  await withExisting(codexHome);

  assert.deepEqual((await hookStatus({ codexHome, stateDir })).installed, []);
  await installHook({ codexHome, stateDir });
  assert.deepEqual((await hookStatus({ codexHome, stateDir })).installed, [...HOOK_EVENTS]);

  // `features.hooks = true` is the user's to set: tether does not write TOML,
  // and that file also holds the trust hashes.
  assert.equal((await hookStatus({ codexHome, stateDir })).featureEnabled, false);
  await writeFile(join(codexHome, 'config.toml'), '[features]\nhooks = true\n');
  assert.equal((await hookStatus({ codexHome, stateDir })).featureEnabled, true);
  await writeFile(join(codexHome, 'config.toml'), '[other]\nhooks = true\n');
  assert.equal((await hookStatus({ codexHome, stateDir })).featureEnabled, false);
});

test('the shim records what it is given, and cannot be talked out of its directory', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  const { shimPath } = await installHook({ codexHome, stateDir });
  assert.equal(((await stat(shimPath)).mode & 0o777).toString(8), '700');

  const payload = {
    session_id: '019fac90-fbcb-7121-a9dc-5b4e866eb680',
    transcript_path: '/home/tester/rollout.jsonl',
    cwd: '/home/tester/work',
    hook_event_name: 'SessionStart',
    source: 'startup',
  };
  runShim(shimPath, JSON.stringify(payload));

  const log = hookLogPath(stateDir, payload.session_id);
  const record = JSON.parse(await readFile(log, 'utf8')) as Record<string, unknown>;
  assert.equal(record['hook_event_name'], 'SessionStart');
  assert.equal(record['transcript_path'], payload.transcript_path);
  assert.equal(record['ppid'], process.pid, 'the parent is the join — here, this test');
  assert.equal(typeof record['at'], 'number');

  // A session id becomes a file name, so it is checked rather than trusted.
  runShim(shimPath, JSON.stringify({ ...payload, session_id: '../../escaped' }));
  await assert.rejects(() => stat(join(stateDir, 'escaped.ndjson')));

  // And nothing it is fed can make it fail: a hook that exits non-zero or hangs
  // interferes with the user's session, and this one only feeds a badge.
  for (const input of ['', 'not json', '{"session_id":null}', '[]']) runShim(shimPath, input);
});

test('the SessionStart join reads back what the shim wrote', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  const { shimPath } = await installHook({ codexHome, stateDir });
  const ids = ['019fac90-fbcb-7121-a9dc-5b4e866eb680', '019fac91-0000-0000-0000-000000000000'];
  ids.forEach((id, index) => {
    // Written through the shim itself, so the `ppid` under test is one it
    // recorded rather than one this test made up.
    runShim(
      shimPath,
      JSON.stringify({
        session_id: id,
        hook_event_name: 'SessionStart',
        transcript_path: `/r/${id}.jsonl`,
        marker: index,
      }),
    );
  });
  // A half-written line must not take the whole read with it.
  await appendFile(hookLogPath(stateDir, ids[0]!), '{"hook_event_name":"SessionSt');

  const starts = await sessionStarts(stateDir);
  assert.equal(starts.length, 2, 'the truncated line is skipped rather than fatal');
  assert.deepEqual(
    starts.map((r) => r['session_id']),
    [ids[1], ids[0]],
    'newest first, because that is the session a pane is running',
  );
  assert.deepEqual(new Set(starts.map((r) => r['ppid'])), new Set([process.pid]));
});
