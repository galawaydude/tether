/**
 * The conversation channel: a per-session `seq`, an in-memory tail, and fan-out.
 *
 * Note the asymmetry with `terminal.ts`, and do not remove it. The terminal has
 * no cursor because tmux re-derives it exactly on every attach. Conversation
 * events are not re-derivable from anything the client holds, so this one needs
 * a cursor — one integer, and one branch for the client that has been gone
 * longer than the tail.
 *
 * `seq` is a position in the mapped event stream, counted from 1. That is what
 * makes it free: the transcript is append-only and the mapper is deterministic,
 * so the HTTP history route and a live tailer independently agree on which event
 * is number 12 without either persisting anything.
 */

import type {
  ConversationEvent,
  PermissionDecision,
  PermissionOutcome,
  ServerFrame,
  SessionState,
  ToolCallEvent,
} from '@tether/shared';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { stateDir as defaultStateDir } from '../db.ts';
import {
  mapHook as mapClaudeHook,
  mapLines as mapClaudeLines,
} from '../providers/claude-code/events.ts';
import { readSession, readSessionId } from '../providers/claude-code/status.ts';
import { findTranscript, type StartMemo } from '../providers/claude-code/transcript.ts';
import { mapHook as mapCodexHook, mapLines as mapCodexLines } from '../providers/codex/events.ts';
import {
  hookLogPath,
  installedPermissionTimeout,
  MAX_HOLD_MS,
  PERMISSION_TIMEOUT_SECONDS,
} from '../providers/codex/hooks.ts';
import { findRollout } from '../providers/codex/rollout.ts';
import { CODEX, codexHome } from '../providers/codex/spawn.ts';
import { CodexStatus } from '../providers/codex/status.ts';
import { type HoldBasis, type HookSignal, permissionTimeoutMs } from '../providers/permission.ts';
import { tailLines, type Tail } from '../providers/tail.ts';
import {
  claimedProviderSessionIds,
  listSessions,
  setProviderSessionId,
  type Session,
} from './registry.ts';
import { DEFAULT_SOCKET, listPanes, type Pane } from './tmux.ts';

/**
 * How many events a reconnecting client can have missed and still be caught up
 * from memory. Beyond it the client is told to refetch the history route, which
 * is always correct and costs one request.
 */
export const TAIL_EVENTS = 512;

/**
 * How long an unreconciled pending tool card is worth showing. A `PreToolUse`
 * is superseded by the transcript record with the same `callId`, which arrives
 * within a second in the normal case — but a session nobody is watching has no
 * tailer running to notice, so this is the floor that stops a proposal from a
 * turn an hour ago being presented as live.
 */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/** Simultaneous proposals in one turn; past this the oldest is dropped. */
const MAX_PENDING = 8;

/** How often the provider's own session registry file is re-read. */
export const STATUS_POLL_MS = 1000;

export type SeqEvent = { seq: number; e: ConversationEvent };

export type ConversationHistory = {
  /** The highest `seq` in `events`; 0 when there is nothing yet. */
  seq: number;
  events: SeqEvent[];
  /** Claude Code's own `ai-title` for the session, once it has named it. */
  title?: string;
  /** The transcript's `version`, for comparing against the captured fixtures. */
  version?: string;
};

export type Send = (frame: ServerFrame) => void;

export type ConversationsOptions = {
  pollMs?: number;
  /** Home directory to look for `~/.claude/projects` under. Tests point it away. */
  home?: string;
  /** Codex's own home. Defaults to what Codex itself would read. */
  codexHome?: string;
  /** Where tether's Codex hook writes. Defaults to tether's state directory. */
  stateDir?: string;
  /**
   * tmux socket, for the pane pid both providers join by: a Codex
   * `SessionStart`, and the Claude Code registry file that is named by it.
   */
  socket?: string | undefined;
  warn?: (message: string) => void;
  /** How often Claude Code's status file is re-read; 0 turns the poller off. */
  statusPollMs?: number;
  /** Overrides `TETHER_PERMISSION_TIMEOUT`; 0 stops tether holding at all. */
  permissionTimeoutMs?: number;
  /**
   * Awaited inside `#syncFromPane`, and nothing in production passes it. The
   * window between "this row has no provider session id" and "it has one" is
   * where a bind can arrive from somewhere else, and that race is load-dependent
   * on a real machine — see `#restart`. This is what lets a test open the window
   * on purpose instead of hoping for a loaded CI box.
   */
  syncDelay?: () => Promise<void>;
};

/**
 * `from` is the transcript line number the batch starts at. Only the Codex
 * mapper reads it — it has no record ids of its own and synthesizes them from
 * the line number, which has to be the file's rather than the batch's or a
 * refetch renumbers everything the client holds. Claude Code's mapper takes ids
 * from the records themselves and ignores it.
 */
type MapLines = (
  lines: readonly string[],
  warn?: (message: string) => void,
  from?: number,
) => { events: ConversationEvent[]; title?: string; version?: string };

/**
 * Which mapper reads this session's file. Two providers, one switch — no
 * registry, no interface, no factory (report §4). A provider tether does not
 * know is read as Claude Code, which is the only thing it can be. The column is
 * not an enum: `startSession` only looks a provider up in `PROVIDER_COMMANDS`
 * when it has no explicit command, so `tether new <dir> --provider anything --
 * somecmd` stores that string, and so does a row written by a newer tether.
 */
export function mapperFor(provider: string): MapLines {
  return provider === CODEX ? mapCodexLines : mapClaudeLines;
}

/** Session ids inside a warning; folded out so the key is the complaint itself. */
const ID_IN_MESSAGE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Past this many distinct complaints the format has moved far enough to notice. */
const MAX_WARNINGS = 100;

