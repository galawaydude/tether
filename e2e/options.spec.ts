/**
 * The composer's option controls, end to end and per provider.
 *
 * `web/src/options.test.ts` owns the table — which axes each agent has, which
 * keystrokes each value sends, and which values have to be acknowledged first.
 * What no unit test can say is that the chain agrees: a native `<select>` in
 * the conversation pane, the `input` frames it turns into, the *terminal*
 * pane's socket they leave on, tmux's paste buffer, and the pane at the far end
 * of it. A control that looks live and reaches nothing is the exact failure
 * this feature is not allowed to be, so the assertion is the pane's own text.
 *
 * Four claims live only here:
 *
 *  - **The two providers offer different controls.** Counted, not sampled: a
 *    Claude Code composer has Model, Effort and Permission mode, and a Codex
 *    composer has none of those and a Permissions picker instead. A shared set
 *    would pass any presence check.
 *  - **A value that lowers the permission bar sends nothing until it is
 *    acknowledged.** The strong half is the negative one — the pane is read
 *    *while the warning is up* and must still be clean — because a gate that
 *    warns after sending is worse than no gate at all.
 *  - **A permission mode the server could not confirm is never claimed.** The
 *    assertion that matters is the absence of "is now": a note saying something
 *    went wrong and a note saying the mode changed are both "a note".
 *  - **Every action in the panel is reachable at 360×340 with the warning gate
 *    up.** Measured, because Playwright scrolls before it clicks and would drive
 *    a confirm button that is off screen for a real thumb. This is the third
 *    panel in this product to grow past a small viewport, so it fails loudly
 *    here rather than waiting for a reviewer.
 *
 * Its own directories, like every other spec here: the suite shares one `tether
 * serve` and one session list, and two sessions in one directory would share a
 * title and make every by-name locator ambiguous.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { dismiss, KEYBOARD_UP, reachable, shots, summon } from './ui.ts';

const dir = process.env['TETHER_E2E_DIR'] as string;
const shoot = shots('options');

const GREETING = 'stub agent ready';

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Password').fill(process.env['TETHER_E2E_PASSWORD'] as string);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/**
 * What the pane has actually received, read through the terminal overlay.
 *
 * The stub acts out a slash command as a command (`e2e/stub-agent.ts`), so one
 * that arrived shows up as the line *and* as the agent's own answer to it, and
 * one that did not shows up not at all. Scoped to `.xterm-rows` because both
 * panes stay mounted.
 */
const rows = (page: Page): Locator => page.locator('.xterm-rows');

/**
 * The conversation, which for an argument-bearing slash command is now the other
 * half of the evidence: `/model x` and `/effort x` write `<command-name>` and
 * `<local-command-stdout>`, and the mapper renders both — so this panel's own
 * claim that "the agent's answer in the conversation is the confirmation" is
 * something a test can check rather than an intention.
 */
const conversation = (page: Page): Locator => page.locator('.conv');

async function openOptions(page: Page): Promise<void> {
  const panel = page.locator('.composer-settings');
  if ((await panel.getAttribute('open')) === null) {
    await panel.locator('summary').click();
  }
  await expect(panel).toHaveAttribute('open', '');
}

/**
 * Ready is the *terminal* being attached, not the conversation having a line in
 * it. The stub writes a Claude-Code-shaped transcript whichever name it is run
 * under, so a Codex session driven through it never gets a conversation at all
 * — and the option controls do not need one: they send keystrokes on the
 * terminal socket, which is what "Live" reports.
 */
async function start(page: Page, project: string, provider: string): Promise<void> {
  mkdirSync(project, { recursive: true });
  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Agent').selectOption(provider);
  await page.getByLabel('Working directory').fill(project);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.bar-chips').getByText('Live', { exact: true })).toHaveCount(1);
  await summon(page);
  await expect(rows(page).getByText(GREETING)).toHaveCount(1);
  await dismiss(page);
}

