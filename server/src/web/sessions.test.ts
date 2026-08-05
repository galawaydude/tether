/**
 * The session API. The round-trips run against a real tmux server on a socket of
 * their own — the registry and tmux staying consistent is the thing being tested,
 * and a mocked driver would test neither.
 *
 * The `cwd` containment cases are the reason this PR exists. `tmux.test.ts` proves
 * `resolveCwd` itself; the ones here prove the route reaches it, with the roots the
 * server was configured with, and answers 400 rather than starting anything.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import {
  applyRegistrySchema,
  getSession,
  listSessions,
  setProviderSessionId,
} from '../machine/registry.ts';
import { Conversations } from '../machine/conversations.ts';
import { createTerminals } from '../machine/terminal.ts';
import { killServer, listPanes, listSessions as listTmuxSessions } from '../machine/tmux.ts';
import { processStart } from '../providers/claude-code/status.ts';
import { createAuthStore } from './auth.ts';
import { defaultAllowedHosts } from './guards.ts';
import { SESSION_COOKIE, buildServer } from './server.ts';

const execFileAsync = promisify(execFile);

const PASSWORD = 'correct horse battery staple';
const HOST = 'localhost:8787';
const BASE = '/api/machines/local/sessions';

/**
 * The API starts the provider's own command and offers no way to override it, so
 * these tests put a stub for each provider on PATH that simply idles. Nothing here tests
 * Claude Code — only that a real pane is started, listed and killed. tmux inherits
 * this process's environment, so the stub is what its panes find.
 */
const STUB_BIN = mkdtempSync(join(tmpdir(), 'tether-bin-'));
for (const agent of ['claude', 'codex']) {
  writeFileSync(join(STUB_BIN, agent), '#!/bin/sh\nexec /bin/sh\n', { mode: 0o755 });
}
process.env['PATH'] = `${STUB_BIN}${delimiter}${process.env['PATH'] ?? ''}`;
process.on('exit', () => rmSync(STUB_BIN, { recursive: true, force: true }));

type Method = 'GET' | 'POST' | 'DELETE';
type Harness = Awaited<ReturnType<typeof harness>>;

/**
 * A server with its own database, its own tmux socket and its own allowed root,
 * all removed however the test ends.
 */
