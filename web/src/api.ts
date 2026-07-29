/**
 * The HTTP half of the server contract, in one module.
 *
 * Every failure the server can return is turned into an {@link ApiError} with a
 * sentence a person can act on. That is not decoration: a refused working
 * directory and a rate-limited login are ordinary states of this product, and a
 * UI that renders them as "something went wrong" has thrown away the one piece
 * of information the server went to the trouble of sending.
 */

import type { Session, SessionState } from '@tether/shared';

import type { SeqEvent } from './conversation.ts';

export type { Session };

/**
 * What each live session is doing, beside the rows rather than on them. No
 * detail: the registry file the list is built from has no such field, and the
 * one sentence that says *what* is wanted arrives on the session's own `state`
 * frame, from the `Notification` hook.
 */
export type SessionStates = Record<string, { state: SessionState }>;

/** The only machine there is in M1; the API is addressed by machine regardless. */
const MACHINE = 'local';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Seconds until a rate-limited login may be retried, when the server said. */
  readonly retryAfter: number | null;

  constructor(status: number, code: string, message: string, retryAfter: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Wording for the error codes the server actually returns. */
const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Wrong password.',
  too_many_attempts: 'Too many attempts. This device is locked out for a while.',
  unauthorized: 'Your session has expired — log in again.',
  no_such_session: 'That session no longer exists.',
  forbidden_host: 'This hostname is not in the server’s allowed list.',
  forbidden_origin: 'The server refused this origin.',
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, 'offline', 'Cannot reach tether — check the connection.');
  }

  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  const fields = (body ?? {}) as { error?: string; message?: string };

  if (!response.ok) {
    const code = fields.error ?? `http_${response.status}`;
    const header = response.headers.get('retry-after');
    throw new ApiError(
      response.status,
      code,
      // The server's own message wins where it has one: `invalid_cwd` carries the
      // allowed roots, and that sentence is the whole answer to the refusal.
      fields.message ?? MESSAGES[code] ?? `The server refused this (${response.status}).`,
      header === null ? null : Number(header),
    );
  }
  return body as T;
}

function json(method: string, value: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

export function login(password: string): Promise<void> {
  return request('/api/login', json('POST', { password }));
}

export function logout(): Promise<void> {
  return request('/api/logout', { method: 'POST' });
}

/** Resolves if the cookie is still good; rejects with 401 if it is not. */
export function checkSession(): Promise<{ authenticated: boolean }> {
  return request('/api/session');
}

export async function listSessions(): Promise<{ sessions: Session[]; states: SessionStates }> {
  const body = await request<{ sessions: Session[]; states?: SessionStates }>(
    `/api/machines/${MACHINE}/sessions`,
  );
  return { sessions: body.sessions, states: body.states ?? {} };
}

export async function createSession(cwd: string, title?: string): Promise<Session> {
  const body = title !== undefined && title !== '' ? { cwd, title } : { cwd };
  const { session } = await request<{ session: Session }>(
    `/api/machines/${MACHINE}/sessions`,
    json('POST', body),
  );
  return session;
}

export function killSession(id: string): Promise<{ session: Session }> {
  return request(`/api/machines/${MACHINE}/sessions/${id}`, { method: 'DELETE' });
}

/**
 * The whole conversation, and the `seq` to follow it from. Step 1 of the `conv`
 * handshake, and the only correct answer to a `refetch`.
 */
export function fetchConversation(id: string): Promise<ConversationHistory> {
  return request(`/api/sessions/${id}/conversation`);
}

export type ConversationHistory = {
  seq: number;
  events: SeqEvent[];
  title?: string;
  version?: string;
};

/**
 * The terminal and conversation channels. Both built from `location` so they
 * follow whatever host and scheme the page was served over — the server's Origin
 * guard compares the two, and a tunnel or reverse proxy changes both together.
 *
 * The terminal is addressed by tmux name and the conversation by registry id;
 * that is the server's split, not a slip.
 */
export function termSocketUrl(tmuxName: string, clientId: string): string {
  return socketUrl(`api/sessions/${tmuxName}/term`, { client: clientId });
}

export function convSocketUrl(id: string, since: number): string {
  return socketUrl(`api/sessions/${id}/conv`, { since: String(since) });
}

function socketUrl(path: string, query: Record<string, string>): string {
  const url = new URL(path, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}