/**
 * Where a tolerant-parse warning goes when the caller names no sink. Ignoring an
 * unknown record is only half the rule — the other half is that the operator
 * finds out that Claude Code's on-disk format moved. Fastify's own log is on
 * stderr too (see `logLevel` in `web/server.ts`), so a caller that names no sink
 * lands where the rest of the server's failures do. Each distinct message is
 * written once: one unknown record type must not become one line per record.
 *
 * Going quiet at the cap is said out loud, once. A long-lived `tether serve`
 * with nothing to report and one that has stopped reporting must not look the
 * same to whoever is reading the log.
 */
export function stderrWarn(): (message: string) => void {
  const seen = new Set<string>();
  let announcedSilence = false;
  return (message) => {
    const key = message.replace(ID_IN_MESSAGE, '<id>');
    if (seen.has(key)) return;
    if (seen.size >= MAX_WARNINGS) {
      if (announcedSilence) return;
      announcedSilence = true;
      process.stderr.write('tether: further transcript warnings suppressed\n');
      return;
    }
    seen.add(key);
    process.stderr.write(`tether: ${message}\n`);
  };
}

type Live = {
  /**
   * The row this is following, and the *one* copy of it that matters once a
   * session is live. `providerSessionId` is re-bound in place when the pane
   * turns out to be running a different session (see `#bind`), so everything
   * downstream — the transcript search, the status poller — has to read it from
   * here rather than from whichever copy of the row it was handed at open time.
   */
  session: Session;
  refs: number;
  seq: number;
  /** Transcript lines the tailer has delivered, which is where the next batch starts. */
  lines: number;
  tail: SeqEvent[];
  subscribers: Set<Send>;
  /**
   * The subset of `subscribers` with the conversation pane actually in front.
   *
   * Not the same set, and the difference is not a detail: the session screen
   * keeps both panes mounted (`web/src/app.tsx`), so the `conv` socket is
   * subscribed for the whole time a user is working in the terminal. Holding on
   * that would stall every `Edit`, `Write` and `Bash` behind a card nobody is
   * looking at, on the one surface where the user is already able to answer.
   * The client says which view is in front and says so again when it changes.
   */
  watching: Set<Send>;
  /** Every `callId` the transcript has produced, so a pending can be retired. */
  seen: Set<string>;
  /**
   * The one state this session is in, whichever provider's evidence produced it.
   * Both paths write it through `#setState`, so "has it changed" is asked once
   * and a subscriber that has just arrived is answered from the same field.
   */
  state: SessionState;
  detail?: string | undefined;
  /** Resolved once the transcript has been read to its end at least once. */
  ready: Promise<void>;
  /**
   * The provider session id whose transcript `#start` actually attached to, which
   * is not always the one the row names: a bind can land while a search is in
   * flight. It is what `seq` counts, so `#restart` asks it — rather than the row —
   * whether there is anything to leave. Undefined until a transcript is found.
   */
  following?: string | undefined;
  /** Discovery's memory, so its once-a-second retry is not a re-read. */
  memo: StartMemo;
  tailer?: Tail | undefined;
  /** Claude Code only: the poller over its own session registry file. */
  statusPoll?: NodeJS.Timeout | undefined;
  /** The tmux pane's pid, which is the provider's own. Resolved once. */
  pid?: number | undefined;
  /** Codex only: the hook log, and the fold that turns it into a state. */
  codex?: CodexStatus | undefined;
  hookTailer?: Tail | undefined;
  retry?: NodeJS.Timeout | undefined;
  stopped: boolean;
};

/**
 * A tool call the provider has proposed, and — while tether is holding the
 * agent's own hook on it — the request that is blocked waiting for an answer.
 *
 * `hold` is what makes the difference between reporting a permission prompt and
 * being the place it is answered. It is present only for the calls tether will
 * actually resolve, which is deliberately not all of them: see `NEVER_HELD` and
 * `#holdFor` for why holding everything would make an agent with a phone open
 * crawl.
 */
type Proposal = {
  at: number;
  e: ToolCallEvent;
  hold?:
    | {
        deadline: number;
        /** Idempotent: the first of the timer, a tap, or a shutdown wins. */
        settle: (outcome: PermissionOutcome) => void;
      }
    | undefined;
  /**
   * How the hold ended, kept after `hold` has gone. A client that was away when
   * it ended — a screen lock is exactly that — would otherwise be replayed a
   * deadline-less proposal and have no way to tell "tether never held this" from
   * "tether held it and stopped", and would put live buttons on a dead hold.
   */
  outcome?: PermissionOutcome | undefined;
};

export class Conversations {
  readonly #db: DatabaseSync;
  readonly #options: ConversationsOptions;
  readonly #live = new Map<string, Live>();
  readonly #warnTo: (message: string) => void;
  /**
   * Proposed tool calls, per session, outside `#live` on purpose: a permission
   * prompt is exactly the moment a user opens the app, so the proposal has to
   * have been kept while nobody was subscribed. Nothing here is persisted — a
   * restarted server has no proposals, which is honest, since the prompt it
   * would be describing is one the agent is still holding on screen.
   */
  readonly #pending = new Map<string, Map<string, Proposal>>();

  constructor(db: DatabaseSync, options: ConversationsOptions = {}) {
    this.#db = db;
    this.#options = options;
    this.#warnTo = options.warn ?? stderrWarn();
  }

