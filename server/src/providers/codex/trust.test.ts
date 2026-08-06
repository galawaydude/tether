/**
 * Codex's half of folder trust. The expectations are codex-cli 0.145.0's own
 * behaviour, established by running it under a scratch `CODEX_HOME`: exact keys,
 * no ancestor walk, and the main repository root rather than the directory it was
 * started in.
 *
 * The other half of this file is the line scanner's refusals. They matter more
 * than they look: `config.toml` holds Codex's hook trust hashes, and appending a
 * second table for a key the scanner failed to see would be a TOML duplicate-key
 * error — tether breaking the user's Codex install while recording consent.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { configBackupPath, configPath, readTrust, writeTrust } from './trust.ts';

const scratches: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tether-codex-trust-'));
  scratches.push(dir);
  return dir;
}

/** A `CODEX_HOME` whose `config.toml` holds exactly this text. */
async function home(text?: string): Promise<string> {
  const dir = await scratch();
  if (text !== undefined) await writeFile(configPath(dir), text);
  return dir;
}

after(async () => {
  const { rm } = await import('node:fs/promises');
  for (const dir of scratches) await rm(dir, { recursive: true, force: true });
});

/** What a real `config.toml` looks like, hook trust hashes included. */
const REAL = `approvals_reviewer = "user"
service_tier = "default"

[projects."/w/repo"]
trust_level = "trusted"

[features]
hooks = true

[hooks.state."/home/u/.codex/hooks.json:session_start:0:0"]
trusted_hash = "sha256:beef"
`;

test('an exact key is trusted and nothing else is', async () => {
  const dir = await home(REAL);
  assert.equal(await readTrust('/w/repo', dir), 'trusted');
  // No ancestor walk — verified live: a repository under a trusted parent still
  // prompts, which is the opposite of Claude Code.
  assert.equal(await readTrust('/w/repo/sub', dir), 'untrusted');
  assert.equal(await readTrust('/w', dir), 'untrusted');
});

test('a literal-string key and a trust_level that is not trusted', async () => {
  assert.equal(
    await readTrust('/w/a', await home(`[projects.'/w/a']\ntrust_level = 'trusted'\n`)),
    'trusted',
  );
  assert.equal(
    await readTrust('/w/a', await home(`[projects."/w/a"]\ntrust_level = "untrusted"\n`)),
    'untrusted',
  );
  // A table with no `trust_level` at all says nothing, which is untrusted.
  assert.equal(await readTrust('/w/a', await home(`[projects."/w/a"]\n`)), 'untrusted');
});

test('a trust_level in the next table is not this table’s', async () => {
  const dir = await home(`[projects."/w/a"]\n\n[projects."/w/b"]\ntrust_level = "trusted"\n`);
  assert.equal(await readTrust('/w/a', dir), 'untrusted');
  assert.equal(await readTrust('/w/b', dir), 'trusted');
});

test('an absent config.toml is untrusted, not undeterminable', async () => {
  assert.equal(await readTrust('/w/a', await home()), 'untrusted');
});

test('TOML this scanner may not reason about is reported, never guessed at', async () => {
  // A multi-line string can hide anything, a table header included.
  const multiline = await home(`greeting = """\n[projects."/w/a"]\ntrust_level = "trusted"\n"""\n`);
  assert.equal(await readTrust('/w/a', multiline), 'unknown');
  // A bare `[projects]` table could define this key where the scanner does not look.
  assert.equal(await readTrust('/w/a', await home(`[projects]\n"/w/a" = { }\n`)), 'unknown');
  // So could a top-level dotted key.
  assert.equal(
    await readTrust('/w/a', await home(`projects."/w/a".trust_level = "trusted"\n`)),
    'unknown',
  );
  // And a projects header carrying an escape the scanner does not decode could be
  // this very key spelled another way.
  assert.equal(await readTrust('/w/a', await home(`[projects."/w/\\u0061"]\n`)), 'unknown');
  // The refusals cover what the shapes *mean*, not the exact spelling Codex uses:
  // a trailing comment or an array-of-tables must not slip past them.
  assert.equal(await readTrust('/w/a', await home(`[projects] # mine\n"/w/a" = { }\n`)), 'unknown');
  assert.equal(await readTrust('/w/a', await home(`[[projects]]\n`)), 'unknown');
  assert.equal(
    await readTrust('/w/a', await home(`projects = { "/w/a" = { trust_level = "trusted" } }\n`)),
    'unknown',
  );
  // And a header the scanner cannot read *after* the target table is still a
  // header that could be the target table under another spelling.
  assert.equal(
    await readTrust('/w/a', await home(`[projects."/w/a"]\n\n[projects."/w/\\u0061"]\n`)),
    'unknown',
  );
});

