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
 * The channel states that say nothing more is coming, so the agent's own
 * `busy`/`idle`/`waiting` badge is no longer something this screen can vouch for.
 *
 * `retrying` and `connecting` are deliberately not here. A dropped socket is the
 * ordinary case on a phone, the last state the agent published is still the best
 * thing known about it, and "Idle" beside "Reconnecting…" is two true statements
 * about two different things.
 */
const FINISHED = new Set<Status>(['ended', 'gone', 'failed', 'signedOut']);

/**
 * Whether the bar may still show the agent's own state beside the channel's.
 *
 * The bug this exists to make unrepresentable: the bar showed **Idle** and
 * **Session not found** side by side — tether reporting the agent alive and the
 * session missing in the same breath, which read as "your work is lost" and was
 * not true. Two facts that can contradict each other must not both be printed
 * with nothing saying which is believed. The channel wins, because it is the
 * fresher of the two: the agent badge is whatever the last `state` frame said
 * before the socket finished, and a socket that has finished is not going to
 * correct it.
 */
export function agentStateTrusted(terminal: Status): boolean {
  return !FINISHED.has(terminal);
}
