/**
 * Reading and setting Claude Code's permission mode on a running pane.
 *
 * This is the one axis with no slash command: `--permission-mode` exists at
 * spawn and mid-session the only mechanism is **Shift+Tab**, which cycles.
 * A cycle is a blind toggle unless the mode can be read back, and the first
 * pass at this feature left the control out for exactly that reason. It was
 * wrong — the mode is observable from three independent places, all verified
 * live against Claude Code 2.1.220:
 *
 *  1. `capture-pane`: the pane's **last line** is Claude Code's status footer
 *     and it names the mode — `⏸ manual mode on`, `⏵⏵ accept edits on`,
 *     `⏸ plan mode on`, `⏵⏵ auto mode on`. Synchronous and always available,
 *     which is the only property that makes *setting* verifiable.
 *  2. `permission_mode` on the **`PreToolUse`** hook payload, which tether
 *     already installs and already receives on every tool call.
 *  3. The same field on `UserPromptSubmit`, which tether does not install.
 *
 * (2) and (3) are structured data and are the better *record*, but both arrive
 * only on an event, so between them they say nothing about right now. (1) is
 * the one that can answer "what is it at this instant", so it is what this
 * module uses, and it is parsed with the discipline `status.ts` uses for the
 * same class of problem: **anything not recognised is `undefined` — "tether
 * cannot say" — never a guess.**
 *
 * The setter never assumes the cycle. It reads, and if it is not already at the
 * target it presses Shift+Tab **once** and waits for the mode to actually
 * change, then reads again — so it cannot overshoot, cannot depend on the cycle
 * order, and cannot be fooled by a fifth mode appearing in a build launched
 * with different flags. The order observed today is
 * `default → acceptEdits → plan → auto →` back to `default`, which is recorded
 * because it explains two things and not because the code relies on it: three
 * steps is the worst case, and reaching `plan` passes *through* `acceptEdits`
 * for a few hundred milliseconds with no prompt submitted in between.
 *
 * What it returns is what it **confirmed by reading**, never what it asked for.
 * A control that says the agent is in `plan` when it is in `auto` is worse than
 * no control at all.
 */

import { capturePlainViewport, sendKeys } from '../../machine/tmux.ts';

/**
 * The screen, or `undefined` when there is no screen to read.
 *
 * A pane that died — the agent exited, the user pressed Ctrl-C, the tmux server
 * went with it — makes `capture-pane` fail, and that is not an exception to
 * this module's rule but the plainest case of it: tether cannot say what mode
 * something that is gone is in. Swallowed here rather than in the route so no
 * caller can turn it into a 500 whose message is tether's own argv.
 */
async function screen(socket: string, target: string): Promise<string | undefined> {
  return capturePlainViewport(socket, target).catch(() => undefined);
}

/** The modes the footer can name, in Claude Code's own `--permission-mode`
 *  vocabulary — which is *not* the footer's wording: the pane says "manual" for
 *  what the CLI, the hook payload and the transcript all call `default`. */
export const MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;

