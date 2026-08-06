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
 *
 * The second test is the same chain for a **slash command**, and it is here
 * rather than in its own spec because it is the same transport with one branch in
 * front of it. What it checks that no unit test can: that a command is not
 * rendered as a message, that the one whose answer the transcript keeps really
 * arrives in the conversation, and that the one whose answer is a chooser reaches
 * the pane and says so instead of pretending.
 */

import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { dismiss, KEYBOARD_UP, reachable, shots, summon } from './ui.ts';

/**
 * Its own directory, like `permission.spec.ts`'s: the three specs share one
 * `tether serve` and one session list, and two sessions in one directory would
 * share a title and make every by-name locator ambiguous.
 */
const project = join(process.env['TETHER_E2E_DIR'] as string, 'composer');

const shoot = shots('composer');

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
  await shoot(page, '1-newline');

  await box.fill('');
  await box.fill(TYPED);
  await shoot(page, '2-filled');

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

  // Copy is a phone control too: visible without hover, copies exactly what is
  // shown, and confirms the tap instead of silently hoping the browser allowed it.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  const copy = conversation.getByRole('button', { name: 'Copy your text' });
  await expect(copy).toHaveCount(1);
  await copy.click();
  await expect(copy).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TYPED);
  await shoot(page, '3-sent');

  // And it really went through tmux to the agent, not just into the view.
  await summon(page);
  await expect(page.locator('.xterm-rows')).toContainText(REPLY);
  await dismiss(page);

  // ── the sender is rewired on remount ───────────────────────────────────────
  // A composed message leaves on the *terminal* pane's socket, through a ref
  // `app.tsx` holds and `terminal.tsx` fills in. A reload drops both panes, both
  // sockets and the ref, so this is where a rewiring that never happens shows
  // up — as a Send button that empties the box and does nothing else.
  await page.reload();
  // The session id in the URL remounts this same screen directly; the sender
  // ref and both sockets are still entirely new.
  await expect(page.getByRole('button', { name: 'Back to sessions' })).toHaveCount(1);
  await expect(conversation.getByText(TYPED, { exact: true })).toHaveCount(1);

  await box.fill(AGAIN);
  await send.click();
  await expect(box).toHaveValue('');
  await expect(conversation.getByText(`echo ${AGAIN}`, { exact: true })).toHaveCount(1);
  await expect(conversation.getByText(AGAIN, { exact: true })).toHaveCount(1);
  await expect(conversation.locator('.msg-sending')).toHaveCount(0);

  // ── the keyboard-open case ─────────────────────────────────────────────────
  // `KEYBOARD_UP` is this phone with its keyboard up, and it is the viewport that
  // finds a composer able to eat the conversation it belongs to. A tall message
  // must leave Send reachable and must not push its own pane sideways.
  await page.setViewportSize(KEYBOARD_UP);
  await box.fill('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten');
  await reachable(page, send, 'Send');
  // Measured on the conversation pane rather than the document: the terminal
  // pane stays mounted and absolutely positioned, and xterm does not re-fit a
  // pane it cannot measure, so a document-wide check reports the *other* pane's
  // stale geometry. What this pane owns is that its own text wraps.
  expect(
    await conversation.evaluate((el) => [el.scrollWidth - el.clientWidth, el.clientWidth]),
  ).toEqual([0, 360]);
  await shoot(page, '4-keyboard-open');
});

/** A real one-pixel PNG: the server checks bytes rather than believing its MIME type. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const imageProject = join(process.env['TETHER_E2E_DIR'] as string, 'composer-image');

test('an image pasted into the conversation is previewed, sent and still viewable after reload', async ({
  page,
}) => {
  mkdirSync(imageProject, { recursive: true });
  await page.goto('/');
  await page.getByLabel('Password').fill(process.env['TETHER_E2E_PASSWORD'] as string);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Working directory').fill(imageProject);
  await page.getByRole('button', { name: 'Start' }).click();

  const box = page.getByLabel('Message');
  await box.evaluate((element, encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }));
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, PIXEL);

  const draft = page.locator('.composer-image');
  await expect(draft).toHaveCount(1);
  await expect(draft.getByRole('img', { name: 'Pasted image 1' })).toBeVisible();
  await expect(draft.getByRole('link', { name: 'View pasted image 1 full size' })).toHaveAttribute(
    'href',
    /^blob:/,
  );
  await shoot(page, '4b-image-preview');

  await page.getByRole('button', { name: 'Send' }).click();
  await expect(draft).toHaveCount(0);
  const sent = page.locator('.msg-user .msg-images');
  await expect(sent).toHaveCount(1);
  await expect(page.locator('.conv .msg-sending')).toHaveCount(0);
  await expect(page.locator('.conv').getByText('echo image received', { exact: true })).toHaveCount(
    1,
  );
  const image = sent.getByRole('img', { name: 'Pasted image 1' });
  await expect(image).toBeVisible();
  const src = await image.getAttribute('src');
  expect(src).toMatch(/^\/api\/sessions\/.+\/images\/[0-9a-f-]{36}\.png$/);
  const response = await page.request.get(src!);
  expect(response.status()).toBe(200);
  expect((await response.body()).subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  await shoot(page, '4c-image-sent');

  await page.reload();
  await expect(page.locator('.msg-user .msg-images img')).toHaveCount(1);
  await expect(page.locator('.msg-user .msg-images img')).toBeVisible();
});

/** Its own directory, so this test's session has its own name in the shared list. */
const commandProject = join(process.env['TETHER_E2E_DIR'] as string, 'composer-cmd');