  #warn(message: string): void {
    this.#warnTo(message);
  }

  /**
   * The tmux pane's pid, which is the provider process's own. It is the join for
   * both providers: a Codex `SessionStart` to the row that spawned it, and a
   * Claude Code session to its own registry file, which is named by that pid.
   *
   * A tmux that cannot be reached is not an error here — Codex discovery falls
   * through to identifying the rollout by its own `session_meta`, which is also
   * the path a declined hook takes, and the status poller simply has nothing to
   * read this tick.
   *
   * A **dead** pane is skipped rather than reported. `remain-on-exit` keeps such
   * a pane listed with the pid of a process that has already exited, and that
   * pid is exactly what the operating system is free to hand to something else.
   * `readSession` will not trust it either — see the `procStart` check
   * there — but the cheapest place to not ask is here.
   */
  async #panes(): Promise<Pane[]> {
    return listPanes(this.#options.socket ?? DEFAULT_SOCKET).catch(() => []);
  }

  #pidOf(panes: readonly Pane[], session: Session): number | undefined {
    return panes.find((pane) => pane.session === session.tmuxName && !pane.dead)?.pid;
  }

  async #panePid(session: Session): Promise<number | undefined> {
    return this.#pidOf(await this.#panes(), session);
  }

  #home(): { home?: string } {
    return this.#options.home === undefined ? {} : { home: this.#options.home };
  }

  /**
   * Record what a pane says it is running against the row it belongs to, and
   * report whether that changed anything. Whether it was a *first* identification
   * or a move off an id the row already carried is deliberately not reported:
   * that distinction used to decide whether subscribers were told to refetch, and
   * it was the wrong question — see `#restart`.
   *
   * **A provider session id is not stable for the life of a tether session.**
   * `/resume` and `--continue` switch Claude Code to a *different* session id and
   * a different transcript mid-session, so a row bound once at spawn and never
   * re-checked ends up naming a file nothing writes to any more — the
   * conversation view then shows a conversation that simply stopped, while the
   * terminal beside it carries on. The row follows the pane, always.
   *
   * What is already bound is read from the *live* row where there is one, never
   * from the caller's copy: `bindProviderSession` snapshots the rows before it
   * awaits a pane read, and Claude Code runs tool calls in parallel, so two hook
   * posts for one not-yet-recorded session both arrive holding a pre-bind
   * snapshot. Comparing against those has each of them restart the same `Live` —
   * two tailers on one transcript, every line ingested twice, and the one that
   * loses the `live.tailer` field left running for the life of the process.
   */
  #bind(session: Session, running: string | undefined): boolean {
    if (running === undefined) return false;
    const live = this.#live.get(session.id);
    const bound = live === undefined ? session.providerSessionId : live.session.providerSessionId;
    session.providerSessionId = running;
    if (running === bound) return false;
    setProviderSessionId(this.#db, session.id, running);
    if (live !== undefined) live.session.providerSessionId = running;
    return true;
  }

  /**
   * The live row whose pane is running `providerSessionId`, bound to it — the
   * hook route's join, and an exact one.
   *
   * A hook subprocess's `$PPID` is the tmux `pane_pid` (the Codex spike, question
   * 4), and Claude Code names its own session registry file by that same pid. So
   * a pane *states* which session it is running and there is nothing left to
   * guess at. What this replaced matched on the payload's `cwd` and could
   * therefore only ever refuse: two tether sessions in one directory post an
   * identical `cwd`, so the second and every later one was declined and never got
   * a conversation at all. Pane identity tells them apart.
   *
   * The safety property is stronger rather than weaker for it. An agent the user
   * started by hand in a tether-managed directory is in no tether pane, so no
   * pane names its session and nothing is bound — which is the failure that
   * matters, since a row bound to a foreign transcript is a `resume` that hands
   * back somebody else's conversation.
   *
   * A row already bound to a *different* id is a candidate too: that is the
   * `/resume` case, and re-binding it here is what stops the view freezing on the
   * old transcript.
   */
  async bindProviderSession(providerSessionId: string): Promise<Session | undefined> {
    const panes = await this.#panes();
    for (const session of listSessions(this.#db)) {
      if (session.deadAt !== null) continue;
      // Claude Code only, as in `#syncFromPane`: Codex publishes no per-pid
      // registry file, so a `~/.claude/sessions/<pid>.json` found under a Codex
      // pane's pid is a dead agent's leftover under a reused pid, and binding it
      // would write a foreign id into the row that `resume` reads.
      if (session.provider === CODEX) continue;
      const pid = this.#pidOf(panes, session);
      if (pid === undefined) continue;
      if ((await readSessionId(pid, this.#home())) !== providerSessionId) continue;
      if (this.#bind(session, providerSessionId)) this.#restart(this.#live.get(session.id));
      return session;
    }
    return undefined;
  }

  /**
   * What the pane on `pid` is doing, for the session list — the same one read the
   * status poller makes, and the same re-bind, so a row follows its pane whether
   * or not anybody has its conversation open.
   *
   * The list is polled every 5 seconds, so this adds nothing per call: it is the
   * `readSession` the route already made, with `#bind` reading the id out of the
   * snapshot it already had. Only an id that actually moved writes anything.
   *
   * The identity guard is unchanged and lives where it always did: `pid` is a
   * *tether pane's* pid, so an agent the user ran by hand is in no pane here and
   * is never reached, and `readSession`'s liveness and `procStart` checks are
   * what say the file under that pid is really that pane's. What is dropped is
   * only the comparison against the id the row happened to be carrying — which
   * was never the guard, just the reason a resumed session's badge went blank.
   *
   * Claude Code only, as in `#syncFromPane` and `bindProviderSession`: Codex
   * publishes no per-pid registry file, so anything found under a Codex pane's
   * pid is a dead agent's leftover under a reused pid.
   */
  async paneState(session: Session, pid: number): Promise<SessionState | undefined> {
    if (session.provider === CODEX) return undefined;
    const record = await readSession(pid, this.#home());
    if (record === undefined) return undefined;
    if (this.#bind(session, record.sessionId)) this.#restart(this.#live.get(session.id));
    // A file that does not say which session it is cannot be attributed to a row
    // that already names one: no badge rather than a possibly foreign state.
    if (record.sessionId === undefined && session.providerSessionId !== null) return undefined;
    return record.state;
  }

  /**
   * Ask the pane which session it is running, before looking for a transcript.
   *
   * Claude Code only, and only where the row does not already name one: this
   * retires the identification guess `findTranscript` would otherwise have to
   * make from mtimes and record timestamps, which cannot separate two sessions
   * started in one directory seconds apart and which rejects a *resumed*
   * session's transcript outright — its first record is the replayed history,
   * stamped long before the row was created. Keeping the id *current* after that
   * is the status poller's job, once a second off a file it already reads.
   *
   * Codex publishes no such file, and needs none: its rollout is already
   * identified by the pane pid its own `SessionStart` hook carries, and the one
   * thing that changes a Codex session id — `codex resume` — is a spawn tether
   * performs itself and records at the time.
   */
  async #syncFromPane(session: Session): Promise<void> {
    if (session.provider === CODEX || session.providerSessionId != null) return;
    await this.#options.syncDelay?.();
    const pid = await this.#panePid(session);
    if (pid === undefined) return;
    this.#bind(session, await readSessionId(pid, this.#home()));
  }

  async #find(session: Session, memo?: StartMemo) {
    await this.#syncFromPane(session);
    const claimed = claimedProviderSessionIds(this.#db, session.id);
    const found =
      session.provider === CODEX
        ? await findRollout({
            cwd: session.cwd,
            createdAt: session.createdAt,
            providerSessionId: session.providerSessionId,
            codexHome: this.#codexHome(),
            stateDir: this.#stateDir(),
            ...(session.providerSessionId == null ? { panePid: await this.#panePid(session) } : {}),
            claimed,
          })
        : await findTranscript({
            cwd: session.cwd,
            createdAt: session.createdAt,
            providerSessionId: session.providerSessionId,
            // Which transcripts are spoken for is the registry's to know and
            // this class's to pass on — `providers/` stays clear of the database.
            claimed,
            ...(memo === undefined ? {} : { memo }),
            ...(this.#options.home === undefined ? {} : { home: this.#options.home }),
          });
    // Back-fill the provisional row where the pane could not say: for Claude Code
    // the transcript's own name is the provider's session id, and for Codex it
    // comes from the `SessionStart` hook or from the rollout's `session_meta`.
    // `resumeSession` then has the id it needs.
    if (found !== undefined && session.providerSessionId == null) {
      this.#bind(session, found.providerSessionId);
    }
    return found;
  }

  #codexHome(): string {
    return this.#options.codexHome ?? codexHome();
  }

  #stateDir(): string {
    return this.#options.stateDir ?? defaultStateDir();
  }

  /**
   * The whole conversation, read from the file. Deliberately stateless: it is
   * the answer to "I have been gone too long", so it must not depend on anything
   * that could also have been lost.
   */
  async history(session: Session): Promise<ConversationHistory> {
    const found = await this.#find(session);
    if (found === undefined) return { seq: 0, events: [] };
    // `findTranscript` has just stat'd this file, so a read that fails here is a
    // real fault — EACCES, a file that vanished, a transcript past the maximum
    // string length. An empty conversation is a lie the caller cannot tell apart
    // from a session that has not said anything yet, so this one is raised.
    const text = await readFile(found.path, 'utf8').catch((error: unknown) => {
      this.#warn(`cannot read ${found.path}: ${String(error)}`);
      throw error;
    });
    const lines = text.split('\n');
    // A file being appended to right now ends mid-line; that line is not there yet.
    if (!text.endsWith('\n')) lines.pop();
    const mapped = mapperFor(session.provider)(lines, (message) => this.#warn(message));
    return {
      seq: mapped.events.length,
      events: mapped.events.map((e, index) => ({ seq: index + 1, e })),
      ...(mapped.title === undefined ? {} : { title: mapped.title }),
      ...(mapped.version === undefined ? {} : { version: mapped.version }),
    };
  }

  /**
   * Follow a session. `since` is the last `seq` the client holds; 0 means it
   * holds nothing. The client is either replayed the events it missed, in order
   * and exactly once, or told to refetch — never sent a partial history.
   *
   * A `since` *ahead* of the tailer is not a gap: `history()` reads the file
   * itself while the tailer only moves when its watch or its poll fires, so the
   * documented handshake produces one routinely. Because `seq` is absolute and
   * the tailer emits every event from 1 upward, such a client can simply
   * subscribe — it drops what it already holds and the stream catches up.
   * Refetching it instead loses the same race again on the next attempt.
   */
  async subscribe(session: Session, since: number, send: Send): Promise<() => void> {
    const live = this.#open(session);
    live.refs += 1;
    await live.ready;

    const oldest = live.tail[0]?.seq ?? live.seq + 1;
    if (since < oldest - 1) {
      send({ c: 'refetch' });
    } else {
      for (const entry of live.tail) {
        if (entry.seq > since) send({ c: 'conv', seq: entry.seq, e: entry.e });
      }
    }
    // State is not replayed and not numbered — it is the latest answer, so a
    // client that has just arrived gets it once, here, and then on every change.
    send({
      c: 'state',
      state: live.state,
      ...(live.detail === undefined ? {} : { detail: live.detail }),
    });
    // After the replay, so a card the client is about to build from the
    // transcript is already there when its proposal arrives to be ignored. The
    // deadline travels with it: a phone that reconnected mid-hold gets the
    // buttons back, which is exactly the case a screen-lock produces — and a
    // hold that ended while it was away is replayed as the `answer` that ended
    // it, so the card comes back saying so rather than wearing live buttons.
    for (const entry of this.#pendingFor(session.id, live)) {
      send({
        c: 'pending',
        e: entry.e,
        ...(entry.hold === undefined ? {} : { deadline: entry.hold.deadline }),
      });
      if (entry.outcome !== undefined) {
        send({ c: 'answer', callId: entry.e.callId, outcome: entry.outcome });
      }
    }

    live.subscribers.add(send);
    // Watching until told otherwise: the conversation is what opening a session
    // lands on, so the common case costs no frame, and a client too old to say
    // is treated as the observer it was before this.
    live.watching.add(send);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      live.subscribers.delete(send);
      live.watching.delete(send);
      live.refs -= 1;
      if (live.refs <= 0) void this.#close(session.id);
      else this.#releaseUnwatched(session.id, live);
    };
  }

  /**
   * The client saying which view is in front. `false` is the terminal summoned
   * over the conversation, where the provider's own prompt is already the
   * answering surface.
   *
   * Summoning it mid-hold releases rather than denies, exactly as the last
   * viewer leaving does: the question goes back to the provider's own rules, and
   * the terminal the user just summoned is where it will be asked.
   */
  watch(sessionId: string, send: Send, watching: boolean): void {
    const live = this.#live.get(sessionId);
    if (live === undefined || !live.subscribers.has(send)) return;
    if (watching) live.watching.add(send);
    else {
      live.watching.delete(send);
      this.#releaseUnwatched(sessionId, live);
    }
  }

  /** Nobody is looking at the conversation any more, so nothing may be held for it. */
  #releaseUnwatched(id: string, live: Live): void {
    if (live.watching.size > 0) return;
    for (const entry of this.#pending.get(id)?.values() ?? []) entry.hold?.settle('timeout');
  }

  /** Every tailer and timer this holds. The server's `onClose` calls it. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#live.keys()].map((id) => this.#close(id)));
  }

  /**
   * A hook payload for a session — the low-latency edge the transcript cannot
   * match (report §4), and the channel a permission prompt is answered on.
   *
   * One method for two providers, and the split is one `await`, because what
   * each provider's hooks *mean* differs while what tether does with the meaning
   * does not. Claude Code sends `PreToolUse` (a proposal, superseded by the
   * transcript) and `Notification` (*waiting for you*); Codex sends only
   * `PermissionRequest`, and sends it because it has already put a dialog on
   * screen. See `#codexSignal` for the one thing Codex needs first.
   *
   * Resolves to a decision only when tether held the agent on this call and the
   * user answered it. Everything else — an unrecognised payload, a call tether
   * does not hold, a hold nobody answered — resolves to `undefined`, which the
   * route turns into a hook that says nothing and so leaves the question to the
   * provider's own permission rules.
   *
   * `gone` is the route saying its caller has left — see `web/hooks.ts`. A hold
   * outstanding when it fires settles as `timeout`, through the same single-shot
   * `settle` a tap uses, so the card stops being answerable and `answer` starts
   * refusing. That is the general invariant, and it is stated as one in
   * `providers/permission.ts`: tether must never show an answerable card for a
   * decision that cannot land. The hook's own request dying is the earliest
   * point at which that is knowable, and knowing it takes no knowledge of what
   * timeout anybody is really enforcing.
   *
   * Never throws and never rejects: this is called from an HTTP route that the
   * agent's own turn is blocked on.
   */
  async hook(
    session: Session,
    payload: unknown,
    gone?: AbortSignal,
  ): Promise<PermissionDecision | undefined> {
    const live = this.#live.get(session.id);
    const signal =
      session.provider === CODEX
        ? await this.#codexSignal(live, payload)
        : mapClaudeHook(payload, (message) => this.#warn(message));
    if (signal === undefined) return undefined;

    if (signal.signal === 'waiting') {
      if (live === undefined) return undefined;
      this.#setState(live, 'waiting', signal.detail);
      return undefined;
    }

    // The transcript can win this race — measured at ~150ms behind the hook on
    // Claude Code 2.1.220, but nothing guarantees the order — and a proposal for
    // a call that is already a real event is not a proposal.
    //
    // `prompting` is exempt, and not as an edge case: Codex flushes its
    // `function_call` *before* the dialog goes up, so for it "the transcript
    // already has this call" is the normal state of affairs rather than a lost
    // race. The frame below is not proposing a card there — it is putting
    // buttons on the one the client already drew, which is what the `pending`
    // channel does when a `callId` is already on screen.
    if (signal.hold !== 'prompting' && live?.seen.has(signal.e.callId) === true) return undefined;
    const calls = this.#pending.get(session.id) ?? new Map<string, Proposal>();
    this.#pending.set(session.id, calls);
    const entry: Proposal = { at: Date.now(), e: signal.e };
    calls.set(signal.e.callId, entry);
    while (calls.size > MAX_PENDING) {
      const oldest = calls.keys().next().value!;
      // Releasing it as it goes, or the agent waits on a card no longer shown.
      calls.get(oldest)?.hold?.settle('timeout');
      calls.delete(oldest);
    }

    // Two questions that make a hold's *length* moot, asked before it is read:
    // nobody is watching, and the caller has already gone. The second can have
    // happened during `catchUp` above. Asking first also keeps `hooks.json` off
    // the path of every background prompt on the machine.
    const watched = live !== undefined && live.watching.size > 0;
    // Codex is the provider whose hook `timeout` tether may not reconcile, so
    // it is the provider whose hook `timeout` tether has to read. Once per
    // prompt: only `PermissionRequest` ever reaches here for Codex.
    const ceilingMs =
      watched && gone?.aborted !== true && session.provider === CODEX
        ? await this.#codexCeiling()
        : Infinity;
    // Asked again after that read, because the read is an `await` the caller can
    // die inside — and a listener added to a signal that has already fired never
    // runs, so a hold created past this point would never be released by one.
    const holdMs = gone?.aborted === true ? 0 : this.#holdFor(signal.hold, live, ceilingMs);
    if (holdMs === 0) {
      // No `deadline`, so the card offers no buttons: tether is reporting this
      // call, not answering it.
      this.#send(live, { c: 'pending', e: signal.e });
      return undefined;
    }

    const deadline = Date.now() + holdMs;
    const outcome = await new Promise<PermissionOutcome>((resolve) => {
      const timer = setTimeout(() => entry.hold?.settle('timeout'), holdMs);
      timer.unref();
      // Not a denial: the caller leaving is the hold ending, and the question
      // goes back to the provider's own prompt exactly as an expiry does.
      const abandon = (): void => entry.hold?.settle('timeout');
      entry.hold = {
        deadline,
        settle: (result) => {
          if (entry.hold === undefined) return;
          entry.hold = undefined;
          entry.outcome = result;
          clearTimeout(timer);
          // However this ended, so a long-lived server does not accumulate one
          // listener per prompt on a signal that outlives the hold.
          gone?.removeEventListener('abort', abandon);
          this.#send(this.#live.get(session.id), {
            c: 'answer',
            callId: signal.e.callId,
            outcome: result,
          });
          resolve(result);
        },
      };
      gone?.addEventListener('abort', abandon, { once: true });
      this.#send(live, { c: 'pending', e: signal.e, deadline });
    });
    // A hold nobody answered is not a denial. Saying nothing hands the question
    // back to the provider's own prompt, which is where it would have been.
    return outcome === 'timeout' ? undefined : outcome;
  }

  /**
   * A Codex hook payload → a signal, once the correlation it needs is a fact.
   *
   * `PermissionRequest` carries no `tool_use_id` (verified against 0.145.0's own
   * hook schema), so the call it is about has to be correlated from the
   * `PreToolUse` before it — and that record arrives on the hook *log*, not
   * here. The log is followed by a tailer whose `fs.watch` fires within
   * milliseconds and whose poll fires within a second, and the prompt is 20ms
   * behind the `PreToolUse` it belongs to, so waiting for either would be
   * racing. `catchUp` is the answer: the shim appended both lines before it
   * POSTed, so a read to the file's end here makes the correlation certain
   * rather than likely.
   *
   * It also folds this session's own `PermissionRequest`, which is what
   * announces `waiting` — so a declined correlation still leaves the user with
   * the badge and the tool's name.
   *
   * The correlation is not an identity and nothing here treats it as one; the
   * limits are in `CodexStatus#correlate`, and the reason a wrong guess cannot
   * answer the wrong call is there too.
   */
  async #codexSignal(live: Live | undefined, payload: unknown): Promise<HookSignal | undefined> {
    await live?.hookTailer?.catchUp();
    // Only a fold that is actually reporting a prompt may name the call it is
    // about: a stale `#waitingOn` from an earlier turn is not evidence about
    // this one, and holding on it would put buttons on a finished card.
    const callId = live?.codex?.state === 'waiting' ? live.codex.waitingOn : undefined;
    return mapCodexHook(payload, callId, (message) => this.#warn(message));
  }

  /**
   * Answer a held proposal. `false` means there was nothing to answer — the
   * call is unknown, was never held, or has already been settled by the timer
   * or by somebody else's tap.
   *
   * That last case is the whole of the reconciliation with the terminal, and it
   * is why the settle is single-shot: two viewers tapping opposite answers, or a
   * tap that lands just after the hold expired, produce one decision and one
   * refusal — never a second answer aimed at a prompt that has moved on.
   */
  answer(sessionId: string, callId: string, decision: PermissionDecision): boolean {
    const hold = this.#pending.get(sessionId)?.get(callId)?.hold;
    if (hold === undefined) return false;
    hold.settle(decision);
    return true;
  }

  /**
   * How long to hold this proposal, or 0 for "do not".
   *
   * Two conditions, and each removes a different way holding would be a cost
   * with no benefit:
   *
   * - **Somebody has the conversation pane in front.** Not merely subscribed:
   *   the session screen keeps both panes mounted, so the socket stays open
   *   while the user works in the terminal — and holding then would stall an
   *   agent in front of the very surface that answers its prompts. A background
   *   session has no subscriber and never pauses; a session being driven from
   *   the terminal has one that says it is not watching, and does not pause
   *   either. Which pane is in front is all the client reports and all this
   *   knows — not whether the screen is even on.
   * - **The tool is holdable.** Claude Code's `PreToolUse` fires for every call
   *   and says nothing about whether it was going to prompt (verified: see
   *   `NEVER_HELD`), so the read-only burst tools are skipped by name. Without
   *   this an agent reading twenty files with a phone open would stall twenty
   *   times over. Codex needs no such list, because `PermissionRequest` only
   *   fires when it really is asking — that is what `prompting` means.
   *
   * `ceilingMs` is what the provider's own configuration allows — `Infinity`
   * where nothing constrains it, and for Codex whatever `#codexCeiling` read off
   * disk, which is either {@link MAX_HOLD_MS} or 0 for "do not hold at all".
   * Clamping to 0 is how the gate is spelled: the caller decides whether a hold
   * is permitted, this decides how long one may be.
   */
  #holdFor(hold: HoldBasis, live: Live | undefined, ceilingMs = Infinity): number {
    if (hold === 'never' || live === undefined || live.watching.size === 0) return 0;
    const holdMs = Math.max(0, this.#options.permissionTimeoutMs ?? permissionTimeoutMs());
    return Math.min(holdMs, ceilingMs);
  }

  /**
   * Whether tether may hold a Codex turn at all, and for how long.
   *
   * The invariant is stated in `providers/permission.ts`: tether may hold only
   * while the provider's own on-disk hook configuration carries the timeout the
   * hold is sized against. Claude Code satisfies it by reconciling
   * `settings.local.json` on every install and at every `listen`. Codex cannot
   * be reconciled — rewriting its entry re-hashes it and puts a trust review in
   * front of a user who already gave one — so the file is read instead, and this
   * is where.
   *
   * A **gate**, not a clamp, and the reason is a number: the `PermissionRequest`
   * entry an older tether wrote carries `timeout: 3`, and 3s minus
   * `KILL_MARGIN_MS` is negative. There is no hold that fits under a 3s hook
   * timeout — only no hold. And a shorter hold would be worse than none: Codex
   * kills the shim at 3s and raises its own dialog while tether still shows a
   * live deadline, so a tap would report an approval the agent never received.
   * 0 is the existing "report the prompt, no buttons" path — a `pending` with no
   * deadline and the `waiting` badge, which is exactly what a Codex session
   * showed before it could be answered here, and a supported state rather than a
   * failure.
   *
   * Read per prompt and deliberately not cached: a prompt happens a handful of
   * times a turn at human speed, `hooks.json` is one small file, and
   * `tether codex-hook install` can run mid-session. A cache is the thing that
   * would make this stale all over again.
   */
  async #codexCeiling(): Promise<number> {
    const installed = await installedPermissionTimeout({
      codexHome: this.#codexHome(),
      stateDir: this.#stateDir(),
    });
    return installed === PERMISSION_TIMEOUT_SECONDS ? MAX_HOLD_MS : 0;
  }

  #send(live: Live | undefined, frame: ServerFrame): void {
    if (live === undefined) return;
    for (const send of live.subscribers) send(frame);
  }

  /**
   * Live proposals for a session: not yet in the transcript, not yet stale.
   *
   * Note the Codex consequence of retiring on `seen`, because it looks like a bug
   * and is not one: a Codex call is in the transcript before the prompt goes up,
   * so the moment its hold settles the entry goes, and a client that reconnects
   * *after* that is not replayed the `answer`. It has nothing to clear — the card
   * it rebuilds from the transcript carries no buttons — and Codex records the
   * refusal in the rollout itself, so the card still tells the story. Keeping
   * settled entries alive to carry the note would put them past every retirement
   * rule this has.
   */
  #pendingFor(id: string, live: Live): Proposal[] {
    const calls = this.#pending.get(id);
    if (calls === undefined) return [];
    const floor = Date.now() - PENDING_TTL_MS;
    const fresh: Proposal[] = [];
    for (const [callId, entry] of calls) {
      // A held call is never stale and never superseded — the agent is blocked
      // on it — so the two retirement rules below cannot reach one.
      if (entry.hold === undefined && (entry.at < floor || live.seen.has(callId))) {
        calls.delete(callId);
      } else fresh.push(entry);
    }
    if (calls.size === 0) this.#pending.delete(id);
    return fresh;
  }

  #setState(live: Live, state: SessionState, detail?: string | undefined): void {
    if (live.state === state && live.detail === detail) return;
    live.state = state;
    live.detail = detail;
    for (const send of live.subscribers) {
      send({ c: 'state', state, ...(detail === undefined ? {} : { detail }) });
    }
  }

  /**
   * Follow the provider's own live session registry file, which is keyed by the
   * tmux pane's pid — the join is free and there is nothing to keep in step
   * (report §4e). The pid is resolved once: a pane's process does not change,
   * and a session whose pane is gone has no status worth polling.
   */
  #startStatus(live: Live): void {
    const every = this.#options.statusPollMs ?? STATUS_POLL_MS;
    if (every <= 0) return;
    const tick = async () => {
      if (live.stopped) return;
      if (live.pid === undefined) {
        live.pid = await this.#panePid(live.session);
        if (live.pid === undefined) return;
      }
      const record = await readSession(live.pid, this.#home());
      if (live.stopped) return;
      // The pane is the authority on which session it is running, and it is free
      // to change it: a `/resume` or a `--continue` typed into the terminal moves
      // Claude Code to a different session id and a different transcript. This
      // tick is what notices — without it the row keeps naming the file the
      // session used to write to, and the conversation view shows a conversation
      // that stopped while the terminal beside it carries on.
      if (record !== undefined && this.#bind(live.session, record.sessionId)) this.#restart(live);
      const state = record?.state;
      // A stale, absent or unmatched file is "tether cannot say", never `idle`:
      // reading it as a state would erase, one tick later, the `waiting` a
      // `Notification` hook had just set — which is the moment this whole path
      // exists for. The last thing actually known stands until something knows
      // better, as it does for the session list's own badge.
      if (state === undefined) return;
      // The detail is kept while the state stands: the *waiting* message is the
      // `Notification` hook's, and the registry file has no such field, so
      // re-reading it must not erase the one sentence that says what is wanted.
      this.#setState(live, state, state === live.state ? live.detail : undefined);
    };
    void tick();
    live.statusPoll = setInterval(() => void tick(), every);
    live.statusPoll.unref();
  }

  #open(session: Session): Live {
    const existing = this.#live.get(session.id);
    if (existing !== undefined) return existing;

    const live: Live = {
      session,
      refs: 0,
      seq: 0,
      lines: 0,
      tail: [],
      subscribers: new Set(),
      watching: new Set(),
      seen: new Set(),
      state: 'idle',
      ready: Promise.resolve(),
      memo: new Map(),
      ...(session.provider === CODEX ? { codex: new CodexStatus() } : {}),
      stopped: false,
    };
    this.#live.set(session.id, live);
    live.ready = this.#start(live);
    // Claude Code only. Codex publishes no registry file of its own; its state
    // comes from the rollout and its hook log, folded in `#ingest`/`#fold`.
    if (live.codex === undefined) this.#startStatus(live);
    return live;
  }

  /**
   * Follow the transcript the row now names, having followed another one.
   *
   * Both questions this asks are asked of `live.following` — the transcript
   * `#start` really attached to — and never of *how* the row came to be bound.
   * The distinction it used to be told, first identification versus a move, was
   * a proxy for "is a subscriber holding events from the file we are leaving",
   * and the proxy is false: with no id yet, `#start` locates a transcript through
   * `findTranscript`'s timestamp/mtime fallback and begins delivering from it, so
   * by the time a poll tick or a hook binds the id for the *first* time a client
   * can already hold event 1. Treating that as "nobody can be holding anything"
   * re-numbered from 0 and re-sent it with no refetch — a duplicate the browser's
   * own `addEvents` happens to drop, and the next consumer will not. It is
   * load-dependent, which is why the guard is a test with the window forced open
   * (`syncDelay`) rather than a comment.
   *
   * So: nothing to do at all when `#start` already settled on the transcript the
   * row now names — the common shape of that race, where a restart would only
   * re-ingest the file it is already following. Otherwise the numbering being
   * discarded was published if anything was ever counted, and every subscriber is
   * told to refetch rather than sent events that would collide with what it holds
   * — the same branch a client gone longer than the tail takes, so there is no
   * second path for a client to get wrong.
   *
   * Fire-and-forget: the caller is a poll tick or an HTTP route, and there is
   * nothing for either to wait for.
   */
  #restart(live: Live | undefined): void {
    if (live === undefined) return;
    void (async () => {
      // The in-flight `#start` first, or its tailer is attached after this has
      // finished clearing and the old file is followed for the rest of the
      // session. It resolves without waiting for a transcript — the retry it
      // schedules is a timer this then cancels.
      await live.ready.catch(() => {});
      if (live.stopped) return;
      if (live.following !== undefined && live.following === live.session.providerSessionId) return;
      if (live.retry !== undefined) clearTimeout(live.retry);
      live.retry = undefined;
      const tailer = live.tailer;
      live.tailer = undefined;
      await tailer?.stop();
      if (live.stopped) return;
      const published = live.seq > 0;
      live.seq = 0;
      live.lines = 0;
      live.tail = [];
      live.seen.clear();
      live.memo.clear();
      live.following = undefined;
      if (published) for (const send of live.subscribers) send({ c: 'refetch' });
      live.ready = this.#start(live);
    })();
  }

  /**
   * Start following the transcript, retrying while there is none: a session that
   * was created a moment ago has no transcript until Claude Code writes its first
   * record, and a viewer opening straight after `POST /sessions` is the normal
   * case, not an edge one.
   */
  async #start(live: Live): Promise<void> {
    if (live.stopped) return;
    const found = await this.#find(live.session, live.memo).catch(() => undefined);
    if (live.stopped) return;
    if (found === undefined) {
      live.retry = setTimeout(() => {
        live.ready = this.#start(live);
      }, this.#options.pollMs ?? 1000);
      live.retry.unref();
      return;
    }

    const map = mapperFor(live.session.provider);
    live.tailer = await tailLines(found.path, (lines) => this.#ingest(live, map, lines), {
      ...(this.#options.pollMs === undefined ? {} : { pollMs: this.#options.pollMs }),
      onError: (error) => this.#warn(`transcript tail failed: ${String(error)}`),
    }).catch((error: unknown) => {
      this.#warn(`cannot follow ${found.path}: ${String(error)}`);
      return undefined;
    });
    // Which transcript `seq` now counts, and only where the tailer really
    // attached: a file that could not be followed has to stay restartable rather
    // than read as the one tether is already following. Nothing can observe this
    // half-set — `#restart` waits on the whole of `#start`.
    if (live.tailer !== undefined) live.following = found.providerSessionId;

    // The hook log. It is tether's own file in tether's own state directory, so
    // it is created empty rather than waited for: the hook may not have fired
    // yet, may never fire because the user declined it, or may be installed
    // while this session is already running — and an empty file being followed
    // handles all three without a second retry loop. Nothing warns, because a
    // hook that is not there is a supported configuration and not a fault: it
    // costs the `waiting` badge and nothing else.
    if (live.codex !== undefined && !live.stopped) {
      const codex = live.codex;
      const path = hookLogPath(this.#stateDir(), found.providerSessionId);
      live.hookTailer = await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        .then(() => open(path, 'a', 0o600))
        .then((handle) => handle.close())
        .then(() =>
          tailLines(path, (lines) => this.#fold(live, codex, lines), {
            ...(this.#options.pollMs === undefined ? {} : { pollMs: this.#options.pollMs }),
            onError: () => {},
          }),
        )
        .catch(() => undefined);
    }
  }

  #ingest(live: Live, map: MapLines, lines: readonly string[]): void {
    // The rollout carries `task_started`/`task_complete` as well as conversation,
    // so a Codex session's `busy` and `idle` come from the same lines the events
    // do — which is what makes declining the hook cost only the `waiting` badge.
    if (live.codex !== undefined) this.#fold(live, live.codex, lines);
    const from = live.lines;
    live.lines += lines.length;
    for (const e of map(lines, (message) => this.#warn(message), from).events) {
      // The record that supersedes a proposal. The client replaces the card it
      // built by `callId`; all this has to do is stop re-sending the proposal.
      if (e.kind === 'tool_call') live.seen.add(e.callId);
      live.seq += 1;
      const entry = { seq: live.seq, e };
      live.tail.push(entry);
      if (live.tail.length > TAIL_EVENTS) live.tail.shift();
      for (const send of live.subscribers) send({ c: 'conv', seq: entry.seq, e });
    }
  }

  /** Records of either vocabulary through the status fold, announced if it moved. */
  #fold(live: Live, codex: CodexStatus, lines: readonly string[]): void {
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        codex.apply(JSON.parse(line));
      } catch {
        // Not JSON: the same truncated write `map` reports. One warning is enough.
      }
    }
    // `#setState` is the only announcer, so "did it move" is asked in one place
    // rather than once per provider.
    this.#setState(live, codex.state, codex.detail);
  }

  async #close(id: string): Promise<void> {
    const live = this.#live.get(id);
    if (live === undefined) return;
    // The last viewer has gone — or the server is stopping — so nobody can tap
    // and the agent must not keep waiting for one. Released rather than denied:
    // the provider's own prompt takes the question back.
    //
    // Before the map entry goes, not after: `settle` fans its `{c:'answer'}` out
    // through `#live`, so settling into a deleted entry tells nobody. On
    // `closeAll` there are still sockets attached to hear it, and even with none
    // left the reconnect replay is built from what this records.
    for (const entry of this.#pending.get(id)?.values() ?? []) entry.hold?.settle('timeout');
    this.#live.delete(id);
    live.stopped = true;
    if (live.retry !== undefined) clearTimeout(live.retry);
    if (live.statusPoll !== undefined) clearInterval(live.statusPoll);
    await live.ready.catch(() => {});
    await live.tailer?.stop();
    await live.hookTailer?.stop();
  }
}
