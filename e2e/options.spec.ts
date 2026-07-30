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
 * Two claims live only here:
 *
 *  - **The two providers offer different controls.** Counted, not sampled: a
 *    Claude Code composer has Model and Effort and no Permissions, and a Codex
 *    composer has the reverse. A shared set would pass any presence check.
 *  - **A value that lowers the permission bar sends nothing until it is
 *    acknowledged.** The strong half is the negative one — the pane is read
 *    *while the warning is up* and must still be clean — because a gate that
 *    warns after sending is worse than no gate at all.
 *
 * Its own directories, like every other spec here: the suite shares one `tether
 * serve` and one session list, and two sessions in one directory would share a
 * title and make every by-name locator ambiguous.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { dismiss, shots, summon } from './ui.ts';

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
 * The stub echoes every line typed at it, so a command that arrived shows up
 * twice — as the line and as its echo — and one that did not shows up not at
 * all. Scoped to `.xterm-rows` because both panes stay mounted.
 */
const rows = (page: Page): Locator => page.locator('.xterm-rows');

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

  // Claude Code takes its model and effort as slash-command arguments, so both
  // are offered. Its permission mode is not: the only mid-session mechanism is
  // a blind Shift+Tab cycle whose current position tether cannot read.
  await expect(page.getByLabel('Model')).toHaveCount(1);
  await expect(page.getByLabel('Effort')).toHaveCount(1);
  await expect(page.getByLabel('Permissions')).toHaveCount(0);
  await shoot(page, '1-claude-composer');

  await page.getByLabel('Effort').selectOption('medium');
  // The control is a menu, not a display of the agent's state — tether cannot
  // read most of these back from a running pane, so it resets rather than
  // claiming a value it would have no way to keep true.
  await expect(page.getByLabel('Effort')).toHaveValue('');

  await summon(page);
  await expect(rows(page).getByText('/effort medium')).toHaveCount(2);
  // The other axis, so this proves a table rather than one wired control.
  await expect(rows(page).getByText('/model sonnet')).toHaveCount(0);
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
  await shoot(page, '2-codex-composer');

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
});
