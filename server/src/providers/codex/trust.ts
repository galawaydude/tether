/**
 * Where Codex records that a folder is trusted, and how to read it.
 *
 * `$CODEX_HOME/config.toml`, under `[projects."<dir>"] trust_level = "trusted"`.
 * Verified against codex-cli 0.145.0 by running it under a scratch `CODEX_HOME`
 * and reading the pane. It is **not** Claude Code's scheme wearing a different
 * spelling, and the differences are the whole reason this file exists:
 *
 * - **No ancestor walk.** A repository whose parent directory is trusted still
 *   prompts. The key is matched exactly.
 * - **The key is the main repository root**, not the directory Codex was started
 *   in: accepting in `repo/sub` writes `[projects."repo"]`, and a session in a
 *   linked worktree of a trusted repository does not prompt at all. So trusting
 *   for Codex is always a decision about a repository, which is why the sheet is
 *   told which path the answer is about rather than saying "this folder".
 * - **Declining writes nothing** — Codex quits. Neither does tether.
 *
 * ## Why a line scanner and not a TOML parser
 *
 * There is no TOML parser in Node and this is not worth a dependency, so the
 * scanner below reads and edits *lines*. That is sound only for the canonical
 * shapes Codex itself writes, so anything outside them is **refused rather than
 * guessed at** (`beyond` below), and the coverage of the refusal has to match the
 * confidence of the regexes rather than their exact form. Four cases:
 *
 * - a **multi-line string** anywhere, which could hide a line that looks like a
 *   table header;
 * - anything naming `projects` in a **table header** this scanner does not
 *   recognise whole — a bare `[projects]`, an `[[projects]]`, a header carrying an
 *   escape it does not decode, a trailing comment;
 * - a **top-level `projects` key**, dotted or assigned outright;
 * - a **`trust_level` assignment** in the target table that the strict form does
 *   not match whole, such as one carrying a trailing comment.
 *
 * Each of them could define this same key somewhere the scanner does not look, or
 * say something the scanner cannot read — where appending a second
 * `[projects."<dir>"]` table, or a second `trust_level` beside one already there,
 * would be a duplicate-key error, which is to say tether would have broken the
 * user's Codex config, hook trust hashes and all. A read then answers `unknown`
 * and a write refuses, which is the honest pair: tether says it cannot tell, and
 * offers nothing.
 *
 * This file is also the one place tether writes to `config.toml`, and only ever
 * this one key. It is where Codex keeps its hook trust hashes and its settings,
 * and neither is tether's to touch — see `cli.ts`, which says so to the user.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { FolderTrust } from '@tether/shared';

import { stateDir as defaultStateDir } from '../../db.ts';
import {
  FolderTrustError,
  type TrustLocations,
  type TrustWrite,
  backupStamp,
  writeAtomically,
} from '../trust.ts';
import { codexHome as defaultCodexHome } from './spawn.ts';

/** `$CODEX_HOME/config.toml` — Codex's own config, which tether reads and barely writes. */
export function configPath(codexHome: string): string {
  return join(codexHome, 'config.toml');
}

