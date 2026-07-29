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
import { join, resolve } from 'node:path';

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

/** An argument tmux's own lexer would read as a command separator rather than data. */
export class UnsafeArgumentError extends Error {
  constructor(arg: string) {
    super(`argument ${JSON.stringify(arg)} is a tmux command separator, not data`);
    this.name = 'UnsafeArgumentError';
  }
}

/**
 * tmux splits its argv on standalone `;`, `{` and `}` before any command sees them:
 * `new-session -- sleep 1 ';' kill-server` runs kill-server. Embedded separators
 * (`a;b`, `$USER`, `#{pane_id}`) are passed through literally and are safe.
 */
const SEPARATORS = new Set([';', '{', '}']);

function checkArgs(args: readonly string[]): void {
  for (const arg of args) if (SEPARATORS.has(arg)) throw new UnsafeArgumentError(arg);
}

/** tmux rejects `:` and `.` in session names — they are its target syntax. */
function checkSessionName(name: string): void {
  if (name === '' || /[:.\s]/.test(name)) {
    throw new Error(`invalid tmux session name ${JSON.stringify(name)}`);
  }
}

function run(socket: string, args: readonly string[], input?: string): Promise<string> {
  const argv = ['-L', socket, '-f', TMUX_CONF, ...args];
  return new Promise((fulfil, reject) => {
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

/**
 * Resolve a caller-supplied working directory and require it to be an existing
 * directory. Returns the real path — symlinks resolved — which is what gets passed
 * to tmux.
 *
 * The configurable root confinement from report section 7 lands with the API in
 * PR #5 and belongs here, right after the realpath: this is the only place a cwd
 * enters the system, and realpath is what makes a root check meaningful.
 */
export async function resolveCwd(cwd: string): Promise<string> {
  const absolute = resolve(cwd);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch (error) {
    throw new InvalidCwdError(absolute, `does not exist (${(error as Error).message})`);
  }
  if (!(await stat(real)).isDirectory()) throw new InvalidCwdError(real, 'not a directory');
  return real;
}

/**
 * Create a detached session running `command` (argv, executed directly — there is no
 * shell in this path). Returns the resolved working directory it was started in.
 */
export async function newSession(
  socket: string,
  opts: { name: string; cwd: string; command: readonly string[] },
): Promise<string> {
  checkSessionName(opts.name);
  checkArgs(opts.command);
  if (opts.command.length === 0) throw new Error('newSession requires a command');
  const cwd = await resolveCwd(opts.cwd);
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
  checkArgs(keys);
  await run(socket, ['send-keys', '-t', target, '--', ...keys]);
}

/**
 * Single-line literal text. **Not** for anything that may contain a newline:
 * `send-keys -l $'a\nb'` silently delivers `ab` (reproduced in report section 3).
 * Use `pasteText` for message bodies.
 */
export async function sendText(socket: string, target: string, text: string): Promise<void> {
  if (text.includes('\n')) {
    throw new Error('sendText drops newlines — use pasteText for multi-line input');
  }
  await run(socket, ['send-keys', '-t', target, '-l', '--', text]);
}

/**
 * Multi-line-safe text delivery: `load-buffer` + `paste-buffer -p -d` (bracketed
 * paste, buffer deleted after). Does *not* submit — send `Enter` as a separate
 * call, because Ink treats Enter in the same tmux invocation as a literal newline.
 */
export async function pasteText(socket: string, target: string, text: string): Promise<void> {
  const buffer = `tether-${randomUUID()}`;
  await run(socket, ['load-buffer', '-b', buffer, '-'], text);
  await run(socket, ['paste-buffer', '-b', buffer, '-t', target, '-p', '-d']);
}
