/**
 * What the session list decides before it renders anything: which rows a search
 * box leaves, and which day heading each of the survivors goes under.
 *
 * It is a `.ts` for the same reason `conversation.ts` is — web tests run under
 * `node --test`, which strips types but cannot compile JSX, so a decision made
 * inside a `.tsx` silently leaves the test suite. `app.tsx` picks elements.
 */

import type { Session } from '@tether/shared';

/**
 * Does this session match what was typed? Title and directory, because those
 * are the two things on a row and either is how someone would look for it.
 *
 * Case-insensitive substring rather than anything cleverer: the list is a
 * handful of sessions on one machine, and a fuzzy matcher would be a ranking
 * problem nobody has.
 */
export function matches(session: Pick<Session, 'title' | 'cwd'>, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return session.title.toLowerCase().includes(needle) || session.cwd.toLowerCase().includes(needle);
}

/**
 * The heading a session goes under. Relative for the two days anyone actually
 * has sessions on, and the date itself past that — "3 days ago" is a sum a
 * reader should not have to do, and a bare date is not one.
 *
 * Both timestamps are compared as *local calendar days*, not as a difference in
 * milliseconds: a session updated at 23:50 and read at 00:10 is yesterday's, and
 * 20 minutes is not.
 *
 * The year is carried only when it is not the current one. Registry rows are
 * marked dead and never deleted by design, so "older than a year" is every
 * session's eventual fate rather than an edge case, and a heading that cannot
 * tell this July from last July is a label that starts lying once the product
 * has been used a while — while two of them are also one duplicate key, since
 * `app.tsx` keys a group by this string.
 */
export function dayLabel(at: number, now: number): string {
  const day = (ms: number): number => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const then = new Date(at);
  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  return then.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** A day heading and the sessions filed under it, newest group first. */
export type Group = { day: string; sessions: Session[] };

/**
 * Filter, then group by the day each session was last touched.
 *
 * The server returns the list in its own order and this preserves it inside a
 * group — grouping is a heading over the existing order, not a re-sort, so a
 * change to how the server orders sessions still shows through. Groups come out
 * in the order their first member appears for the same reason.
 */
export function groupSessions(sessions: readonly Session[], query: string, now: number): Group[] {
  const groups: Group[] = [];
  for (const session of sessions) {
    if (!matches(session, query)) continue;
    const day = dayLabel(session.updatedAt, now);
    const last = groups.at(-1);
    if (last?.day === day) last.sessions.push(session);
    else groups.push({ day, sessions: [session] });
  }
  return groups;
}

/**
 * A directory as a breadcrumb: the segments, with the last one marked, so the
 * strip can give way at the front and keep the end whole.
 *
 * The path is the server's own and is always absolute, but this does not assume
 * it: an empty result is a strip with nothing in it rather than a crash.
 */
export function crumbs(cwd: string): string[] {
  return cwd.split('/').filter((segment) => segment !== '');
}
