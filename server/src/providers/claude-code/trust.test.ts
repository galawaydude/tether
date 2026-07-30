/**
 * Claude Code's half of folder trust. Every expectation here is the behaviour of
 * the real CLI, established by running 2.1.220 under a scratch `HOME` — the
 * ancestor walk especially, which an exact-path check would get wrong for a
 * directory Claude Code is perfectly happy in.
 *
 * Nothing here touches the developer's own `~/.claude.json`: every case passes an
 * explicit config path into a temporary directory.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { claudeConfigPath, configBackupPath, readTrust, writeTrust } from './trust.ts';

const scratches: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tether-trust-'));
  scratches.push(dir);
  return dir;
}

/** A config file with whatever `projects` a case needs, plus a key it must not lose. */
async function config(projects: Record<string, unknown>): Promise<string> {
  const path = join(await scratch(), '.claude.json');
  await writeFile(path, `${JSON.stringify({ numStartups: 85, projects }, null, 2)}\n`);
  return path;
}

after(async () => {
  const { rm } = await import('node:fs/promises');
  for (const dir of scratches) await rm(dir, { recursive: true, force: true });
});

test('the config file is $CLAUDE_CONFIG_DIR/.claude.json, else ~/.claude.json', () => {
  assert.equal(claudeConfigPath({}, '/home/u'), '/home/u/.claude.json');
  assert.equal(claudeConfigPath({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/u'), '/cfg/.claude.json');
  // Set-but-empty is not set: an exported-and-cleared variable is the ordinary
  // way a shell says "default", and joining on it would read `/.claude.json`.
  assert.equal(claudeConfigPath({ CLAUDE_CONFIG_DIR: '  ' }, '/home/u'), '/home/u/.claude.json');
});

test('an accepted directory is trusted', async () => {
  const path = await config({ '/w/p': { hasTrustDialogAccepted: true } });
  assert.equal(await readTrust('/w/p', undefined, path), 'trusted');
});

test('an accepted ancestor is enough, which is what Claude Code itself does', async () => {
  const path = await config({ '/w/p': { hasTrustDialogAccepted: true } });
  assert.equal(await readTrust('/w/p/a/b', undefined, path), 'trusted');
});

test('an entry that says false does not count, even under a trusted ancestor', async () => {
  // The exact shape the CLI leaves behind: it writes the child's own entry as
  // `false` and still does not prompt there, because the parent is accepted.
  const path = await config({
    '/w/p': { hasTrustDialogAccepted: true },
    '/w/p/child': { hasTrustDialogAccepted: false },
  });
  assert.equal(await readTrust('/w/p/child', undefined, path), 'trusted');
  assert.equal(await readTrust('/w/other', undefined, path), 'untrusted');
});

test('the main repository root counts, and its ancestors do not', async () => {
  const path = await config({ '/w/repo': { hasTrustDialogAccepted: true } });
  // From a linked worktree, whose own path is in no configuration file.
  assert.equal(await readTrust('/far/away/wt', '/w/repo', path), 'trusted');
  // And the negative case, verified live: a worktree of a repository whose
  // *parent* is accepted still prompts.
  const parent = await config({ '/w': { hasTrustDialogAccepted: true } });
  assert.equal(await readTrust('/far/away/wt', '/w/repo', parent), 'untrusted');
});

test('an absent config file is untrusted, not undeterminable', async () => {
  const path = join(await scratch(), '.claude.json');
  assert.equal(await readTrust('/w/p', undefined, path), 'untrusted');
});

test('a config file that cannot be understood reports rather than assumes', async () => {
  const broken = join(await scratch(), '.claude.json');
  await writeFile(broken, '{"projects": {');
  assert.equal(await readTrust('/w/p', undefined, broken), 'unknown');

  const wrongShape = join(await scratch(), '.claude.json');
  await writeFile(wrongShape, '["not an object"]');
  assert.equal(await readTrust('/w/p', undefined, wrongShape), 'unknown');

  const wrongProjects = join(await scratch(), '.claude.json');
  await writeFile(wrongProjects, '{"projects": 7}');
  assert.equal(await readTrust('/w/p', undefined, wrongProjects), 'unknown');
});

test('accepting records it where Claude Code reads it, and loses nothing else', async () => {
  const path = await config({
    '/w/other': { hasTrustDialogAccepted: false, allowedTools: ['Bash'] },
  });
  const state = await scratch();
  const result = await writeTrust('/w/p', {
    claudeConfigPath: path,
    stateDir: state,
    now: new Date('2026-07-30T12:00:00.000Z'),
  });

  assert.equal(result.path, '/w/p');
  assert.equal(await readTrust('/w/p', undefined, path), 'trusted');
  const after = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  // The unrelated key and the unrelated project, untouched.
  assert.equal(after['numStartups'], 85);
  const projects = after['projects'] as Record<string, Record<string, unknown>>;
  assert.deepEqual(projects['/w/other'], { hasTrustDialogAccepted: false, allowedTools: ['Bash'] });
  assert.deepEqual(projects['/w/p'], { hasTrustDialogAccepted: true });

  // Backed up first, under tether's state directory rather than beside the file.
  assert.equal(
    result.backupPath,
    configBackupPath(state, '2026-07-30T12-00-00-000Z'),
    'the backup goes where the helper says',
  );
  const backup = JSON.parse(await readFile(result.backupPath as string, 'utf8')) as {
    projects: Record<string, unknown>;
  };
  assert.equal('/w/p' in backup.projects, false, 'the backup is the file as it was');
});

test('an existing entry keeps its other fields', async () => {
  const path = await config({ '/w/p': { hasTrustDialogAccepted: false, allowedTools: ['Read'] } });
  await writeTrust('/w/p', { claudeConfigPath: path, stateDir: await scratch() });
  const after = JSON.parse(await readFile(path, 'utf8')) as {
    projects: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(after.projects['/w/p'], {
    hasTrustDialogAccepted: true,
    allowedTools: ['Read'],
  });
});

test('an absent config file is created with just the one entry', async () => {
  const path = join(await scratch(), '.claude.json');
  const result = await writeTrust('/w/p', { claudeConfigPath: path, stateDir: await scratch() });
  assert.equal(result.backupPath, undefined, 'there was nothing to back up');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    projects: { '/w/p': { hasTrustDialogAccepted: true } },
  });
});

test('an already-trusted directory is a no-op, and writes nothing at all', async () => {
  const path = await config({ '/w/p': { hasTrustDialogAccepted: true } });
  const before = await readFile(path, 'utf8');
  const result = await writeTrust('/w/p', { claudeConfigPath: path, stateDir: await scratch() });
  assert.equal(result.backupPath, undefined);
  // Byte-identical: a running Claude Code rewrites this file, so a pointless
  // write is a chance to lose whatever it wrote since the read.
  assert.equal(await readFile(path, 'utf8'), before);
});

test('a config file tether cannot parse is refused, not repaired', async () => {
  const path = join(await scratch(), '.claude.json');
  await writeFile(path, 'not json at all');
  await assert.rejects(
    writeTrust('/w/p', { claudeConfigPath: path, stateDir: await scratch() }),
    /will not rewrite/,
  );
  assert.equal(await readFile(path, 'utf8'), 'not json at all');
});

test('an entry of the wrong shape is refused rather than replaced', async () => {
  const path = await config({ '/w/p': 'somebody put a string here' });
  await assert.rejects(
    writeTrust('/w/p', { claudeConfigPath: path, stateDir: await scratch() }),
    /is not an object/,
  );
});
