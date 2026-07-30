/**
 * The two shared pieces: the ancestor chain, and the git resolution both
 * providers depend on. Against real `git`, because the claim being made is about
 * what git reports for a **linked worktree** — the case that made this a function
 * rather than a `--show-toplevel` at each call site.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

import { repoRoot, selfAndAncestors } from './trust.ts';

const run = promisify(execFile);
const scratches: string[] = [];

after(async () => {
  for (const dir of scratches) await rm(dir, { recursive: true, force: true });
});

test('the ancestor chain is the directory and every parent, nearest first', () => {
  assert.deepEqual(selfAndAncestors('/a/b/c'), ['/a/b/c', '/a/b', '/a', '/']);
  assert.deepEqual(selfAndAncestors('/'), ['/']);
});

test('the repository root is the main one, from a worktree as well as from a subdirectory', async () => {
  // `mkdtemp` under `/tmp` can be a symlink on macOS, and git answers with the
  // resolved path; comparing against a resolved root keeps this about git.
  const scratch = await mkdtemp(join(tmpdir(), 'tether-repo-'));
  scratches.push(scratch);
  const { stdout } = await run('realpath', [scratch]);
  const base = stdout.trim();

  const repo = join(base, 'repo');
  await mkdir(join(repo, 'sub'), { recursive: true });
  await run('git', ['-C', repo, 'init', '-q']);
  await run('git', [
    '-C',
    repo,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'x',
  ]);
  const worktree = join(base, 'elsewhere');
  await run('git', ['-C', repo, 'worktree', 'add', '-q', worktree, '-b', 'w']);

  assert.equal(await repoRoot(repo), repo);
  assert.equal(await repoRoot(join(repo, 'sub')), repo);
  // The point of the whole function: from a linked worktree, both agents resolve
  // back to the repository, so `--show-toplevel` — which would answer with
  // `worktree` here — would have tether writing an entry the agent then ignores.
  assert.equal(await repoRoot(worktree), repo);

  const plain = join(base, 'plain');
  await mkdir(plain, { recursive: true });
  assert.equal(await repoRoot(plain), undefined, 'nothing outside a repository');
});
