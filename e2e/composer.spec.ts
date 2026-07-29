/**
 * The third end-to-end claim: a message composed in the conversation view
 * reaches the agent, and appears **once**.
 *
 * This is the piece that makes tether usable from a phone at all (report §3,
 * risk 5). Everything under the browser is unit-tested — `terminal.test.ts`
 * proves a multi-line `input` reaches a real tmux pane whole, once and in order,
 * and `conversation.test.ts` proves the optimistic echo is retired by the
 * transcript's own record rather than left beside it. What no unit test can say
 * is that the chain agrees: a textarea in one pane, an `input` frame on the
 * *other* pane's socket, tmux's paste buffer, the agent, its transcript, and the
 * `conv` frame that comes back.
 *
 * Two things asserted here and nowhere else:
 *
 *  - **Enter is a line break.** The composer has no key handler at all — that is
 *    the implementation — so the only honest check is a real browser, a real
 *    textarea and a real Enter, confirming the value gained a newline and
 *    nothing was sent. Submitting a half-written prompt because someone reached
 *    for a line break is the failure this rule exists to prevent, and it is
 *    exactly the kind of thing a later "convenience" quietly reintroduces.
 *  - **Counts, not presence.** `toContainText` passes just as happily on an echo
 *    that was never retired sitting next to its own record.
 *
 * The message is single-line because `e2e/stub-agent.ts` reads lines: a real
 * agent's TUI holds a bracketed paste as one prompt until Enter, and readline
 * cannot. Multi-line delivery is `server/src/machine/terminal.test.ts`'s job,
 * against real tmux.
 */

import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Its own directory, like `permission.spec.ts`'s: the three specs share one
 * `tether serve` and one session list, and two sessions in one directory would
 * share a title and make every by-name locator ambiguous.
 */
const project = join(process.env['TETHER_E2E_DIR'] as string, 'composer');

/** Where a reviewer's copies go; set by the runner, ignored when it is not. */
const evidence = process.env['TETHER_E2E_SHOTS'];

const GREETING = 'stub agent ready';
const TYPED = 'summarise what you just did';
const REPLY = `echo ${TYPED}`;
/** The second message, sent after a reload through a freshly wired sender. */
const AGAIN = 'and once more after a reload';

test('a composed message reaches the agent and appears exactly once', async ({ page }) => {
  mkdirSync(project, { recursive: true });

  await page.goto('/');
  await page.getByLabel('Password').fill(process.env['TETHER_E2E_PASSWORD'] as string);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Working directory').fill(project);
  await page.getByRole('button', { name: 'Start' }).click();

  // Scoped to the conversation pane: both panes stay mounted, so an unscoped
  // locator would find the terminal's copy of the same text as well.
  const conversation = page.locator('.conv');
  const box = page.getByLabel('Message');
  const send = page.getByRole('button', { name: 'Send' });

  await expect(conversation.getByText(GREETING, { exact: true })).toHaveCount(1);
  // Nothing to send is not a thing to send: an empty message would submit a bare
  // Enter at the pane.
  await expect(send).toBeDisabled();

  // ── Enter is a line break, not a submit ────────────────────────────────────
  await box.click();
  await page.keyboard.type('first line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second line');
  expect(await box.inputValue()).toBe('first line\nsecond line');
  // Still in the box, and nothing has been sent.
  await expect(conversation.getByText('first line', { exact: false })).toHaveCount(0);
  if (evidence !== undefined) {
    await page.screenshot({ path: join(evidence, '5-composer-newline.png') });
  }

  await box.fill('');
  await box.fill(TYPED);
  if (evidence !== undefined) {
    await page.screenshot({ path: join(evidence, '6-composer.png') });
  }

  // ── the claim ──────────────────────────────────────────────────────────────
  // The message shows immediately from the composer's own echo, and the
  // transcript's record for it replaces that echo rather than joining it. One
  // copy at the end is the assertion; two is the bug this reconciliation exists
  // to prevent, and it is invisible to `toContainText`.
  await send.click();
  await expect(box).toHaveValue('');
  await expect(conversation.getByText(REPLY, { exact: true })).toHaveCount(1);
  await expect(conversation.getByText(TYPED, { exact: true })).toHaveCount(1);
  await expect(conversation.locator('.msg-sending')).toHaveCount(0);
  if (evidence !== undefined) {
    await page.screenshot({ path: join(evidence, '7-composer-sent.png') });
  }

  // And it really went through tmux to the agent, not just into the view.
  await page.getByRole('button', { name: 'Terminal' }).click();
  await expect(page.locator('.xterm-rows')).toContainText(REPLY);

  // ── the sender is rewired on remount ───────────────────────────────────────
  // A composed message leaves on the *terminal* pane's socket, through a ref
  // `app.tsx` holds and `terminal.tsx` fills in. A reload drops both panes, both
  // sockets and the ref, so this is where a rewiring that never happens shows
  // up — as a Send button that empties the box and does nothing else.
  await page.reload();
  // By name, like the other two specs: three sessions share this list.
  await page.getByRole('button', { name: `composer ${project}` }).click();
  await expect(conversation.getByText(TYPED, { exact: true })).toHaveCount(1);

  await box.fill(AGAIN);
  await send.click();
  await expect(box).toHaveValue('');
  await expect(conversation.getByText(`echo ${AGAIN}`, { exact: true })).toHaveCount(1);
  await expect(conversation.getByText(AGAIN, { exact: true })).toHaveCount(1);
  await expect(conversation.locator('.msg-sending')).toHaveCount(0);

  // ── the keyboard-open case ─────────────────────────────────────────────────
  // 360×340 is this phone with its keyboard up, and it is the viewport that
  // finds a composer able to eat the conversation it belongs to. A tall message
  // must leave Send on screen and must not push its own pane sideways.
  await page.setViewportSize({ width: 360, height: 340 });
  await box.fill('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten');
  const button = await send.boundingBox();
  if (button === null) throw new Error('Send is not laid out at all at 360×340');
  expect(button.y + button.height).toBeLessThanOrEqual(340);
  // Measured on the conversation pane rather than the document: the terminal
  // pane stays mounted and absolutely positioned, and xterm does not re-fit a
  // pane it cannot measure, so a document-wide check reports the *other* pane's
  // stale geometry. What this pane owns is that its own text wraps.
  expect(
    await conversation.evaluate((el) => [el.scrollWidth - el.clientWidth, el.clientWidth]),
  ).toEqual([0, 360]);
  if (evidence !== undefined) {
    await page.screenshot({ path: join(evidence, '8-composer-keyboard-open.png') });
  }
});
