/**
 * `busy` | `waiting` | `idle` for a Codex session.
 *
 * Codex publishes no status field anywhere, so all three are folded out of
 * records tether is already reading:
 *
 * | State     | Source                                                        |
 * |-----------|---------------------------------------------------------------|
 * | `busy`    | rollout `event_msg/task_started`                              |
 * | `waiting` | the `PermissionRequest` hook — the only one that needs a hook |
 * | `idle`    | rollout `event_msg/task_complete` — or `turn_aborted`          |
 *
 * That split is why declining tether's hook costs only the `waiting` badge: two
 * of the three states come from a file that is always there. See
 * `hooks.ts` — installing the hook is the user's decision, and refusing it is a
 * supported configuration rather than a broken one.
 *
 * Nothing in `providers/` may import from `web/` (report §5).
 */

import type { SessionState } from '@tether/shared';

/** How many `PreToolUse` records are kept for the correlation below. */
const RECENT_CALLS = 32;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * A `tool_input` reduced to what the two events actually agree on.
 *
 * A byte comparison is not available, and finding that out cost a real feature:
 * verified in the 0.145.0 fixtures, an `apply_patch` reaches `PreToolUse` with
 * its `command` ending in a newline and `PermissionRequest` with that newline
 * stripped. An exact match therefore never correlates a patch — which is half
 * of what a Codex user is ever asked to approve — and does so silently.
 *
 * Every string value is trimmed at its ends and nothing else is touched, so two
 * genuinely different commands still differ. Key order is not normalised: both
 * payloads are serialised by the same Codex, from the same value.
 */
function inputKey(input: unknown): string {
  return JSON.stringify(input ?? null, (_key, value: unknown) =>
    typeof value === 'string' ? value.trim() : value,
  );
}

type PendingCall = {
  sessionId: string | undefined;
  turnId: string | undefined;
  input: string;
  callId: string;
};

/**
 * The fold. Feed it rollout records and hook records in the order they arrive;
 * read `state` and `detail` whenever.
 *
 * Deliberately not a reducer over a retained list: it is fed by two live tailers
 * and only the latest answer is ever wanted, so the whole of its memory is the
 * current state plus the last few tool calls.
 */
export class CodexStatus {
  #state: SessionState = 'idle';
  #detail: string | undefined;
  /** The call the user is being asked about, when it could be worked out. */
  #waitingOn: string | undefined;
  #recent: PendingCall[] = [];
  /** When the newest record that has set the state happened. See `#when`. */
  #at = 0;

  get state(): SessionState {
    return this.#state;
  }

  /** The tool being waited on, while `state` is `waiting`. */
  get detail(): string | undefined {
    return this.#detail;
  }

  /**
   * Which pending call the current `PermissionRequest` was correlated to, while
   * `state` is `waiting` — `undefined` when it could not be worked out.
   *
   * Read by `machine/conversations.ts` to key the answerable card. It is a
   * correlation and not a key (see {@link CodexStatus.#correlate}), so a caller
   * must treat `undefined` as "report the prompt, offer no buttons" rather than
   * reach for a nearby call.
   */
  get waitingOn(): string | undefined {
    return this.#waitingOn;
  }

