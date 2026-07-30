import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_TERMINAL_LABEL,
  CODEX,
  COMMAND_TERMINAL_LABEL,
  copyLabel,
  DEFAULT_PROVIDER,
  PROVIDERS,
  providerLabel,
  trustAsk,
  turnErrorLabel,
  unresumableNote,
  WAITING_TERMINAL_LABEL,
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

test('a Copy button says what it copies, and never says “message”', () => {
  assert.equal(copyLabel('user', CODEX), 'Copy your text');
  assert.equal(copyLabel('assistant', CODEX), 'Copy the reply from Codex');
  // The composer's own label is the single word "Message" and Playwright's
  // `getByLabel` matches on a substring, so a Copy button carrying that word
  // makes every `getByLabel('Message')` in the e2e suite ambiguous. It cost two
  // specs once; this is the guard, and it is cheaper than the next bisect.
  for (const who of ['user', 'assistant'] as const) {
    for (const provider of [DEFAULT_PROVIDER, CODEX, 'some-future-agent']) {
      assert.doesNotMatch(copyLabel(who, provider), /message/i);
      // The same rule, for the heading that attributes a failed turn's row to
      // the CLI that wrote it rather than to the model.
      assert.doesNotMatch(turnErrorLabel(provider), /message/i);
    }
  }
});

test('a failed turn’s row is attributed to the CLI that wrote it', () => {
  // The box carries that for sighted users; the heading is the same fact for a
  // screen reader, which otherwise hears the CLI's words in the model's voice.
  assert.equal(turnErrorLabel(CODEX), 'Codex reported a failed turn');
  assert.equal(turnErrorLabel(DEFAULT_PROVIDER), 'Claude Code reported a failed turn');
  assert.equal(turnErrorLabel('some-future-agent'), 'some-future-agent reported a failed turn');
});

test('no two controls that summon the terminal share a name, even partly', () => {
  // Three distinct buttons, all of which can be on screen at once: one on a
  // failed turn's row, the composer's command note, and the waiting banner.
  // These are the strings those buttons render, imported rather than copied —
  // a guard against hand-written duplicates guards nothing.
  const names = [AUTH_TERMINAL_LABEL, COMMAND_TERMINAL_LABEL, WAITING_TERMINAL_LABEL];
  const why =
    'these are three distinct controls that can be on screen together, so one ' +
    'accessible name containing another makes `getByRole({ name })` ambiguous ' +
    'for the specs that locate the other two, and makes the control ambiguous ' +
    'for a screen reader — rename it to something neither contains';
  for (const a of names) {
    for (const b of names) {
      if (a === b) continue;
      // Playwright's name matching is case-insensitive substring matching, so
      // the containment has to be checked the same way.
      assert.equal(
        b.toLowerCase().includes(a.toLowerCase()),
        false,
        `“${a}” is inside “${b}”: ${why}`,
      );
    }
  }
  // And they are genuinely three, not two written twice.
  assert.equal(new Set(names).size, names.length, `duplicate terminal control name: ${why}`);
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

test('a trusted folder is asked nothing at all', () => {
  // Not a reassuring sentence, not a ticked box: there is no question here, and
  // the consent pattern this follows rules out mentioning a settled one.
  for (const provider of [DEFAULT_PROVIDER, CODEX]) {
    assert.equal(trustAsk(provider, 'trusted', '/w/p', '/w/p'), null);
  }
});

test('an untrusted folder says what trusting means, and that declining still works', () => {
  const ask = trustAsk(DEFAULT_PROVIDER, 'untrusted', '/w/p', '/w/p');
  const text = (ask?.lines ?? []).join(' ');
  assert.match(text, /Claude Code/, 'the agent is named, not "the agent"');
  assert.match(text, /\/w\/p/, 'and so is the directory');
  // The three things the user has to be told before deciding.
  assert.match(text, /read, change and run files/);
  assert.match(text, /remembered/);
  assert.match(text, /will ask you in the terminal instead/);
  // Something to tick, and it is a plain first-person statement rather than an
  // instruction: the label is the decision, so it must read like one.
  assert.equal(ask?.accept, 'I trust this folder');
});

test('a folder whose trust is about a different path says which', () => {
  // Codex keys trust by repository, so a session in `repo/sub` agrees to `repo`.
  // A control saying "this folder" over that would be a lie by omission.
  const ask = trustAsk(CODEX, 'untrusted', '/w/repo', '/w/repo/sub');
  const text = (ask?.lines ?? []).join(' ');
  assert.match(text, /\/w\/repo, the repository \/w\/repo\/sub is in/);
  assert.match(text, /every directory inside it/);
  assert.equal(ask?.accept, 'I trust this folder');
});

test('an undeterminable state reports rather than assuming, and offers nothing', () => {
  const ask = trustAsk(CODEX, 'unknown', '/w/p', '/w/p');
  const text = (ask?.lines ?? []).join(' ');
  assert.match(text, /cannot tell whether Codex/);
  assert.match(text, /will not guess/);
  // Nothing to tick. There is exactly one file tether would have to write, and it
  // is the one it has just failed to read.
  assert.equal(ask?.accept, undefined);
  // And it says what happens next, because the session still starts.
  assert.match(text, /ask in the terminal/);
});

test('an agent this build has not heard of is named by its id, and asked nothing it cannot answer', () => {
  const ask = trustAsk('some-future-agent', 'unknown', '/w/p', '/w/p');
  assert.match((ask?.lines ?? []).join(' '), /some-future-agent/);
  assert.equal(ask?.accept, undefined);
});
