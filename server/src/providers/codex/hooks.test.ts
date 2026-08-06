/**
 * Installing and removing the hook.
 *
 * `hooks.json` is a file tether does not own, so every test here is about what
 * tether leaves alone. The captain's decision spells the obligations out
 * (`tether-codex-spike-decision-codex-hook-trust-install`); this is where they
 * are enforced rather than described.
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { appendFile, mkdir, rm } from 'node:fs/promises';
import { hookSecretPath, KILL_MARGIN_MS, writeHookEndpoint } from '../permission.ts';
import {
  HOOK_EVENTS,
  HooksFileError,
  hookLogPath,
  hookShimPath,
  hookStatus,
  hooksJsonPath,
  installedPermissionTimeout,
  installHook,
  MAX_HOLD_MS,
  PERMISSION_TIMEOUT_SECONDS,
  removeHook,
  sessionStarts,
} from './hooks.ts';

/** The shim reads stdin to EOF, so it is fed one and waited for. */
function runShim(shim: string, input: string): void {
  execFileSync(process.execPath, [shim], { input, timeout: 10_000 });
}

/**
 * The same thing, without blocking this process — which the tests below need,
 * because the tether the shim POSTs to is a stub server on this very event loop.
 * A synchronous spawn deadlocks against it: the child waits for a reply nobody
 * is left running to send.
 */
async function askShim(
  shim: string,
  payload: unknown,
): Promise<{ stdout: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = execFile(shim, (error) => {
      if (error !== null && error.code === undefined) reject(error);
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: string) => (stdout += chunk));
    child.on('close', (code) => resolve({ stdout, code }));
    child.stdin?.end(JSON.stringify(payload));
  });
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

    // And `status` says so rather than reporting `not installed`, which would be
    // the wrong explanation for why the install the user tries next refuses.
    const status = await hookStatus({ codexHome, stateDir });
    assert.match(status.unreadable ?? '', /refusing to change .*hooks\.json/);
    assert.equal(await readFile(hooksJsonPath(codexHome), 'utf8'), bad, 'status changes nothing');
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
  const status = await hookStatus({ codexHome, stateDir });
  assert.deepEqual(status.installed, [...HOOK_EVENTS]);
  assert.equal(status.unreadable, undefined, 'a file tether can read has nothing to report');

  // `features.hooks = true` is the user's to set: tether does not write TOML,
  // and that file also holds the trust hashes.
  assert.equal((await hookStatus({ codexHome, stateDir })).featureEnabled, false);
  await writeFile(join(codexHome, 'config.toml'), '[features]\nhooks = true\n');
  assert.equal((await hookStatus({ codexHome, stateDir })).featureEnabled, true);
  await writeFile(join(codexHome, 'config.toml'), '[other]\nhooks = true\n');
  assert.equal((await hookStatus({ codexHome, stateDir })).featureEnabled, false);
});

test('status can tell a current installation from one an older tether wrote', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  const { shimPath, hooksPath } = await installHook({ codexHome, stateDir });

  const fresh = await hookStatus({ codexHome, stateDir });
  assert.equal(fresh.shimCurrent, true);
  assert.equal(fresh.permissionTimeout, PERMISSION_TIMEOUT_SECONDS);
  assert.equal(
    await installedPermissionTimeout({ codexHome, stateDir }),
    PERMISSION_TIMEOUT_SECONDS,
    'one reader, and the gate in `machine/conversations.ts` uses this one',
  );

  // Exactly what an upgrade leaves behind: nothing rewrites a Codex installation
  // on its own, so the log-only shim and the 3s `timeout` an older tether wrote
  // are still there and `installed` still lists all five events. Both halves are
  // reported, because either one alone means the buttons cannot work.
  await writeFile(shimPath, '#!/usr/bin/env node\n// an older tether\n', { mode: 0o700 });
  const oldShim = await hookStatus({ codexHome, stateDir });
  assert.deepEqual(oldShim.installed, [...HOOK_EVENTS], 'registered, and still not answerable');
  assert.equal(oldShim.shimCurrent, false);

  await installHook({ codexHome, stateDir });
  const file = JSON.parse(await readFile(hooksPath, 'utf8')) as {
    hooks: Record<string, { hooks: Record<string, unknown>[] }[]>;
  };
  for (const group of file.hooks['PermissionRequest'] ?? []) {
    for (const handler of group.hooks) handler['timeout'] = 3;
  }
  await writeFile(hooksPath, `${JSON.stringify(file, null, 2)}\n`);
  const oldTimeout = await hookStatus({ codexHome, stateDir });
  assert.equal(oldTimeout.shimCurrent, true, 're-installing rewrote the shim');
  assert.equal(oldTimeout.permissionTimeout, 3);

  // A correction the user is told about, because Codex re-hashes the entry.
  const corrected = await installHook({ codexHome, stateDir });
  assert.deepEqual(corrected.updated, ['PermissionRequest']);
  assert.equal(
    (await hookStatus({ codexHome, stateDir })).permissionTimeout,
    PERMISSION_TIMEOUT_SECONDS,
  );
});

