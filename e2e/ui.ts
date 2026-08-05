/**
 * The handful of things every spec does to the app, spelled once.
 *
 * The summon/dismiss recipe in particular: the header toggle and its
 * `aria-expanded` handshake were written out in four specs, so changing the
 * control meant finding all four. It lives here beside `serve.ts` for the
 * same reason that does — it is harness, not a claim.
 */

import { expect, type Locator, type Page } from '@playwright/test';
import { join } from 'node:path';

/**
 * A phone with its on-screen keyboard up: the smallest viewport this product
 * supports, and the one two of its four clipped panels only failed at.
 *
 * A check at full phone height would have passed while the product was broken,
 * so it is a named constant rather than a literal in one spec.
 */
export const KEYBOARD_UP = { width: 360, height: 340 } as const;

/** Where a reviewer's copies go; set by the runner, ignored when it is not. */
const evidence = process.env['TETHER_E2E_SHOTS'];

/** The one control that switches between conversation and terminal. */
export const hatch = (page: Page): Locator => page.locator('.bar-term');

export async function summon(page: Page): Promise<void> {
  await expect(hatch(page)).toHaveText('Terminal');
  await hatch(page).click();
  await expect(hatch(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(hatch(page)).toHaveText('Conversation');
}

export async function dismiss(page: Page): Promise<void> {
  await expect(hatch(page)).toHaveText('Conversation');
  await hatch(page).click();
  await expect(hatch(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(hatch(page)).toHaveText('Terminal');
}

/**
 * **Reachable**, spelled once, because four panels in this product have grown
 * past a small phone and every one of them was caught by a reviewer instead of
 * by a test: the New session sheet pushed its Agent picker off the top of a
 * fixed overlay, the waiting banner's overlay fix covered the content under it,
 * and the composer's permission warning pushed its own confirm and Send below
 * the fold with the keyboard up.
 *
 * All three are the same failure and none of them is *presence* — the control
 * was in the DOM every time. So this asserts geometry, and it asserts what a
 * thumb can actually do:
 *
 *  - it has a box at all;
 *  - after being scrolled to **through its own container** — the panels here
 *    scroll inside themselves, and being below one's fold is not the failure —
 *    that box is wholly inside the viewport;
 *  - it is a real 44px tap target;
 *  - nothing is lying on top of it, hit-tested at its centre rather than
 *    inferred, which is the only form that catches an overlay;
 *  - and the *document* does not scroll, in **either** axis, because a header and
 *    a conversation scrolling away is not a fix for a panel that outgrew the
 *    screen — and a panel that pushed the page sideways instead is the same
 *    failure turned ninety degrees.
 *
 * Every failure names the control and the viewport it failed at, so the next
 * person reads the message instead of bisecting a layout. Playwright's own
 * `toBeInViewport` would scroll the page to make itself true and reports a
 * ratio, not a reason.
 */
export async function reachable(page: Page, control: Locator, name: string): Promise<void> {
  const view = page.viewportSize() ?? { width: 0, height: 0 };
  const at = `${name} at ${view.width}×${view.height}`;

  if ((await control.boundingBox()) === null) throw new Error(`${at}: not laid out at all`);
  await control.scrollIntoViewIfNeeded();

  const seen = await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    // Off the screen there is nothing to hit-test — `elementFromPoint` answers
    // `null` for every point outside the viewport, and reporting that as "nothing
    // is on top of it" would bury the fault that is actually there.
    const onScreen = x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
    const top = onScreen ? document.elementFromPoint(x, y) : element;
    const named =
      top === null
        ? 'nothing at all'
        : top.tagName.toLowerCase() +
          (top.getAttribute('class') ?? '')
            .split(/\s+/)
            .filter(Boolean)
            .map((one) => `.${one}`)
            .join('');
    return {
      x: box.x,
      y: box.y,
      right: box.right,
      bottom: box.bottom,
      height: box.height,
      // `contains` rather than identity: a button's label is its own node and is
      // what a hit test lands on. Anything outside the control is on top of it.
      covered: top !== null && element.contains(top) ? null : named,
      taller: document.documentElement.scrollHeight - window.innerHeight,
      wider: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

  const px = (value: number): string => `${Math.round(value)}px`;
  const faults: string[] = [];
  if (seen.height < 44)
    faults.push(`it is only ${px(seen.height)} tall, under the 44px tap target`);
  if (seen.y < -0.5) faults.push(`its top is ${px(-seen.y)} above the top of the screen`);
  if (seen.bottom > view.height + 0.5) {
    faults.push(`it ends ${px(seen.bottom - view.height)} below the bottom of the screen`);
  }
  if (seen.x < -0.5) faults.push(`its left edge is ${px(-seen.x)} off the screen`);
  if (seen.right > view.width + 0.5) {
    faults.push(`its right edge is ${px(seen.right - view.width)} off the screen`);
  }
  if (seen.covered !== null) faults.push(`${seen.covered} is lying on top of it`);
  if (seen.taller > 0.5) {
    faults.push(`the page itself is ${px(seen.taller)} taller than the screen`);
  }
  if (seen.wider > 0.5) {
    faults.push(`the page itself is ${px(seen.wider)} wider than the screen`);
  }

  if (faults.length > 0) throw new Error(`${at} is unreachable: ${faults.join('; ')}`);
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
