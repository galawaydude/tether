import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_CHANNEL, STATUS_TEXT, agentStateTrusted, type Status } from './status.ts';

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

test('alive and missing are no longer sayable at once', () => {
  // The screenshot that produced this fix: the bar read **Idle** and **Session
  // not found** side by side. Two chips, two sources, and nothing said which one
  // tether believed — so the user read it as "the agent is fine and the work is
  // lost". A finished channel cannot vouch for the agent badge beside it, so the
  // badge is not drawn at all.
  for (const status of ['ended', 'gone', 'failed', 'signedOut'] as const) {
    assert.equal(agentStateTrusted(status), false, status);
  }

  // A socket that is coming back is not a contradiction: the last state the
  // agent published is still the best thing known about it, and a phone drops
  // its socket every time the screen locks.
  for (const status of ['connecting', 'live', 'retrying'] as const) {
    assert.equal(agentStateTrusted(status), true, status);
  }
});

test('the surface that reports the agent follows the channel that publishes it', () => {
  // The `state` frame arrives on the conversation socket, so a dead *terminal*
  // says nothing about whether the agent's state is still worth showing. Gating
  // the waiting banners and the live region on whichever pane was in front made
  // a screen reader's announcement come and go with the terminal overlay, which
  // is the one thing that region is kept separate from both surfaces to avoid.
  assert.equal(AGENT_CHANNEL, 'conversation');

  const status = { conversation: 'live', terminal: 'failed' } as const;
  assert.equal(agentStateTrusted(status[AGENT_CHANNEL]), true, 'the agent is still being heard');
  assert.equal(agentStateTrusted(status.terminal), false, 'the terminal chip is a different fact');
});