test('there is no timeout to read where tether has no entry', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  assert.equal(await installedPermissionTimeout({ codexHome, stateDir }), undefined, 'no file');
  await withExisting(codexHome);
  assert.equal(
    await installedPermissionTimeout({ codexHome, stateDir }),
    undefined,
    'a hooks.json that is somebody else’s entirely',
  );
  await writeFile(hooksJsonPath(codexHome), '{ not json');
  assert.equal(
    await installedPermissionTimeout({ codexHome, stateDir }),
    undefined,
    'and a file tether refuses to read is a timeout tether cannot say — never a hold',
  );
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

  // The logs are one per Codex session and never pruned, so a caller with a
  // session to bound it by says so: an untouched log cannot hold the
  // `SessionStart` of a session that began after it, and discovery retries this
  // once a second while a new session waits for its first prompt.
  const old = new Date(Date.now() - 60 * 60_000);
  await utimes(hookLogPath(stateDir, ids[0]!), old, old);
  assert.deepEqual(
    (await sessionStarts(stateDir, Date.now() - 5 * 60_000)).map((r) => r['session_id']),
    [ids[1]],
    'the stale log is stat’d and never opened',
  );
});

// ── the one event that answers ───────────────────────────────────────────────
//
// `PermissionRequest` is the only Codex hook with a decision channel, and on it
// **stdout is a security boundary**: a stray write silently allows or blocks a
// tool call on the user's machine. Nothing short of executing the installed file
// and reading its bytes proves what it says, so these do exactly that.

/**
 * The `PermissionRequest` payload as Codex delivers it — no `tool_use_id`,
 * because 0.145.0's own hook schema does not have one.
 */
const PERMISSION_REQUEST = {
  session_id: '019fac90-fbcb-7121-a9dc-5b4e866eb680',
  turn_id: '019fac91-dcc4-7492-9d4a-6d796117fa13',
  transcript_path: '/home/tester/rollout.jsonl',
  cwd: '/home/tester/work',
  hook_event_name: 'PermissionRequest',
  model: 'gpt-5.6-sol',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf ./build' },
};

