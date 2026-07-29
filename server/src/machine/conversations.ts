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

import type { ConversationEvent, ServerFrame } from '@tether/shared';
import { readFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';

import { mapLines } from '../providers/claude-code/events.ts';
import { findTranscript, tailLines, type Tail } from '../providers/claude-code/transcript.ts';
import { setProviderSessionId, type Session } from './registry.ts';

/**
 * How many events a reconnecting client can have missed and still be caught up
 * from memory. Beyond it the client is told to refetch the history route, which
 * is always correct and costs one request.
 */
export const TAIL_EVENTS = 512;

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
  warn?: (message: string) => void;
};

/** Session ids inside a warning; folded out so the key is the complaint itself. */
const ID_IN_MESSAGE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Past this many distinct complaints the format has moved far enough to notice. */
const MAX_WARNINGS = 100;

/**
 * Where a tolerant-parse warning goes when the caller names no sink. Ignoring an
 * unknown record is only half the rule — the other half is that the operator
 * finds out that Claude Code's on-disk format moved, and the server runs Fastify
 * with `logger: false`, so stderr is the only place left. Each distinct message
 * is written once: one unknown record type must not become one line per record.
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
  refs: number;
  seq: number;
  tail: SeqEvent[];
  subscribers: Set<Send>;
  /** Resolved once the transcript has been read to its end at least once. */
  ready: Promise<void>;
  tailer?: Tail | undefined;
  retry?: NodeJS.Timeout | undefined;
  stopped: boolean;
};

export class Conversations {
  readonly #db: DatabaseSync;
  readonly #options: ConversationsOptions;
  readonly #live = new Map<string, Live>();
  readonly #warnTo: (message: string) => void;

  constructor(db: DatabaseSync, options: ConversationsOptions = {}) {
    this.#db = db;
    this.#options = options;
    this.#warnTo = options.warn ?? stderrWarn();
  }

  #warn(message: string): void {
    this.#warnTo(message);
  }

  async #find(session: Session) {
    const found = await findTranscript({
      cwd: session.cwd,
      createdAt: session.createdAt,
      providerSessionId: session.providerSessionId,
      ...(this.#options.home === undefined ? {} : { home: this.#options.home }),
    });
    // Back-fill the provisional row: the transcript's own name is the provider's
    // session id, so the directory scan happens once per session and PR #12 has
    // the id it needs to resume.
    if (found !== undefined && session.providerSessionId == null) {
      setProviderSessionId(this.#db, session.id, found.providerSessionId);
    }
    return found;
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
    const mapped = mapLines(lines, (message) => this.#warn(message));
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

    live.subscribers.add(send);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      live.subscribers.delete(send);
      live.refs -= 1;
      if (live.refs <= 0) void this.#close(session.id);
    };
  }

  /** Every tailer and timer this holds. The server's `onClose` calls it. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#live.keys()].map((id) => this.#close(id)));
  }

  #open(session: Session): Live {
    const existing = this.#live.get(session.id);
    if (existing !== undefined) return existing;

    const live: Live = {
      refs: 0,
      seq: 0,
      tail: [],
      subscribers: new Set(),
      ready: Promise.resolve(),
      stopped: false,
    };
    this.#live.set(session.id, live);
    live.ready = this.#start(session, live);
    return live;
  }

  /**
   * Start following the transcript, retrying while there is none: a session that
   * was created a moment ago has no transcript until Claude Code writes its first
   * record, and a viewer opening straight after `POST /sessions` is the normal
   * case, not an edge one.
   */
  async #start(session: Session, live: Live): Promise<void> {
    if (live.stopped) return;
    const found = await this.#find(session).catch(() => undefined);
    if (live.stopped) return;
    if (found === undefined) {
      live.retry = setTimeout(() => {
        live.ready = this.#start(session, live);
      }, this.#options.pollMs ?? 1000);
      live.retry.unref();
      return;
    }

    live.tailer = await tailLines(found.path, (lines) => this.#ingest(live, lines), {
      ...(this.#options.pollMs === undefined ? {} : { pollMs: this.#options.pollMs }),
      onError: (error) => this.#warn(`transcript tail failed: ${String(error)}`),
    }).catch((error: unknown) => {
      this.#warn(`cannot follow ${found.path}: ${String(error)}`);
      return undefined;
    });
  }

  #ingest(live: Live, lines: readonly string[]): void {
    for (const e of mapLines(lines, (message) => this.#warn(message)).events) {
      live.seq += 1;
      const entry = { seq: live.seq, e };
      live.tail.push(entry);
      if (live.tail.length > TAIL_EVENTS) live.tail.shift();
      for (const send of live.subscribers) send({ c: 'conv', seq: entry.seq, e });
    }
  }

  async #close(id: string): Promise<void> {
    const live = this.#live.get(id);
    if (live === undefined) return;
    this.#live.delete(id);
    live.stopped = true;
    if (live.retry !== undefined) clearTimeout(live.retry);
    await live.ready.catch(() => {});
    await live.tailer?.stop();
  }
}
