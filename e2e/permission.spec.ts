/**
 * The other end-to-end claim, and the one PR #10 exists for: during a permission
 * prompt the conversation view is **not** blind.
 *
 * Claude Code writes nothing to its transcript until the turn commits, so a
 * transcript-only view has nothing at all to show at exactly the moment a user
 * reaches for their phone (report §4, risk 2). Everything below the browser is
 * unit-tested; what is not, and cannot be, is the whole chain agreeing —
 * `startSession` installing the hook into the project, the agent's own process
 * exec'ing that shim, the shim finding the secret and the endpoint beside
 * itself, `POST /internal/hook`, and the `pending` and `state` frames arriving
 * on a socket the browser already had open.
 *
 * `e2e/stub-agent.ts` plays the agent, so CI still never runs a live one. It
 * publishes its own `~/.claude/sessions/<pid>.json` and runs whatever
 * `.claude/settings.local.json` says, and it knows nothing about where tether's
 * shim, secret or endpoint are — if the installer did not write that file, this
 * test fails rather than quietly proving nothing.
 *
 * The assertion that matters is a **count**: the transcript's record for the
 * same call must replace the proposed card, not sit beside it.
 */

import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Its own directory inside the sandbox, not `session.spec.ts`'s. The three specs
 * share one `tether serve`, and that spec asserts on counts — a second session
 * in the same directory would give both rows the same title and make its
 * post-reload locator ambiguous.
 */
const project = join(process.env['TETHER_E2E_DIR'] as string, 'permission');

/** Where a reviewer's copies go; set by the runner, ignored when it is not. */
const evidence = process.env['TETHER_E2E_SHOTS'];

const GREETING = 'stub agent ready';
const ASK = 'ask to run something';
const ANSWER = 'yes';
const COMMAND = 'rm -rf ./build';

test('a permission prompt is visible before the transcript has it, and reconciles to one card', async ({
  page,
}) => {
  // `e2e/serve.ts` wipes the sandbox at startup, so this is made here rather
  // than there — it belongs to this spec and nothing else needs it.
  mkdirSync(project, { recursive: true });

  await page.goto('/');
  await page.getByLabel('Password').fill(process.env['TETHER_E2E_PASSWORD'] as string);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Working directory').fill(project);
  await page.getByRole('button', { name: 'Start' }).click();

  const conversation = page.locator('.conv');
  const connection = page.locator('header .chip[role="status"]');
  const agentChip = page.locator('header .chip:not([role])');
  const banner = page.locator('.waiting');
  const cards = conversation.locator('details.tool');

  await expect(conversation.getByText(GREETING, { exact: true })).toHaveCount(1);
  // Idle before anything is asked: the poller has read the agent's own file.
  await expect(agentChip).toHaveText('Idle');

  // ── the prompt ─────────────────────────────────────────────────────────────
  // Typed at the pane, which is how a real one starts.
  await page.getByRole('button', { name: 'Terminal' }).click();
  await expect(connection).toHaveText('Live');
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(ASK);
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('Do you want to proceed?');

  // The user's own words, above both panes, while they are still on the
  // terminal — which is the tab that can actually answer it.
  await expect(banner).toContainText('Waiting for you.');
  await expect(banner).toContainText('Claude needs your permission to use Bash');
  await expect(agentChip).toHaveText('Waiting for you');
  if (evidence !== undefined) {
    await page.screenshot({ path: join(evidence, '1-terminal-waiting.png') });
  }

  // And the card, built from the hook alone: the transcript still has nothing
  // about this call.
  await page.getByRole('button', { name: 'Conversation' }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.locator('.tool-state')).toHaveText('asking');
  await cards.locator('summary').click();
  await expect(cards).toContainText(COMMAND);
  await expect(cards).toContainText('Waiting for you to answer in the terminal.');
  if (evidence !== undefined) {
    await page.screenshot({ path: join(evidence, '2-conversation-pending.png') });
  }

  // The list badge, from the same poller over the agent's own registry file.
  await page.getByRole('button', { name: 'Back to sessions' }).click();
  await expect(page.locator('.chip-agent-waiting')).toHaveText('Waiting for you');
  if (evidence !== undefined) {
    await page.screenshot({ path: join(evidence, '3-session-list-waiting.png') });
  }

  // ── the answer ─────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: `permission ${project}` }).click();
  await page.getByRole('button', { name: 'Terminal' }).click();
  await expect(connection).toHaveText('Live');
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(ANSWER);
  await page.keyboard.press('Enter');

  await page.getByRole('button', { name: 'Conversation' }).click();
  // The claim. The transcript's `tool_use` carries the same `tool_use_id` the
  // hook announced, so it supersedes that card in place. Two cards here is the
  // failure this reconciliation exists to prevent, and `toContainText` would
  // pass just as happily on it.
  await expect(cards).toHaveCount(1);
  await expect(cards.locator('.tool-state')).toHaveText('✓');
  await expect(cards).toContainText('removed ./build');
  await expect(banner).toHaveCount(0);
  await expect(agentChip).toHaveText('Idle');
  if (evidence !== undefined) {
    await page.screenshot({ path: join(evidence, '4-conversation-reconciled.png') });
  }
});
