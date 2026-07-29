/**
 * Capping what a conversation card may carry.
 *
 * Both providers can put a whole file in one record — Claude Code's `Write` and
 * `Edit` inputs, Codex's `apply_patch` input and `exec_command` output — and the
 * terminal is the full-fidelity view, so a card is capped rather than allowed to
 * put megabytes in the replay buffer and on the wire.
 *
 * Provider-neutral by nature, so it lives here rather than in either provider
 * directory; see `tail.ts` for the same reasoning.
 */

/**
 * The same number for an input and an output: asymmetric caps are the uncapped
 * one wearing a hat.
 */
export const MAX_OUTPUT = 16_000;

const TRUNCATED = '\n…[truncated by tether]';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A tool result's content is a string, or blocks, or something new. */
export function capOutput(content: unknown, total = MAX_OUTPUT): string {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((block) =>
              isObject(block) && typeof block['text'] === 'string' ? block['text'] : '',
            )
            .filter((part) => part !== '')
            .join('\n')
        : JSON.stringify(content ?? null);
  return text.length > total ? `${text.slice(0, total)}${TRUNCATED}` : text;
}

function eachString(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) for (const item of value) eachString(item, visit);
  else if (isObject(value)) for (const item of Object.values(value)) eachString(item, visit);
}

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]),
    );
  }
  return value;
}

/**
 * The longest a single string may be for the whole value to fit in `total`,
 * sharing what the short strings do not need out among the long ones. Every
 * string is measured against the same limit, so which one comes first in the
 * object decides nothing.
 */
function fieldLimit(lengths: readonly number[], total: number): number {
  let remaining = total;
  let count = lengths.length;
  for (const length of [...lengths].sort((a, b) => a - b)) {
    const share = Math.floor(remaining / count);
    if (length > share) return share;
    remaining -= length;
    count -= 1;
  }
  return Infinity;
}

/**
 * The same cap for a tool call's input, spent as an equal share per string
 * rather than first-come: an `Edit` whose `old_string` is huge must not leave
 * `new_string` as a bare marker, which reads as a plausible and wrong edit. The
 * shape is kept rather than the value stringified or fields dropped — it is
 * structured, the UI renders it as fields, and it is the strings inside it that
 * are long — and each cut carries the marker a tool result's does.
 */
export function capInput(value: unknown, total = MAX_OUTPUT): unknown {
  const lengths: number[] = [];
  eachString(value, (text) => lengths.push(text.length));
  const limit = fieldLimit(lengths, total);
  if (limit === Infinity) return value;
  return mapStrings(value, (text) =>
    text.length > limit ? `${text.slice(0, limit)}${TRUNCATED}` : text,
  );
}
