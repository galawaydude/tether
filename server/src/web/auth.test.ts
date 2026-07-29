import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { MIN_PASSWORD_LENGTH, SESSION_TTL_MS, createAuthStore } from './auth.ts';

function store() {
  return createAuthStore(new DatabaseSync(':memory:'));
}

test('scrypt round-trip: the password that was set is the password that verifies', () => {
  const auth = store();
  assert.equal(auth.hasPassword(), false);
  auth.setPassword('correct horse battery staple');
  assert.equal(auth.hasPassword(), true);
  assert.equal(auth.verifyPassword('correct horse battery staple'), true);
});

test('a wrong password is rejected', () => {
  const auth = store();
  auth.setPassword('correct horse battery staple');
  for (const wrong of ['correct horse battery stapl', 'Correct horse battery staple', '', 'x']) {
    assert.equal(auth.verifyPassword(wrong), false, JSON.stringify(wrong));
  }
});

test('nothing verifies before a password is set', () => {
  assert.equal(store().verifyPassword('anything at all'), false);
});

test('the stored record is a salted hash, not the password', () => {
  const db = new DatabaseSync(':memory:');
  const auth = createAuthStore(db);
  auth.setPassword('correct horse battery staple');
  const row = db.prepare('SELECT salt, hash FROM auth_password WHERE id = 1').get() as {
    salt: Uint8Array;
    hash: Uint8Array;
  };
  assert.equal(row.salt.length, 32);
  assert.equal(row.hash.length, 64);
  assert.equal(Buffer.from(row.hash).includes('correct horse battery staple'), false);
});

test('the salt is per-install, so identical passwords hash differently', () => {
  const a = new DatabaseSync(':memory:');
  const b = new DatabaseSync(':memory:');
  createAuthStore(a).setPassword('correct horse battery staple');
  createAuthStore(b).setPassword('correct horse battery staple');
  const hashOf = (db: DatabaseSync) =>
    Buffer.from((db.prepare('SELECT hash FROM auth_password').get() as { hash: Uint8Array }).hash);
  assert.notEqual(hashOf(a).toString('hex'), hashOf(b).toString('hex'));
});

test('a too-short password is refused', () => {
  const auth = store();
  assert.throws(() => auth.setPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1)), /at least/);
  assert.equal(auth.hasPassword(), false);
});

test('a session token is 256 bits of randomness and validates', () => {
  const auth = store();
  const { token, expiresAt } = auth.createSession(1000);
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.equal(expiresAt, 1000 + SESSION_TTL_MS);
  assert.equal(auth.validateSession(token, 1000), true);
});

test('tokens are unique per session', () => {
  const auth = store();
  const tokens = new Set(Array.from({ length: 50 }, () => auth.createSession().token));
  assert.equal(tokens.size, 50);
});

test('a token expires, and the expired row is dropped', () => {
  const db = new DatabaseSync(':memory:');
  const auth = createAuthStore(db);
  const { token, expiresAt } = auth.createSession(1000);
  assert.equal(auth.validateSession(token, expiresAt - 1), true);
  assert.equal(auth.validateSession(token, expiresAt), false, 'expiry is exclusive');
  assert.equal(auth.validateSession(token, expiresAt + 1), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_session').get()?.['n'], 0);
});

test('an unknown or empty token never validates', () => {
  const auth = store();
  auth.createSession();
  assert.equal(auth.validateSession('not-a-real-token'), false);
  assert.equal(auth.validateSession(''), false);
});

test('logout genuinely revokes: server-side state, not a stateless token', () => {
  const auth = store();
  const { token } = auth.createSession();
  const other = auth.createSession().token;
  auth.revokeSession(token);
  assert.equal(auth.validateSession(token), false);
  assert.equal(auth.validateSession(other), true, 'revoking one session leaves the others');
});

test('revokeAllSessions signs everyone out', () => {
  const auth = store();
  const tokens = [auth.createSession().token, auth.createSession().token];
  auth.revokeAllSessions();
  for (const token of tokens) assert.equal(auth.validateSession(token), false);
});

test('changing the password revokes every existing session', () => {
  const auth = store();
  auth.setPassword('correct horse battery staple');
  const { token } = auth.createSession();
  assert.equal(auth.validateSession(token), true);
  auth.setPassword('a different long password');
  assert.equal(auth.validateSession(token), false);
  assert.equal(auth.verifyPassword('correct horse battery staple'), false);
  assert.equal(auth.verifyPassword('a different long password'), true);
});

test('the database stores a hash of the token, never the token itself', () => {
  const db = new DatabaseSync(':memory:');
  const { token } = createAuthStore(db).createSession();
  const row = db.prepare('SELECT token_hash FROM auth_session').get() as { token_hash: Uint8Array };
  assert.equal(row.token_hash.length, 32);
  assert.notEqual(Buffer.from(row.token_hash).toString('base64url'), token);
});
