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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Its own directory inside the sandbox, not `session.spec.ts`'s. The three specs
 * share one `tether serve`, and that spec asserts on counts — a second session
 * in the same directory would give both rows the same title and make its
 * post-reload locator ambiguous.
 */
const project = join(process.env['TETHER_E2E_DIR'] as string, 'permission');

/**
 * The watch/hold spec's own directory. It is a second session because it drives
 * the same three-way join from the other side — a call proposed while nobody is
 * watching the conversation — and a card count in the test above must not
 * depend on how many cards this one made.
 */
const unwatched = join(process.env['TETHER_E2E_DIR'] as string, 'unwatched');

/** Where a reviewer's copies go; set by the runner, ignored when it is not. */
const evidence = process.env['TETHER_E2E_SHOTS'];

/** The server's own hold, from the one place it is configured. */
const HOLD_MS = Number(process.env['TETHER_E2E_HOLD_SECONDS'] ?? '15') * 1000;

const GREETING = 'stub agent ready';
const ASK = 'ask to run something';
const ASK_DENY = 'ask to run the other thing';
const ASK_WAIT = 'ask and wait it out';
const ASK_UP = 'ask with the terminal up';
const ASK_AWAY = 'ask with the terminal away';
const ANSWER = 'yes';
/** What the agent's own prompt prints when tether did not answer the hook. */
const OWN_PROMPT = 'Do you want to proceed?';

async function shoot(page: Page, name: string): Promise<void> {
  if (evidence !== undefined) await page.screenshot({ path: join(evidence, `${name}.png`) });
}

/** Summon the terminal over the conversation, and wait for its attach. */
async function summon(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.locator('header .chip[role="status"]')).toHaveText('Live');
}

/** Put it away again, back to the conversation. */
async function dismiss(page: Page): Promise<void> {
  await page.locator('.termsheet').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
}

