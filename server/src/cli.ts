#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { databasePath, stateDir } from './db.ts';
import {
  DEFAULT_PROVIDER,
  type Session,
  getSession,
  listSessions,
  openRegistry,
  reconcileWithTmux,
} from './machine/registry.ts';
import { resumeSession, startSession, stopSession } from './machine/sessions.ts';
import { PtyUnavailableError, createTerminals, loadPty } from './machine/terminal.ts';
import { HOOK_EVENTS, hookStatus, installHook, removeHook } from './providers/codex/hooks.ts';
import { codexHome } from './providers/codex/spawn.ts';
import { DEFAULT_SOCKET, allowedRoots } from './machine/tmux.ts';
import { MIN_PASSWORD_LENGTH, createAuthStore } from './web/auth.ts';
import type { AuthStore } from './web/auth.ts';
import { defaultAllowedHosts, isLoopbackHost } from './web/guards.ts';
import { buildServer } from './web/server.ts';

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
/** The off-loopback warning is not a one-off: it repeats for as long as it is true. */
const WARN_INTERVAL_MS = 10 * 60 * 1000;

const USAGE = `tether — self-hosted control plane for coding-agent sessions

Usage:
  tether set-password              Set the single account's password (prompts; never echoes)
  tether serve [options]           Run the server
  tether ls                        List this machine's sessions, live and dead
  tether new <dir> [options]       Start a session in <dir>
  tether kill <id>                 Kill a session; <id> is any unambiguous id prefix
  tether resume <id>               Resume a dead session, keeping its conversation
  tether codex-hook <action>       Manage tether's Codex hook: status | install | remove

Options for serve:
  --port <n>                       Port to listen on (default ${DEFAULT_PORT})
  --host <addr>                    Address to bind (default ${DEFAULT_HOST}, loopback only).
                                   Binding off-loopback requires a password to be set.
  --allowed-host <name>            Extra hostname accepted in the Host header; repeatable.
                                   Needed for a Tailscale name or a reverse proxy.
  --trusted-proxy <ip|cidr>        Believe X-Forwarded-* from this peer; repeatable.

Options for new:
  --title <title>                  Session title (default: the directory's name)
  --provider <name>                Provider to start (default ${DEFAULT_PROVIDER})
  -- <command> [args...]           Run this instead of the provider's own command
`;

/**
 * What `tether codex-hook install` says *before* Codex's trust prompt appears.
 *
 * Explaining it beforehand is an obligation, not a courtesy: the prompt is a
 * security control on the user's own machine, and a user who accepts it because
 * a tool told them to has not made a decision. So this says exactly what is
 * being added, what it does, what it costs to say no, and how to undo it —
 * before anything is written.
 */
function codexHookExplanation(hooksPath: string, shimPath: string): string {
  return [
    'tether is about to add one entry to your Codex hooks file:',
    '',
    `  file:    ${hooksPath}`,
    `  command: ${shimPath}`,
    `  events:  ${HOOK_EVENTS.join(', ')}`,
    '',
    'That command is a script tether writes. On each of those events Codex runs it,',
    'and it appends one JSON line to a log under tether’s own state directory. It',
    'writes nothing else, reads nothing else, and talks to no network.',
    '',
    'tether needs it for exactly one thing: to know that a session is *waiting for',
    'you* to answer a permission prompt. Everything else — the conversation, the',
    'terminal, working and idle — is read from files Codex already writes.',
    '',
    'The next time you start Codex it will ask you to review and trust this hook.',
    'Declining is a perfectly good answer: you lose the live “waiting” badge and',
    'nothing else, and tether will not ask you again.',
    '',
    'Your existing hooks file is backed up first, and existing entries are kept.',
    'Undo any time with `tether codex-hook remove`.',
  ].join('\n');
}

/**
 * `status` | `install` | `remove`. Read-only by default: `tether codex-hook`
 * with no action reports and changes nothing, because a command that writes to
 * a file tether does not own should have to be asked for by name.
 */
