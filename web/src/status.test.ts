import assert from 'node:assert/strict';
import test from 'node:test';

import { STATUS_TEXT, agentStateTrusted, type Status } from './status.ts';

/** Every value of the union, so a new one cannot be added without a decision. */
const ALL: readonly Status[] = [
  'connecting',
  'live',
  'retrying',
  'ended',
  'gone',
  'failed',
  'signedOut',
];

test('only a genuinely missing session may say the session is missing', () => {
  // The bug: `CLOSE_NO_SESSION` was sent for *any* failed attach, so this
  // sentence was shown for a native module that would not spawn and for a
  // session that had ended normally. It is now one close code, one fact.
  assert.equal(STATUS_TEXT.gone, 'Session not found');
  const missingClaims = ALL.filter((status) =>
    /not found|no longer|missing/i.test(STATUS_TEXT[status]),
  );
  assert.deepEqual(missingClaims, ['gone']);

  // And the other two say what they really are, without guessing at a cause
  // this side never saw.
  assert.equal(STATUS_TEXT.ended, 'Session ended');
  assert.equal(STATUS_TEXT.failed, 'Terminal unavailable');
});

/** The states that say the session is over, whichever channel noticed. */
const OVER: readonly Status[] = ['ended', 'gone', 'signedOut'];

test('alive and missing are no longer sayable at once, on either channel', () => {
  // The screenshot that produced this fix: the bar read **Idle** and **Session
  // not found** side by side. Two chips, two sources, and nothing said which one
  // tether believed — so the user read it as "the agent is fine and the work is
  // lost". The whole matrix rather than an example, because this invariant has
  // been broken twice by changes meant to protect it: once by gating the badge
  // on the front pane, and once by gating it on the conversation channel alone,
  // which left a dead pane's last `waiting` on screen for good.
  for (const conversation of ALL) {
    for (const terminal of ALL) {
      const over = OVER.includes(conversation) || OVER.includes(terminal);
      assert.equal(
        agentStateTrusted(conversation, terminal),
        !over,
        `${conversation} / ${terminal}`,
      );
    }
  }
});

test('a terminal that could not be opened says nothing about the agent', () => {
  // `failed` is the one channel state that is not a fact about the session: it
  // says a terminal could not be opened, and the agent may be working perfectly.
  // Hiding its state there would be this screen guessing in the other direction,
  // which is the same fault with the sign flipped.
  assert.equal(agentStateTrusted('live', 'failed'), true);
  assert.equal(agentStateTrusted('failed', 'live'), true);

  // And a socket that is coming back is not a contradiction either: a phone
  // drops its socket every time the screen locks, and the last state the agent
  // published is still the best thing known about it.
  for (const status of ['connecting', 'live', 'retrying'] as const) {
    assert.equal(agentStateTrusted(status, status), true, status);
  }
});
