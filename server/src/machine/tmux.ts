/**
 * The tmux driver: every conversation tether has with tmux goes through here.
 *
 * Two rules this module exists to enforce, both from report sections 2 and 7:
 *
 *  1. Commands are argv arrays, never shell strings. A session's working directory
 *     and command are attacker-controlled input in a product whose threat model says
 *     reaching it equals a shell.
 *  2. Every invocation carries `-L <socket> -f <tether.conf>`, so whichever command
 *     happens to start the server starts it with tether's config and never reads the
 *     user's ~/.tmux.conf.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The socket name of tether's own tmux server. Tests use their own. */
export const DEFAULT_SOCKET = 'tether';

/** Shipped alongside this module; the server build copies it into `dist/machine/`. */
export const TMUX_CONF = join(import.meta.dirname, 'tether.conf');

/** One pane, as reported by `list-panes`. */
export interface Pane {
  session: string;
  paneId: string;
  pid: number;
  command: string;
  path: string;
  dead: boolean;
}

/** A tmux command that exited non-zero. Carries the argv and stderr, on purpose. */
export class TmuxError extends Error {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(argv: readonly string[], exitCode: number | null, stderr: string) {
    super(`tmux ${argv.join(' ')} failed (exit ${exitCode}): ${stderr.trim() || '<no stderr>'}`);
    this.name = 'TmuxError';
    this.argv = argv;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** A working directory that does not resolve to an existing directory. */
export class InvalidCwdError extends Error {
  readonly cwd: string;