  /**
   * When a record happened: the shim's `at` on a hook, the ISO `timestamp` on a
   * rollout record. Both are wall-clock milliseconds from the same machine, so
   * they order against each other — which is the only reason the two streams can
   * be folded together at all.
   */
  #when(record: Record<string, unknown>): number | undefined {
    const at = record['at'];
    if (typeof at === 'number' && Number.isFinite(at)) return at;
    const stamp = Date.parse(str(record['timestamp']) ?? '');
    return Number.isNaN(stamp) ? undefined : stamp;
  }

  /**
   * One record, of either vocabulary. A hook payload is recognised by
   * `hook_event_name` and a rollout record by its `type`; anything else is
   * ignored, exactly as in `events.ts` — a status fold must never be the thing
   * that throws.
   *
   * **A record older than the newest one already applied does not change the
   * state.** The rollout and the hook log are two files followed independently,
   * so they arrive interleaved by luck rather than by time: catching up on a
   * hook log *after* the rollout has been read to its end replays a finished
   * turn's `PreToolUse` over the `task_complete` that ended it, and reports a
   * session sitting idle as busy. Observed live against real Codex, not reasoned
   * about. The record is still read — a stale `PreToolUse` is still a pending
   * call a later `PermissionRequest` may need to correlate to — it just does not
   * get to say what is happening now.
   *
   * Returns true when the state or the detail changed.
   */
  apply(record: unknown): boolean {
    if (!isObject(record)) return false;
    const at = this.#when(record);
    const stale = at !== undefined && at < this.#at;
    const before = { state: this.#state, detail: this.#detail, waitingOn: this.#waitingOn };

    const hookEvent = str(record['hook_event_name']);
    if (hookEvent !== undefined) this.#hook(hookEvent, record);
    else this.#rollout(record);

    if (stale) {
      this.#state = before.state;
      this.#detail = before.detail;
      this.#waitingOn = before.waitingOn;
      return false;
    }
    if (at !== undefined) this.#at = at;
    return this.#state !== before.state || this.#detail !== before.detail;
  }

  #set(state: SessionState, detail?: string): void {
    this.#state = state;
    this.#detail = detail;
  }

  #rollout(record: Record<string, unknown>): void {
    if (record['type'] !== 'event_msg') return;
    const payload = record['payload'];
    if (!isObject(payload)) return;
    if (payload['type'] === 'task_started') this.#set('busy');
    // `turn_aborted` is what a turn the user interrupted ends with instead of
    // `task_complete` — including one interrupted *at* a permission prompt, which
    // is the one way `waiting` ends with no `PostToolUse` to clear it. Without it
    // an interrupted session sits at its composer reporting as busy for good.
    else if (payload['type'] === 'task_complete' || payload['type'] === 'turn_aborted') {
      this.#waitingOn = undefined;
      this.#set('idle');
    }
  }

  #hook(event: string, record: Record<string, unknown>): void {
    switch (event) {
      case 'SessionStart':
      case 'SessionEnd':
        this.#waitingOn = undefined;
        this.#set('idle');
        return;
      case 'PreToolUse': {
        const callId = str(record['tool_use_id']);
        // Deduplicated by `tool_use_id`, because this fold is fed from more
        // than one place: the hook log tailer, and — for the record a blocked
        // `PermissionRequest` needs — a `catchUp` that reads the same lines
        // again if the tailer had already delivered them.
        if (callId !== undefined && !this.#recent.some((call) => call.callId === callId)) {
          this.#recent.push({
            sessionId: str(record['session_id']),
            turnId: str(record['turn_id']),
            input: inputKey(record['tool_input']),
            callId,
          });
          if (this.#recent.length > RECENT_CALLS) this.#recent.shift();
        }
        this.#set('busy');
        return;
      }
      case 'PermissionRequest':
        this.#waitingOn = this.#correlate(record);
        this.#set('waiting', str(record['tool_name']));
        return;
      case 'PostToolUse': {
        // With a correlated call, only that call's completion answers the
        // prompt; without one, any completion is the best evidence there is.
        const callId = str(record['tool_use_id']);
        if (this.#state !== 'waiting') return;
        if (this.#waitingOn !== undefined && callId !== this.#waitingOn) return;
        this.#waitingOn = undefined;
        this.#set('busy');
        return;
      }
      default:
        return;
    }
  }

  /**
   * Which pending call a `PermissionRequest` is about.
   *
   * **This is a correlation, not a key.** `PermissionRequest` carries no
   * `tool_use_id` (verified against Codex 0.145.0), so the only join available
   * is the most recent `PreToolUse` on the same `(session_id, turn_id)` with the
   * same `tool_input` (up to {@link inputKey}) — and in a real capture that is
   * genuinely ambiguous: a sandbox-denied first attempt and the retry that
   * raises the prompt carry byte-identical `tool_input` under different
   * `tool_use_id`s. Most-recent-wins is right for that case and is not provably
   * right for every case, so **nothing downstream may treat the answer as an
   * identity.**
   *
   * Two things read it, and neither does. It decides which `PostToolUse` clears
   * the badge, and `task_complete` clears it anyway; and it decides which card
   * an answerable permission prompt is drawn on. Not *whether* the user's answer
   * reaches the prompt: the hold is the HTTP request the hook is blocked on, so
   * a tap always answers the call Codex is actually asking about, however this
   * guessed at its id. A `undefined` is honest and its cost is one card's
   * buttons; a wrong id is one card's buttons on the wrong card.
   *
   * `undefined` is also the ordinary answer in a supported configuration: a user
   * who trusted tether's `PermissionRequest` entry in Codex's review and
   * declined its `PreToolUse` one has no pending calls here at all.
   *
   * Worth an upstream issue against Codex.
   */
  #correlate(record: Record<string, unknown>): string | undefined {
    const sessionId = str(record['session_id']);
    const turnId = str(record['turn_id']);
    const input = inputKey(record['tool_input']);
    for (let i = this.#recent.length - 1; i >= 0; i -= 1) {
      const call = this.#recent[i]!;
      if (call.sessionId === sessionId && call.turnId === turnId && call.input === input) {
        return call.callId;
      }
    }
    return undefined;
  }
}