async function codexHookCommand(argv: readonly string[]): Promise<number> {
  const action = argv[0] ?? 'status';
  if (argv.length > 1 || !['status', 'install', 'remove'].includes(action)) {
    process.stderr.write(USAGE);
    return 1;
  }
  const where = { codexHome: codexHome(), stateDir: stateDir() };

  if (action === 'remove') {
    const { hooksPath, removed } = await removeHook(where);
    process.stdout.write(
      removed.length === 0
        ? `tether’s hook was not in ${hooksPath}; nothing to remove.\n`
        : `Removed tether’s hook from ${hooksPath} (${removed.join(', ')}).\n`,
    );
    return 0;
  }

  const before = await hookStatus(where);
  if (action === 'status') {
    process.stdout.write(
      [
        `hooks file:  ${before.hooksPath}`,
        `hook script: ${before.shimPath}`,
        `registered:  ${before.installed.length > 0 ? before.installed.join(', ') : 'not installed'}`,
        `features.hooks: ${before.featureEnabled ? 'true' : 'false — Codex will not run any hook until this is set'}`,
        '',
        'Without the hook tether still shows the conversation, the terminal, and',
        'whether a session is working or idle. The hook adds the live “waiting for',
        'you” badge, and nothing else.',
      ].join('\n') + '\n',
    );
    return 0;
  }

  process.stdout.write(`${codexHookExplanation(before.hooksPath, before.shimPath)}\n\n`);
  const result = await installHook(where);
  if (result.alreadyInstalled) {
    process.stdout.write(`Already installed in ${result.hooksPath}; nothing changed.\n`);
  } else {
    if (result.backupPath !== undefined) {
      process.stdout.write(`Backed up ${result.hooksPath} to ${result.backupPath}\n`);
    }
    process.stdout.write(
      `Added tether’s hook to ${result.hooksPath} (${result.added.join(', ')}).\n`,
    );
  }
  if (!before.featureEnabled) {
    process.stdout.write(
      [
        '',
        'One thing left, and it is yours to do: Codex runs no hooks at all unless',
        `its config enables them. Add this to ${join(codexHome(), 'config.toml')}:`,
        '',
        '  [features]',
        '  hooks = true',
        '',
        'tether does not edit that file — it is also where Codex records which',
        'hooks you have trusted.',
      ].join('\n') + '\n',
    );
  }
  return 0;
}

export type ServeConfig = {
  host: string;
  port: number;
  allowedHosts: Set<string>;
  trustedProxies: string[];
  /** Where a session may be started — home unless `TETHER_ALLOWED_ROOTS` widens it. */
  allowedRoots: readonly string[];
};

export type ServeArgs = {
  host?: string | undefined;
  port?: string | undefined;
  allowedHosts?: readonly string[] | undefined;
  trustedProxies?: readonly string[] | undefined;
};

/**
 * Loopback is the default and binding anywhere else is an explicit act that
 * refuses to happen without a password (report §7). No silent `0.0.0.0`.
 */
export function resolveServeConfig(args: ServeArgs, hasPassword: boolean): ServeConfig {
  const host = args.host ?? DEFAULT_HOST;
  // An empty --host would reach `listen` as "bind every interface", silently.
  if (host.trim() === '') throw new Error(`invalid --host ${JSON.stringify(args.host)}`);
  const port = args.port === undefined ? DEFAULT_PORT : Number(args.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --port ${JSON.stringify(args.port)}`);
  }
  if (!isLoopbackHost(host) && !hasPassword) {
    throw new Error(
      `refusing to bind ${host}: no password is set, and binding off-loopback exposes a shell.\n` +
        'Run `tether set-password` first.',
    );
  }
  return {
    host,
    port,
    allowedHosts: defaultAllowedHosts(host, args.allowedHosts ?? []),
    trustedProxies: [...(args.trustedProxies ?? [])],
    allowedRoots: allowedRoots(),
  };
}

export function formatBanner(config: ServeConfig, hasPassword: boolean): string {
  const shown = config.host.includes(':') ? `[${config.host}]` : config.host;
  return [
    `tether listening on http://${shown}:${config.port}`,
    `  password:      ${hasPassword ? 'set' : 'NOT SET — every login will fail'}`,
    `  allowed hosts: ${[...config.allowedHosts].join(', ')}`,
    `  trusted proxies: ${config.trustedProxies.length > 0 ? config.trustedProxies.join(', ') : 'none (X-Forwarded-* ignored)'}`,
    `  session roots: ${config.allowedRoots.join(', ')}`,
  ].join('\n');
}