/** Any table header: `[a]`, `[a.b]`, `[[a]]`. Ends the table before it. */
const TABLE = /^\s*\[/;

/** `[projects."<key>"]` or `[projects.'<key>']`, the two forms TOML allows. */
const PROJECT_TABLE = /^\s*\[projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\]\s*$/;

/**
 * Any header naming `projects`, whether or not `PROJECT_TABLE` recognises its
 * shape — a bare `[projects]`, whose keys could define anything, included.
 */
const SOME_PROJECTS_TABLE = /^\s*\[\[?projects\b/;

/** A top-level `projects` key — dotted or assigned whole — which could define anything too. */
const TOP_PROJECTS = /^\s*(?:projects|"projects"|'projects')\s*[.=]/;

/** `trust_level = "trusted"`, in either string form. */
const TRUST_LEVEL = /^\s*trust_level\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*$/;

/** Any `trust_level` assignment, including the shapes `TRUST_LEVEL` will not read. */
const SOME_TRUST_LEVEL = /^\s*trust_level\s*=/;

/**
 * A basic string made only of plain characters and the two escapes this scanner
 * decodes. Written as a whole-string match rather than a "does it contain an
 * escape we do not know" test, because that has to pair the backslashes: in
 * `\\ backslash` the second `\` is not the start of an escape at all, and a
 * lookahead reading it as one calls a path tether wrote itself undecodable.
 */
const DECODABLE = /^(?:[^\\]|\\["\\])*$/;

/** The bytes of a basic-string key, decoded, or `undefined` for an escape we do not read. */
function decodeKey(line: string): string | undefined {
  const match = PROJECT_TABLE.exec(line);
  if (match === null) return undefined;
  const literal = match[2];
  if (literal !== undefined) return literal;
  const basic = match[1] as string;
  if (!DECODABLE.test(basic)) return undefined;
  // One pass, because two sequential replacements would let the output of the
  // first be read as an escape by the second.
  return basic.replace(/\\(["\\])/g, '$1');
}

/** The header tether writes, with the two characters a basic string must escape. */
function header(key: string): string {
  return `[projects."${key.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`;
}

type Scan = {
  /** True when the file holds something this scanner may not reason about. */
  beyond: boolean;
  /** Index of the `[projects."<key>"]` header line, when it is there. */
  at?: number;
  /** Index of that table's `trust_level` line, when it has one. */
  trustAt?: number;
  /** The value on that line. */
  trustLevel?: string;
};

/**
 * Find the target table and its `trust_level`, or decide the file is beyond this
 * scanner. One function so a read and a write can never disagree about what is
 * in the file — an appended duplicate of a table the reader missed is the one
 * failure here that damages something.
 */
function scan(text: string, key: string, lines: readonly string[]): Scan {
  // A multi-line string can contain anything, table headers included, so its mere
  // presence anywhere puts the file out of reach. Codex writes none.
  if (text.includes('"""') || text.includes("'''")) return { beyond: true };
  const result: Scan = { beyond: false };
  let inTable = false;
  let seenTable = false;
  for (const [index, line] of lines.entries()) {
    if (TABLE.test(line)) {
      seenTable = true;
      inTable = false;
      const found = decodeKey(line);
      // A header naming *some* project in a shape this scanner does not recognise
      // whole could be this very key spelled another way. Checked even once the
      // target table has been found, for exactly that reason.
      if (found === undefined && SOME_PROJECTS_TABLE.test(line)) return { beyond: true };
      if (result.at !== undefined) continue;
      if (found === key) {
        result.at = index;
        inTable = true;
      }
      continue;
    }
    if (!seenTable && TOP_PROJECTS.test(line)) return { beyond: true };
    if (!inTable) continue;
    const trust = TRUST_LEVEL.exec(line);
    if (trust !== null) {
      result.trustAt = index;
      // One of the two alternatives always matched; the empty string is not
      // `trusted` either way, which is the answer an unreadable value deserves.
      result.trustLevel = trust[1] ?? trust[2] ?? '';
      continue;
    }
    // An assignment the strict form does not match whole: overwriting the line
    // would lose what else is on it, and splicing one beside it is the duplicate
    // key this whole scanner is arranged to avoid.
    if (SOME_TRUST_LEVEL.test(line)) return { beyond: true };
  }
  return result;
}

/** Is `dir` — a repository root, or a directory outside any repository — trusted? */
export async function readTrust(
  dir: string,
  codexHome: string = defaultCodexHome(),
): Promise<FolderTrust> {
  const path = configPath(codexHome);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    // Absent is not undeterminable: nothing is trusted, which is an answer.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'untrusted' : 'unknown';
  }
  const found = scan(text, dir, text.split('\n'));
  if (found.beyond) return 'unknown';
  return found.trustLevel === 'trusted' ? 'trusted' : 'untrusted';
}

/** Where `config.toml` is copied before tether touches it. Under tether's state directory. */
export function configBackupPath(stateDir: string, stamp: string): string {
  return join(stateDir, 'codex-config-backups', `config-${stamp}.toml`);
}

/**
 * Record that the user trusts the repository (or lone directory) at `dir`.
 *
 * Merged, never rewritten: an existing table for this key has its `trust_level`
 * set in place, one is added to a table that has none, and only a file with no
 * such table at all gets a new one appended at the end. Every other table, key,
 * comment and blank line comes out exactly as it went in — including the
 * `[hooks.state]` hashes, which are what Codex's own trust gate is built on.
 *
 * `now` is only for tests, which need a predictable backup name.
 */
export async function writeTrust(
  dir: string,
  where: TrustLocations & { now?: Date } = {},
): Promise<TrustWrite> {
  const path = configPath(where.codexHome ?? defaultCodexHome());
  let text: string | undefined;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new FolderTrustError(
        `tether will not rewrite ${path}: it could not be read (${(error as Error).message})`,
      );
    }
  }

  const lines = text === undefined ? [] : text.split('\n');
  const found = scan(text ?? '', dir, lines);
  if (found.beyond) {
    throw new FolderTrustError(
      `tether will not rewrite ${path}: it uses TOML that tether cannot edit safely. ` +
        `Add \`trust_level = "trusted"\` under \`${header(dir)}\` by hand, or let Codex ask you ` +
        `in the terminal.`,
    );
  }
  if (found.trustLevel === 'trusted') return { path: dir };

  const next = [...lines];
  if (found.trustAt !== undefined) {
    next[found.trustAt] = 'trust_level = "trusted"';
  } else if (found.at !== undefined) {
    // Directly under its own header rather than at the end of the table: a table
    // may end on blank lines and a comment belonging to whatever follows it.
    next.splice(found.at + 1, 0, 'trust_level = "trusted"');
  } else {
    // Appended, and only ever here. The comment is so a user can find this entry
    // and take it back out — this is a file tether does not own.
    const spacer = next.length === 0 || next.at(-1)?.trim() === '' ? [] : [''];
    next.push(
      ...spacer,
      '# Trusted from tether’s New session sheet.',
      header(dir),
      'trust_level = "trusted"',
      '',
    );
  }

  let backupPath: string | undefined;
  if (text !== undefined) {
    backupPath = configBackupPath(where.stateDir ?? defaultStateDir(), backupStamp(where.now));
    await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    await writeAtomically(backupPath, text, 0o600);
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeAtomically(path, next.join('\n'), 0o600);
  return { path: dir, ...(backupPath === undefined ? {} : { backupPath }) };
}