export type PermissionMode = (typeof MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/**
 * How the footer names each mode. Matched against the last line only, so an
 * agent that writes "plan mode on" into its own output cannot be mistaken for
 * the footer.
 */
const FOOTER: readonly (readonly [RegExp, PermissionMode])[] = [
  [/\bmanual mode on\b/, 'default'],
  [/\baccept edits on\b/, 'acceptEdits'],
  [/\bplan mode on\b/, 'plan'],
  [/\bauto mode on\b/, 'auto'],
];

/**
 * The mode the pane is in, or `undefined` when the screen does not say so —
 * a pane mid-repaint, a version whose footer reads differently, an agent that
 * is not Claude Code at all.
 *
 * Two matches on one line is also `undefined`: the point of this function is to
 * be certain, and a line that could be read two ways is not certainty.
 */
export function readPermissionMode(pane: string): PermissionMode | undefined {
  const last = pane
    .split('\n')
    .filter((line) => line.trim() !== '')
    .at(-1);
  if (last === undefined) return undefined;
  const hits = FOOTER.filter(([pattern]) => pattern.test(last));
  return hits.length === 1 ? hits[0]?.[1] : undefined;
}

/** What `setPermissionMode` did. `changed` is false when the pane was already
 *  there and nothing was pressed. */
export type ModeResult =
  | { ok: true; mode: PermissionMode; changed: boolean }
  /** The screen never said what mode it was in, so nothing was pressed. */
  | { ok: false; reason: 'unreadable' }
  /** Another attempt on the same pane had not finished, so nothing was pressed. */
  | { ok: false; reason: 'busy' }
  /** Keys were pressed and the pane did not arrive. `mode` is where it actually
   *  is, when that could still be read. */
  | { ok: false; reason: 'not_confirmed'; mode: PermissionMode | undefined };

/**
 * **`BTab`, not `S-Tab`.** tmux resolves `S-Tab` against what the pane's
 * application has negotiated: Claude Code turns on extended keys, so `S-Tab`
 * happens to reach it as shift+tab — but with that off, tmux 3.7b delivers a
 * plain `\t`, which is an autocomplete keystroke and moves no mode at all.
 * `BTab` is the unconditional `ESC[Z`. Both were tried against a live pane; the
 * one that does not depend on a negotiation tether never sees is the one used.
 */
const BACK_TAB = 'BTab';

/** Three is the worst case over the four modes seen today; the extra room is
 *  for a cycle that is longer in some configuration, and the failure past it is
 *  a stated one rather than an endless loop. */
const MAX_STEPS = 6;

/** How long a Shift+Tab is given to show up in the footer before the attempt is
 *  called failed. Generous: this is a person waiting, once, on purpose. */
const SETTLE_MS = 2000;
const POLL_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `readPermissionMode` over a screen that may not exist. */
const read = (pane: string | undefined): PermissionMode | undefined =>
  pane === undefined ? undefined : readPermissionMode(pane);

/** One Shift+Tab, or `false` when the pane is no longer there to take it. */
const press = (socket: string, target: string): Promise<boolean> =>
  sendKeys(socket, target, [BACK_TAB]).then(
    () => true,
    () => false,
  );

/**
 * One attempt per pane at a time, and the serialisation lives here rather than
 * in the browser because a second viewer — or a second tab — reaches the same
 * state with no double-tap at all.
 *
 * Read-press-read is only sound if nothing else is pressing between the read and
 * the read back. Two concurrent attempts interleave their keystrokes, and each
 * then confirms a mode the *other* one cycled the pane into: both return `ok`,
 * and whichever the browser renders last claims a mode the pane is no longer in.
 * That is the one thing this axis exists not to do, so a second attempt is
 * refused rather than queued — it was aimed at a mode the pane has since left,
 * and the person who asked for it can ask again once the screen has settled.
 */
const running = new Set<string>();

export async function setPermissionMode(
  socket: string,
  target: string,
  mode: PermissionMode,
): Promise<ModeResult> {
  if (running.has(target)) return { ok: false, reason: 'busy' };
  running.add(target);
  try {
    return await drive(socket, target, mode);
  } finally {
    running.delete(target);
  }
}

/**
 * Drive the pane to `target`, confirming every step by reading the screen back.
 *
 * `now` is passed to each read so a step is only counted once the footer has
 * genuinely moved off the mode it started on — waiting for "different" rather
 * than sleeping a fixed time is what keeps a slow repaint from being read as
 * "the key did nothing" and answered with a second Shift+Tab.
 */
async function drive(socket: string, target: string, mode: PermissionMode): Promise<ModeResult> {
  let now = read(await screen(socket, target));
  if (now === undefined) return { ok: false, reason: 'unreadable' };
  if (now === mode) return { ok: true, mode, changed: false };

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const before = now;
    // A pane that has gone between the read and the press: nothing landed, and
    // the loop below will find no screen to read either.
    if (!(await press(socket, target))) return { ok: false, reason: 'not_confirmed', mode: before };
    now = await settle(socket, target, before);
    if (now === undefined) return { ok: false, reason: 'not_confirmed', mode: undefined };
    if (now === mode) return { ok: true, mode, changed: true };
  }
  return { ok: false, reason: 'not_confirmed', mode: now };
}

/** Read until the footer names something other than `before`, or give up. */
async function settle(
  socket: string,
  target: string,
  before: PermissionMode,
): Promise<PermissionMode | undefined> {
  for (let waited = 0; waited < SETTLE_MS; waited += POLL_MS) {
    await sleep(POLL_MS);
    const now = read(await screen(socket, target));
    if (now !== undefined && now !== before) return now;
  }
  return undefined;
}