/**
 * tether implements no TLS by design (report §7 delegates it to Tailscale, SSH
 * or a reverse proxy), so an off-loopback bind is plaintext until the operator
 * puts something in front of it. Say so, loudly, and keep saying it.
 */
export function offLoopbackWarning(config: ServeConfig): string | null {
  if (isLoopbackHost(config.host)) return null;
  return [
    '!! tether is bound off-loopback and serves plain HTTP.',
    '!! Anyone who reaches this port and knows the password gets a shell on this machine.',
    '!! Put it behind Tailscale, `ssh -L`, or a TLS reverse proxy — see README.',
  ].join('\n');
}

/** Reads a secret from the terminal without echoing it, or from piped stdin. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').split('\n')[0]?.replace(/\r$/, '') ?? '';
  }
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk as Buffer, encoding);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = new Promise<string>((resolve) => rl.question(prompt, resolve));
    muted = true;
    return await answer;
  } finally {
    muted = false;
    rl.close();
    process.stdout.write('\n');
  }
}

async function setPassword(auth: AuthStore): Promise<number> {
  const password = await readSecret('New password: ');
  if (password.length < MIN_PASSWORD_LENGTH) {
    // The password itself is never echoed back, not even in an error.
    process.stderr.write(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.\n`);
    return 1;
  }
  if (process.stdin.isTTY) {
    const again = await readSecret('Confirm password: ');
    if (again !== password) {
      process.stderr.write('Passwords did not match.\n');
      return 1;
    }
  }
  await auth.setPassword(password);
  process.stdout.write(`Password set in ${databasePath()}. Existing sessions were revoked.\n`);
  return 0;
}

async function serve(db: DatabaseSync, auth: AuthStore, args: ServeArgs): Promise<number> {
  const hasPassword = auth.hasPassword();
  let config: ServeConfig;
  try {
    config = resolveServeConfig(args, hasPassword);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  // Checked before listening rather than on the first attach: node-pty ships no
  // Linux prebuild, so a `npm ci` without a C++ toolchain leaves it unbuilt, and
  // a terminal that fails to open is the whole product failing. Say so as an
  // instruction, not as a stack trace out of an import.
  try {
    await loadPty();
  } catch (error) {
    if (!(error instanceof PtyUnavailableError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  const app = buildServer({
    auth,
    db,
    terminals: createTerminals(socket),
    allowedHosts: config.allowedHosts,
    trustedProxies: config.trustedProxies,
    socket,
    allowedRoots: config.allowedRoots,
  });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    process.stderr.write(
      `Could not listen on ${config.host}:${config.port} — ${(error as Error).message}\n`,
    );
    return 1;
  }

  process.stdout.write(`${formatBanner(config, hasPassword)}\n`);
  const warning = offLoopbackWarning(config);
  if (warning !== null) {
    process.stderr.write(`${warning}\n`);
    setInterval(() => process.stderr.write(`${warning}\n`), WARN_INTERVAL_MS).unref();
  }
  return 0;
}

// ── ls | new | kill: tether from a terminal, before any web UI exists ──

/** Tests point this at their own tmux server; nothing else sets it. */
const socket = process.env['TETHER_TMUX_SOCKET'] || DEFAULT_SOCKET;