async function stubTether(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
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
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  t.after(close);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/hook`,
    seen,
    close,
  };
}

test('only the answerable event carries a hold-length timeout', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  const result = await installHook({ codexHome, stateDir });
  const hooks = (await readJson(result.hooksPath))['hooks'] as Record<
    string,
    { hooks: { timeout?: number }[] }[]
  >;

  // Three seconds is right for a hook that appends one line, and would be a net
  // that fires before the user can reach for their phone on the one that waits.
  for (const event of HOOK_EVENTS) {
    assert.equal(
      hooks[event]![0]!.hooks[0]!.timeout,
      event === 'PermissionRequest' ? PERMISSION_TIMEOUT_SECONDS : 3,
      event,
    );
  }
  // A constant, and the reason it is one: Codex hashes the entry, so a timeout
  // that followed `TETHER_PERMISSION_TIMEOUT` would put a trust prompt in front
  // of the user every time an operator changed an environment variable.
  assert.equal(MAX_HOLD_MS, PERMISSION_TIMEOUT_SECONDS * 1000 - KILL_MARGIN_MS);
  assert.ok(
    MAX_HOLD_MS < PERMISSION_TIMEOUT_SECONDS * 1000,
    'the hold settles before Codex gives up',
  );

  // The shim POSTs, so it needs the secret — created here, `0600`, and shared
  // with the Claude Code shim on purpose (`../permission.ts`).
  assert.equal(((await stat(hookSecretPath(stateDir))).mode & 0o777).toString(8), '600');
});

test('an entry an older tether wrote is corrected, and only that one field', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  await withExisting(codexHome);
  await installHook({ codexHome, stateDir });

  // What a tether from before `PermissionRequest` could answer left behind.
  const path = hooksJsonPath(codexHome);
  const file = await readJson(path);
  const hooks = file['hooks'] as Record<
    string,
    { matcher?: string; hooks: Record<string, unknown>[] }[]
  >;
  hooks['PermissionRequest']![0]!.hooks[0]!['timeout'] = 3;
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);

  const result = await installHook({ codexHome, stateDir });
  assert.deepEqual(result.added, [], 'nothing to add');
  assert.deepEqual(result.updated, ['PermissionRequest']);
  assert.equal(result.alreadyInstalled, false);

  const after = (await readJson(path))['hooks'] as Record<
    string,
    { hooks: { command?: string; timeout?: number }[] }[]
  >;
  assert.equal(after['PermissionRequest']![0]!.hooks[0]!.timeout, PERMISSION_TIMEOUT_SECONDS);
  assert.deepEqual(
    after['SessionStart']!.map((g) => g.hooks[0]?.command),
    ['gh-axi', 'chrome-devtools-axi', 'lavish-axi', hookShimPath(stateDir)],
    'the user’s own entries are still there, still in order',
  );

  // And it settles: the values tether writes are constants, so a third install
  // rewrites nothing and Codex is never asked to re-review a trusted entry again.
  const bytes = await readFile(path, 'utf8');
  const third = await installHook({ codexHome, stateDir });
  assert.equal(third.alreadyInstalled, true);
  assert.deepEqual(third.updated, []);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('a decision tether sends comes back on stdout in Codex’s own shape', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  const { shimPath } = await installHook({ codexHome, stateDir });

  for (const decision of ['allow', 'deny'] as const) {
    const tether = await stubTether(t, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ decision }));
    });
    await writeHookEndpoint(stateDir, tether.url);

    const { stdout, code } = await askShim(shimPath, PERMISSION_REQUEST);
    assert.equal(code, 0, 'Codex reads exit code 2 as a denial, so never one of these');
    assert.deepEqual(JSON.parse(stdout), {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: decision,
          message:
            decision === 'allow'
              ? 'Approved in Remote Control Agent.'
              : 'Denied in Remote Control Agent.',
        },
      },
    });
    assert.deepEqual(JSON.parse(tether.seen[0]!), PERMISSION_REQUEST, 'the payload arrived whole');
    await tether.close();
  }
});

test('the log line is written before tether is asked, not after', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  const { shimPath } = await installHook({ codexHome, stateDir });
  const log = hookLogPath(stateDir, PERMISSION_REQUEST.session_id);

  // The order matters twice over: that line is what sets the `waiting` badge if
  // tether is not listening, and the `PreToolUse` before it is what the server
  // correlates this prompt against — so it has to be on disk by the time the
  // request lands, not once the answer comes back.
  let onDisk: string | undefined;
  const tether = await stubTether(t, (_request, response) => {
    onDisk = readFileSync(log, 'utf8');
    response.writeHead(204).end();
  });
  await writeHookEndpoint(stateDir, tether.url);
  await askShim(shimPath, PERMISSION_REQUEST);

  assert.equal(
    (JSON.parse(onDisk ?? 'null') as Record<string, unknown>)['hook_event_name'],
    'PermissionRequest',
  );
});

test('the four log-only events never ask tether anything', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  const { shimPath } = await installHook({ codexHome, stateDir });
  const tether = await stubTether(t, (_request, response) => response.writeHead(204).end());
  await writeHookEndpoint(stateDir, tether.url);

  for (const event of HOOK_EVENTS) {
    if (event === 'PermissionRequest') continue;
    const { stdout } = await askShim(shimPath, { ...PERMISSION_REQUEST, hook_event_name: event });
    assert.equal(stdout, '', event);
  }
  // A round trip per tool call is a cost with nothing to buy: the log is the
  // transport for everything that has no answer to return.
  assert.deepEqual(tether.seen, []);
});

test('the ordinary answer is 204, and it says nothing at all', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  const { shimPath } = await installHook({ codexHome, stateDir });
  const tether = await stubTether(t, (_request, response) => response.writeHead(204).end());
  await writeHookEndpoint(stateDir, tether.url);

  // Not "safely empty" — deliberately empty. Saying nothing is what leaves
  // Codex's own approval prompt in charge of the call.
  assert.equal((await askShim(shimPath, PERMISSION_REQUEST)).stdout, '');
});

test('a reply tether should never send cannot become a decision', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  const { shimPath } = await installHook({ codexHome, stateDir });

  // The shim rebuilds the decision rather than echoing the body, so nothing that
  // arrives on this socket can put arbitrary bytes on the decision channel.
  for (const body of ['{"decision":"maybe"}', '{"decision":{"nested":true}}', 'not json at all']) {
    const tether = await stubTether(t, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(body);
    });
    await writeHookEndpoint(stateDir, tether.url);
    const { stdout, code } = await askShim(shimPath, PERMISSION_REQUEST);
    await tether.close();
    assert.equal(code, 0, body);

    const said = stdout.trim() === '' ? {} : (JSON.parse(stdout) as Record<string, unknown>);
    assert.equal(said['hookSpecificOutput'], undefined, body);
  }
});

test('a tether that cannot be reached falls through, and does so silently', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  const { shimPath } = await installHook({ codexHome, stateDir });
  // Nothing listening: the endpoint names a port that was bound and released.
  const tether = await stubTether(t, (_request, response) => response.writeHead(204).end());
  await writeHookEndpoint(stateDir, tether.url);
  await tether.close();

  // Neither allow nor deny: the question goes back to Codex's own prompt. And
  // silent, because tether not running is ordinary, the browser cannot be
  // showing a card either, and the captain's decision forbids nagging by name.
  assert.equal((await askShim(shimPath, PERMISSION_REQUEST)).stdout, '');
});

test('a tether that answers with a refusal says so, without deciding', async (t) => {
  const { codexHome, stateDir } = await lab(t);
  const { shimPath } = await installHook({ codexHome, stateDir });
  const tether = await stubTether(t, (_request, response) => response.writeHead(401).end());
  await writeHookEndpoint(stateDir, tether.url);

  // A note, not a decision. This is the case where somebody may be looking at a
  // card whose buttons are dead, so it must not be silent — and it must still
  // not touch the permission decision.
  const said = JSON.parse((await askShim(shimPath, PERMISSION_REQUEST)).stdout) as Record<
    string,
    unknown
  >;
  assert.match(String(said['systemMessage']), /Remote Control Agent could not answer/);
  assert.equal(said['hookSpecificOutput'], undefined);
});

test('a session whose user declined the hook has no shim to run at all', async (t) => {
  // The whole of "declining is supported", stated where it can be checked:
  // nothing tether writes to `hooks.json` is required by anything else, so a
  // `hooks.json` tether never touched leaves a working session — conversation,
  // terminal, busy and idle — minus the badge and the buttons.
  const { codexHome, stateDir } = await lab(t);
  await withExisting(codexHome);
  const before = await readFile(hooksJsonPath(codexHome), 'utf8');

  const status = await hookStatus({ codexHome, stateDir });
  assert.deepEqual(status.installed, []);
  assert.equal(status.unreadable, undefined, 'not installed is not a fault');
  assert.equal(await readFile(hooksJsonPath(codexHome), 'utf8'), before, 'and nothing was written');
  await assert.rejects(() => stat(hookShimPath(stateDir)), 'no shim either');
});
