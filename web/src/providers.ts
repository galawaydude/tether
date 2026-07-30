/**
 * What the browser says about a provider. One list, three uses: the picker in
 * the New session sheet, the tag on a list row, and the name over an assistant
 * message.
 *
 * The ids are the server's own (`DEFAULT_PROVIDER` in `machine/registry.ts`,
 * `CODEX` in `providers/codex/spawn.ts`) and the create route validates against
 * the same set, so a typo here is a 400 rather than a session started under the
 * wrong agent. They are literals because `@tether/shared` emits types and no
 * JavaScript — there is nothing to import a value from.
 *
 * Like every other display decision in the web app this lives in a `.ts` rather
 * than a `.tsx`: the tests run under `node --test`, which strips types but does
 * not compile JSX.
 */

import type { FolderTrust } from '@tether/shared';

/** The provider a session gets when nothing says otherwise. */
export const DEFAULT_PROVIDER = 'claude-code';

export const CODEX = 'codex';

export const PROVIDERS = [
  { id: DEFAULT_PROVIDER, label: 'Claude Code' },
  { id: CODEX, label: 'Codex' },
] as const;

/**
 * A provider's name, or the raw id for one this build has not heard of. Falling
 * back to the id is the same rule the conversation view follows for an unknown
 * event kind: show what is known, never throw and never blank the screen.
 */
export function providerLabel(provider: string): string {
  return PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
}

/** The name over a message. The assistant is whichever agent is actually running. */
export function whoLabel(who: 'user' | 'assistant', provider: string): string {
  return who === 'user' ? 'You' : providerLabel(provider);
}

/**
 * The accessible name of a message's Copy button — the button has no visible
 * text a screen reader could use on its own, and "Copy" repeated down a
 * conversation names nothing.
 *
 * It deliberately does **not** contain the word "message". The composer's own
 * label is exactly that word, and Playwright's `getByLabel` matches on a
 * substring, so a Copy button named "Copy Claude Code message" makes
 * `getByLabel('Message')` ambiguous and takes two specs down with it. Naming
 * what is copied — your text, the agent's reply — is clearer anyway.
 */
export function copyLabel(who: 'user' | 'assistant', provider: string): string {
  return who === 'user' ? 'Copy your text' : `Copy the reply from ${providerLabel(provider)}`;
}

/**
 * The accessible names of the three controls that summon the terminal: a failed
 * turn's row, the composer's command note, and the waiting banner.
 *
 * Here for the same reason `copyLabel` is — it is the wording of a control's
 * accessible name — and all three rather than one, because the rule is about
 * them as a set. Any two can be on screen together, and `getByRole({ name })`
 * matches on a case-insensitive substring, so one name containing another is an
 * ambiguity for a screen reader and for the specs that locate the others. The
 * guard in `providers.test.ts` is only a guard if it compares the strings the
 * buttons actually render, so the buttons take their names from here.
 */
export const AUTH_TERMINAL_LABEL = 'Go to the terminal';

export const COMMAND_TERMINAL_LABEL = 'Show the terminal';

export const WAITING_TERMINAL_LABEL = 'Open the terminal';

/**
 * What a screen reader hears before a failed turn's row.
 *
 * Sighted users get the attribution from the house rule that a box means an
 * artefact and prose means the agent; without a heading, the CLI's own words are
 * read out in the model's voice, straight after an assistant message. It names
 * the provider through `providerLabel` rather than an agent, because the same
 * row renders for both.
 *
 * Like `copyLabel` it must not contain the word "message": the composer's own
 * label is exactly that word and `getByLabel` matches on a substring.
 */
export function turnErrorLabel(provider: string): string {
  return `${providerLabel(provider)} reported a failed turn`;
}

/**
 * What the New session sheet says about folder trust, before the agent starts.
 *
 * Here rather than in the `.tsx` for the usual reason — the tests cannot compile
 * JSX — and here rather than anywhere else because every sentence names the
 * agent, and this module is where the web app reads an agent's name.
 *
 * The shape of the answer decides the shape of the ask:
 *
 * - **trusted** — nothing at all. There is no question to put in front of anyone,
 *   and a reassuring line about a folder the agent was always going to accept is
 *   the nagging the consent pattern rules out.
 * - **untrusted** — the explanation and a box to tick. Unticked is a real answer
 *   and the default: the session still starts and the agent asks in the terminal,
 *   exactly as it does today, which the last line says so the consequence of
 *   declining is visible rather than discovered.
 * - **unknown** — the explanation with no box. tether says it cannot tell instead
 *   of guessing, and offers nothing, because the file it would have to write is
 *   the one it has just failed to understand.
 *
 * `path` is the directory the answer is *about* and is named whenever it differs
 * from the one being started in: Codex keys trust by repository, so a session in
 * `repo/sub` trusts `repo` and everything else under it. A control that said
 * "this folder" over that would be a lie by omission on a security decision.
 */
export type TrustAsk = {
  /** Paragraphs, in order. */
  lines: readonly string[];
  /** The checkbox's label — absent when there is nothing to offer. */
  accept?: string;
};

export function trustAsk(
  provider: string,
  trust: FolderTrust,
  path: string,
  cwd: string,
): TrustAsk | null {
  const agent = providerLabel(provider);
  if (trust === 'trusted') return null;
  if (trust === 'unknown') {
    return {
      lines: [
        `tether cannot tell whether ${agent} already trusts ${path} — its configuration could not ` +
          `be read, so tether will not guess and will not write to it.`,
        `The session starts either way. If ${agent} does not trust this folder yet, it will ask in ` +
          `the terminal, and you can answer it there.`,
      ],
    };
  }
  const scope =
    path === cwd
      ? `${agent} has not been told to trust ${path}.`
      : `${agent} has not been told to trust ${path}, the repository ${cwd} is in — it records ` +
        `trust per repository, so this covers every directory inside it.`;
  return {
    lines: [
      `${scope} Trusting it lets ${agent} read, change and run files there, including anything a ` +
        `file in it tells ${agent} to do.`,
      `Your answer is remembered in ${agent}'s own settings, so it will not ask again. Leave this ` +
        `unticked and the session still starts — ${agent} will ask you in the terminal instead.`,
    ],
    accept: `I trust this folder`,
  };
}

/**
 * Why a dead session cannot be brought back, when it cannot.
 *
 * Codex creates no session identity until the first user message, so a session
 * closed before anyone typed into it has no conversation to resume — the server
 * refuses that resume outright rather than starting a fresh session wearing a
 * resumed one's name. The row says so instead of leaving a user to find out from
 * a 409, and says nothing at all when there is nothing to say.
 */
export function unresumableNote(session: {
  deadAt: number | null;
  providerSessionId: string | null;
}): string | null {
  if (session.deadAt === null || session.providerSessionId !== null) return null;
  return 'no conversation to resume — it never got a first message';
}
