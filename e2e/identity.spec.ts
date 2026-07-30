/**
 * The fourth end-to-end claim, and the one found in live use rather than by a
 * test: **every** session gets its own conversation, and keeps it.
 *
 * Both halves are about which transcript a row is joined to, and neither can be
 * checked below the browser. `web/hooks.test.ts` and `machine/conversations.test.ts`
 * prove the join itself — against real tmux panes and real Claude Code registry
 * files — but what the captain actually saw was a *view*: a second session in a
 * directory that already had one showed an empty conversation forever, and a
 * session resumed in the terminal showed a conversation that had simply stopped,
 * while the terminal beside both of them worked perfectly.
 *
 * So this drives the two of them the way a user meets them:
 *
 *  - **Two sessions in one directory.** They post an identical `cwd`, so a `cwd`
 *    can only ever say "one of these". Their panes tell them apart exactly.
 *  - **A `/resume` typed at the pane.** Claude Code moves to a different session
 *    id and a different transcript and announces it to nobody; the view has to
 *    follow anyway.
 *
 * Its own directory like the other three, and two sessions in it — which is why
 * both are given a title, since the by-name locator the other specs rely on
 * would otherwise be ambiguous by construction here.
 */

import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { dismiss, shots, summon } from './ui.ts';

const project = join(process.env['TETHER_E2E_DIR'] as string, 'shared');

const shoot = shots('identity');

const GREETING = 'stub agent ready';
const RESUME = 'resume the old conversation';
const RESUMED = 'back in the resumed conversation';

/** Start a session in {@link project}, from the list, as a user does. */
async function start(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Working directory').fill(project);
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Start' }).click();
}

/** Types at the pane, which is the only place a `/resume` can come from. */
async function typeAt(page: Page, text: string): Promise<void> {
  await summon(page);
  await expect(page.locator('header .chip[role="status"]')).toHaveText('Live');
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText(text);
  await dismiss(page);
}

test('two sessions in one directory each show their own conversation, and follow a resume', async ({
  page,
}) => {
  mkdirSync(project, { recursive: true });

  await page.goto('/');
  await page.getByLabel('Password').fill(process.env['TETHER_E2E_PASSWORD'] as string);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Scoped to the conversation pane: both panes stay mounted, so an unscoped
  // locator would find the terminal's copy of the same text as well.
  const conversation = page.locator('.conv');

  const FIRST = 'a question only the first session was asked';
  await start(page, 'alpha');
  await expect(conversation.getByText(GREETING, { exact: true })).toHaveCount(1);
  await typeAt(page, FIRST);
  await expect(conversation.getByText(`echo ${FIRST}`, { exact: true })).toHaveCount(1);

  // ── the claim ──────────────────────────────────────────────────────────────
  // A second session in a directory that already has one. Nothing about the
  // directory distinguishes it, and this is the session that had no conversation
  // at all: adoption matched on the `cwd`, found two candidates, and declined.
  const SECOND = 'a question only the second session was asked';
  await page.getByRole('button', { name: 'Back to sessions' }).click();
  await start(page, 'beta');
  await expect(conversation.getByText(GREETING, { exact: true })).toHaveCount(1);
  await typeAt(page, SECOND);
  await expect(conversation.getByText(SECOND, { exact: true })).toHaveCount(1);
  await expect(conversation.getByText(`echo ${SECOND}`, { exact: true })).toHaveCount(1);
  // Its own and nothing else's: a join that merely found *a* transcript in the
  // directory would show the neighbour's here, which is the failure that costs a
  // user their conversation rather than merely hiding it.
  await expect(conversation.getByText(FIRST, { exact: true })).toHaveCount(0);
  await shoot(page, '1-second-session-in-one-directory');

  // ── and the resume ─────────────────────────────────────────────────────────
  // Typed at the pane, so tether learns about it the only way there is: the
  // registry file the poller already reads names a different session now.
  await typeAt(page, RESUME);
  await expect(conversation.getByText(RESUMED, { exact: true })).toHaveCount(1);
  // The resumed conversation, from its own start — the view moved to the file
  // the session is writing to now, rather than sitting on one nothing writes to.
  await expect(conversation.getByText(SECOND, { exact: true })).toHaveCount(0);
  await shoot(page, '2-after-a-resume-at-the-pane');

  // The neighbour was never touched by any of it.
  await page.getByRole('button', { name: 'Back to sessions' }).click();
  await page.getByRole('button', { name: `alpha ${project}` }).click();
  await expect(conversation.getByText(FIRST, { exact: true })).toHaveCount(1);
  await expect(conversation.getByText(`echo ${FIRST}`, { exact: true })).toHaveCount(1);
  await expect(conversation.getByText(SECOND, { exact: true })).toHaveCount(0);
  await expect(conversation.getByText(RESUMED, { exact: true })).toHaveCount(0);
  await shoot(page, '3-first-session-unaffected');
});