function fixed(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

function format(sessions: readonly Session[]): string {
  const header = `${fixed('ID', 10)}${fixed('STATE', 6)}${fixed('PROVIDER', 14)}${fixed('TITLE', 24)}DIR`;
  const lines = sessions.map(
    (s) =>
      `${fixed(s.id.slice(0, 8), 10)}${fixed(s.deadAt === null ? 'live' : 'dead', 6)}` +
      `${fixed(s.provider, 14)}${fixed(s.title, 24)}${s.cwd}`,
  );
  return [header, ...lines].join('\n');
}

/**
 * Split the command to run off the front-matter. `parseArgs` folds everything past
 * `--` into positionals, which would make `tether new /dir -- sleep 300` and
 * `tether new /dir sleep 300` indistinguishable.
 */
function splitCommand(argv: readonly string[]): { args: string[]; command: string[] | null } {
  const at = argv.indexOf('--');
  if (at === -1) return { args: [...argv], command: null };
  return { args: argv.slice(0, at), command: argv.slice(at + 1) };
}

/**
 * `serve` parses its own flags with `allowPositionals: false`; `new` takes a
 * directory, its own options and a `--` terminator, so it parses its own slice.
 */
async function newCommand(db: DatabaseSync, argv: readonly string[]): Promise<string> {
  const { args, command } = splitCommand(argv);
  const { values, positionals } = parseArgs({
    args,
    options: { title: { type: 'string' }, provider: { type: 'string' } },
    allowPositionals: true,
  });
  const dir = positionals[0];
  if (dir === undefined || positionals.length > 1) throw new Error(USAGE);

  const session = await startSession(db, socket, {
    cwd: dir,
    title: values.title,
    provider: values.provider,
    command: command ?? undefined,
  });
  return `${session.id}\t${session.tmuxName}\t${session.cwd}`;
}

async function killCommand(db: DatabaseSync, argv: readonly string[]): Promise<string> {
  const id = argv[0];
  if (id === undefined || argv.length > 1) throw new Error(USAGE);
  const session = getSession(db, id);
  if (session === undefined) throw new Error(`no such session: ${id}`);
  await stopSession(db, socket, session);
  return `killed ${session.id}`;
}

async function resumeCommand(db: DatabaseSync, argv: readonly string[]): Promise<string> {
  const id = argv[0];
  if (id === undefined || argv.length > 1) throw new Error(USAGE);
  const session = getSession(db, id);
  if (session === undefined) throw new Error(`no such session: ${id}`);
  const resumed = await resumeSession(db, socket, session);
  return `resumed ${resumed.id}\t${resumed.tmuxName}\t${resumed.cwd}`;
}

/**
 * `ls`, `kill` and `resume` reconcile against real tmux first, so none of them ever
 * reports a session that died while tether was not running — and it is what makes a
 * session that died with the machine resumable rather than a row that merely looks
 * live. `new` has nothing to reconcile.
 */
async function registryCommand(command: string, argv: readonly string[]): Promise<number> {
  const db = openRegistry();
  try {
    if (command === 'new') {
      process.stdout.write(`${await newCommand(db, argv)}\n`);
      return 0;
    }
    await reconcileWithTmux(db, socket);
    const output =
      command === 'ls'
        ? format(listSessions(db))
        : command === 'resume'
          ? await resumeCommand(db, argv)
          : await killCommand(db, argv);
    process.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    db.close();
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  // Before the serve flag parsing below: these three take positionals, and `new`
  // needs a `--` terminator that `allowPositionals: false` would reject.
  if (command === 'ls' || command === 'new' || command === 'kill' || command === 'resume') {
    return registryCommand(command, rest);
  }

  // Touches no database and no tmux: it is one file in the user's Codex home
  // and one script in tether's own state directory.
  if (command === 'codex-hook') {
    try {
      return await codexHookCommand(rest);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  let values;
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        'allowed-host': { type: 'string', multiple: true },
        'trusted-proxy': { type: 'string', multiple: true },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  // One database, one schema: `serve` answers the session routes from the same file
  // the CLI's `ls` reads.
  const db = openRegistry();
  const auth = createAuthStore(db);

  switch (command) {
    case 'set-password':
      return setPassword(auth);
    case 'serve':
      return serve(db, auth, {
        host: values.host,
        port: values.port,
        allowedHosts: values['allowed-host'],
        trustedProxies: values['trusted-proxy'],
      });
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

/**
 * npm's bin links — `npx tether`, `node_modules/.bin/tether`, a global install —
 * run this file through a symlink. Node resolves `import.meta.url` through
 * symlinks but leaves `process.argv[1]` as given, so the two only compare equal
 * once argv[1] is resolved too. An argv[1] that no longer exists compares
 * unresolved rather than crashing the CLI.
 */
function resolveEntry(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolveEntry(entry)).href) {
  process.exitCode = await main(process.argv.slice(2));
  // `serve` keeps the event loop alive on its own; every other path is done here.
}
