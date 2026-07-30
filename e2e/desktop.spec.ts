/**
 * The desktop shape, at 1280x800 — the one spec that runs above the 900px
 * breakpoint, and the only test that renders what `app.tsx`'s `useWide` branch
 * builds. It exists because every other check in this repo runs at a phone
 * viewport, and a shape no check has ever rendered is exactly how the
 * secure-context bug reached a real device: everything passed, in the one
 * environment that worked.
 *
 * So it asserts geometry and counts, not presence (report §8). "The list is
 * still there" passes on a list stacked under the session, on a rail 4px wide,
 * and on a back button that is merely invisible — none of which is the shape
 * this branch exists to build.
 */

import { expect, test, type Locator } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { shots } from './ui.ts';

/** Its own directory, like every other spec's: one server, one session list. */
const project = join(process.env['TETHER_E2E_DIR'] as string, 'desktop');

const shoot = shots('desktop');

const GREETING = 'stub agent ready';

async function box(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found as { x: number; y: number; width: number; height: number };
}

test('past 900px the list is a rail beside the open session, not a screen before it', async ({
  page,
}) => {
  mkdirSync(project, { recursive: true });

  await page.goto('/');
  await page.getByLabel('Password').fill(process.env['TETHER_E2E_PASSWORD'] as string);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Working directory').fill(project);
  await page.getByRole('button', { name: 'Start' }).click();

  // The real path, through the stub agent: a session that never started would
  // make every geometry assertion below true of an empty pane.
  await expect(page.locator('.conv').getByText(GREETING, { exact: true })).toHaveCount(1);

  const rail = page.locator('.workspace > .rail');
  const session = page.locator('.workspace > main.screen');

  // ── Beside, not below ──────────────────────────────────────────────────────
  const railBox = await box(rail);
  const sessionBox = await box(session);
  // Left of it and not overlapping it, both full height, and the session has the
  // larger share — a stacked layout or a collapsed rail fails all three.
  expect(railBox.x + railBox.width).toBeLessThanOrEqual(sessionBox.x + 1);
  expect(railBox.y).toBeCloseTo(sessionBox.y, 0);
  expect(railBox.height).toBeGreaterThan(400);
  expect(railBox.width).toBeGreaterThanOrEqual(280);
  expect(sessionBox.width).toBeGreaterThan(railBox.width);

  // ── The open session is marked in the rail ─────────────────────────────────
  // By name, never `.row-open`: the other specs share this list.
  const row = page.getByRole('button', { name: `desktop ${project}` });
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.row-on')).toHaveCount(1);

  // ── Absent, not invisible ──────────────────────────────────────────────────
  // `display: none` is deliberate: a keyboard must not reach a control that goes
  // back to a list already on screen, so the count is 0 rather than "hidden".
  await expect(page.getByRole('button', { name: 'Back to sessions' })).toHaveCount(0);

  // ── One landmark, and it is the session ────────────────────────────────────
  // A document may have exactly one `<main>`; in this shape the rail is the
  // complementary landmark beside it.
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.getByRole('complementary', { name: 'Sessions' })).toHaveCount(1);

  // ── Never sideways ─────────────────────────────────────────────────────────
  // The brief's own non-negotiable: wide content scrolls inside its container.
  const overflow = await page.evaluate(() => ({
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.root).toBeLessThanOrEqual(0);
  expect(overflow.body).toBeLessThanOrEqual(0);

  await shoot(page, '1-rail-beside-the-session');

  // ── And back below the breakpoint ──────────────────────────────────────────
  // The count is the point: a document may have one `<main>`, and the element
  // that is it changes with the shape, so the invariant needs checking on both
  // sides of the crossing rather than only on the new one. The back button
  // returns with the phone layout.
  await page.setViewportSize({ width: 412, height: 915 });
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Back to sessions' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Back to sessions' }).click();
  await expect(page.locator('main')).toHaveCount(1);
});
