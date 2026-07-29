import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { setTimeout as delay } from 'node:timers/promises';

import type { AuthStore } from './auth.ts';
import { isHostAllowed, isOriginAllowed, isStateChanging } from './guards.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Reachable without a session. Everything else is denied by default. */
    public?: boolean;
  }
}

export const SESSION_COOKIE = 'tether_session';

export type ServerOptions = {
  auth: AuthStore;
  /** Accepted `Host` header hostnames — see `defaultAllowedHosts`. */
  allowedHosts: Iterable<string>;
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
    logger: false,
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

  // ── Host allowlist and Origin guard, before anything else touches a request ──
  app.addHook('onRequest', async (request, reply) => {
    if (!isHostAllowed(request.headers.host, allowedHosts)) {
      return reply.code(403).send({ error: 'forbidden_host' });
    }
    if (
      isStateChanging(request.method) &&
      !isOriginAllowed(request.headers.origin, request.headers.host)
    ) {
      return reply.code(403).send({ error: 'forbidden_origin' });
    }
    return undefined;
  });

  // ── Default deny. A route is reachable only if it opts out explicitly. ──
  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions.config.public === true) return undefined;
    const token = request.cookies[SESSION_COOKIE];
    if (token !== undefined && auth.validateSession(token)) return undefined;
    return reply.code(401).send({ error: 'unauthorized' });
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

  function recordFailure(ip: string, now: number): void {
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

      await delay(loginDelayMs);

      if (!auth.verifyPassword(request.body.password)) {
        recordFailure(request.ip, now);
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

  return app;
}
