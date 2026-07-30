import type { Session } from '@tether/shared';
import assert from 'node:assert/strict';
import test from 'node:test';

import { crumbs, dayLabel, groupSessions, matches } from './sessions.ts';

/** Whatever the test is about, plus the fields the row does not read. */
function session(over: Partial<Session>): Session {
  return {
    id: 's',
    machineId: 'm',
    provider: 'claude-code',
    providerSessionId: null,
    cwd: '/home/you/code/tether',
    title: 'tether',
    tmuxName: 'tether-1',
    createdAt: 0,
    updatedAt: 0,
    deadAt: null,
    ...over,
  };
}

/** A fixed local wall-clock moment, so the day arithmetic is not "today". */
const NOW = new Date(2026, 6, 30, 9, 30).getTime();
const DAY = 86_400_000;

test('search looks at both things a row shows, and an empty query keeps everything', () => {
  const row = session({ title: 'tether', cwd: '/home/you/code/api' });
  assert.equal(matches(row, ''), true);
  assert.equal(matches(row, '   '), true);
  assert.equal(matches(row, 'TETH'), true, 'case-insensitive on the title');
  assert.equal(matches(row, 'code/api'), true, 'and on the directory');
  assert.equal(matches(row, 'nothing here'), false);
});

test('a day heading is a calendar day, not a difference in hours', () => {
  const lateYesterday = new Date(2026, 6, 29, 23, 50).getTime();
  // 9h40m earlier, which is far less than a day — and still yesterday.
  assert.equal(dayLabel(lateYesterday, NOW), 'Yesterday');
  assert.equal(dayLabel(new Date(2026, 6, 30, 0, 5).getTime(), NOW), 'Today');
  // A clock that has drifted ahead of the server must not invent a future day.
  assert.equal(dayLabel(NOW + DAY, NOW), 'Today');
  assert.notEqual(dayLabel(NOW - 5 * DAY, NOW), 'Today');
});

test('a heading past this year carries the year, and one inside it does not', () => {
  const thisJuly = new Date(2026, 6, 3).getTime();
  const lastJuly = new Date(2025, 6, 3).getTime();
  const inYear = dayLabel(thisJuly, NOW);
  assert.equal(inYear.includes('2026'), false, 'the current year is not worth the width');
  assert.notEqual(dayLabel(lastJuly, NOW), inYear, 'last July is not this July');
  assert.equal(dayLabel(lastJuly, NOW).includes('2025'), true);
  // Two sessions on the same day of different years are two groups, not one
  // heading used twice — `app.tsx` keys a group by this string.
  const days = groupSessions(
    [session({ id: 'a', updatedAt: thisJuly }), session({ id: 'b', updatedAt: lastJuly })],
    '',
    NOW,
  ).map((g) => g.day);
  assert.equal(days.length, 2);
  assert.equal(new Set(days).size, 2);
});

test('grouping keeps the server’s order and starts a new group only on a change', () => {
  const list = [
    session({ id: 'a', updatedAt: NOW }),
    session({ id: 'b', updatedAt: NOW - 60_000 }),
    session({ id: 'c', updatedAt: NOW - DAY }),
    session({ id: 'd', updatedAt: NOW - 6 * DAY }),
  ];
  const groups = groupSessions(list, '', NOW);
  assert.deepEqual(
    groups.map((g) => [g.day, g.sessions.map((s) => s.id)]),
    [
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      [dayLabel(NOW - 6 * DAY, NOW), ['d']],
    ],
  );
});

test('a search that empties a group drops the heading with it', () => {
  const list = [
    session({ id: 'a', title: 'tether', updatedAt: NOW }),
    session({ id: 'b', title: 'docs', updatedAt: NOW - DAY }),
  ];
  assert.deepEqual(
    groupSessions(list, 'docs', NOW).map((g) => g.day),
    ['Yesterday'],
  );
  assert.deepEqual(groupSessions(list, 'neither', NOW), []);
});

test('a breadcrumb is the path’s segments, and an odd path is not a crash', () => {
  assert.deepEqual(crumbs('/home/you/code/tether'), ['home', 'you', 'code', 'tether']);
  assert.deepEqual(crumbs('/'), []);
  assert.deepEqual(crumbs(''), []);
  assert.deepEqual(crumbs('/a//b/'), ['a', 'b']);
});
