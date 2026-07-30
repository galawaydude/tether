/**
 * One of the two end-to-end tests — `permission.spec.ts` is the other: log in,
 * start a session, watch it, type at it, and **reload the page**.
 *
 * That reload is the product claim (report §8). Everything else in this codebase
 * is unit-testable and is unit-tested; this is not, because it is the whole
 * stack agreeing — browser, WebSockets, tmux and the transcript — that a client
 * which threw its state away comes back to exactly what it left, once.
 *
 * So the assertions are counts, not presence. `toContainText` passes just as
 * happily on a conversation that replayed itself twice, and duplication is the
 * failure this design exists to prevent.
 */

import { expect, test, type Locator } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dismiss, hatch, shots, summon } from './ui.ts';

/** This spec's own directory inside the sandbox; `serve.ts` makes it. */
const project = join(process.env['TETHER_E2E_DIR'] as string, 'project');

/** The overlay test's own, for the same reason every other spec has one. */
const overlay = join(process.env['TETHER_E2E_DIR'] as string, 'overlay');

/** And the geometry test's, which puts a session into `waiting` of its own. */
const chrome = join(process.env['TETHER_E2E_DIR'] as string, 'chrome');

const shoot = shots('session');

/** What `e2e/stub-agent.ts` prints and records; the reload counts them. */
const GREETING = 'stub agent ready';
const TYPED = 'ping from the phone';
const REPLY = `echo ${TYPED}`;

/**
 * Two of the stub's asks, used by the geometry test below purely to put a
 * session into `waiting` and back — one held, one not. They belong to
 * `permission.spec.ts`'s subject; here they are only a way to make the banner
 * mount. Its own session, so neither spec's card counts touch the other's.
 */
const ASK = 'ask to run something';
const ASK_UP = 'ask with the terminal up';
const ANSWER = 'yes';

/** The server's own hold, from the one place it is configured. */
const HOLD_MS = Number(process.env['TETHER_E2E_HOLD_SECONDS'] ?? '15') * 1000;

/**
 * The terminal as the user sees it: the rendered rows, trailing blanks dropped.
 *
 * This is the right unit to compare across a reload, and the scrollback above it
 * deliberately is not. tether's replay pushes the captured history up with a
 * screenful of newlines and then lets tmux's own attach repaint redraw the pane
 * over it (report §3), so the buffer legitimately holds the capture *and* the
 * repaint — which is exactly why the design has nothing to desynchronise.
 * Byte-exactness of the reconstruction is `server/src/machine/terminal.test.ts`'s
 * job, against `capture-pane` ground truth. What no unit test can say is that
 * what the user was looking at is what they get back, and that is this.
 */
async function screen(rows: Locator): Promise<string> {
  return (await rows.innerText()).replace(/\s+$/, '');
}

test('a reload loses nothing: scrollback and conversation come back intact and once', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Password').fill(process.env['TETHER_E2E_PASSWORD'] as string);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Working directory').fill(project);
  await page.getByRole('button', { name: 'Start' }).click();

  // Scoped to their own pane: both stay mounted and the hidden one keeps its
  // text in the DOM, so an unscoped locator would find each string twice and
  // say nothing about either view.
  const conversation = page.locator('.conv');
  const rows = page.locator('.xterm-rows');
  const status = page.getByRole('status');

  // The session opens on the conversation, which arrives from the transcript.
  await expect(conversation.getByText(GREETING, { exact: true })).toHaveCount(1);

  await summon(page);
  // Before typing, not for tidiness: keystrokes sent at a socket that has not
  // opened are dropped, and that is a real flake rather than a slow assertion.
  await expect(status).toHaveText('Live');
  await expect(rows).toContainText(GREETING);

  await page.locator('.xterm-screen').click();
  await page.keyboard.type(TYPED);
  await page.keyboard.press('Enter');
  await expect(rows).toContainText(REPLY);
  const before = await screen(rows);

  await dismiss(page);
  await expect(conversation.getByText(TYPED, { exact: true })).toHaveCount(1);
  await expect(conversation.getByText(REPLY, { exact: true })).toHaveCount(1);

  // ── The claim ──────────────────────────────────────────────────────────────
  // Nothing survives on the client: a reload drops the xterm buffer, every
  // socket and all of the app's state. What comes back is re-derived — the
  // terminal from tmux, the conversation from the transcript.
  await page.reload();
  // By name, not `.row-open`: `permission.spec.ts` shares this server and has a
  // session of its own in the list, and reopening the wrong one would compare
  // this session's terminal against another's.
  await page.getByRole('button', { name: `project ${project}` }).click();

  await expect(conversation.getByText(GREETING, { exact: true })).toHaveCount(1);
  await expect(conversation.getByText(TYPED, { exact: true })).toHaveCount(1);
  await expect(conversation.getByText(REPLY, { exact: true })).toHaveCount(1);

  await summon(page);
  await expect(status).toHaveText('Live');
  await expect(rows).toContainText(REPLY);
  // Identical, not merely "contains": a replay that repeated itself, dropped a
  // line, or leaked an escape sequence all show up here and only here.
  expect(await screen(rows)).toBe(before);
});