/** Types at the pane, which is how a real prompt starts. */
async function typeAtPane(page: Page, text: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/** Summon, type, and put the terminal away again. */
async function typeAt(page: Page, text: string): Promise<void> {
  await summon(page);
  await typeAtPane(page, text);
  await dismiss(page);
}

/**
 * Ask for something, in two steps, because tether holds a proposed call only
 * while the conversation is what is on screen — and typing needs the terminal
 * over it. So the typed line only **arms** the stub, and the tool call is fired
 * from here, out of band, once the terminal is demonstrably put away.
 *
 * That is a construction rather than a wait: `e2e/stub-agent.ts` fires when the
 * armed ask and the trigger file are both present, in whichever order they land,
 * so there is no window where the result depends on which round-trip won. A
 * `waitForTimeout` here would only have hidden the race.
 */
async function askAt(page: Page, text: string, dir = project): Promise<void> {
  await typeAt(page, text);
  await expect(page.locator('header .chip[role="status"]')).toHaveText('Live');
  writeFileSync(join(dir, '.tether-e2e-fire'), '');
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
  await typeAt(page, ANSWER);
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
  // Nothing is tapped, and the terminal is not summoned either — doing so would
  // release the hold that is being watched expire. Both panes stay mounted, so
  // the terminal's rendered rows are readable from behind the closed overlay:
  // until the deadline, the pane shows no dialog at all, because the agent is
  // blocked inside the hook rather than waiting on a keystroke.
  await expect(page.locator('.xterm-rows')).not.toContainText(OWN_PROMPT);

  await expect(waited.locator('.tool-state')).toHaveText('in terminal', {
    timeout: HOLD_MS + 10_000,
  });
  await expect(waited.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(waited).toContainText('asking in the terminal');
  // And now the agent's own dialog really is up, with the banner above both
  // panes that says so.
  await expect(banner).toContainText('Claude needs your permission to use Bash');
  await expect(agentChip).toHaveText('Waiting for you');
  // The one control a user taps one-handed while an agent is blocked on them,
  // so it is measured rather than merely found: styling `.link` down to its own
  // text height once dropped it to 16.5px, which a presence check passes.
  const open = banner.getByRole('button', { name: 'Open the terminal' });
  const openBox = await open.boundingBox();
  expect(openBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await shoot(page, '5-handed-back-to-the-terminal');

  // And it is a way *there*, not a tab switch: it summons the overlay, which is
  // where the agent's own dialog now is. Once it is up the link is gone, since
  // it would be offering the thing already on screen.
  await open.click();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.locator('.xterm-rows')).toContainText(OWN_PROMPT);
  await expect(banner.getByRole('button', { name: 'Open the terminal' })).toHaveCount(0);
  await shoot(page, '6-the-banner-summons-the-terminal');

  // Answering there reconciles to the same one card — the other direction of
  // the same join, and the reason neither surface may assume it won.
  await typeAtPane(page, ANSWER);
  await dismiss(page);
  await expect(waited.locator('.tool-state')).toHaveText('✓');
  await expect(cards).toHaveCount(3);
  await expect(waited).toContainText('removed ./cache');
  await expect(banner).toHaveCount(0);
  await expect(agentChip).toHaveText('Idle');
  await shoot(page, '7-answered-in-the-terminal');
});

/**
 * The watch/hold decision the terminal overlay had to make, end to end.
 *
 * tether holds a proposed tool call only while somebody has the conversation in
 * front of them (`#holdFor` in `server/src/machine/conversations.ts`). The tab
 * pair made that "which tab is selected"; the overlay makes it "is the terminal
 * summoned", and this is the test that says which — because getting it wrong is
 * silent in both directions. Hold with the terminal up and the agent stalls in
 * front of the surface that answers it, behind an overlay hiding tether's own
 * Approve. Fail to hold with it away and the feature the product exists for
 * simply does not fire.
 *
 * So both halves are asserted, on one session, with the same construction the
 * spec above uses: the typed line arms the stub and a trigger file fires it,
 * which is what removes the race rather than hiding it.
 */
test('the hold follows the terminal overlay: not held while it is up, held once it is away', async ({
  page,
}) => {
  mkdirSync(unwatched, { recursive: true });

  await page.goto('/');
  await page.getByLabel('Password').fill(process.env['TETHER_E2E_PASSWORD'] as string);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Working directory').fill(unwatched);
  await page.getByRole('button', { name: 'Start' }).click();

  const conversation = page.locator('.conv');
  const rows = page.locator('.xterm-rows');
  const cards = conversation.locator('details.tool');

  await expect(conversation.getByText(GREETING, { exact: true })).toHaveCount(1);

  // ── with the terminal up: not held ─────────────────────────────────────────
  // Armed and fired without ever putting the overlay away, so the hook arrives
  // while the client has said it is not watching.
  await summon(page);
  await typeAtPane(page, ASK_UP);
  writeFileSync(join(unwatched, '.tether-e2e-fire'), '');

  // The claim: tether did not hold. The agent's own prompt has the question
  // straight away, which it only ever prints for a hook that decided nothing.
  await expect(rows).toContainText(OWN_PROMPT);
  // A card is still reported — tether reports far more proposals than it holds
  // — but a deadline-less `pending` carries no buttons, and that is the part
  // that would have stalled the agent. By class rather than by role: the
  // conversation is `inert` under the overlay, so *every* role locator reads
  // zero here and one that did would prove nothing.
  await expect(cards.locator('.tool-answer')).toHaveCount(0);
  await expect(cards).toHaveCount(1);
  await shoot(page, '8-not-held-with-the-terminal-up');

  // Answered at the pane, where the question actually is.
  await typeAtPane(page, ANSWER);
  await dismiss(page);
  await expect(cards.locator('.tool-state')).toHaveText('✓');
  await expect(cards).toContainText('removed ./one');

  // ── and once it is away: held ──────────────────────────────────────────────
  // The same session, the same construction, one dismissal apart.
  await askAt(page, ASK_AWAY, unwatched);
  await expect(cards).toHaveCount(2);
  const held = cards.nth(1);
  await expect(held.locator('.tool-answer')).toHaveCount(1);
  await expect(held.getByRole('button', { name: 'Approve' })).toHaveCount(1);
  // And it really is a hold rather than a card drawn hopefully: the agent is
  // blocked inside the hook, so its own prompt has not been printed for this
  // one. The pane is read through the closed overlay, which stays mounted.
  await expect(rows).not.toContainText('rm -rf ./two');
  await shoot(page, '9-held-once-the-terminal-is-away');

  await held.getByRole('button', { name: 'Approve' }).click();
  await expect(held.locator('.tool-state')).toHaveText('✓');
  await expect(held).toContainText('removed ./two');
  await expect(cards).toHaveCount(2);
});
