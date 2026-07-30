/**
 * The composer's option controls, per provider.
 *
 * The reference client the captain supplied puts a row of dropdowns beside the
 * message box — permission mode, model, thinking level, fast mode. That client
 * *owns* its agent, so it can offer every axis the agent has. tether does not:
 * an agent here is a TUI in a tmux pane, and the only thing that reaches a
 * running pane is a keystroke. So an option is a **canned keystroke sequence**,
 * sent on the same terminal socket a composed message goes out on, and an axis
 * earns a control only if pressing those keys demonstrably changes the running
 * session.
 *
 * That test — not the CLI's flag list — is what this table records, and it is
 * why the two providers get different controls rather than a shared set. All of
 * it was established by driving the installed CLIs in a tmux pane and reading
 * back the pane, the transcript and the rollout. Claude Code 2.1.220 and
 * codex-cli 0.145.0; the omissions are as load-bearing as the entries and are
 * spelled out beside them.
 *
 * Values that lower the permission bar are marked, because a dropdown entry
 * that quietly stops an agent asking before it acts is the one thing this
 * surface must never be. {@link lowersBar} is what the view gates on.
 *
 * Logic lives here rather than in `conversation.tsx` for the reason every other
 * decision does: web tests run under `node --test`, which strips types but
 * cannot compile JSX, so anything decided in a `.tsx` leaves the test suite.
 */

import { CODEX, DEFAULT_PROVIDER } from './providers.ts';

/**
 * One value of one axis.
 *
 * `keys` is what gets sent, in order, as `input` frames — each one is text
 * pasted into the pane followed by Enter, which is exactly what the composer
 * already does with a message. Two entries means a command that opens a picker
 * and the choice made in it; the ordering is the terminal socket's own, and
 * both frames are in its resend-until-ACKed set, so a socket that dies between
 * them finishes the sequence on reconnect rather than leaving a picker open.
 */
export type Choice = {
  /** Stable id — what the `<select>` carries, never shown. */
  readonly value: string;
  /** What the menu shows. */
  readonly label: string;
  /** The `input` frames, in order. */
  readonly keys: readonly string[];
  /**
   * Present when picking this lets the agent act with less asking than before.
   * The sentence is shown, and acknowledged, *before* the keys are sent.
   */
  readonly lowers?: string;
};

export type Axis = {
  readonly id: string;
  /** The control's accessible name. Never contains "Message" or "Agent" —
   *  Playwright's `getByLabel` matches on a substring and both of those name
   *  something else on this screen already. */
  readonly label: string;
  readonly choices: readonly Choice[];
};

/**
 * Claude Code's two axes that a running pane really accepts.
 *
 * Both are slash commands that take their value as an **argument**, so one
 * keystroke frame applies them and the pane says so — `Set model to Sonnet 5`,
 * `Set effort level to medium` — which also lands in the transcript as a
 * `<local-command-stdout>` record, so the conversation is the confirmation.
 *
 * Two axes the reference shows are deliberately **absent**:
 *
 *  - **Permission mode.** `--permission-mode` exists at spawn, but the only
 *    mid-session mechanism is Shift+Tab, which *cycles* — manual → acceptEdits
 *    → plan → auto → manual, and `dontAsk`/`bypassPermissions` are not in the
 *    cycle at all. Landing on a chosen mode needs to know the current one, and
 *    tether cannot: it is not in `~/.claude/sessions/<pid>.json`, and the
 *    transcript's own `permission-mode` record does not follow the cycle
 *    (verified — it still read `default` with the pane in plan mode). A
 *    dropdown over a blind cycle would silently land on the wrong mode, and on
 *    a *permission* axis the wrong mode is an agent that stops asking.
 *  - **Fast mode.** There is no slash command for it in 2.1.220.
 */
