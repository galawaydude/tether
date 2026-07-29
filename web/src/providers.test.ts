import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODEX,
  DEFAULT_PROVIDER,
  PROVIDERS,
  providerLabel,
  unresumableNote,
  whoLabel,
} from './providers.ts';

test('every provider the server accepts is offered, default first', () => {
  assert.deepEqual(
    PROVIDERS.map((p) => p.id),
    [DEFAULT_PROVIDER, CODEX],
  );
  // The sheet's `<select>` takes its initial value from this, so the first
  // option and the server's own default have to be the same string.
  assert.equal(PROVIDERS[0]?.id, DEFAULT_PROVIDER);
});

test('a provider this build has not heard of is named, not blanked', () => {
  assert.equal(providerLabel(DEFAULT_PROVIDER), 'Claude Code');
  assert.equal(providerLabel(CODEX), 'Codex');
  assert.equal(providerLabel('some-future-agent'), 'some-future-agent');
});

test('an assistant message is signed by whichever agent is actually running', () => {
  assert.equal(whoLabel('user', CODEX), 'You');
  assert.equal(whoLabel('assistant', CODEX), 'Codex');
  assert.equal(whoLabel('assistant', DEFAULT_PROVIDER), 'Claude Code');
});

test('a dead session says it cannot be resumed only when it genuinely cannot', () => {
  // Codex writes nothing until the first user message, so a session closed
  // before anyone typed has no conversation to go back to and the server refuses
  // the resume. The row says the same thing rather than implying otherwise.
  assert.match(
    unresumableNote({ deadAt: 1, providerSessionId: null }) ?? '',
    /no conversation to resume/,
  );
  // A live session has not been asked to resume anything, and a dead one with an
  // id resumes fine. Neither is a place to say something is missing.
  assert.equal(unresumableNote({ deadAt: null, providerSessionId: null }), null);
  assert.equal(unresumableNote({ deadAt: 1, providerSessionId: 'abc' }), null);
  assert.equal(unresumableNote({ deadAt: null, providerSessionId: 'abc' }), null);
});
