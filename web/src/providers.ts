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
