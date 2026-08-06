#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { databasePath, stateDir } from './db.ts';
import { accessHealthy, formatAccessReport, inspectAccess } from './machine/access.ts';
import { writeHookEndpoint } from './providers/permission.ts';
import {
  DEFAULT_PROVIDER,
  type Session,
  getSession,
  listSessions,
  openRegistry,
  reconcileWithTmux,
} from './machine/registry.ts';
import {
  reconcileProviderHooks,
  resumeSession,
  startSession,
  stopSession,
} from './machine/sessions.ts';
import { funnelHost } from './machine/tailscale.ts';
import { PtyUnavailableError, createTerminals, loadPty } from './machine/terminal.ts';
import {
  HOOK_EVENTS,
  type HookStatus,
  hookStatus,
  installHook,
  PERMISSION_TIMEOUT_SECONDS,
  removeHook,
} from './providers/codex/hooks.ts';
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

const USAGE = `Remote Control Agent — remote control for persistent coding-agent sessions

Usage:
  rcagent set-password [--if-unset] Set the single account's password (prompts; never echoes).
                                    --if-unset leaves an existing one alone, for installers.
  rcagent serve [options]           Run the server
  rcagent ls                        List this machine's sessions, live and dead
  rcagent new <dir> [options]       Start a session in <dir>
  rcagent kill <id>                 Kill a session; <id> is any unambiguous id prefix
  rcagent resume <id>               Resume a dead session, keeping its conversation
  rcagent access status             Check the browser-only Funnel URL end to end
  rcagent codex-hook <action>       Manage the Codex hook: status | install | remove

Options for serve:
  --port <n>                       Port to listen on (default ${DEFAULT_PORT})
  --host <addr>                    Address to bind (default ${DEFAULT_HOST}, loopback only).
                                   Binding off-loopback requires a password to be set.
  --funnel                         Serve behind Tailscale Funnel: stay on loopback, ask
                                   Tailscale for this machine's own name, and trust what
                                   Funnel forwards. PUBLISHES THIS MACHINE ON THE
                                   INTERNET; requires a password. Turn Funnel itself on
                                   with \`sudo tailscale funnel --bg <port>\`.
  --allowed-host <name>            Extra hostname accepted in the Host header; repeatable.
                                   Needed for a Tailscale name or a reverse proxy.
  --trusted-proxy <ip|cidr>        Believe X-Forwarded-* from this peer; repeatable.
  RCAGENT_LOG_LEVEL=<level>        Environment, not a flag: the server's log level, on
                                   stderr. Default warn — every failure, none of the
                                   request chatter; info adds the request log.

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
    'Remote Control Agent is about to add one entry to your Codex hooks file:',
    '',
    `  file:    ${hooksPath}`,
    `  command: ${shimPath}`,
    `  events:  ${HOOK_EVENTS.join(', ')}`,
    '',
    'That command is a script Remote Control Agent writes. Codex runs it on each',
    'event, and it appends one JSON line under the app’s private state directory.',
    '',
    'On PermissionRequest — and on no other event — it also asks Remote Control',
    'Agent over loopback whether you have answered the prompt, and waits for you',
    'for as long as Remote Control Agent is configured to wait. It talks to nothing else and',
    'to nowhere else.',
    '',
    'Remote Control Agent needs it for two things: to know that a session is',
    '*waiting for you*, and to let you answer outside the terminal.',
    'Everything else — the conversation, the terminal, working and idle — is read',
    'from files Codex already writes.',
    '',
    'The next time you start Codex it will ask you to review and trust this hook.',
    'Declining is a perfectly good answer: you lose the live “waiting” badge and',
    'the Approve/Deny buttons, the prompt is still there in the terminal where it',
    'has always been, and Remote Control Agent will not ask again.',
    '',
    'Your existing hooks file is backed up first, and existing entries are kept.',
    'Undo any time with `rcagent codex-hook remove`.',
  ].join('\n');
}

/**
 * An installation tether wrote, and has since outgrown.
 *
 * Both halves matter and neither is guessed at: a shim whose bytes are not the
 * ones this tether writes cannot POST, and a `PermissionRequest` entry not
 * carrying {@link PERMISSION_TIMEOUT_SECONDS} is one `machine/conversations.ts`
 * refuses to hold a turn behind. Either way the badge still works and the
 * buttons cannot, which is a different sentence from "not installed" and needs
 * saying — once, here.
 */
function outdated(status: HookStatus): boolean {
  return (
    status.installed.length > 0 &&
    (!status.shimCurrent || status.permissionTimeout !== PERMISSION_TIMEOUT_SECONDS)
  );
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
        ? `Remote Control Agent’s hook was not in ${hooksPath}; nothing to remove.\n`
        : `Removed Remote Control Agent’s hook from ${hooksPath} (${removed.join(', ')}).\n`,
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
        // The refusal, said here rather than saved for the install that will
        // hit it: `not installed` on its own would be the wrong explanation.
        ...(before.unreadable === undefined ? [] : [`problem:     ${before.unreadable}`]),
        `features.hooks: ${before.featureEnabled ? 'true' : 'false — Codex will not run any hook until this is set'}`,
        '',
        'Without the hook Remote Control Agent still shows the conversation, terminal, and',
        'whether a session is working or idle, and a permission prompt is still',
        'answered in the terminal. The hook adds the live “waiting for you” badge',
        'and the Approve/Deny buttons, and nothing else.',
        // Only for an installation tether can see is out of date, and only here,
        // in a command the user typed. `not installed` is a supported answer and
        // gets nothing added to it — a user who declined on purpose is not
        // nagged, which the captain's decision forbids by name.
        ...(outdated(before)
          ? [
              '',
              'This installation is out of date, in a way Remote Control Agent can see:',
              // Two different facts, and only the first is about the script. The
              // second is tether declining to hold a turn the entry it can read
              // is not sized for — the script would carry an answer back fine.
              ...(before.shimCurrent
                ? []
                : ['  the hook script is an older one that cannot answer at all']),
              ...(before.permissionTimeout === PERMISSION_TIMEOUT_SECONDS
                ? []
                : [
                    `  its PermissionRequest entry says timeout ${before.permissionTimeout ?? 'nothing'}, not ${PERMISSION_TIMEOUT_SECONDS},`,
                    '  so Remote Control Agent will not hold a turn behind it',
                  ]),
              '',
              'It still reports that a session is waiting for you, but offers no',
              'Approve/Deny buttons; answer in the terminal as before. Run',
              '`rcagent codex-hook install` to update it. The conversation and terminal',
              'and working/idle are unaffected either way.',
            ]
          : []),
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
    if (result.added.length > 0) {
      process.stdout.write(
        `Added Remote Control Agent’s hook to ${result.hooksPath} (${result.added.join(', ')}).\n`,
      );
    }
    // Said out loud because it costs the user something: Codex hashes each entry,
    // so an entry tether corrected is one Codex will ask them to review again.
    if (result.updated.length > 0) {
      process.stdout.write(
        [
          `Corrected the timeout on Remote Control Agent’s existing entry (${result.updated.join(', ')}).`,
          'Codex will ask you to review that entry once more, because its contents',
          'changed. This is a one-off: the values Remote Control Agent writes are fixed,',
          'so nothing here follows a setting and nothing will ask you again.',
        ].join('\n') + '\n',
      );
    }
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
        'Remote Control Agent changes no setting there — Codex also records',
        'which hooks you have trusted. The one thing it ever writes there is a',
        'folder you chose to trust in the New session sheet, and it backs the file',
        'up first.',
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
  /** Where a session may start — home unless `RCAGENT_ALLOWED_ROOTS` widens it. */
  allowedRoots: readonly string[];
  /** This machine's own `.ts.net` name, when `--funnel` asked Tailscale for it. */
  funnelHost?: string | undefined;
};

export type ServeArgs = {
  host?: string | undefined;
  port?: string | undefined;
  allowedHosts?: readonly string[] | undefined;
  trustedProxies?: readonly string[] | undefined;
  /**
   * The machine's `.ts.net` name — already derived, because deriving it spawns
   * `tailscale` and this function is pure. `undefined` is "no `--funnel`".
   */
  funnelHost?: string | undefined;
};

/** What Funnel connects from, having terminated TLS at Tailscale's edge. */
const FUNNEL_PROXY = '127.0.0.1';

/**
 * Loopback is the default and binding anywhere else is an explicit act that
 * refuses to happen without a password (report §7). No silent `0.0.0.0`.
 *
 * `--funnel` is the third case, and it is the reason the password check below
 * is not written as "off-loopback": it *stays* on loopback and is nonetheless
 * the most exposed thing tether can be, because Funnel is in front of it. The
 * shape it composes was established by putting a header echo behind a real
 * Funnel (see README): the request arrives from the proxy target's own address,
 * carrying `Host: <name>.ts.net` with no port and `X-Forwarded-Proto: https`.
 * So binding {@link FUNNEL_PROXY} makes the port unreachable from anywhere but
 * this machine — which is what makes trusting that proxy's `X-Forwarded-*` safe
 * — and the derived name is what the browser will send as `Host`.
 */
export function resolveServeConfig(args: ServeArgs, hasPassword: boolean): ServeConfig {
  const funnel = args.funnelHost;
  if (funnel !== undefined && args.host !== undefined) {
    throw new Error('--funnel binds loopback and sets the address itself; drop --host.');
  }
  const host = funnel !== undefined ? FUNNEL_PROXY : (args.host ?? DEFAULT_HOST);
  // An empty --host would reach `listen` as "bind every interface", silently.
  if (host.trim() === '') throw new Error(`invalid --host ${JSON.stringify(args.host)}`);
  const port = args.port === undefined ? DEFAULT_PORT : Number(args.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --port ${JSON.stringify(args.port)}`);
  }
  if (!hasPassword) {
    // Two exposures, two sentences, one rule: nothing reachable from off this
    // machine starts without a password. Funnel's is the louder one because
    // what it is reachable from is everyone.
    if (funnel !== undefined) {
      throw new Error(
        'refusing to publish this machine on the internet: no password is set.\n' +
          `--funnel would put a shell behind https://${funnel}/ with nothing in front of it.\n` +
          'Run `rcagent set-password` first.',
      );
    }
    if (!isLoopbackHost(host)) {
      throw new Error(
        `refusing to bind ${host}: no password is set, and binding off-loopback exposes a shell.\n` +
          'Run `rcagent set-password` first.',
      );
    }
  }
  return {
    host,
    port,
    allowedHosts: defaultAllowedHosts(host, [
      ...(funnel === undefined ? [] : [funnel]),
      ...(args.allowedHosts ?? []),
    ]),
    trustedProxies: [
      ...(funnel === undefined ? [] : [FUNNEL_PROXY]),
      ...(args.trustedProxies ?? []),
    ],
    allowedRoots: allowedRoots(),
    funnelHost: funnel,
  };
}