  constructor(cwd: string, reason: string) {
    super(`refusing to start a session in ${cwd}: ${reason}`);
    this.name = 'InvalidCwdError';
    this.cwd = cwd;
  }
}

/** An argument tmux's own lexer would consume rather than hand on as data. */
export class UnsafeArgumentError extends Error {
  constructor(arg: string) {
    super(`argument ${JSON.stringify(arg)} is eaten by tmux's lexer, not passed as data`);
    this.name = 'UnsafeArgumentError';
  }
}

/**
 * tmux splits its argv on standalone `;`, `{` and `}` before any command sees them:
 * `new-session -- sleep 1 ';' kill-server` runs kill-server, and `send-keys -l -- ';'`
 * delivers nothing at all.
 *
 * A *trailing* unescaped `;` is swallowed the same way and is the case that is easy
 * to miss, because nothing fails: tmux 3.7b exits 0 for `send-keys -l -- 'z;'` and
 * delivers `z`, and for the key name `M-;` types the literal `M-`. `x;;` loses one
 * `;` and `y\;` loses the backslash, so an escaped trailing `;` is refused too
 * rather than reasoned about. Separators *inside* an argument (`a;b`, `$USER`,
 * `#{pane_id}`) are passed through literally and are safe.
 *
 * The check lives in `run`, so it covers every argv this module builds — session
 * names, pane targets, keys, commands — rather than only the paths that remember
 * to ask for it.
 */
function mangledByLexer(arg: string): boolean {
  return arg === ';' || arg === '{' || arg === '}' || arg.endsWith(';');
}

/**
 * Whether `checkArgs` would refuse this exact string as an argument. Exported so a
 * caller that has another way to deliver the value — the paste buffer, which
 * reaches tmux on stdin and never becomes argv — can choose it *before* building a
 * command, rather than by catching the guard or by weakening it. There is one rule
 * and this is it: `checkArgs` asks the same predicate, so the two cannot drift.
 */
export function isSeparatorArgument(arg: string): boolean {
  return mangledByLexer(arg);
}

function checkArgs(args: readonly string[]): void {
  for (const arg of args) if (mangledByLexer(arg)) throw new UnsafeArgumentError(arg);
}

/** tmux rejects `:` and `.` in session names — they are its target syntax. */
function checkSessionName(name: string): void {
  if (name === '' || /[:.\s]/.test(name)) {
    throw new Error(`invalid tmux session name ${JSON.stringify(name)}`);
  }
}

/**
 * The full argv for a tmux invocation, checked. Exported because the attach in
 * `terminal.ts` needs a PTY rather than a pipe and so cannot go through `run` —
 * it still must not be allowed to build its own argv and lose `-f tether.conf`.
 *
 * `-u` because tether's pipeline is UTF-8 end to end but tmux decides that per
 * client from LC_ALL/LC_CTYPE/LANG: under a C locale it sanitizes non-printable
 * bytes to `_`, which turns `listPanes`' \x1f separator into an unparseable row.
 */
export function tmuxArgv(socket: string, args: readonly string[]): string[] {
  checkArgs(args);
  return ['-u', '-L', socket, '-f', TMUX_CONF, ...args];
}

function run(socket: string, args: readonly string[], input?: string): Promise<string> {
  return new Promise((fulfil, reject) => {
    // Inside the executor, so a bad argument rejects rather than throwing synchronously
    // out of the wrappers that are not `async`.
    const argv = tmuxArgv(socket, args);
    const child = spawn('tmux', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) fulfil(Buffer.concat(out).toString('utf8'));
      else reject(new TmuxError(argv, code, Buffer.concat(err).toString('utf8')));
    });
    // A tmux that exits before draining stdin (bad socket, unreadable config) turns a
    // large `load-buffer` write into an EPIPE. Swallow it: `close` reports the real
    // failure with argv, exit code and stderr, and an unhandled 'error' would take
    // the process down instead.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/**
 * "Nothing is running" is the correct answer to "what is running", not a failure.
 * tmux 3.7b says `no server running on <socket>` for a stale socket and
 * `error connecting to <socket> (No such file or directory)` when there is none;
 * anything else (a permission error, say) still throws.
 */
const NO_SERVER = /no server running on|error connecting to .*\(No such file or directory\)/;

function emptyIfNoServer(error: unknown): string {
  if (error instanceof TmuxError && NO_SERVER.test(error.stderr)) return '';
  throw error;
}

/** tmux 3.7b's wording when the server is up but the target session is not. */
const NO_SESSION = /can't find session/;

/**
 * True only for the two ways tmux says the session is genuinely already gone: no
 * server at all, or no session by that name. It lives next to `NO_SERVER` so both
 * stderr matchers stay in the one module that talks to tmux. A caller treating
 * "gone" as success must ask this rather than catching every `TmuxError`, or a
 * permission error reads as a successful kill.
 */
export function isSessionGone(error: unknown): boolean {
  return (
    error instanceof TmuxError && (NO_SERVER.test(error.stderr) || NO_SESSION.test(error.stderr))
  );
}

/**
 * Where a session may be started. `cwd` is attacker-controlled input that becomes a
 * process working directory on a machine where reaching tether is a shell (report
 * §7), so it is confined to these roots. The default is the user's home;
 * `RCAGENT_ALLOWED_ROOTS` — a `:`-separated list, like `PATH` — widens it. The
 * former `TETHER_ALLOWED_ROOTS` name remains an alias. One
 * setting, read at use, and that is deliberately all of it: there is no per-root
 * permission model to build, because there is one account with full access.
 */
export function allowedRoots(): readonly string[] {
  const configured = process.env['RCAGENT_ALLOWED_ROOTS'] ?? process.env['TETHER_ALLOWED_ROOTS'];
  if (configured === undefined || configured.trim() === '') return [homedir()];
  return configured.split(delimiter).filter((root) => root.trim() !== '');
}

/**
 * Real containment, never a string prefix: `/home/user2` is not inside `/home/user`
 * however similar the two strings are. `relative` is the stdlib answer — `''` for
 * the root itself, and something starting `..` (or an absolute path, on Windows,
 * across drives) for anything outside it.
 */
function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Resolve a caller-supplied working directory, require it to be an existing
 * directory, and require it to lie inside one of `roots`. Returns the real path —
 * symlinks resolved — which is what gets passed to tmux.
 *
 * The order is the whole point (report §7): resolve *first*, then check. Checking
 * the path as given would pass `~/link -> /etc` and `~/../../etc` alike.
 */
export async function resolveCwd(
  cwd: string,
  roots: readonly string[] = allowedRoots(),
): Promise<string> {
  const absolute = resolve(cwd);
  let real: string;
  let isDirectory: boolean;
  try {
    real = await realpath(absolute);
    isDirectory = (await stat(real)).isDirectory();
  } catch (error) {
    throw new InvalidCwdError(absolute, `does not exist (${(error as Error).message})`);
  }
  if (!isDirectory) throw new InvalidCwdError(real, 'not a directory');
  // The roots are resolved too: a home directory that is itself a symlink would
  // otherwise contain nothing at all. A root that does not resolve is dropped
  // rather than compared literally, so an unusable list denies everything.
  const realRoots = (
    await Promise.all(roots.map((root) => realpath(resolve(root)).catch(() => null)))
  ).filter((root) => root !== null);
  if (!realRoots.some((root) => contains(root, real))) {
    throw new InvalidCwdError(real, `outside the allowed roots (${roots.join(delimiter)})`);
  }
  return real;
}

/**
 * Create a detached session running `command` (argv, executed directly — there is no
 * shell in this path). Returns the resolved working directory it was started in.
 */
export async function newSession(
  socket: string,
  opts: {
    name: string;
    cwd: string;
    command: readonly string[];
    roots?: readonly string[] | undefined;
  },
): Promise<string> {
  checkSessionName(opts.name);
  if (opts.command.length === 0) throw new Error('newSession requires a command');
  const cwd = await resolveCwd(opts.cwd, opts.roots);
  await run(socket, ['new-session', '-d', '-s', opts.name, '-c', cwd, '--', ...opts.command]);
  return cwd;
}

export async function listSessions(socket: string): Promise<string[]> {
  const out = await run(socket, ['list-sessions', '-F', '#{session_name}']).catch(emptyIfNoServer);
  return out.split('\n').filter((line) => line !== '');
}

export async function killSession(socket: string, name: string): Promise<void> {
  checkSessionName(name);
  await run(socket, ['kill-session', '-t', name]);
}

/** Idempotent: a server that is already gone is the postcondition, not an error. */
export async function killServer(socket: string): Promise<void> {
  await run(socket, ['kill-server']).catch(emptyIfNoServer);
}

/**
 * `\x1f` (unit separator) rather than the report's `|`: a pane's current path is
 * attacker-influenced and may legally contain a pipe.
 *
 * ponytail: a path containing \x1f or a newline yields a field-count mismatch and
 * throws rather than mis-parsing. Move to one `display-message` per pane if a real
 * user ever hits it.
 */
const PANE_FIELDS = [
  'session_name',
  'pane_id',
  'pane_pid',
  'pane_current_command',
  'pane_current_path',
  'pane_dead',
] as const;

const PANE_FORMAT = PANE_FIELDS.map((f) => `#{${f}}`).join('\x1f');

export async function listPanes(socket: string): Promise<Pane[]> {
  const out = await run(socket, ['list-panes', '-a', '-F', PANE_FORMAT]).catch(emptyIfNoServer);
  return out
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const f = line.split('\x1f');
      if (f.length !== PANE_FIELDS.length) {
        throw new Error(`unparseable list-panes row: ${JSON.stringify(line)}`);
      }
      const [session, paneId, pid, command, path, dead] = f as unknown as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      return { session, paneId, pid: Number(pid), command, path, dead: dead === '1' };
    });
}

/**
 * The scrollback strictly *above* the current viewport, at most `lines` deep.
 * `-E -1` is what makes this compose with `captureViewport` with no overlap and no
 * gap — report section 3 proved the boundary.
 */
export function captureScrollback(socket: string, target: string, lines: number): Promise<string> {
  return run(socket, [
    'capture-pane',
    '-p',
    '-e',
    '-J',
    '-S',
    `-${lines}`,
    '-E',
    '-1',
    '-t',
    target,
  ]);
}

/** The visible screen. Picks up exactly where `captureScrollback` stopped. */
export function captureViewport(socket: string, target: string): Promise<string> {
  return run(socket, ['capture-pane', '-p', '-e', '-J', '-t', target]);
}

/**
 * The visible screen as **text**, with no escape sequences — the replay path
 * wants `-e` so the browser gets the colours, and anything that reads the screen
 * to answer a question wants the opposite, because a colour change lands
 * mid-line and every parse then has to strip it first.
 *
 * Here rather than in the caller because every tmux command goes through this
 * module; a second `capture-pane` argv built elsewhere is one without
 * `-f tether.conf`.
 */
export function capturePlainViewport(socket: string, target: string): Promise<string> {
  return run(socket, ['capture-pane', '-p', '-J', '-t', target]);
}

/** Columns and rows of a pane's grid. */
export interface PaneSize {
  cols: number;
  rows: number;
}

/**
 * The pane's exact grid. The attach PTY is sized to this and nothing else: a
 * client one row short makes tmux reflow the window and a line falls off the top
 * of the scrollback, silently (report section 3).
 */
export async function paneSize(socket: string, target: string): Promise<PaneSize> {
  const out = await run(socket, [
    'display-message',
    '-p',
    '-t',
    target,
    '#{pane_width}\x1f#{pane_height}',
  ]);
  const [cols, rows] = out.trim().split('\x1f').map(Number);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || !cols || !rows) {
    throw new Error(`unparseable pane size for ${target}: ${JSON.stringify(out)}`);
  }
  return { cols, rows };
}