/**
 * The other half of what the tab pair used to do, now that there is no tab pair:
 * the conversation is where a session opens, the terminal is summoned over it,
 * and putting it away leaves both views exactly where they were.
 *
 * The scroll claim is the reason this cannot be a unit test. It is not a feature
 * anything implements — it falls out of both panes staying laid out and the one
 * behind being hidden with `visibility` — so the only honest check is a real
 * browser measuring a real `scrollTop` across a real summon. `display: none`, an
 * unmount, or a sheet that resizes the pane all pass every other test in this
 * repo and fail this one.
 *
 * 360×640 is the smallest phone the product targets, and it is also what makes
 * the conversation overflow with a handful of messages — a `scrollTop` that
 * cannot be non-zero proves nothing about preserving it.
 */
test('the terminal is summoned over the conversation and dismissed, and neither loses its place', async ({
  page,
}) => {
  mkdirSync(overlay, { recursive: true });
  await page.setViewportSize({ width: 360, height: 640 });

  await page.goto('/');
  await page.getByLabel('Password').fill(process.env['TETHER_E2E_PASSWORD'] as string);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Working directory').fill(overlay);
  await page.getByRole('button', { name: 'Start' }).click();

  const conversation = page.locator('.conv');
  const sheet = page.locator('.termsheet');
  const rows = page.locator('.xterm-rows');
  const box = page.getByLabel('Message');

  // ── the conversation is where a session opens ──────────────────────────────
  // A count, not a visibility check: the claim is that the choice is gone, and
  // a Conversation button that merely starts out selected is not that.
  await expect(conversation.getByText(GREETING, { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Conversation' })).toHaveCount(0);
  await expect(hatch(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(sheet.locator('.xterm-screen')).toBeHidden();
  await shoot(page, '1-conversation-is-the-landing-view');

  // Enough conversation to have a place to lose. Through the composer, which is
  // the fast way to make one and does not need the terminal at all.
  for (const line of ['one', 'two', 'three', 'four', 'five', 'six']) {
    await box.fill(`say ${line}`);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(conversation.getByText(`echo say ${line}`, { exact: true })).toHaveCount(1);
  }
  await conversation.evaluate((element) => {
    element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2);
  });
  const place = await conversation.evaluate((element) => element.scrollTop);
  expect(place).toBeGreaterThan(0);

  // ── summoned, and over rather than instead ─────────────────────────────────
  await summon(page);
  await expect(page.locator('header .chip[role="status"]')).toHaveText('Live');
  await expect(rows).toContainText(GREETING);

  const panes = await page.locator('.panes').boundingBox();
  const over = await sheet.boundingBox();
  if (panes === null || over === null) throw new Error('the overlay is not laid out');
  // A strip of the conversation still shows above it, which is the difference
  // between an overlay and a replacement — and it is asserted in pixels because
  // "the sheet is there" is true of a sheet that took the whole pane.
  expect(over.y).toBeGreaterThan(panes.y);
  expect(over.height).toBeLessThan(panes.height);
  expect(over.height).toBeGreaterThan(panes.height / 2);
  // Everything the conversation offers is behind it, the composer included —
  // visible in the strip above, and `inert`, so a keyboard cannot reach a
  // control the terminal is sitting on top of.
  await expect(page.locator('.pane:not(.termsheet)')).toHaveAttribute('inert', '');
  await shoot(page, '2-terminal-summoned');
  const screenBefore = await screen(rows);

  // ── dismissed, and nothing moved ───────────────────────────────────────────
  await dismiss(page);
  await expect(page.locator('.pane:not(.termsheet)')).not.toHaveAttribute('inert', '');
  await box.fill('and the composer answers again');
  await expect(box).toHaveValue('and the composer answers again');
  await box.fill('');
  expect(await conversation.evaluate((element) => element.scrollTop)).toBe(place);

  // And again, because the terminal's own place is the half a second summon
  // cannot show: identical rendered rows means it was never re-attached and the
  // pane was never resized, which is what a replay or a refit would cost.
  await summon(page);
  expect(await screen(rows)).toBe(screenBefore);
  await dismiss(page);
  expect(await conversation.evaluate((element) => element.scrollTop)).toBe(place);
});

/**
 * The invariant the whole design rests on, and the one thing no other test says:
 * **tether's own chrome never resizes the terminal pane.**
 *
 * A change in the panes' height refits xterm, which posts a `resize` frame,
 * which resizes the tmux pane — and tmux makes the agent redraw its prompt into
 * the scrollback for *every other viewer* of that session. So the two pieces of
 * chrome that come and go while a session runs must both leave the pane's box
 * exactly where it was: the terminal being summoned and dismissed, and the
 * waiting banner mounting and unmounting as the agent stops and starts.
 *
 * Both are asserted as numbers — the pane's rectangle and xterm's own row count,
 * which is the second signal, because a refit that happened and undid itself
 * would leave the box right and the rows wrong at the moment it mattered.
 *
 * The measurement is `getBoundingClientRect` rather than `boundingBox()`:
 * Playwright reports no box for a `visibility: hidden` element, and the terminal
 * is deliberately behind the conversation for half of this test — which is the
 * state the assertion is *about*.
 */
test('tether’s own chrome never resizes the terminal pane', async ({ page }) => {
  mkdirSync(chrome, { recursive: true });
  // 360×640, the smallest phone the product targets, and set before the
  // baseline so the viewport never changes inside the test. It is also the
  // width at which the waiting reason cannot fit on one line, which is what
  // makes the "nothing is clipped" assertion below say anything.
  await page.setViewportSize({ width: 360, height: 640 });

  await page.goto('/');
  await page.getByLabel('Password').fill(process.env['TETHER_E2E_PASSWORD'] as string);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Working directory').fill(chrome);
  await page.getByRole('button', { name: 'Start' }).click();

  const conversation = page.locator('.conv');
  const rows = page.locator('.xterm-rows');
  const banner = page.locator('.waiting');
  const agentChip = page.locator('header .chip:not([role])');

  const geometry = async (): Promise<Record<string, number>> =>
    page.locator('.term').evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        rows: element.querySelector('.xterm-rows')?.childElementCount ?? 0,
      };
    });

  await expect(conversation.getByText(GREETING, { exact: true })).toHaveCount(1);

  // The baseline is taken with the terminal open and attached, which is the only
  // state xterm has certainly finished fitting in.
  await summon(page);
  await expect(page.locator('header .chip[role="status"]')).toHaveText('Live');
  await expect(rows).toContainText(GREETING);
  const settled = await geometry();
  expect(settled.rows).toBeGreaterThan(0);
  expect(settled.height).toBeGreaterThan(0);

  // ── summon and dismiss ─────────────────────────────────────────────────────
  await dismiss(page);
  expect(await geometry()).toEqual(settled);
  await summon(page);
  expect(await geometry()).toEqual(settled);

  // ── waiting, with the terminal up ──────────────────────────────────────────
  // Fired without dismissing, so tether does not hold and the agent's own prompt
  // takes the question — which is also what publishes `waiting`.
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(ASK_UP);
  await page.keyboard.press('Enter');
  writeFileSync(join(chrome, '.tether-e2e-fire'), '');
  await expect(agentChip).toHaveText('Waiting for you', { timeout: HOLD_MS });
  expect(await geometry()).toEqual(settled);

  // The banner's fact is still on screen while its element is not, and the way
  // out is still a whole tap target with nothing laid over it — the two things
  // the banner is allowed to cost by being an overlay rather than a row.
  await expect(page.locator('.termsheet-waiting')).toHaveCount(1);
  await expect(page.locator('.termsheet-waiting')).toContainText('Waiting for you');
  // Whole, not merely present: an ellipsis here cuts the *reason* — the one
  // thing this line exists to say — and "approving blind" is what this surface
  // is against. Measured rather than eyeballed, in both axes, because a
  // nowrap line clips sideways and a fixed-height one clips downwards.
  expect(
    await page.locator('.termsheet-waiting').evaluate((element) => ({
      sideways: element.scrollWidth - element.clientWidth,
      down: element.scrollHeight - element.clientHeight,
    })),
  ).toEqual({ sideways: 0, down: 0 });
  const close = await page
    .locator('.termsheet')
    .getByRole('button', { name: 'Close' })
    .boundingBox();
  expect(close?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expect(page.locator('.termsheet').getByRole('button', { name: 'Close' })).toBeInViewport({
    ratio: 1,
  });

  // …and back to idle, still with the terminal up.
  await page.keyboard.type(ANSWER);
  await page.keyboard.press('Enter');
  await expect(agentChip).toHaveText('Idle');
  expect(await geometry()).toEqual(settled);

  // ── waiting, with the terminal away ────────────────────────────────────────
  // The bigger half: here the banner really does mount and unmount, over a pane
  // whose box must not notice. Armed at the pane, then fired once the overlay is
  // demonstrably put away, which is what makes it a hold rather than a race.
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(ASK);
  await page.keyboard.press('Enter');
  await dismiss(page);
  expect(await geometry()).toEqual(settled);
  writeFileSync(join(chrome, '.tether-e2e-fire'), '');

  await expect(banner).toHaveCount(1, { timeout: HOLD_MS });
  expect(await geometry()).toEqual(settled);
  await shoot(page, '3-the-waiting-banner-is-an-overlay');

  // Covering the conversation's top rows is the price of not resizing the pane;
  // *disabling* them is not, so the banner is click-through everywhere except
  // its own link. Hit-tested rather than clicked: what is under the banner at
  // this moment is whatever the conversation happens to be showing, and the
  // claim is about which element receives the tap, not about what it does. The
  // assertion is that the *conversation* got it, not merely that the banner did
  // not: another inert layer in between would pass the weaker form while the
  // rows underneath stayed just as unreachable.
  const bannerBox = await banner.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  expect(bannerBox.height).toBeGreaterThan(0);
  const under = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x as number, y as number)?.closest('.conv') !== null,
    [bannerBox.x + 4, bannerBox.y + bannerBox.height - 4],
  );
  expect(under).toBe(true);

  // And the one thing that *is* meant to take a tap still does, at full size.
  const open = banner.getByRole('button', { name: 'Open the terminal' });
  const openBox = await open.boundingBox();
  expect(openBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(
      ([x, y]) => document.elementFromPoint(x as number, y as number)?.closest('.link') !== null,
      [
        (openBox as { x: number; width: number }).x + (openBox as { width: number }).width / 2,
        (openBox as { y: number; height: number }).y + (openBox as { height: number }).height / 2,
      ],
    ),
  ).toBe(true);

  await conversation.getByRole('button', { name: 'Approve' }).click();
  await expect(banner).toHaveCount(0, { timeout: HOLD_MS });
  await expect(agentChip).toHaveText('Idle');
  expect(await geometry()).toEqual(settled);
});

