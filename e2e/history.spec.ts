/**
 * A real long-running transcript, and the refresh path that used to blank it.
 *
 * The live Mac session that exposed this held 5,079 mapped events: the history
 * route sent all 4.1 MB of them and the browser mounted every row again after a
 * reload. This fixture is only large enough to cross the product's bound; the
 * assertion is the same shape without putting megabytes in CI.
 */

import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env['TETHER_E2E_DIR'] as string;
const project = join(home, 'long-history');
const title = 'long history';
const MAX_ROWS = 512;

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Password').fill(process.env['TETHER_E2E_PASSWORD'] as string);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

function transcript(): string {
  const sanitised = realpathSync(project).replace(/[^a-zA-Z0-9]/g, '-');
  const dir = join(home, '.claude', 'projects', sanitised);
  const file = readdirSync(dir).find((name) => name.endsWith('.jsonl'));
  if (file === undefined) throw new Error(`no transcript under ${dir}`);
  return join(dir, file);
}

function appendReplies(count: number): void {
  let records = '';
  for (let index = 0; index < count; index += 1) {
    records += `${JSON.stringify({
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date(Date.now() + index).toISOString(),
      version: '2.1.220',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `history reply ${index}` }],
      },
    })}\n`;
  }
  appendFileSync(transcript(), records);
}

test('a large conversation resumes and survives reload without blanking the view', async ({
  page,
}) => {
  mkdirSync(project, { recursive: true });
  await signIn(page);

  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Working directory').fill(project);
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('.conv').getByText('stub agent ready', { exact: true })).toHaveCount(1);

  // Close the viewer before the bulk append: opening it again has to use the
  // HTTP history path a browser refresh uses, not the already-running tailer.
  await page.getByRole('button', { name: 'Back to sessions' }).click();
  appendReplies(MAX_ROWS + 88);
  await page.getByRole('button', { name: `${title} ${project}` }).click();

  const conversation = page.locator('.conv');
  await expect(
    conversation.getByText(`history reply ${MAX_ROWS + 87}`, { exact: true }),
  ).toHaveCount(1);
  await expect(conversation.getByText('history reply 0', { exact: true })).toHaveCount(0);
  await expect(conversation.locator('.msg')).toHaveCount(MAX_ROWS);
  await expect(conversation.locator('.history-note')).toContainText('Earlier conversation');

  // Older history is reachable, but one bounded page at a time: this must not
  // restore the original 4 MB response and thousands of mounted rows merely to
  // make the first turn accessible.
  await conversation.getByRole('button', { name: 'Load earlier' }).click();
  await expect(conversation.getByText('history reply 0', { exact: true })).toHaveCount(1);
  await expect(
    conversation.getByText(`history reply ${MAX_ROWS + 87}`, { exact: true }),
  ).toHaveCount(0);
  await expect(conversation.locator('.msg')).toHaveCount(89);
  await expect(conversation.locator('.history-note')).toContainText('events 1–89');
  await conversation.getByRole('button', { name: 'Back to latest' }).click();
  await expect(
    conversation.getByText(`history reply ${MAX_ROWS + 87}`, { exact: true }),
  ).toHaveCount(1);
  await expect(conversation.locator('.msg')).toHaveCount(MAX_ROWS);

  // No manual trip through the list: the URL restores the open session and the
  // bounded suffix is reconstructed from its current transcript.
  await page.reload();
  await expect(
    conversation.getByText(`history reply ${MAX_ROWS + 87}`, { exact: true }),
  ).toHaveCount(1);
  await expect(conversation.locator('.msg')).toHaveCount(MAX_ROWS);
  await expect(conversation.locator('.history-note')).toHaveCount(1);
});
