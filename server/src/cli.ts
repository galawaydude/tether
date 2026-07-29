#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { databasePath, openDatabase } from './db.ts';
import {
  DEFAULT_PROVIDER,
  type Session,
  createSession,
  getSession,
  listSessions,
  markDead,
  openRegistry,
  reconcileWithTmux,
} from './machine/registry.ts';
import {
  DEFAULT_SOCKET,
  isSessionGone,
  killSession,
  newSession,
  resolveCwd,
} from './machine/tmux.ts';
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

export type ServeConfig = {
  host: string;
  port: number;
  allowedHosts: Set<string>;
  trustedProxies: string[];
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
  };
}

export function formatBanner(config: ServeConfig, hasPassword: boolean): string {
  const shown = config.host.includes(':') ? `[${config.host}]` : config.host;
  return [
    `tether listening on http://${shown}:${config.port}`,
    `  password:      ${hasPassword ? 'set' : 'NOT SET — every login will fail'}`,
    `  allowed hosts: ${[...config.allowedHosts].join(', ')}`,
    `  trusted proxies: ${config.trustedProxies.length > 0 ? config.trustedProxies.join(', ') : 'none (X-Forwarded-* ignored)'}`,
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

async function serve(auth: AuthStore, args: ServeArgs): Promise<number> {
  const hasPassword = auth.hasPassword();
  let config: ServeConfig;
  try {
    config = resolveServeConfig(args, hasPassword);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  const app = buildServer({
    auth,
    allowedHosts: config.allowedHosts,
    trustedProxies: config.trustedProxies,
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

/**
 * What `tether new` starts when no explicit command is given. A `Map` rather than
 * an object literal so `--provider constructor` is an unknown provider and not
 * `Object.prototype`'s member.
 */
const PROVIDER_COMMANDS = new Map<string, readonly string[]>([[DEFAULT_PROVIDER, ['claude']]]);

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

  const provider = values.provider ?? DEFAULT_PROVIDER;
  const run = command?.length ? command : PROVIDER_COMMANDS.get(provider);
  if (run === undefined) {
    throw new Error(`unknown provider ${provider} — pass the command after \`--\``);
  }

  // The one cwd validation in tether lives in the tmux driver; this is a call to
  // it, not a second copy. Doing it before anything is created means a bad
  // directory leaves no tmux session and no row.
  const cwd = await resolveCwd(dir);
  const id = randomUUID();
  const tmuxName = `tether-${id.slice(0, 8)}`;

  await newSession(socket, { name: tmuxName, cwd, command: run });
  try {
    // Provisional from spawn: provider_session_id is null here and is back-filled
    // once the provider creates its own session identity.
    createSession(db, { id, provider, cwd, title: values.title ?? basename(cwd), tmuxName });
  } catch (error) {
    // A session tmux is running that the registry does not know about is invisible
    // garbage — nothing would ever list it, let alone kill it.
    await killSession(socket, tmuxName).catch(() => {});
    throw error;
  }
  return `${id}\t${tmuxName}\t${cwd}`;
}

async function killCommand(db: DatabaseSync, argv: readonly string[]): Promise<string> {
  const id = argv[0];
  if (id === undefined || argv.length > 1) throw new Error(USAGE);
  const session = getSession(db, id);
  if (session === undefined) throw new Error(`no such session: ${id}`);
  // Already-gone is the postcondition, not an error — but only already-gone. Any
  // other tmux failure leaves the pane running, so it must not be reported as a
  // kill and must not record a row dead that nothing ever revives.
  await killSession(socket, session.tmuxName).catch((error: unknown) => {
    if (!isSessionGone(error)) throw error;
  });
  markDead(db, session.id);
  return `killed ${session.id}`;
}

/**
 * `ls` and `kill` reconcile against real tmux first, so neither ever reports a
 * session that died while tether was not running. `new` has nothing to reconcile.
 */
async function registryCommand(command: string, argv: readonly string[]): Promise<number> {
  const db = openRegistry();
  try {
    if (command === 'new') {
      process.stdout.write(`${await newCommand(db, argv)}\n`);
      return 0;
    }
    await reconcileWithTmux(db, socket);
    const output = command === 'ls' ? format(listSessions(db)) : await killCommand(db, argv);
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
  if (command === 'ls' || command === 'new' || command === 'kill') {
    return registryCommand(command, rest);
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

  const db = openDatabase();
  const auth = createAuthStore(db);

  switch (command) {
    case 'set-password':
      return setPassword(auth);
    case 'serve':
      return serve(auth, {
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