test('a slash command goes to the agent as a command, not as a prompt', async ({ page }) => {
  mkdirSync(commandProject, { recursive: true });

  await page.goto('/');
  await page.getByLabel('Password').fill(process.env['TETHER_E2E_PASSWORD'] as string);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Working directory').fill(commandProject);
  await page.getByRole('button', { name: 'Start' }).click();

  const conversation = page.locator('.conv');
  const box = page.getByLabel('Message');
  const send = page.getByRole('button', { name: 'Send' });
  await expect(conversation.getByText(GREETING, { exact: true })).toHaveCount(1);

  // ── discoverability ────────────────────────────────────────────────────────
  // The placeholder says `/ commands`; this is what makes that true. It appears
  // only while a command is being typed, and it is not there for ordinary text.
  await box.fill('summarise');
  await expect(page.locator('.composer-cmds')).toHaveCount(0);
  await box.fill('/re');
  const list = page.locator('.composer-cmds');
  await expect(list.getByRole('button')).toHaveCount(2);
  await expect(list.getByText('/resume', { exact: true })).toHaveCount(1);
  await shoot(page, '5-command-list');

  // Tapping fills the box rather than sending: a mis-tap on this surface must not
  // be the one that runs `/clear`.
  await list.getByRole('button').first().click();
  await expect(box).toHaveValue('/resume');

  // ── the chooser case: reported, never claimed ──────────────────────────────
  await send.click();
  await expect(box).toHaveValue('');
  // Not a message. No echo, no "Sending…", and no `You` bubble carrying the
  // command — a card that never retires is exactly what the message path would
  // have produced here, since a command writes no `user` record.
  await expect(conversation.locator('.msg-sending')).toHaveCount(0);
  await expect(conversation.getByText('/resume', { exact: true })).toHaveCount(0);
  // What it says instead: where the answer is, and the way there.
  const note = page.locator('.composer-note');
  await expect(note).toContainText('chooser Remote Control Agent cannot show');
  await shoot(page, '6-command-sent');

  // And it really reached the agent — which for this one is only provable in the
  // pane, because a chooser writes nothing anywhere else. That is the claim the
  // note is making, checked rather than trusted.
  await page.getByRole('button', { name: 'Show the terminal' }).click();
  await expect(page.locator('.xterm-rows')).toContainText('Resume session');
  await shoot(page, '7-terminal-opened');
  await dismiss(page);

  // ── the recorded case: shown, so nothing has to be claimed ─────────────────
  // `/model sonnet` writes `<command-name>` and `<local-command-stdout>`, and the
  // mapper renders both. So the conversation *is* the confirmation, and the note
  // says so without offering a terminal nobody needs.
  await box.fill('/model sonnet');
  await send.click();
  await expect(conversation.locator('.cmd')).toHaveCount(2);
  await expect(conversation.getByText('/model sonnet', { exact: true })).toHaveCount(1);
  await expect(
    conversation.getByText('Set model to sonnet and saved as your default for new sessions', {
      exact: true,
    }),
  ).toHaveCount(1);
  // The colour codes the agent wrote around the model name are gone rather than
  // sitting in the page as a literal `[1m`.
  await expect(conversation.locator('.cmd-out')).not.toContainText('[1m');
  await expect(note).toContainText('lands above');
  await expect(page.getByRole('button', { name: 'Show the terminal' })).toHaveCount(0);
  await shoot(page, '8-command-recorded');

  // ── ordinary text is still ordinary text ───────────────────────────────────
  // The branch is a leading slash and nothing else: a message that merely
  // mentions one is a message, and it still gets the echo and the reply.
  await box.fill('run /resume for me');
  await send.click();
  await expect(conversation.getByText('echo run /resume for me', { exact: true })).toHaveCount(1);
  await expect(conversation.getByText('run /resume for me', { exact: true })).toHaveCount(1);

  // ── the list may not push Send off a phone with its keyboard up ────────────
  // This panel is `overflow-y: auto` for the bar-lowering warning's sake, so a
  // list taller than the pane scrolls Send out of reach rather than clipping
  // visibly. `KEYBOARD_UP` is the viewport that finds it.
  await page.setViewportSize(KEYBOARD_UP);
  await box.fill('/');
  await expect(page.locator('.composer-cmds button')).toHaveCount(6);
  await reachable(page, send, 'Send');
  expect(await conversation.evaluate((el) => el.scrollWidth - el.clientWidth)).toEqual(0);
  await shoot(page, '9-list-keyboard-open');
});