/**
 * The New session sheet is the one screen that grows with its copy — the Codex
 * hook note is an informed-consent obligation and is deliberately long — while
 * sitting in a `position: fixed` overlay that the page cannot scroll. Overflow
 * there goes off the *top*, taking the Agent picker with it, and it only shows
 * on a viewport shorter than the one it was last looked at on.
 *
 * So this asserts geometry rather than presence: the card's top edge against the
 * viewport, at the shortest phones and at a phone with the keyboard up. No
 * session is started, so it needs no agent — the sheet is asserted on before it
 * is submitted.
 */
for (const [width, height] of [
  [360, 640],
  [375, 667],
  [390, 500],
] as const) {
  test(`the New session sheet stays reachable at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.getByLabel('Password').fill(process.env['TETHER_E2E_PASSWORD'] as string);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.getByRole('button', { name: 'New session' }).click();
    const agent = page.getByLabel('Agent');
    await agent.selectOption('codex');
    // The note is what makes the sheet overflow; without it on screen this test
    // would pass on the layout it exists to catch.
    await expect(page.locator('.sheet .note')).toHaveCount(1);

    const card = page.locator('.sheet .card');
    const top = async (locator: Locator): Promise<number> => {
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      return (box as { y: number }).y;
    };
    expect(await top(card)).toBeGreaterThanOrEqual(0);

    // And the picker itself is not merely on screen but usable: scrolled to,
    // focused and changed back, which a control clipped out of the overlay
    // cannot be.
    await agent.scrollIntoViewIfNeeded();
    expect(await top(agent)).toBeGreaterThanOrEqual(0);
    await agent.selectOption('claude-code');
    await expect(agent).toHaveValue('claude-code');
  });
}
