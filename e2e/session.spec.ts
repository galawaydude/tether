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
import { join } from 'node:path';

/** This spec's own directory inside the sandbox; `serve.ts` makes it. */
const project = join(process.env['TETHER_E2E_DIR'] as string, 'project');

/** What `e2e/stub-agent.ts` prints and records; the reload counts them. */
const GREETING = 'stub agent ready';
const TYPED = 'ping from the phone';
const REPLY = `echo ${TYPED}`;

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

  await page.getByRole('button', { name: 'Terminal' }).click();
  // Before typing, not for tidiness: keystrokes sent at a socket that has not
  // opened are dropped, and that is a real flake rather than a slow assertion.
  await expect(status).toHaveText('Live');
  await expect(rows).toContainText(GREETING);

  await page.locator('.xterm-screen').click();
  await page.keyboard.type(TYPED);
  await page.keyboard.press('Enter');
  await expect(rows).toContainText(REPLY);
  const before = await screen(rows);

  await page.getByRole('button', { name: 'Conversation' }).click();
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

  await page.getByRole('button', { name: 'Terminal' }).click();
  await expect(status).toHaveText('Live');
  await expect(rows).toContainText(REPLY);
  // Identical, not merely "contains": a replay that repeated itself, dropped a
  // line, or leaked an escape sequence all show up here and only here.
  expect(await screen(rows)).toBe(before);
});