/** Sizes tether accepts from a browser. Outside this tmux errors or misbehaves. */
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 1000;

/**
 * `window-size manual` (tether.conf) means an attaching client never changes the
 * window, which is what stops a phone resizing everybody else's pane. The flip
 * side is that a deliberate resize has to say so, and this is how.
 */
export async function resizeWindow(
  socket: string,
  target: string,
  cols: number,
  rows: number,
): Promise<void> {
  for (const n of [cols, rows]) {
    if (!Number.isInteger(n) || n < MIN_DIMENSION || n > MAX_DIMENSION) {
      throw new Error(`refusing to resize to ${cols}x${rows}: out of range`);
    }
  }
  await run(socket, ['resize-window', '-t', target, '-x', String(cols), '-y', String(rows)]);
}

/**
 * Force tmux to repaint every client attached to `session`. A repaint is the
 * absolutely-positioned resync a joining viewer needs; the first viewer gets one
 * for free from `attach-session`, later ones have to ask (report section 3).
 */
export async function refreshClients(socket: string, session: string): Promise<void> {
  checkSessionName(session);
  const out = await run(socket, ['list-clients', '-t', session, '-F', '#{client_tty}']);
  for (const tty of out.split('\n').filter((line) => line !== '')) {
    try {
      await run(socket, ['refresh-client', '-t', tty]);
    } catch (error) {
      // A phone can close its socket after `list-clients` and before this spawn.
      // That tty has nothing left to repaint; losing the viewer that is still
      // joining because a different one left in this gap is the actual failure.
      if (error instanceof TmuxError && /^can't find client:/.test(error.stderr)) continue;
      throw error;
    }
  }
}

/** A single global server option's value. The proof that `tether.conf` was read. */
export async function showOption(socket: string, name: string): Promise<string> {
  return (await run(socket, ['show-options', '-g', '-v', name])).trim();
}

/** Key names, e.g. `['Enter']`, `['C-c']`, `['Escape']`. Not literal text. */
export async function sendKeys(
  socket: string,
  target: string,
  keys: readonly string[],
): Promise<void> {
  await run(socket, ['send-keys', '-t', target, '--', ...keys]);
}

/**
 * Single-line literal text. **Not** for anything that may contain a line break:
 * `send-keys -l $'a\nb'` silently delivers `ab` (reproduced in report section 3),
 * and a bare `\r` reaches the pane as a carriage return, which a TUI reads as submit.
 * Use `pasteText` for message bodies.
 */
export async function sendText(socket: string, target: string, text: string): Promise<void> {
  if (/[\n\r]/.test(text)) {
    throw new Error('sendText drops newlines — use pasteText for multi-line input');
  }
  await run(socket, ['send-keys', '-t', target, '-l', '--', text]);
}

/**
 * Multi-line-safe text delivery: `load-buffer` + `paste-buffer -p -d` (bracketed
 * paste, buffer deleted after). Does *not* submit — send `Enter` as a separate
 * call, because Ink treats Enter in the same tmux invocation as a literal newline.
 *
 * Only `-d` deletes the buffer, so a failed paste — the target pane died between a
 * `listPanes` read and this call — has to delete it explicitly: a named buffer is
 * exempt from `buffer-limit` and would hold the message text for the life of the
 * server.
 */
export async function pasteText(socket: string, target: string, text: string): Promise<void> {
  const buffer = `tether-${randomUUID()}`;
  await run(socket, ['load-buffer', '-b', buffer, '-'], text);
  try {
    await run(socket, ['paste-buffer', '-b', buffer, '-t', target, '-p', '-d']);
  } catch (error) {
    await run(socket, ['delete-buffer', '-b', buffer]).catch(() => {});
    throw error;
  }
}
