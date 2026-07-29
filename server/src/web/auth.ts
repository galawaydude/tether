import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { BinaryLike, ScryptOptions } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

/**
 * The single account and its server-side sessions (report §7).
 *
 * Reaching tether is equivalent to a shell on the machine, so an auth bypass
 * here is an unauthenticated RCE. This is the one module in M1 that is exempt
 * from Ponytail's minimalism; nothing below is shortened for its own sake.
 */

/**
 * Derivation runs on the libuv threadpool rather than blocking the event loop:
 * `/api/login` is the one public route, so a burst of unauthenticated requests
 * would otherwise stall the whole process for ~70ms each.
 */
const derive = promisify<BinaryLike, BinaryLike, number, ScryptOptions, Buffer>(scrypt);

/**
 * scrypt work factor. ~70ms per derivation on the reference machine. `maxmem`
 * must exceed 128·N·r (= 32 MiB here), which is above node's 32 MiB default.
 */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;
const KEY_LEN = 64;
const SALT_LEN = 32;

/** 256 bits, per §7. */
const TOKEN_BYTES = 32;

export const MIN_PASSWORD_LENGTH = 8;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type Session = { token: string; expiresAt: number };

export type AuthStore = {
  hasPassword(): boolean;
  /** Replaces the password and revokes every existing session. */
  setPassword(password: string): Promise<void>;
  verifyPassword(password: string): Promise<boolean>;
  createSession(now?: number): Session;
  validateSession(token: string, now?: number): boolean;
  revokeSession(token: string): void;
  revokeAllSessions(): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_password (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  salt       BLOB    NOT NULL,
  hash       BLOB    NOT NULL,
  n          INTEGER NOT NULL,
  r          INTEGER NOT NULL,
  p          INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_session (
  token_hash BLOB    PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

type PasswordRow = { salt: Uint8Array; hash: Uint8Array; n: number; r: number; p: number };

/**
 * Sessions are stored as SHA-256 of the token, so the database never holds a
 * value that is itself a credential. The token is 256 random bits, so a plain
 * digest is enough — there is nothing to brute-force.
 */
function tokenHash(token: string): Uint8Array {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function createAuthStore(db: DatabaseSync): AuthStore {
  db.exec(SCHEMA);

  const selectPassword = db.prepare('SELECT salt, hash, n, r, p FROM auth_password WHERE id = 1');
  const upsertPassword = db.prepare(
    `INSERT INTO auth_password (id, salt, hash, n, r, p, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET salt = excluded.salt, hash = excluded.hash,
       n = excluded.n, r = excluded.r, p = excluded.p, updated_at = excluded.updated_at`,
  );
  const insertSession = db.prepare(
    'INSERT INTO auth_session (token_hash, created_at, expires_at) VALUES (?, ?, ?)',
  );
  const selectSession = db.prepare('SELECT expires_at FROM auth_session WHERE token_hash = ?');
  const deleteSession = db.prepare('DELETE FROM auth_session WHERE token_hash = ?');
  const deleteExpired = db.prepare('DELETE FROM auth_session WHERE expires_at <= ?');
  const deleteAllSessions = db.prepare('DELETE FROM auth_session');

  function readPassword(): PasswordRow | null {
    return (selectPassword.get() as PasswordRow | undefined) ?? null;
  }

  return {
    hasPassword() {
      return readPassword() !== null;
    },

    async setPassword(password) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      }
      const salt = randomBytes(SALT_LEN);
      const hash = await derive(password, salt, KEY_LEN, SCRYPT);
      upsertPassword.run(salt, hash, SCRYPT.N, SCRYPT.r, SCRYPT.p, Date.now());
      // A password change must invalidate anyone already holding a cookie.
      deleteAllSessions.run();
    },

    async verifyPassword(password) {
      const row = readPassword();
      if (row === null) return false;
      const stored = Buffer.from(row.hash);
      const derived = await derive(password, Buffer.from(row.salt), stored.length, {
        N: row.n,
        r: row.r,
        p: row.p,
        maxmem: SCRYPT.maxmem,
      });
      // Lengths always match — `stored.length` is the requested key length —
      // so timingSafeEqual cannot throw, and the comparison stays constant time.
      return timingSafeEqual(derived, stored);
    },

    createSession(now = Date.now()) {
      deleteExpired.run(now);
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      const expiresAt = now + SESSION_TTL_MS;
      insertSession.run(tokenHash(token), now, expiresAt);
      return { token, expiresAt };
    },

    validateSession(token, now = Date.now()) {
      if (token === '') return false;
      const hash = tokenHash(token);
      const row = selectSession.get(hash) as { expires_at: number } | undefined;
      if (row === undefined) return false;
      if (row.expires_at > now) return true;
      deleteSession.run(hash);
      return false;
    },

    revokeSession(token) {
      if (token !== '') deleteSession.run(tokenHash(token));
    },

    revokeAllSessions() {
      deleteAllSessions.run();
    },
  };
}
