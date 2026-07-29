#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { databasePath, openDatabase } from './db.ts';
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

Options for serve:
  --port <n>                       Port to listen on (default ${DEFAULT_PORT})
  --host <addr>                    Address to bind (default ${DEFAULT_HOST}, loopback only).
                                   Binding off-loopback requires a password to be set.
  --allowed-host <name>            Extra hostname accepted in the Host header; repeatable.
                                   Needed for a Tailscale name or a reverse proxy.
  --trusted-proxy <ip|cidr>        Believe X-Forwarded-* from this peer; repeatable.
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

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
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

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
  // `serve` keeps the event loop alive on its own; every other path is done here.
}
