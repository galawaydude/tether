/**
 * `POST /internal/hook` — where either provider's shim delivers a hook.
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
 * 1. **Loopback only, and not proxied**, checked against the real peer address
 *    rather than `request.ip` — with `trustProxy` on, `request.ip` is whatever
 *    `X-Forwarded-For` said, and a forwarded header must never be able to
 *    present itself as a local process. The peer address alone stopped being
 *    the whole of that gate when Funnel became the documented default: Funnel
 *    proxies from `127.0.0.1`, so every request off the public internet arrives
 *    with a loopback peer and the check would admit the whole of it, leaving the
 *    secret as the only remaining gate. So a request carrying any of the four
 *    headers a real Funnel sets — `X-Forwarded-For`, `X-Forwarded-Host`,
 *    `X-Forwarded-Proto` and its own `Tailscale-Funnel-Request` marker, all
 *    captured off a live one — is refused here. The shim POSTs to `127.0.0.1`
 *    and sets none of them, and the failure direction is the safe one: a
 *    presence test can only refuse a local caller that volunteered a forwarded
 *    header, never admit a forwarded request, because Funnel always sets them.
 * 2. **The shared secret**, compared in constant time.
 * 3. **A session that exists**, resolved from the payload's own `session_id`.
 *    This is the per-session authorisation: a valid secret does not let a caller
 *    say anything about a session tether does not have a live row for. A row
 *    whose provider session id is unknown or out of date can be bound to this
 *    one here, but only where a pane tether spawned states that it is running
 *    that very session — `Conversations.bindProviderSession`.
 *
 * The `Host` allowlist and the Origin guard in `server.ts` run on `onRequest`,
 * before any of this, so they cover this route too — a cross-origin page's POST
 * is refused there and never reaches the secret comparison.
 *
 * The reply is empty except for one case: a call tether decided to hold — a
 * Claude Code `PreToolUse` or a Codex `PermissionRequest` — where the request
 * stays open until the user taps Approve or Deny in the conversation view and the
 * answer comes back as `{"decision":"allow"|"deny"}`. On both of those a hook's
 * **stdout** is how it allows or denies a tool call, so an empty reply is not a
 * neutral default that happens to be safe — it is the deliberate statement
 * "tether has nothing to say about this call", which leaves the provider's own
 * permission rules in charge. Which vocabulary a payload is read in is the
 * session row's `provider`, decided in `Conversations.hook`; this route reads
 * only `session_id`.
 *
 * Note what authorises that decision, because it is not this route. The secret
 * authenticates the *hook*; what authenticates the *answer* is the session
 * cookie on `POST /api/sessions/:id/permission`, which is default-denied like
 * every other route. A caller holding only the hook secret can propose a tool
 * call to tether and can wait for it, but cannot approve one.
 */

import { timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';

import { stateDir as defaultStateDir } from '../db.ts';
import type { Conversations } from '../machine/conversations.ts';
import { getSessionByProviderSessionId } from '../machine/registry.ts';
import { readHookSecret } from '../providers/permission.ts';

/**
 * The payload is the provider's, not tether's, and both ship weekly. Only that it
 * is an object is asserted here; each provider's `mapHook` reads the fields it
 * knows and warns about the rest, by the same tolerant rule as the transcript
 * mappers.
 */
const HOOK_SCHEMA = { body: { type: 'object' } } as const;

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  // Node reports an IPv4 peer on a dual-stack socket as `::ffff:127.0.0.1`.
  const plain = address.replace(/^::ffff:/i, '').toLowerCase();
  return plain === '::1' || /^127(\.\d{1,3}){3}$/.test(plain);
}

/**
 * What a reverse proxy adds and a local process does not. The first three are
 * every proxy's; the fourth is Tailscale Funnel's own marker.
 */
const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'tailscale-funnel-request',
] as const;

export function isProxied(headers: Record<string, unknown>): boolean {
  return PROXY_HEADERS.some((name) => headers[name] !== undefined);
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
      if (!isLoopbackAddress(request.socket.remoteAddress) || isProxied(request.headers)) {
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
      if (typeof providerSessionId !== 'string' || providerSessionId === '') {
        return reply.code(204).send();
      }

      // The usual join, and then the one that covers a session no row names yet
      // — the *first* tool call, since `PreToolUse` can precede the transcript's
      // first flush, and equally the first after a `/resume` moved the agent to
      // a session id nothing has recorded. `bindProviderSession` asks the panes
      // themselves; the payload's `cwd` is deliberately not consulted, because
      // two tether sessions in one directory report an identical one.
      const session =
        getSessionByProviderSessionId(db, providerSessionId) ??
        (await conversations.bindProviderSession(providerSessionId));
      // A hook for a session tether does not know is not an error. Either agent
      // is commonly run by hand — Claude Code in a directory tether once managed
      // with the shim still installed in that project, Codex anywhere at all,
      // since its hook is installed once per machine.
      if (session === undefined) return reply.code(204).send();

      // This is where the agent's turn waits. `hook` resolves as soon as the
      // user taps, and otherwise when its own hold expires — never later, so
      // the shim's abort and the provider's own `timeout` stay nets rather than
      // mechanisms (`providers/permission.ts`).
      //
      // Unless the caller leaves first, which is the other half of what an empty
      // reply means: tether must never show an answerable card for a decision
      // that cannot land. A shim killed by a provider timeout tether never
      // enumerated, a Ctrl-C'd pane, a killed agent and a provider tether has
      // not met are all one thing from here — the request dying — and that is
      // knowable without knowing whose timeout it was. The alternative is the
      // worst sentence this surface can say: *approved*, for a decision nothing
      // received. Shared on purpose, so it covers Claude Code's `PreToolUse`
      // hold as well as Codex's `PermissionRequest`; leaving the other provider
      // with the same hole because a task was scoped to one of them would be the
      // wrong kind of discipline.
      //
      // Watched on the *reply*, not the request, and that is not a style
      // preference: Fastify parses the body before the handler runs, so by here
      // `request.raw` is already destroyed and has already emitted its own
      // `close` — a listener added now would never fire, and the guard would
      // read as working while catching nothing. `reply.raw` emits `close` in
      // both cases, and `writableFinished` is what tells them apart: false when
      // the socket went before the reply was written, true after an ordinary
      // one. (`aborted` on the request is the deprecated spelling of an event
      // that is no use here anyway.)
      const gone = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) gone.abort();
      });
      const decision = await conversations.hook(session, payload, gone.signal);
      if (decision === undefined) return reply.code(204).send();
      return reply.code(200).send({ decision });
    },
  );
}
