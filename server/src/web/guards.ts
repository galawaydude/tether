/**
 * The two header checks that stand between a malicious web page and a
 * loopback-bound shell (report §7). Pure functions, so the truth table below is
 * unit-testable without a server.
 */

/** Methods a browser will send cross-origin without a preflight. */
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isStateChanging(method: string): boolean {
  return STATE_CHANGING.has(method.toUpperCase());
}

/**
 * A `Host` header may only contain hostname/IPv6-literal/port characters.
 * Rejecting everything else up front removes the `user@host` and `host/path`
 * parsing tricks that would otherwise reach `new URL()`.
 */
const HOST_CHARS = /^[0-9a-z._~:[\]-]+$/i;

/** `hostname:port` with default ports elided, lowercased. `null` if unusable. */
function authorityOf(url: URL): string | null {
  if (url.username !== '' || url.password !== '') return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === '') return null;
  return `${hostname.toLowerCase()}:${url.port}`;
}

/** Parse a `Host` header into `{ hostname, authority }`, or `null` if invalid. */
export function parseHost(
  host: string | undefined,
): { hostname: string; authority: string } | null {
  if (host === undefined || host === '' || !HOST_CHARS.test(host)) return null;
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return null;
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  const authority = authorityOf(url);
  if (authority === null) return null;
  return { hostname: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(), authority };
}

/**
 * Host allowlist — the defence against DNS rebinding, where a page resolves its
 * own hostname to 127.0.0.1 and reaches a loopback-bound server from the
 * victim's browser. Unlike the Origin check this one is never bypassed: a
 * missing or unparseable `Host` is a rejection, not an exemption.
 */
export function isHostAllowed(host: string | undefined, allowed: ReadonlySet<string>): boolean {
  const parsed = parseHost(host);
  return parsed !== null && allowed.has(parsed.hostname);
}

/**
 * Origin guard for state-changing methods. The truth table, in full:
 *
 * | `Origin`             | result |
 * |----------------------|--------|
 * | present, foreign     | reject |
 * | `null` (opaque)      | reject |
 * | absent               | allow  |
 * | present, same as Host| allow  |
 *
 * Absent is allowed because non-browser clients (`curl`, the hook) omit it,
 * while a browser always sends it on a cross-origin state-changing request.
 * "Allowed" is compared against the request's own `Host`, which the caller has
 * already run through {@link isHostAllowed}; that makes the check same-origin
 * without a second list to keep in sync, and it ignores the scheme so a TLS
 * terminating reverse proxy does not break it.
 */
export function isOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  if (origin === 'null' || origin === '') return false;
  const target = parseHost(host);
  if (target === null) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return authorityOf(url) === target.authority;
}

/** `0.0.0.0` and `::` mean "every interface", so they are not a Host anyone sends. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '*']);

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Loopback names are always accepted (they reach the server whatever it is
 * bound to), plus the bind address itself, plus whatever the operator passed
 * with `--allowed-host` — which is what a Tailscale or reverse-proxy hostname
 * needs.
 */
export function defaultAllowedHosts(bindHost: string, extra: readonly string[] = []): Set<string> {
  const hosts = new Set(['localhost', '127.0.0.1', '::1']);
  const bind = bindHost.replace(/^\[|\]$/g, '').toLowerCase();
  if (!WILDCARD_BINDS.has(bind)) hosts.add(bind);
  for (const host of extra) {
    const normalized = host
      .replace(/^\[|\]$/g, '')
      .trim()
      .toLowerCase();
    if (normalized !== '') hosts.add(normalized);
  }
  return hosts;
}