export function formatBanner(config: ServeConfig, hasPassword: boolean): string {
  const shown = config.host.includes(':') ? `[${config.host}]` : config.host;
  return [
    `Remote Control Agent listening on http://${shown}:${config.port}`,
    // First, above the settings, because on a Funnel run it is the address that
    // matters and the bind address is an implementation detail of it.
    ...(config.funnelHost === undefined
      ? []
      : [
          `  public URL:    https://${config.funnelHost}/`,
          // Funnel is a machine-wide setting tether does not own and never turns
          // on (it needs root), so the URL above is only live once this has been
          // run once — by `install.sh`, or by hand. Said every time rather than
          // guessed at: a banner that claims a link is up when it is not is the
          // one thing this line must never do.
          `                 (live once \`sudo tailscale funnel --bg ${config.port}\` has been run once)`,
        ]),
    `  password:      ${hasPassword ? 'set' : 'NOT SET — every login will fail'}`,
    `  allowed hosts: ${[...config.allowedHosts].join(', ')}`,
    `  trusted proxies: ${config.trustedProxies.length > 0 ? config.trustedProxies.join(', ') : 'none (X-Forwarded-* ignored)'}`,
    `  session roots: ${config.allowedRoots.join(', ')}`,
  ].join('\n');
}

/**
 * What this bind exposes, said plainly and then kept being said. tether
 * implements no TLS by design (report §7 delegates it to Tailscale, SSH or a
 * reverse proxy), so an off-loopback bind is plaintext until the operator puts
 * something in front of it — and a Funnel bind is the opposite problem: the
 * transport is fine and the *audience* is the internet.
 *
 * Funnel's sentence is not softer for being the recommended path. It is the one
 * configuration where getting it wrong is unrecoverable by the reader's own
 * network, so it names the address, what reaching it is worth, and how to stop.
 */