test('each provider offers its own controls, and they reach the pane', async ({ page }) => {
  await signIn(page);
  await start(page, join(dir, 'options-claude'), 'claude-code');

  // Claude Code takes its model and effort as slash-command arguments, and its
  // permission mode by a cycle whose position the server can read off the pane.
  // Codex's own permissions picker is a different axis with a different name, so
  // neither label can match the other's control.
  await expect(page.getByLabel('Model')).toHaveCount(1);
  await expect(page.getByLabel('Effort')).toHaveCount(1);
  await expect(page.getByLabel('Permission mode')).toHaveCount(1);
  await expect(page.getByLabel('Permissions')).toHaveCount(0);
  await shoot(page, '1-claude-composer');

  await openOptions(page);
  await page.getByLabel('Effort').selectOption('medium');
  // The control is a menu, not a display of the agent's state — tether cannot
  // read most of these back from a running pane, so it resets rather than
  // claiming a value it would have no way to keep true.
  await expect(page.getByLabel('Effort')).toHaveValue('');

  // The applied line, and it is now the *agent's answer* rather than the stub
  // echoing the keystrokes back: since `e2e/stub-agent.ts` acts out a slash
  // command as a command, `/effort medium` appears once — the line the pane
  // received — and `Set effort level to medium` is what says it landed.
  await expect(conversation(page).locator('.cmd')).toHaveCount(2);
  await expect(
    conversation(page).getByText('Set effort level to medium', { exact: true }),
  ).toHaveCount(1);

  await summon(page);
  await expect(rows(page).getByText('/effort medium')).toHaveCount(1);
  await expect(rows(page).getByText('Set effort level to medium')).toHaveCount(1);
  // The other axis, so this proves a table rather than one wired control.
  await expect(rows(page).getByText('/model sonnet')).toHaveCount(0);
  // The pane itself, because "the control reaches the agent" is the one claim of
  // this feature a reviewer cannot take on trust from a screenshot of the panel.
  await shoot(page, '1b-claude-pane');
  await dismiss(page);

  // ── the narrowest phone, and then its keyboard ─────────────────────────────
  // Agent settings are collapsed by default so they do not permanently take
  // half the composer. While deliberately open at 360px, every native control
  // and Send still has to remain reachable.
  await page.setViewportSize({ width: 360, height: 640 });
  // The placeholder fits the single row a textarea has before it is typed in,
  // so its second half is not simply cut off.
  expect(
    await page
      .locator('.composer-text')
      .evaluate((el) => el.scrollHeight - (el as HTMLElement).clientHeight),
  ).toBeLessThanOrEqual(0);
  // Every control is reachable: nothing is clipped out of the panel sideways,
  // and each is a real 44px target.
  const controls = page.locator('.composer-opt, .composer button.primary');
  await expect(controls).toHaveCount(4);
  const panel = (await page.locator('.composer').boundingBox()) as { x: number; width: number };
  for (const box of await controls.evaluateAll((els) =>
    els
      .map((el) => el.getBoundingClientRect())
      .map((r) => ({ x: r.x, right: r.right, h: r.height })),
  )) {
    expect(box.h).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(panel.x);
    expect(box.right).toBeLessThanOrEqual(panel.x + panel.width + 0.5);
  }
  await shoot(page, '5-claude-360');

  // 360×340 is this phone with its keyboard up, and it is the size that finds a
  // composer able to eat the conversation it belongs to. The expanded settings
  // are intentionally temporary, but Send must still be on screen. And
  // not Send alone: every control in the panel, by the same rule the sheet and
  // the permission card are held to.
  await page.setViewportSize(KEYBOARD_UP);
  await page.locator('.composer-text').fill('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight');
  for (const name of ['Model', 'Effort', 'Permission mode']) {
    await reachable(page, page.getByLabel(name), name);
  }
  await reachable(page, page.locator('.composer button.primary'), 'Send');
  await shoot(page, '6-claude-360x340');

  // ── and the same screen with the warning gate up ───────────────────────────
  // The gate is a third child of the composer's column and is *not* in the
  // message box's height budget: its sentence, its Cancel and its confirm are
  // ~170px on top of a panel that already filled the pane. This is the third
  // time a panel has grown past a small viewport in this product, so it is
  // asserted rather than left to be noticed — and asserted as reachability of
  // every action, because the confirm being the one below the fold is exactly
  // the surface where a user is being asked to lower their own protection.
  await page.getByLabel('Permission mode').selectOption('acceptEdits');
  await expect(page.locator('.composer-warn')).toHaveCount(1);
  // The panel bounds itself and scrolls inside, so nothing it grows by ever
  // leaves the page. A document taller than the viewport is the failure whether
  // or not a control could be scrolled to afterwards — the header and the
  // conversation scrolling away with it is not a fix.
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight),
  ).toBeLessThanOrEqual(0);
  for (const name of ['Cancel', 'Set permission mode to Accept edits', 'Send']) {
    await reachable(page, page.getByRole('button', { name, exact: true }), name);
  }
  await shoot(page, '7-claude-360x340-warned');
});

