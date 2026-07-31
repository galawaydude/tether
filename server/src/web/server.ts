import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

import { Conversations } from '../machine/conversations.ts';
import type { Terminals } from '../machine/terminal.ts';
import type { AuthStore } from './auth.ts';
import { registerConvSocket, registerConversationRoutes } from './conversation.ts';
import { isHostAllowed, isOriginAllowed, isStateChanging } from './guards.ts';
import { registerHookRoute } from './hooks.ts';
import type { TrustLocations } from '../providers/trust.ts';
import { registerSessionRoutes } from './sessions.ts';
import { registerStatic } from './static.ts';
import { registerTermSocket } from './term-socket.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Reachable without a session. Everything else is denied by default. */
    public?: boolean;
  }
}

export const SESSION_COOKIE = 'tether_session';

export type ServerOptions = {
  auth: AuthStore;
  /** The registry database (the same file the auth store uses). */
  db: DatabaseSync;
  /** Backs the `term` WebSocket channel. */
  terminals: Terminals;
  /** Backs the conversation routes. Tests point it at a transcript of their own. */
  conversations?: Conversations;
  /** Accepted `Host` header hostnames — see `defaultAllowedHosts`. */
  allowedHosts: Iterable<string>;
  /** tmux socket the session routes drive. Tests point this at their own. */
  socket?: string | undefined;
  /** Directories a session may be started in; defaults to `allowedRoots()`. */
  allowedRoots?: readonly string[] | undefined;
  /**
   * Where the providers keep folder trust; defaults to their real locations.
   * Tests point it at scratch homes, so nothing reads or writes the developer's
   * own `.claude.json` or `config.toml`.
   */
  trustIn?: TrustLocations | undefined;
  /** Where the built browser app lives; defaults to `WEB_DIST`. */
  webRoot?: string | undefined;
  /** Where the hook secret lives; defaults to `stateDir()`. Tests point it away. */
  stateDir?: string | undefined;
  /**
   * IPs/CIDRs whose `X-Forwarded-Proto` and `X-Forwarded-For` are believed. Empty
   * means believe nobody, so a client header can never spoof the `Secure` flag.
   */
  trustedProxies?: readonly string[];
  /** Fixed per-attempt login delay. */
  loginDelayMs?: number;
  /** Failed logins per IP before that IP is locked out for `loginWindowMs`. */
  loginMaxFailures?: number;
  loginWindowMs?: number;
};

const DEFAULTS = {
  loginDelayMs: 250,
  loginMaxFailures: 10,
  loginWindowMs: 15 * 60 * 1000,
};

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

/**
 * **`warn`, not `false` and not `true`.** The server used to be built with the
 * logger off, so every `app.log.warn` in it — a terminal attach that threw, a
 * frame the argv guard refused — was written to nothing. The user got a badge
 * and the operator got silence, which cost one debugging session of about three
 * hours: turning the logger on by hand printed the exception immediately.
 *
 * `true` is the other wrong answer. Fastify logs every request and every reply
 * at `info`, and the browser polls the session list every 5 seconds, so an
 * operator would be reading two lines a tick for as long as a tab is open —
 * noise that gets switched off again, taking the failures with it. `warn` is the
 * level at which nothing routine is said and every failure is.
 *
 * `TETHER_LOG_LEVEL` is there for the debugging session that wants the request
 * log, and is validated rather than passed through: pino throws on a level it
 * does not know, and a typo in an env var must not be a server that will not
 * start.
 */
function logLevel(): string {
  const wanted = process.env['TETHER_LOG_LEVEL'];
  return wanted !== undefined && LOG_LEVELS.includes(wanted) ? wanted : 'warn';
}

const LOGIN_SCHEMA = {
  body: {
    type: 'object',
    required: ['password'],
    additionalProperties: false,
    properties: { password: { type: 'string', minLength: 1, maxLength: 1024 } },
  },
} as const;

/** Logout carries no data; anything sent with it is a mistake worth rejecting. */
const EMPTY_BODY_SCHEMA = {
  body: { type: ['object', 'null'], additionalProperties: false, properties: {} },
} as const;

/**
 * A WebSocket upgrade carries cookies but is a `GET`, so the Origin guard below
 * would skip it, and it is not a CORS request, so the browser will not stop it
 * either. Every other check it does get: `@fastify/websocket` dispatches the
 * upgrade through the normal router, so the Host allowlist and the default-deny
 * `preParsing` hook both run.
 */