export function offLoopbackWarning(config: ServeConfig): string | null {
  if (config.funnelHost !== undefined) {
    return [
      `!! Remote Control Agent is on the public internet at https://${config.funnelHost}/`,
      '!! Anyone who opens that address and knows the password gets a shell on this machine.',
      '!! The address is not a secret: its certificate is in the public transparency logs.',
      '!! `sudo tailscale funnel --bg off` takes it down.',
    ].join('\n');
  }
  if (isLoopbackHost(config.host)) return null;
  return [
    '!! Remote Control Agent is bound off-loopback and serves plain HTTP.',
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

async function serve(
  db: DatabaseSync,
  auth: AuthStore,
  args: ServeArgs & { funnel?: boolean | undefined },
): Promise<number> {
  const hasPassword = auth.hasPassword();
  let config: ServeConfig;
  try {
    // Asked of Tailscale rather than of the user: the name is discoverable, and
    // a hand-typed one that is wrong fails as a 403 with no clue why. A refusal
    // here is a precondition the user can fix, so it prints its own sentence and
    // exits — `funnelHost` has already written the only useful one.
    config = resolveServeConfig(
      { ...args, funnelHost: args.funnel === true ? await funnelHost() : undefined },
      hasPassword,
    );
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

  // Written after `listen`, so it names a port that is actually bound. The shim
  // reads it at hook time, which is what lets a session spawned under one
  // `tether serve` reach the next one. Always loopback: `/internal/hook` refuses
  // anything else, and a server bound *only* to a non-loopback address simply
  // gets no hooks — the same as no server at all, which the shim already
  // survives silently.
  await writeHookEndpoint(stateDir(), `http://127.0.0.1:${config.port}/internal/hook`);

  // Beside the endpoint, and for the same reason: the world changed under panes
  // that are still running. That rewrites where the shim posts; this brings the
  // settings-file `timeout` back into step with the hold this process was
  // started with. It updates tether's own entry and never adds one — see
  // `reconcileProviderHooks` for why the two must never disagree, and for why
  // reconciling is not installing.
  await reconcileProviderHooks(db, socket);

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
const socket =
  process.env['RCAGENT_TMUX_SOCKET'] ?? process.env['TETHER_TMUX_SOCKET'] ?? DEFAULT_SOCKET;

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

  // Read-only and independent of the registry: this asks the actual proxy, the
  // loopback origin and the public URL rather than reporting a saved setup as
  // though it were still alive.
  if (command === 'access') {
    if (rest.length !== 1 || rest[0] !== 'status') {
      process.stderr.write(USAGE);
      return 1;
    }
    try {
      const report = await inspectAccess();
      process.stdout.write(`${formatAccessReport(report)}\n`);
      return accessHealthy(report) ? 0 : 1;
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
        funnel: { type: 'boolean' },
        'allowed-host': { type: 'string', multiple: true },
        'trusted-proxy': { type: 'string', multiple: true },
        // `set-password`'s, so `install.sh` can re-run end to end without
        // asking again for a password that is already set.
        'if-unset': { type: 'boolean' },
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
      if (values['if-unset'] === true && auth.hasPassword()) {
        process.stdout.write('A password is already set; leaving it alone.\n');
        return 0;
      }
      return setPassword(auth);
    case 'serve':
      return serve(db, auth, {
        host: values.host,
        port: values.port,
        funnel: values.funnel,
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
