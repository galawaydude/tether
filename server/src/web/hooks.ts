/**
 * `POST /internal/hook` — where tether's Claude Code shim delivers a hook.
 *
 * This is the only route besides `/api/login` and the two static ones that opts
 * out of the session cookie, and it is worth being explicit about why that is
 * safe. It is not unauthenticated: it is authenticated *differently*, by a
 * secret the caller can only have by reading a `0600` file inside tether's own
 * `0700` state directory. A browser cannot do that, and a local process that can
 * already has the user's uid.
 *
 * Three independent gates, and none of them is the cookie:
 *
 * 1. **Loopback only**, checked against the real peer address rather than
 *    `request.ip` — with `trustProxy` on, `request.ip` is whatever
 *    `X-Forwarded-For` said, and a forwarded header must never be able to
 *    present itself as a local process.
 * 2. **The shared secret**, compared in constant time.
 * 3. **A session that exists**, resolved from the payload's own `session_id`.
 *    This is the per-session authorisation: a valid secret does not let a caller
 *    say anything about a session tether does not have a live row for.
 *
 * The `Host` allowlist and the Origin guard in `server.ts` run on `onRequest`,
 * before any of this, so they cover this route too — a cross-origin page's POST
 * is refused there and never reaches the secret comparison.
 *
 * The reply is always empty. On `PreToolUse` a hook's **stdout** is how it
 * allows or denies the tool call; answering the prompt is PR #14's, so until
 * then tether says nothing that could be mistaken for a decision. The shim does
 * not read the body at all — this is belt and braces on the side that would be
 * dangerous to get wrong later.
 */

import { timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';

import { stateDir as defaultStateDir } from '../db.ts';
import type { Conversations } from '../machine/conversations.ts';
import { adoptProviderSessionId, getSessionByProviderSessionId } from '../machine/registry.ts';
import { readHookSecret } from '../providers/claude-code/hooks.ts';

/**
 * The payload is Claude Code's, not tether's, and it ships weekly. Only that it
 * is an object is asserted here; `mapHook` reads the fields it knows and warns
 * about the rest, by the same tolerant rule as the transcript mapper.
 */
const HOOK_SCHEMA = { body: { type: 'object' } } as const;

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  // Node reports an IPv4 peer on a dual-stack socket as `::ffff:127.0.0.1`.
  const plain = address.replace(/^::ffff:/i, '').toLowerCase();
  return plain === '::1' || /^127(\.\d{1,3}){3}$/.test(plain);
}

/** Constant-time, and length-safe: `timingSafeEqual` throws on a length mismatch. */
function secretMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerHookRoute(
  app: FastifyInstance,
  db: DatabaseSync,
  conversations: Conversations,
  options: { stateDir?: string } = {},
): void {
  const stateDir = options.stateDir ?? defaultStateDir();

  app.post(
    '/internal/hook',
    { config: { public: true }, schema: HOOK_SCHEMA },
    async (request, reply) => {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        return reply.code(403).send();
      }

      // Read per request rather than captured at registration: `installHook`
      // creates the secret, and a server that started before the first session
      // would otherwise hold `undefined` for its whole life.
      const secret = await readHookSecret(stateDir);
      if (secret === undefined || !secretMatches(request.headers['x-tether-hook'], secret)) {
        return reply.code(401).send();
      }

      const payload = request.body as Record<string, unknown>;
      const providerSessionId = payload['session_id'];
      const cwd = payload['cwd'];
      if (typeof providerSessionId !== 'string' || providerSessionId === '') {
        return reply.code(204).send();
      }

      // The usual join, and then the one that covers a session whose transcript
      // has not been discovered yet — which is exactly the *first* tool call,
      // since `PreToolUse` can precede the transcript's first flush.
      const session =
        getSessionByProviderSessionId(db, providerSessionId) ??
        (typeof cwd === 'string' ? adoptProviderSessionId(db, cwd, providerSessionId) : undefined);
      // A hook for a session tether does not know is not an error. Claude Code
      // is commonly run by hand in a directory tether once managed, and the shim
      // stays installed in that project afterwards.
      if (session === undefined) return reply.code(204).send();

      conversations.hook(session, payload);
      return reply.code(204).send();
    },
  );
}