const CLAUDE_AXES: readonly Axis[] = [
  {
    id: 'model',
    label: 'Model',
    choices: [
      { value: 'opus', label: 'Opus 5', keys: ['/model opus'] },
      { value: 'sonnet', label: 'Sonnet 5', keys: ['/model sonnet'] },
      { value: 'fable', label: 'Fable 5', keys: ['/model fable'] },
    ],
  },
  {
    id: 'effort',
    label: 'Effort',
    choices: [
      { value: 'low', label: 'Low', keys: ['/effort low'] },
      { value: 'medium', label: 'Medium', keys: ['/effort medium'] },
      { value: 'high', label: 'High', keys: ['/effort high'] },
      { value: 'xhigh', label: 'Extra high', keys: ['/effort xhigh'] },
      { value: 'max', label: 'Max', keys: ['/effort max'] },
    ],
  },
];

/**
 * Codex's one axis that a running pane really accepts.
 *
 * `/permissions` opens a **fixed** three-item picker — the same three presets
 * the CLI's `--ask-for-approval` and `--sandbox` compose into — and a digit
 * applies one immediately. The pane says `Permissions updated to …` and the
 * rollout records an `event_msg/thread_settings_applied` carrying the new
 * `approval_policy` and `sandbox_policy`, so the change is readable as well as
 * visible.
 *
 * **Model and reasoning effort are absent, and that is not an oversight.**
 * Codex folds them into one `/model` picker whose list comes from the account,
 * so a digit selects whatever happens to sit at that position — a guess, not a
 * choice. And unlike Claude Code, Codex's slash commands take no argument:
 * `/model gpt-5.6-terra` is sent to the model as a **prompt** (verified — it
 * cost a turn, and the model replied that it cannot switch itself). `/fast` is
 * absent for the third form of the same problem: it is a toggle with no
 * set-form, so tether cannot know which way a tap will move it, and it writes
 * the user's global `~/.codex/config.toml` when it lands.
 */
const CODEX_AXES: readonly Axis[] = [
  {
    id: 'permissions',
    label: 'Permissions',
    choices: [
      { value: 'ask', label: 'Ask for approval', keys: ['/permissions', '1'] },
      {
        value: 'auto',
        label: 'Approve for me',
        keys: ['/permissions', '2'],
        lowers:
          'Codex stops asking before it acts, except for what it judges unsafe. ' +
          'Its own review approves the rest, so the Approve and Deny buttons here ' +
          'will mostly stop appearing.',
      },
      {
        value: 'full',
        label: 'Full access',
        keys: ['/permissions', '3'],
        lowers:
          'Codex edits files outside this directory and reaches the network without ' +
          'asking. Nothing is held for you, so nothing on this screen can stop a ' +
          'command before it runs.',
      },
    ],
  },
];

const AXES: ReadonlyMap<string, readonly Axis[]> = new Map([
  [DEFAULT_PROVIDER, CLAUDE_AXES],
  [CODEX, CODEX_AXES],
]);

/**
 * What this provider's composer offers. A provider this build has not heard of
 * gets nothing — the same rule the rest of the web app follows for anything
 * unknown: show what is known, never guess, never throw.
 */
export function axesFor(provider: string): readonly Axis[] {
  return AXES.get(provider) ?? [];
}

/** A choice by id, or `undefined` — a `<select>` cannot produce an unknown
 *  value, but nothing here should throw if one arrives. */
export function choiceIn(axis: Axis, value: string): Choice | undefined {
  return axis.choices.find((choice) => choice.value === value);
}

/**
 * What must be said, and agreed to, before this choice is applied — or `null`
 * when there is nothing to warn about.
 *
 * Kept as a function rather than read off the field at the call site so the
 * rule has one home: whether a value lowers the bar is a property of the table,
 * and the view only has to ask.
 */
export function lowersBar(choice: Choice): string | null {
  return choice.lowers ?? null;
}

/**
 * The teaching placeholder, naming the agent that is actually running.
 *
 * It teaches the one rule of this composer that a phone user will otherwise
 * discover by losing a half-written prompt: Enter is a line break here, and
 * Send is a button.
 */
export function composerHint(agentName: string): string {
  return `Message ${agentName} — / for its commands, Enter for a new line`;
}