async function harness(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  applyRegistrySchema(db);
  const auth = createAuthStore(db);
  await auth.setPassword(PASSWORD);

  const socket = `tether-test-${randomUUID().slice(0, 8)}`;
  t.after(async () => {
    await killServer(socket);
    await rm(join(tmpdir(), `tmux-${process.getuid?.() ?? ''}`, socket), { force: true });
  });

  // Realpath'd, because that is what the routes return and compare against.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tether-api-')));
  t.after(() => rm(root, { recursive: true, force: true }));

  /**
   * Scratch homes for the folder-trust routes. Not optional: the real ones are
   * the developer's own `~/.claude.json` and `~/.codex/config.toml`, and a test
   * suite that reads — let alone writes — either of those is a test suite that
   * changes what the machine running it trusts.
   */
  const trustDir = await realpath(await mkdtemp(join(tmpdir(), 'tether-trust-api-')));
  t.after(() => rm(trustDir, { recursive: true, force: true }));
  const trustIn = {
    claudeConfigPath: join(trustDir, '.claude.json'),
    codexHome: join(trustDir, 'codex'),
    stateDir: join(trustDir, 'state'),
  };

  /**
   * A scratch home for Claude Code's per-pid session registry files, which the
   * list route reads through `Conversations`. Not optional for the same reason
   * the trust directory is not: the real one is the developer's own
   * `~/.claude/sessions`, and the badge tests below write files into it.
   */
  const home = await realpath(await mkdtemp(join(tmpdir(), 'tether-home-api-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const conversations = new Conversations(db, { socket, home });

  const app = buildServer({
    auth,
    db,
    // The real thing on this test's own socket: no test here attaches, so no PTY
    // is ever spawned, and `app.close()` takes it down either way.
    terminals: createTerminals(socket),
    conversations,
    allowedHosts: defaultAllowedHosts('127.0.0.1'),
    loginDelayMs: 0,
    socket,
    allowedRoots: [root],
    trustIn,
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { host: HOST, origin: `http://${HOST}` },
    payload: { password: PASSWORD },
  });
  const token = login.cookies[0]?.value;
  assert.ok(token, 'logged in');

  return { app, db, socket, root, token, trustIn, home };
}

/** An authenticated request, with the header guards satisfied. */
function call(h: Harness, method: Method, url: string, payload?: unknown) {
  return h.app.inject({
    method,
    url,
    headers: {
      host: HOST,
      origin: `http://${HOST}`,
      cookie: `${SESSION_COOKIE}=${h.token}`,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

function create(h: Harness, cwd: string, body: Record<string, unknown> = {}) {
  return call(h, 'POST', BASE, { cwd, ...body });
}

// ── Auth: the posture PR #4 established, on the routes added here ──

test('every session route rejects an unauthenticated request', async (t) => {
  const h = await harness(t);
  const id = randomUUID();

  const requests: [Method, string, unknown?][] = [
    ['GET', BASE],
    ['POST', BASE, { cwd: h.root }],
    ['GET', `${BASE}/${id}`],
    ['DELETE', `${BASE}/${id}`],
    ['POST', `${BASE}/${id}/resume`],
    ['POST', `${BASE}/${id}/forget`],
  ];

  for (const [method, url, payload] of requests) {
    for (const cookie of [undefined, `${SESSION_COOKIE}=forged`]) {
      const res = await h.app.inject({
        method,
        url,
        headers: {
          host: HOST,
          origin: `http://${HOST}`,
          ...(cookie === undefined ? {} : { cookie }),
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
      assert.equal(res.statusCode, 401, `${method} ${url} (cookie: ${String(cookie)})`);
    }
  }

  // Nothing was started on the way to being refused.
  assert.deepEqual(await listTmuxSessions(h.socket), []);
});

// ── cwd confinement: the trust boundary (report §7) ──

test('creating a session outside the allowed roots is refused', async (t) => {
  const h = await harness(t);

  const outside = await mkdtemp(join(tmpdir(), 'tether-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));

  // A sibling whose path is a string prefix of the root: `/home/user2` must not
  // pass because it starts with `/home/user`.
  const sibling = `${h.root}2`;
  await mkdir(sibling);
  t.after(() => rm(sibling, { recursive: true, force: true }));

  // A symlink inside the root pointing out of it — caught only because the path is
  // resolved before it is checked.
  const escape = join(h.root, 'escape-hatch');
  await symlink(outside, escape);

  const file = join(h.root, 'a-file');
  await writeFile(file, '');

  const refused: [string, string][] = [
    [outside, 'a directory outside the roots'],
    [sibling, 'a sibling whose path is a prefix match'],
    [join(h.root, '..'), 'traversal above the root'],
    [join(h.root, '..', basename(outside)), 'traversal into a sibling directory'],
    [escape, 'a symlink pointing outside the root'],
    [join(h.root, 'no-such-dir'), 'a path that does not exist'],
    [file, 'a file rather than a directory'],
  ];

  for (const [cwd, why] of refused) {
    const res = await create(h, cwd);
    assert.equal(res.statusCode, 400, why);
    assert.equal(res.json().error, 'invalid_cwd', why);
  }

  // A refusal starts nothing and records nothing.
  assert.deepEqual(await listTmuxSessions(h.socket), []);
  assert.deepEqual(listSessions(h.db), []);

  // …and the root and its children are still accepted, so the check is a
  // containment test rather than a blanket refusal.
  const inside = join(h.root, 'project');
  await mkdir(inside);
  for (const cwd of [h.root, inside]) {
    const res = await create(h, cwd);
    assert.equal(res.statusCode, 201, cwd);
    assert.equal(res.json().session.cwd, cwd);
  }
});

// ── Schema validation on bodies and route parameters ──

test('malformed create bodies are rejected by the schema', async (t) => {
  const h = await harness(t);

  const bad: unknown[] = [
    {},
    { cwd: 123 },
    { cwd: '' },
    { cwd: h.root, title: '' },
    { cwd: h.root, title: 'x'.repeat(201) },
    { cwd: h.root, provider: 'nonesuch' },
    // Not offered over HTTP: "run this argv" is a different capability from
    // "start the agent". Passing it must fail, not be silently stripped.
    { cwd: h.root, command: ['/bin/sh'] },
    { cwd: h.root, extra: true },
    { cwd: 'x'.repeat(4097) },
    'not an object',
    null,
  ];

  for (const payload of bad) {
    const res = await call(h, 'POST', BASE, payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  assert.deepEqual(await listTmuxSessions(h.socket), []);
});

test('route parameters are validated: the machine id and the session id', async (t) => {
  const h = await harness(t);
  const id = randomUUID();

  // `local` is the only machine there is, and the one field is what makes a second
  // machine a later split rather than a rewrite.
  assert.equal((await call(h, 'GET', '/api/machines/remote/sessions')).statusCode, 400);
  assert.equal((await create(h, h.root)).statusCode, 201);
  const elsewhere = await call(h, 'POST', '/api/machines/remote/sessions', { cwd: h.root });
  assert.equal(elsewhere.statusCode, 400);

  const bad = [
    `/api/machines/remote/sessions/${id}`,
    `${BASE}/not-a-uuid`,
    // The CLI takes any unambiguous prefix; the API deliberately does not, so
    // there is no ambiguous-prefix case for a handler to answer for.
    `${BASE}/${id.slice(0, 8)}`,
    `${BASE}/${id.toUpperCase()}`,
    `${BASE}/${id}extra`,
  ];

  for (const url of bad) {
    assert.equal((await call(h, 'GET', url)).statusCode, 400, url);
    assert.equal((await call(h, 'DELETE', url)).statusCode, 400, url);
  }
});

// ── The round trip, against real tmux ──

test('create, list, read and delete round-trip against real tmux', async (t) => {
  const h = await harness(t);
  const project = join(h.root, 'widget');
  await mkdir(project);

  assert.deepEqual((await call(h, 'GET', BASE)).json().sessions, []);

  const created = await create(h, project, { title: 'my project' });
  assert.equal(created.statusCode, 201, created.body);
  const session = created.json().session;
  assert.match(session.id, /^[0-9a-f-]{36}$/);
  assert.equal(session.machineId, 'local');
  assert.equal(session.provider, 'claude-code');
  assert.equal(session.cwd, project);
  assert.equal(session.title, 'my project');
  assert.equal(session.deadAt, null);
  assert.equal(session.providerSessionId, null, 'provisional until the provider has one');
  assert.deepEqual(await listTmuxSessions(h.socket), [session.tmuxName]);

  const listed = (await call(h, 'GET', BASE)).json().sessions;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, session.id);

  const read = await call(h, 'GET', `${BASE}/${session.id}`);
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json().session, session);

  const deleted = await call(h, 'DELETE', `${BASE}/${session.id}`);
  assert.equal(deleted.statusCode, 200);
  assert.ok(deleted.json().session.deadAt > 0, 'the row is marked dead');
  assert.deepEqual(await listTmuxSessions(h.socket), [], 'and tmux agrees');

  // Dead, not deleted — the row is what a later Resume needs.
  assert.equal(listSessions(h.db).length, 1);
  assert.equal(
    (await call(h, 'GET', BASE)).json().sessions[0].deadAt,
    deleted.json().session.deadAt,
  );
});

test('delete is idempotent, and unknown ids are 404 rather than 500', async (t) => {
  const h = await harness(t);

  const session = (await create(h, h.root)).json().session;
  const first = await call(h, 'DELETE', `${BASE}/${session.id}`);
  assert.equal(first.statusCode, 200);

  // Same call again: the tmux session is already gone, which is the postcondition
  // and not an error, and the first death is the one that stays recorded.
  const second = await call(h, 'DELETE', `${BASE}/${session.id}`);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().session.deadAt, first.json().session.deadAt);

  // A well-formed id that was never issued is missing, not broken.
  for (const method of ['GET', 'DELETE'] as const) {
    const res = await call(h, method, `${BASE}/${randomUUID()}`);
    assert.equal(res.statusCode, 404, method);
    assert.equal(res.json().error, 'no_such_session');
  }
});

test('remove hides only a dead row and leaves live sessions alone', async (t) => {
  const h = await harness(t);
  const session = (await create(h, h.root, { title: 'removable' })).json().session;

  const live = await call(h, 'POST', `${BASE}/${session.id}/forget`);
  assert.equal(live.statusCode, 409);
  assert.equal(live.json().error, 'session_live');
  assert.equal((await call(h, 'GET', BASE)).json().sessions.length, 1);

  await call(h, 'DELETE', `${BASE}/${session.id}`);
  const removed = await call(h, 'POST', `${BASE}/${session.id}/forget`);
  assert.equal(removed.statusCode, 204, removed.body);
  assert.deepEqual((await call(h, 'GET', BASE)).json().sessions, []);
  assert.equal((await call(h, 'GET', `${BASE}/${session.id}`)).statusCode, 404);
  assert.equal((await call(h, 'POST', `${BASE}/${session.id}/resume`)).statusCode, 404);
  assert.equal((await call(h, 'POST', `${BASE}/${session.id}/forget`)).statusCode, 404);
});

test('the list reconciles: a session killed behind tether’s back reads as dead', async (t) => {
  const h = await harness(t);

  const session = (await create(h, h.root)).json().session;
  assert.equal((await call(h, 'GET', BASE)).json().sessions[0].deadAt, null);

  await killServer(h.socket);

  const listed = (await call(h, 'GET', BASE)).json().sessions;
  assert.ok(listed[0].deadAt > 0, 'the list reports what tmux actually has');
  assert.ok((await call(h, 'GET', `${BASE}/${session.id}`)).json().session.deadAt > 0);
});

// ── The list's badge: it follows the pane, and only the pane ──

/**
 * Publish what Claude Code publishes for a live pane, into the scratch home.
 * `procStart` has to be the kernel's own value for that pid or `status.ts`
 * rejects the file, which is exactly the pid-reuse guard these tests keep.
 */
async function publishStatus(
  home: string,
  pid: number,
  fields: { sessionId?: string; status: string },
): Promise<void> {
  const procStart = await processStart(pid);
  assert.ok(procStart, 'this platform publishes a process start identity tether understands');
  await mkdir(join(home, '.claude', 'sessions'), { recursive: true });
  await writeFile(
    join(home, '.claude', 'sessions', `${pid}.json`),
    JSON.stringify({ pid, procStart, ...fields }),
  );
}

async function panePid(h: Harness, tmuxName: string): Promise<number> {
  const pid = (await listPanes(h.socket)).find((pane) => pane.session === tmuxName)?.pid;
  assert.ok(pid, 'the pane is running');
  return pid;
}

test('the badge follows the pane after a /resume, with nothing watching', async (t) => {
  const h = await harness(t);
  const session = (await create(h, h.root)).json().session;
  setProviderSessionId(h.db, session.id, 'before-resume');

  // What `/resume` typed into the terminal does: the same pane, a different
  // session id and a different transcript. Nobody has the conversation open, so
  // the poller that re-binds a live row is not running at all.
  await publishStatus(h.home, await panePid(h, session.tmuxName), {
    sessionId: 'after-resume',
    status: 'waiting',
  });

  const listed = (await call(h, 'GET', BASE)).json();
  assert.deepEqual(listed.states[session.id], { state: 'waiting' }, 'the badge is not blank');
  // And the row now names what its pane is really running, so a later resume
  // restores that conversation rather than the abandoned one.
  assert.equal(getSession(h.db, session.id)?.providerSessionId, 'after-resume');
  assert.equal(listed.sessions[0].providerSessionId, 'after-resume');
});

test('a hand-run agent in a tether directory is still not adopted by the list', async (t) => {
  const h = await harness(t);
  const session = (await create(h, h.root)).json().session;
  setProviderSessionId(h.db, session.id, 'mine');

  // An agent the user started by hand in the same directory: a live process
  // publishing a live status file, in no tether pane. The join is the pane's
  // pid, so there is nothing here to mistake it for.
  await publishStatus(h.home, process.pid, { sessionId: 'theirs', status: 'busy' });

  assert.equal((await call(h, 'GET', BASE)).json().states[session.id], undefined);
  assert.equal(getSession(h.db, session.id)?.providerSessionId, 'mine', 'the row is untouched');

  // The same file under a *Codex* pane's own pid, which is the leftover-under-a-
  // reused-pid case: Codex publishes no such file, so one found there is some
  // dead Claude Code's, and binding it would write a foreign id into the row.
  const codex = (await create(h, h.root, { provider: 'codex' })).json().session;
  setProviderSessionId(h.db, codex.id, 'codex-rollout');
  await publishStatus(h.home, await panePid(h, codex.tmuxName), {
    sessionId: 'leftover',
    status: 'busy',
  });

  assert.equal((await call(h, 'GET', BASE)).json().states[codex.id], undefined);
  assert.equal(getSession(h.db, codex.id)?.providerSessionId, 'codex-rollout');
});

test('the list spawns a constant number of tmux commands, whatever it is listing', async (t) => {
  const h = await harness(t);

  // A `tmux` on PATH that records each invocation and then is the real one. The
  // list is polled every 5 seconds by every open browser, so what matters is
  // that its cost per call did not become per-session: the pane state is read
  // from a file, off the one `list-panes` this already made.
  const real = (await execFileAsync('sh', ['-c', 'command -v tmux'])).stdout.trim();
  const log = join(await mkdtemp(join(tmpdir(), 'tether-tmuxlog-')), 'calls');
  await writeFile(join(STUB_BIN, 'tmux'), `#!/bin/sh\necho x >> ${log}\nexec ${real} "$@"\n`, {
    mode: 0o755,
  });
  t.after(() => rmSync(join(STUB_BIN, 'tmux'), { force: true }));

  const counted = async () => {
    await writeFile(log, '');
    await call(h, 'GET', BASE);
    return (await readFile(log, 'utf8')).split('\n').filter(Boolean).length;
  };

  const first = (await create(h, h.root)).json().session;
  await publishStatus(h.home, await panePid(h, first.tmuxName), {
    sessionId: 'one',
    status: 'busy',
  });
  const one = await counted();

  for (let i = 0; i < 3; i += 1) {
    const extra = (await create(h, h.root)).json().session;
    await publishStatus(h.home, await panePid(h, extra.tmuxName), {
      sessionId: `extra-${i}`,
      status: 'busy',
    });
  }
  assert.equal(Object.keys((await call(h, 'GET', BASE)).json().states).length, 4);
  assert.equal(await counted(), one, 'four sessions cost the same tmux calls as one');
});

test('a session is titled after its directory by default', async (t) => {
  const h = await harness(t);
  const project = join(h.root, 'widget');
  await mkdir(project);

  assert.equal((await create(h, project)).json().session.title, 'widget');
});

test('a create that starts a pane it cannot record leaves no orphan', async (t) => {
  const h = await harness(t);

  // The registry write fails: `tmux_name` is UNIQUE and the table is gone from
  // under it. What must not happen is a tmux session nothing will ever list.
  h.db.exec('DROP TABLE sessions');
  const res = await create(h, h.root);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(await listTmuxSessions(h.socket), []);
});

// ── Resume: what a dead row is for (report §2) ──

test('resume brings a dead session back under the same row and the same conversation', async (t) => {
  const h = await harness(t);
  const session = (await create(h, h.root)).json().session;
  // What PR #8's transcript tail back-fills for real.
  const providerSessionId = randomUUID();
  setProviderSessionId(h.db, session.id, providerSessionId);

  // The reboot: tmux keeps nothing on disk, so the whole server goes with it.
  await killServer(h.socket);

  const resumed = await call(h, 'POST', `${BASE}/${session.id}/resume`);
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(resumed.json().session.id, session.id);
  assert.equal(resumed.json().session.providerSessionId, providerSessionId);
  assert.equal(resumed.json().session.deadAt, null);
  assert.deepEqual(await listTmuxSessions(h.socket), [session.tmuxName]);

  // Idempotent: a second resume finds it live and starts nothing.
  const again = await call(h, 'POST', `${BASE}/${session.id}/resume`);
  assert.equal(again.statusCode, 200);
  assert.deepEqual(await listTmuxSessions(h.socket), [session.tmuxName]);
  assert.equal(listSessions(h.db).length, 1);

  // A well-formed id that was never issued is missing, not broken.
  const missing = await call(h, 'POST', `${BASE}/${randomUUID()}/resume`);
  assert.equal(missing.statusCode, 404);
});

test('resuming a session with no provider session id is refused, not quietly started fresh', async (t) => {
  const h = await harness(t);
  const session = (await create(h, h.root)).json().session;
  assert.equal(session.providerSessionId, null, 'never got a first message');

  await killServer(h.socket);

  const res = await call(h, 'POST', `${BASE}/${session.id}/resume`);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, 'no_provider_session');
  assert.match(res.json().message, /Start a new session/);

  // Nothing was started, and the row still reads dead rather than resumed.
  assert.deepEqual(await listTmuxSessions(h.socket), []);
  assert.ok(getSession(h.db, session.id)!.deadAt !== null);
});

// ── Which provider a session is ──

test('the provider is the caller\u2019s to choose, and claude-code when it is not', async (t) => {
  const h = await harness(t);

  // Every provider the CLI can start, over HTTP, recorded on the row the list
  // returns — which is what the browser tags each session with.
  for (const provider of ['claude-code', 'codex']) {
    const res = await create(h, h.root, { provider });
    assert.equal(res.statusCode, 201, provider);
    assert.equal(res.json().session.provider, provider);
  }

  const omitted = await create(h, h.root);
  assert.equal(omitted.statusCode, 201);
  assert.equal(
    omitted.json().session.provider,
    'claude-code',
    'unspecified means Claude Code, so nothing existing changes behaviour',
  );

  assert.deepEqual(
    listSessions(h.db)
      .map((session) => session.provider)
      .sort(),
    ['claude-code', 'claude-code', 'codex'],
  );

  // The enum is the same set the CLI starts from: an unknown provider is a 400
  // from the schema, before a handler or a pane exists.
  const unknown = await create(h, h.root, { provider: 'some-future-agent' });
  assert.equal(unknown.statusCode, 400);
});

// ── folder trust: asked before the agent starts, recorded only when told to ──

const TRUST = '/api/machines/local/folder-trust';

function trustQuery(h: Harness, cwd: string, provider?: string) {
  const query = new URLSearchParams({ cwd, ...(provider === undefined ? {} : { provider }) });
  return call(h, 'GET', `${TRUST}?${query.toString()}`);
}

test('the folder-trust route needs the same cookie and the same roots as everything else', async (t) => {
  const h = await harness(t);

  const open = await h.app.inject({
    method: 'GET',
    url: `${TRUST}?cwd=${encodeURIComponent(h.root)}`,
    headers: { host: HOST, origin: `http://${HOST}` },
  });
  assert.equal(open.statusCode, 401, 'a read of the agent’s configuration is not public');

  const outside = await mkdtemp(join(tmpdir(), 'tether-outside-trust-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const refused = await trustQuery(h, outside);
  assert.equal(refused.statusCode, 400, 'the same confinement as create');
  assert.equal(refused.json().error, 'invalid_cwd');
});

test('an untrusted directory says so, and an already-trusted one has nothing to ask', async (t) => {
  const h = await harness(t);

  const untrusted = await trustQuery(h, h.root, 'claude-code');
  assert.equal(untrusted.statusCode, 200);
  assert.deepEqual(untrusted.json(), { trust: 'untrusted', path: h.root });

  await writeFile(
    h.trustIn.claudeConfigPath,
    JSON.stringify({ projects: { [h.root]: { hasTrustDialogAccepted: true } } }),
  );
  assert.deepEqual(await trustQuery(h, h.root, 'claude-code').then((r) => r.json()), {
    trust: 'trusted',
    path: h.root,
  });
});

test('a configuration tether cannot read is reported as undeterminable', async (t) => {
  const h = await harness(t);
  await writeFile(h.trustIn.claudeConfigPath, 'not json');
  assert.equal((await trustQuery(h, h.root, 'claude-code')).json().trust, 'unknown');
});

test('accepting records trust where the agent reads it, before the pane exists', async (t) => {
  const h = await harness(t);

  const res = await create(h, h.root, { provider: 'claude-code', trustFolder: true });
  assert.equal(res.statusCode, 201);
  // The check the whole feature exists for: the agent would find this trusted.
  assert.equal((await trustQuery(h, h.root, 'claude-code')).json().trust, 'trusted');
  const config = JSON.parse(await readFile(h.trustIn.claudeConfigPath, 'utf8')) as {
    projects: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(config.projects[h.root], { hasTrustDialogAccepted: true });
});

test('declining is not an error: the session starts and nothing is written', async (t) => {
  const h = await harness(t);

  // Both spellings of "no". Declining is a supported answer — the agent asks in
  // the terminal, exactly as it did before any of this existed — so it must be a
  // 201 and not a refusal, and it must leave the agent's configuration alone.
  for (const body of [{}, { trustFolder: false }]) {
    const res = await create(h, h.root, { provider: 'claude-code', ...body });
    assert.equal(res.statusCode, 201, JSON.stringify(body));
    assert.equal(res.json().session.deadAt, null);
  }
  await assert.rejects(readFile(h.trustIn.claudeConfigPath, 'utf8'), /ENOENT/);
  assert.equal((await trustQuery(h, h.root, 'claude-code')).json().trust, 'untrusted');
  assert.equal(listSessions(h.db).length, 2, 'both sessions are real');
});

test('Codex is asked about its repository, and answered there', async (t) => {
  const h = await harness(t);

  // A repository inside the root, so the answer is about the root of it rather
  // than the directory the session runs in.
  const repo = join(h.root, 'repo');
  const sub = join(repo, 'sub');
  await mkdir(sub, { recursive: true });
  await execFileAsync('git', ['-C', repo, 'init', '-q']);

  const asked = await trustQuery(h, sub, 'codex');
  assert.deepEqual(asked.json(), { trust: 'untrusted', path: repo }, 'keyed by repository');

  assert.equal((await create(h, sub, { provider: 'codex', trustFolder: true })).statusCode, 201);
  const config = await readFile(join(h.trustIn.codexHome, 'config.toml'), 'utf8');
  assert.match(config, /\[projects\."[^"]*\/repo"\]\ntrust_level = "trusted"/);
  // And the whole repository now reads trusted, which is what Codex itself does.
  assert.equal((await trustQuery(h, sub, 'codex')).json().trust, 'trusted');
  assert.equal((await trustQuery(h, repo, 'codex')).json().trust, 'trusted');
});

test('a configuration tether will not rewrite fails the create, having started nothing', async (t) => {
  const h = await harness(t);
  await writeFile(h.trustIn.claudeConfigPath, '{ broken');

  const res = await create(h, h.root, { provider: 'claude-code', trustFolder: true });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'trust_not_recorded');
  assert.match(res.json().message, /will not rewrite/);
  // Nothing half-done: no row, no pane. The same Start without the box ticked is
  // still a working session, which is what the sheet falls back to.
  assert.deepEqual(listSessions(h.db), []);
  assert.deepEqual(await listTmuxSessions(h.socket), []);
  assert.equal(await readFile(h.trustIn.claudeConfigPath, 'utf8'), '{ broken');
});
