/**
 * What the `term` channel's own state is called, and what the session bar is
 * allowed to say about the agent while it is in that state.
 *
 * Here rather than in `terminal.tsx` for the reason at the top of
 * `conversation.ts`: web tests run under `node --test`, which strips types but
 * cannot compile JSX, so a wording table that lives in a `.tsx` is a wording
 * table no test can reach — and these particular strings are the ones a user
 * reads when something has gone wrong, which is exactly when being wrong is
 * expensive.
 */

/**
 * Shared with the conversation channel, which reaches a subset of these.
 *
 * `ended`, `gone` and `failed` are one close code each and are kept apart rather
 * than merged into "finished", because they are three different facts and the
 * user can act on the difference: a session that stopped, a session the server
 * has no row for, and an attach that threw for a reason this side cannot name.
 * The last one used to be reported as the second, which told people whose agent
 * was alive and working that their session was gone. The composer reads all
 * three too (`sendBlocked`), because this socket is where a composed message
 * goes — a message accepted after any of them could never leave.
 */
export type Status = 'connecting' | 'live' | 'retrying' | 'ended' | 'gone' | 'failed' | 'signedOut';

export const STATUS_TEXT: Record<Status, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  retrying: 'Reconnecting…',
  ended: 'Session ended',
  // Only ever shown when the registry has no row for this session at all.
  gone: 'Session not found',
  // Something stopped the terminal opening. What, is in the server's log — this
  // side never saw it, so this side does not guess at it.
  failed: 'Terminal unavailable',
  signedOut: 'Signed out',
};

/**
 * The channel states that silence the agent's own `busy`/`idle`/`waiting` state,
 * on **either** channel.
 *
 * `ended` and `gone` are facts about the *session*, not about the socket that
 * noticed one: a session that has ended has ended for both channels, and neither
 * will correct the other. The conversation socket closes only where the registry
 * has no row at all, and the status poller may not announce a state it could not
 * read — so a pane that dies mid-turn leaves the last published `waiting`
 * standing for the life of the page, and something has to be the thing that
 * stops believing it. `signedOut` is here because a browser that is no longer
 * allowed to ask is not one to keep telling.
 *
 * `failed` is deliberately not here, and that distinction is the whole point of
 * this set: it says a terminal could not be opened and nothing whatever about
 * whether the session is alive — the agent may be working perfectly, and hiding
 * its state would be this screen guessing in the opposite direction. Nor are
 * `connecting` and `retrying`: a phone drops its socket every time it locks, and
 * "Idle" beside "Reconnecting…" is two true statements about two different
 * things.
 */
const SILENCES_AGENT = new Set<Status>(['ended', 'gone', 'signedOut']);

/**
 * Whether any surface may still show the agent's own state.
 *
 * The bug this exists to make unrepresentable: the bar showed **Idle** and
 * **Session not found** side by side — tether reporting the agent alive and the
 * session missing in the same breath, which read as "your work is lost" and was
 * not true. Two facts that can contradict each other must not both be printed
 * with nothing saying which is believed. The channel wins, because it is the
 * fresher of the two: the agent badge is whatever the last `state` frame said
 * before the socket finished, and a socket that has finished is not going to
 * correct it.
 *
 * Both channels, one answer, and **not** "whichever pane is in front". Asking
 * about the front pane is how this was broken in the other direction: the
 * `sr-only` live region is kept separate from both surfaces precisely so what a
 * blind user hears does not depend on which one is up, and gating it on the
 * front pane silenced the announcement on every summon and made it again on
 * dismiss. Taking the pair removes the choice — "ask the right channel" and
 * "never contradict the other one" are one rule here, not two that can be
 * satisfied separately. The header's channel chip still prints the front
 * channel's own word; that is the channel's fact, not the agent's.
 */
export function agentStateTrusted(conversation: Status, terminal: Status): boolean {
  return !SILENCES_AGENT.has(conversation) && !SILENCES_AGENT.has(terminal);
}
