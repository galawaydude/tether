/**
 * The handful of things every spec does to the app, spelled once.
 *
 * The summon/dismiss recipe in particular: `.termsheet`, the Close button's name
 * and the `aria-expanded` handshake were written out in four specs, so renaming
 * the control meant finding all four. It lives here beside `serve.ts` for the
 * same reason that does — it is harness, not a claim.
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { join } from 'node:path';

/** Where a reviewer's copies go; set by the runner, ignored when it is not. */
const evidence = process.env['TETHER_E2E_SHOTS'];

/** The one control that summons the terminal, and the one that puts it away. */
export const hatch = (page: Page): Locator =>
  page.getByRole('button', { name: 'Terminal', exact: true });

export async function summon(page: Page): Promise<void> {
  await hatch(page).click();
  await expect(hatch(page)).toHaveAttribute('aria-expanded', 'true');
}

export async function dismiss(page: Page): Promise<void> {
  await page.locator('.termsheet').getByRole('button', { name: 'Close' }).click();
  await expect(hatch(page)).toHaveAttribute('aria-expanded', 'false');
}

/**
 * Evidence screenshots, namespaced by the spec that took them.
 *
 * Every spec writes into the one `TETHER_E2E_SHOTS` directory and `workers: 1`
 * runs them in sequence, so a shared counter meant the last spec to use a number
 * silently overwrote an earlier spec's image — and a reviewer opening it was
 * looking at another screen entirely. A prefix makes a new shot in one spec
 * unable to collide with another by construction.
 */
export function shots(spec: string): (page: Page, name: string) => Promise<void> {
  return async (page, name) => {
    if (evidence !== undefined) {
      await page.screenshot({ path: join(evidence, `${spec}-${name}.png`) });
    }
  };
}