test('a trust_level the scanner cannot read whole is reported, not overwritten', async () => {
  // The line does define the key, so reading it as absent and splicing a second
  // one under the header would be a TOML duplicate-key error.
  const byHand = `[projects."/w/a"]\ntrust_level = "untrusted" # set by hand\n`;
  const dir = await home(byHand);
  assert.equal(await readTrust('/w/a', dir), 'unknown');
  await assert.rejects(
    writeTrust('/w/a', { codexHome: dir, stateDir: await scratch() }),
    /cannot edit safely/,
  );
  assert.equal(await readFile(configPath(dir), 'utf8'), byHand, 'refused means untouched');

  // Nor is the commented case quietly read as trusted, which would be the same
  // guess in the direction that matters most.
  assert.equal(
    await readTrust('/w/a', await home(`[projects."/w/a"]\ntrust_level = "trusted" # mine\n`)),
    'unknown',
  );
  // A `trust_level` in some *other* table is nothing to do with this key.
  assert.equal(
    await readTrust(
      '/w/a',
      await home(`[features]\ntrust_level = "trusted" # mine\n\n[projects."/w/a"]\n`),
    ),
    'untrusted',
  );
});

test('accepting appends one table and leaves every other byte alone', async () => {
  const dir = await home(REAL);
  const state = await scratch();
  const result = await writeTrust('/w/new', {
    codexHome: dir,
    stateDir: state,
    now: new Date('2026-07-30T12:00:00.000Z'),
  });

  assert.equal(result.path, '/w/new');
  assert.equal(await readTrust('/w/new', dir), 'trusted');
  const text = await readFile(configPath(dir), 'utf8');
  // Everything that was there, byte for byte, including the hook trust hash.
  assert.ok(text.startsWith(REAL), 'the original text is a prefix of the new text');
  assert.ok(text.includes('trusted_hash = "sha256:beef"'));
  assert.equal(await readTrust('/w/repo', dir), 'trusted', 'the other project still reads trusted');
  // Exactly one table for the new key: a second would be a TOML duplicate.
  assert.equal(text.match(/\[projects\."\/w\/new"\]/g)?.length, 1);
  // Marked, so a user can find this entry and take it out again.
  assert.ok(/# Trusted from Remote Control Agent/.test(text));

  assert.equal(result.backupPath, configBackupPath(state, '2026-07-30T12-00-00-000Z'));
  assert.equal(await readFile(result.backupPath as string, 'utf8'), REAL);
});

test('an existing table for the key is edited in place, never duplicated', async () => {
  const dir = await home(`[projects."/w/a"]\ntrust_level = "untrusted"\nsome_other_key = 1\n`);
  await writeTrust('/w/a', { codexHome: dir, stateDir: await scratch() });
  const text = await readFile(configPath(dir), 'utf8');
  assert.equal(text, `[projects."/w/a"]\ntrust_level = "trusted"\nsome_other_key = 1\n`);
  assert.equal(text.match(/\[projects/g)?.length, 1);
});

test('a table with no trust_level gets one directly under its own header', async () => {
  const dir = await home(`[projects."/w/a"]\n\n[features]\nhooks = true\n`);
  await writeTrust('/w/a', { codexHome: dir, stateDir: await scratch() });
  assert.equal(
    await readFile(configPath(dir), 'utf8'),
    `[projects."/w/a"]\ntrust_level = "trusted"\n\n[features]\nhooks = true\n`,
  );
});

test('an absent config.toml is created with just the one table', async () => {
  const dir = await home();
  const result = await writeTrust('/w/a', { codexHome: dir, stateDir: await scratch() });
  assert.equal(result.backupPath, undefined, 'there was nothing to back up');
  const text = await readFile(configPath(dir), 'utf8');
  assert.match(
    text,
    /^# Trusted from Remote Control Agent[^\n]*\n\[projects\."\/w\/a"\]\ntrust_level = "trusted"\n$/,
  );
});

test('an already-trusted key is a no-op and writes nothing', async () => {
  const dir = await home(REAL);
  const result = await writeTrust('/w/repo', { codexHome: dir, stateDir: await scratch() });
  assert.equal(result.backupPath, undefined);
  assert.equal(await readFile(configPath(dir), 'utf8'), REAL);
});

test('a file the scanner may not edit is refused, and left untouched', async () => {
  const text = `[projects]\n"/w/a" = { trust_level = "untrusted" }\n`;
  const dir = await home(text);
  await assert.rejects(
    writeTrust('/w/a', { codexHome: dir, stateDir: await scratch() }),
    /cannot edit safely/,
  );
  assert.equal(await readFile(configPath(dir), 'utf8'), text, 'refused means untouched');
});

test('a key needing escapes round-trips through its own header', async () => {
  const dir = await home();
  const odd = '/w/a "quoted" and \\ backslash';
  await writeTrust(odd, { codexHome: dir, stateDir: await scratch() });
  assert.equal(await readTrust(odd, dir), 'trusted');
  assert.equal(await readTrust('/w/a', dir), 'untrusted');
});
