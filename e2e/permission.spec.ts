/**
 * The other end-to-end claim, and the one the hook exists for: during a
 * permission prompt the conversation view is **not** blind — and, since the
 * captain's decision, it is where the prompt is answered.
 *
 * Claude Code writes nothing to its transcript until the turn commits, so a
 * transcript-only view has nothing at all to show at exactly the moment a user
 * reaches for their phone (report §4, risk 2). Everything below the browser is
 * unit-tested; what is not, and cannot be, is the whole chain agreeing —
 * `startSession` installing the hook into the project, the agent's own process
 * exec'ing that shim, the shim finding the secret and the endpoint beside
 * itself, `POST /internal/hook` **staying open**, a tap reaching
 * `POST /api/sessions/:id/permission`, and the decision travelling back out of
 * the shim's stdout into the agent's own turn.
 *
 * `e2e/stub-agent.ts` plays the agent, so CI still never runs a live one. It
 * publishes its own `~/.claude/sessions/<pid>.json`, runs whatever
 * `.claude/settings.local.json` says, and — the part that matters here — reads
 * the hook's stdout and honours the decision, exactly as Claude Code does. It
 * knows nothing about where tether's shim, secret or endpoint are: if the
 * installer did not write that file, this test fails rather than quietly proving
 * nothing.
 *
 * Three assertions carry the weight, and each is a **count** or an **absence**
 * rather than a presence, because `toContainText` passes just as happily on a
 * duplicated card or a double answer:
 *
 *  1. Approve runs it, and the transcript's record replaces the card it was
 *     approved on rather than sitting beside it.
 *  2. Deny blocks it — the command never ran — and the card says so.
 *  3. A hold nobody answers hands the question back to Claude Code's own prompt,
 *     answering *there* still reconciles to one card, and a `yes` typed at the
 *     pane after tether already approved something approves nothing at all.
 */

import { expect, test, type Page } from '@playwright/test';
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

/** The server's own hold, from the one place it is configured. */
const HOLD_MS = Number(process.env['TETHER_E2E_HOLD_SECONDS'] ?? '15') * 1000;

const GREETING = 'stub agent ready';
const ASK = 'ask to run something';
const ASK_DENY = 'ask to run the other thing';
const ASK_WAIT = 'ask and wait it out';
const ANSWER = 'yes';

async function shoot(page: Page, name: string): Promise<void> {
  if (evidence !== undefined) await page.screenshot({ path: join(evidence, `${name}.png`) });
}

/** Types at the pane, which is how a real prompt starts, then comes back. */
async function askAt(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('header .chip[role="status"]')).toHaveText('Live');
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
}

test('a permission prompt is answered from the conversation view, and only once', async ({
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
  const agentChip = page.locator('header .chip:not([role])');
  const banner = page.locator('.waiting');
  const cards = conversation.locator('details.tool');
  const approve = conversation.getByRole('button', { name: 'Approve' });
  const deny = conversation.getByRole('button', { name: 'Deny' });

  await expect(conversation.getByText(GREETING, { exact: true })).toHaveCount(1);
  await expect(agentChip).toHaveText('Idle');

  // ── approve ────────────────────────────────────────────────────────────────
  await askAt(page, ASK);

  // The card is built from the hook alone — the transcript still has nothing
  // about this call — and it opens itself, because approving a tool name and a
  // clipped line is approving blind.
  await expect(cards).toHaveCount(1);
  await expect(cards.locator('.tool-state')).toHaveText('asking');
  await expect(cards).toContainText('rm -rf ./build', {
    useInnerText: true,
  });
  await expect(approve).toHaveCount(1);
  // The buttons are the whole feature, so they have to be *reachable*: inside
  // the viewport, not merely in the DOM. This project has shipped a control
  // clipped out of a fixed box once already.
  await expect(approve).toBeInViewport({ ratio: 1 });
  await expect(deny).toBeInViewport({ ratio: 1 });
  await shoot(page, '1-approve-on-a-phone');

  await approve.click();
  // One card, and it is the transcript's record now: the `tool_use` carries the
  // same `tool_use_id` the hook announced, so it supersedes rather than joins.
  await expect(cards.locator('.tool-state')).toHaveText('✓');
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText('removed ./build');
  await expect(approve).toHaveCount(0, { timeout: 1000 });
  await shoot(page, '2-approved');

  // The reflex: a user taps Approve and then hits the terminal out of habit.
  // tether's `allow` means Claude Code never showed a dialog, so there is
  // nothing there to answer — the keystroke is ordinary typing and must approve
  // nothing, least of all something else.
  await askAt(page, ANSWER);
  await expect(cards).toHaveCount(1, { timeout: 2000 });
  await expect(agentChip).toHaveText('Idle');

  // ── deny ───────────────────────────────────────────────────────────────────
  await askAt(page, ASK_DENY);
  await expect(cards).toHaveCount(2);
  const denied = cards.nth(1);
  await expect(denied.locator('.tool-state')).toHaveText('asking');
  await expect(denied).toContainText('rm -rf ./dist', { useInnerText: true });
  await shoot(page, '3-deny-on-a-phone');

  await denied.getByRole('button', { name: 'Deny' }).click();
  // "denied", not "error": the transcript's result really is an error, but the
  // user is the one who caused it and the card says whose decision it was.
  await expect(denied.locator('.tool-state')).toHaveText('denied');
  // The claim: the command did not run. The stub only ever prints `removed …`
  // for a call it was allowed to make.
  await expect(conversation).not.toContainText('removed ./dist');
  await expect(denied).toContainText('The user denied permission');
  await expect(cards).toHaveCount(2);
  await shoot(page, '4-denied');

  // ── nobody answers ─────────────────────────────────────────────────────────
  // The timeout policy, end to end. tether stops holding, says so in the card
  // rather than silently, and Claude Code's own prompt takes the question — the
  // surface that was always going to be correct.
  await askAt(page, ASK_WAIT);
  await expect(cards).toHaveCount(3);
  const waited = cards.nth(2);
  await expect(waited.getByRole('button', { name: 'Approve' })).toHaveCount(1);
  // Nothing is tapped. Until the hold expires, the pane shows no dialog at all:
  // the agent is blocked inside the hook, not waiting on a keystroke.
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('.xterm-rows')).not.toContainText('Do you want to proceed?');
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();

  await expect(waited.locator('.tool-state')).toHaveText('in terminal', {
    timeout: HOLD_MS + 10_000,
  });
  await expect(waited.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(waited).toContainText('asking in the terminal');
  // And now the agent's own dialog really is up, with the banner above both
  // panes that says so.
  await expect(banner).toContainText('Claude needs your permission to use Bash');
  await expect(agentChip).toHaveText('Waiting for you');
  await shoot(page, '5-handed-back-to-the-terminal');

  // Answering there reconciles to the same one card — the other direction of
  // the same join, and the reason neither surface may assume it won.
  await askAt(page, ANSWER);
  await expect(waited.locator('.tool-state')).toHaveText('✓');
  await expect(cards).toHaveCount(3);
  await expect(waited).toContainText('removed ./cache');
  await expect(banner).toHaveCount(0);
  await expect(agentChip).toHaveText('Idle');
  await shoot(page, '6-answered-in-the-terminal');
});