function isUpgrade(request: FastifyRequest): boolean {
  return request.headers.upgrade?.toLowerCase() === 'websocket';
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const { auth } = options;
  const allowedHosts = new Set(options.allowedHosts);
  const trustedProxies = options.trustedProxies ?? [];
  const loginDelayMs = options.loginDelayMs ?? DEFAULTS.loginDelayMs;
  const loginMaxFailures = options.loginMaxFailures ?? DEFAULTS.loginMaxFailures;
  const loginWindowMs = options.loginWindowMs ?? DEFAULTS.loginWindowMs;

  const app = Fastify({
    // `false` means request.protocol is derived from the socket alone, so
    // X-Forwarded-Proto is ignored unless the operator named the proxy.
    trustProxy: trustedProxies.length > 0 ? [...trustedProxies] : false,
    // On stderr, where the rest of tether's diagnostics go: stdout is the
    // banner. See `logLevel` for why the default is `warn`.
    logger: { level: logLevel(), stream: process.stderr },
    ajv: {
      customOptions: {
        // Fastify's defaults silently repair a bad body: they strip unknown
        // properties and coerce types. On a trust boundary a malformed request
        // should be rejected, not quietly rewritten into a valid one.
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
      },
    },
  });

  app.register(cookie);
  app.register(websocket);

  // ── Host allowlist and Origin guard, before anything else touches a request ──
  app.addHook('onRequest', async (request, reply) => {
    if (!isHostAllowed(request.headers.host, allowedHosts)) {
      return reply.code(403).send({ error: 'forbidden_host' });
    }
    if (
      (isStateChanging(request.method) || isUpgrade(request)) &&
      !isOriginAllowed(request.headers.origin, request.headers.host)
    ) {
      return reply.code(403).send({ error: 'forbidden_origin' });
    }
    return undefined;
  });

  // ── Default deny. A route is reachable only if it opts out explicitly. ──
  // `preParsing`, not `preHandler`: it runs after the cookie plugin's onRequest
  // hook but before body parsing and schema validation, so an unauthenticated
  // caller can neither reach the body parser nor tell a real route from an
  // unmatched one by whether it answers 400 or 401.
  app.addHook('preParsing', async (request, reply) => {
    if (request.routeOptions.config.public === true) return undefined;
    const token = request.cookies[SESSION_COOKIE];
    if (token !== undefined && auth.validateSession(token)) return undefined;
    await reply.code(401).send({ error: 'unauthorized' });
    return undefined;
  });

  // Per-IP failed-login counter. A password on a LAN is otherwise brute-forceable.
  const failures = new Map<string, { count: number; resetAt: number }>();
  // ponytail: an attacker rotating source addresses grows this map; entries are
  // swept once it is large, which bounds it at roughly the number of distinct
  // IPs seen within one window. Swap for an LRU if that is ever a real number.
  const MAX_TRACKED_IPS = 10_000;

  function lockedUntil(ip: string, now: number): number | null {
    const entry = failures.get(ip);
    if (entry === undefined) return null;
    if (entry.resetAt <= now) {
      failures.delete(ip);
      return null;
    }
    return entry.count >= loginMaxFailures ? entry.resetAt : null;
  }

  /**
   * Counts an attempt as it starts, not its failure once verification returns:
   * otherwise N simultaneous requests all pass `lockedUntil` at count 0 and the
   * limit bounds sequential guesses only.
   */
  function recordAttempt(ip: string, now: number): void {
    const entry = failures.get(ip);
    if (entry === undefined || entry.resetAt <= now) {
      if (failures.size >= MAX_TRACKED_IPS) {
        for (const [key, value] of failures) if (value.resetAt <= now) failures.delete(key);
      }
      failures.set(ip, { count: 1, resetAt: now + loginWindowMs });
      return;
    }
    entry.count += 1;
  }

  /** `Secure` only when the request genuinely arrived over TLS (§7). */
  function cookieOptions(request: FastifyRequest, expiresAt: number) {
    return {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: request.protocol === 'https',
      expires: new Date(expiresAt),
    } as const;
  }

  app.post(
    '/api/login',
    { config: { public: true }, schema: LOGIN_SCHEMA },
    async (request: FastifyRequest<{ Body: { password: string } }>, reply: FastifyReply) => {
      const now = Date.now();
      const until = lockedUntil(request.ip, now);
      if (until !== null) {
        return reply
          .code(429)
          .header('retry-after', Math.ceil((until - now) / 1000))
          .send({ error: 'too_many_attempts' });
      }

      recordAttempt(request.ip, now);
      await delay(loginDelayMs);

      if (!(await auth.verifyPassword(request.body.password))) {
        return reply.code(401).send({ error: 'invalid_credentials' });
      }

      failures.delete(request.ip);
      const session = auth.createSession(now);
      return reply
        .setCookie(SESSION_COOKIE, session.token, cookieOptions(request, session.expiresAt))
        .code(200)
        .send({ ok: true });
    },
  );

  app.post('/api/logout', { schema: EMPTY_BODY_SCHEMA }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token !== undefined) auth.revokeSession(token);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });

  app.get('/api/session', async (_request, reply) => reply.send({ authenticated: true }));

  registerStatic(app, options.webRoot);

  // The same socket the session routes drive: both providers join to a registry
  // row by the tmux pane's pid — a Codex `SessionStart`, Claude Code's status
  // file — so discovery has to be asking the same tmux the sessions started on.
  // Built before those routes because the list reads its badges through it, so
  // that the re-bind after a `/resume` does not wait for a conversation viewer.
  const conversations =
    options.conversations ?? new Conversations(options.db, { socket: options.socket });

  // Behind the same default-deny hook as everything else — these routes opt out of
  // nothing, which is the whole point of the posture being deny-by-default.
  registerSessionRoutes(app, {
    db: options.db,
    conversations,
    socket: options.socket,
    allowedRoots: options.allowedRoots,
    trustIn: options.trustIn,
  });

  registerConversationRoutes(app, options.db, conversations);
  registerHookRoute(app, options.db, conversations, {
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
  });

  // In `after`, not inline: `@fastify/websocket` upgrades a route through an
  // `onRoute` hook it only installs once its own registration has run, and a
  // route added before that silently stays a plain HTTP route.
  app.after(() => {
    registerTermSocket(app, options.terminals, options.db, options.socket);
    registerConvSocket(app, options.db, conversations);
  });
  // Closing the server must take the attach PTYs and the transcript tailers with
  // it, or `npm test` leaves tmux clients behind and the process never exits.
  app.addHook('onClose', async () => {
    await conversations.closeAll();
    await options.terminals.closeAll();
  });

  return app;
}
