/**
 * The browser app is the one thing besides `/api/login` that is reachable without
 * a session, so what it is allowed to reach is worth pinning down: the two named
 * routes and nothing else, from inside the `root` directory and nowhere else.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';

import { applyRegistrySchema } from '../machine/registry.ts';
import type { Terminals } from '../machine/terminal.ts';
import { createAuthStore } from './auth.ts';
import { defaultAllowedHosts } from './guards.ts';
import { buildServer } from './server.ts';

const HOST = 'localhost:8787';

const NO_TERMINALS: Terminals = {
  attach: () => Promise.reject(new Error('not used')),
  refresh: () => Promise.resolve(),
  resize: () => Promise.resolve(),
  input: () => Promise.resolve(true),
  text: () => Promise.resolve(true),
  key: () => Promise.resolve(true),
  closeAll: () => {},
};

async function harness(t: TestContext) {
  const webRoot = await mkdtemp(join(tmpdir(), 'tether-web-'));
  t.after(() => rm(webRoot, { recursive: true, force: true }));
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>tether</title>', 'utf8');
  await mkdir(join(webRoot, 'assets'));
  await writeFile(
    join(webRoot, 'assets', 'index-abc123.js'),
    'export const app = "the browser bundle compresses";\n'.repeat(500),
    'utf8',
  );
  // The file a traversal would be reaching for, one level above the root.
  await writeFile(join(webRoot, '..', 'tether-web-secret.txt'), 'secret', 'utf8');
  t.after(() => rm(join(webRoot, '..', 'tether-web-secret.txt'), { force: true }));

  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  applyRegistrySchema(db);
  const app = buildServer({
    auth: createAuthStore(db),
    db,
    terminals: NO_TERMINALS,
    allowedHosts: defaultAllowedHosts('127.0.0.1'),
    webRoot,
  });
  t.after(() => app.close());
  await app.ready();
  return app;
}

test('the app shell is served without a session — the login screen asks for one', async (t) => {
  const app = await harness(t);

  const page = await app.inject({ method: 'GET', url: '/', headers: { host: HOST } });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'] as string, /text\/html/);
  assert.match(page.body, /<title>tether<\/title>/);

  const asset = await app.inject({
    method: 'GET',
    url: '/assets/index-abc123.js',
    headers: { host: HOST, 'accept-encoding': 'gzip' },
  });
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers['content-type'] as string, /javascript/);
  assert.equal(asset.headers['content-encoding'], 'gzip', 'the Funnel transfer is compressed');
  assert.equal(
    asset.headers['cache-control'],
    'public, max-age=31536000, immutable',
    'a Vite hash makes this URL permanent',
  );
  assert.notEqual(
    page.headers['cache-control'],
    asset.headers['cache-control'],
    'index.html is still revalidated so a new release is found',
  );
});

test('serving the app opens nothing else: no traversal, no API without a session', async (t) => {
  const app = await harness(t);

  for (const url of [
    '/assets/../tether-web-secret.txt',
    '/assets/..%2ftether-web-secret.txt',
    '/assets/subdir/file.js',
  ]) {
    const response = await app.inject({ method: 'GET', url, headers: { host: HOST } });
    assert.ok(response.statusCode >= 400, `${url} answered ${response.statusCode}`);
    assert.doesNotMatch(response.body, /secret/);
  }

  // The static routes are public; nothing else became public with them.
  const api = await app.inject({ method: 'GET', url: '/api/session', headers: { host: HOST } });
  assert.equal(api.statusCode, 401);
});