/**
 * The permission-mode axis, which is the one that cannot be answered by reading
 * the pane for a keystroke: it is a request, and what the browser is allowed to
 * say is bounded by what the server *confirmed by reading the pane back*.
 *
 * The stub is not Claude Code and paints no status footer, so the server cannot
 * read a mode from it — which makes this the unreadable case, and the unreadable
 * case is the one worth driving through a browser. Reaching every mode from
 * every mode is `permission-mode.test.ts`'s job, against real tmux and a pane
 * that does cycle.
 */
test('an unreadable pane is reported, never dressed up as a mode that was set', async ({
  page,
}) => {
  await signIn(page);
  await start(page, join(dir, 'options-mode'), 'claude-code');
  await openOptions(page);

  // `plan` lowers nothing, so it applies without a gate — and still must not
  // claim to have worked when the server could not read the pane.
  await page.getByLabel('Permission mode').selectOption('plan');
  const note = page.locator('.composer-note');
  await expect(note).toContainText(/could not read the current permission mode/i);
  await expect(note).toContainText(/nothing was changed/i);
  // The sentence that would be the lie. Checked explicitly because "shows a
  // note" passes just as happily on a note claiming success.
  await expect(note).not.toContainText(/is now/i);
  await shoot(page, '4-mode-unreadable');
});

test('a mode that lowers the permission bar is held until it is acknowledged', async ({ page }) => {
  await signIn(page);
  await start(page, join(dir, 'options-mode-warn'), 'claude-code');
  await openOptions(page);

  // `acceptEdits` stops Claude Code asking before it writes to files, so it gets
  // the same treatment as Codex's presets rather than being a quiet list entry.
  await page.getByLabel('Permission mode').selectOption('acceptEdits');
  const confirm = page.getByRole('button', { name: 'Set permission mode to Accept edits' });
  await expect(confirm).toHaveCount(1);
  // Nothing has been attempted yet: no outcome line at all, which is what makes
  // this a gate rather than a warning shown alongside the thing it warns about.
  await expect(page.locator('.composer-note')).toHaveCount(0);

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('.composer-note')).toHaveCount(0);

  // And through the gate the request really is made — the honest failure from
  // the stub's unreadable pane is the proof it went.
  await page.getByLabel('Permission mode').selectOption('acceptEdits');
  await page.getByRole('button', { name: 'Set permission mode to Accept edits' }).click();
  await expect(page.locator('.composer-note')).toContainText(/could not read/i);
});

test('a Codex composer offers Codex’s axis, and warns before it lowers the bar', async ({
  page,
}) => {
  await signIn(page);
  await start(page, join(dir, 'options-codex'), 'codex');

  // The mirror of the first test: Codex's slash commands take no argument at
  // all — `/model gpt-5.6-terra` is sent to the model as a prompt — so its
  // model and effort are absent and its fixed permissions picker is not.
  await expect(page.getByLabel('Permissions')).toHaveCount(1);
  await expect(page.getByLabel('Model')).toHaveCount(0);
  await expect(page.getByLabel('Effort')).toHaveCount(0);
  await expect(page.getByLabel('Permission mode')).toHaveCount(0);
  await shoot(page, '2-codex-composer');

  await openOptions(page);
  // The value that asks for everything applies straight away: there is nothing
  // to warn about, and a warning there would teach a user to click past the
  // ones that matter.
  await page.getByLabel('Permissions').selectOption('ask');
  await summon(page);
  await expect(rows(page).getByText('/permissions')).toHaveCount(2);
  await dismiss(page);

  // Full access is the opposite: nothing may reach the pane until the sentence
  // has been read.
  await page.getByLabel('Permissions').selectOption('full');
  const confirm = page.getByRole('button', { name: 'Set permissions to Full access' });
  await expect(confirm).toHaveCount(1);
  await shoot(page, '3-codex-warning');

  await summon(page);
  // Still two — the `ask` pair from above and nothing since. This is the claim
  // the whole gate exists for, and it is checked before the confirmation rather
  // than after, when a leak would already have happened.
  await expect(rows(page).getByText('/permissions')).toHaveCount(2);
  await dismiss(page);

  await confirm.click();
  await expect(confirm).toHaveCount(0);
  await summon(page);
  await expect(rows(page).getByText('/permissions')).toHaveCount(4);
  // The digit is a second frame and it is what picks the preset, so a sequence
  // that stopped after the command would look applied and change nothing. The
  // stub's echo of it is what proves it arrived as its own line rather than
  // glued to the command.
  await expect(rows(page).getByText('echo 3')).toHaveCount(1);
  await shoot(page, '3b-codex-pane');
});
