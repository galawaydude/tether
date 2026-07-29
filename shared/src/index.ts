/**
 * The contract between the tether server and the browser.
 *
 * Nothing here is implemented yet — these are the shapes every later package
 * codes against. See report sections 4 (conversation) and 5 (architecture).
 */

/** Epoch milliseconds. */
export type Timestamp = number;

/**
 * The normalised conversation shape: what the browser renders, and what every
 * future provider adapter must produce. Deliberately not an interface with a
 * registry behind it — there is one provider in M1.
 */
export type ConversationEvent =
  | { kind: 'user'; id: string; at: Timestamp; text: string }
  | {
      kind: 'assistant';
      id: string;
      at: Timestamp;
      text: string;
      /**
       * Providers that emit running commentary separately from the answer say
       * which this is. Claude Code does not distinguish them and leaves it unset.
       */
      phase?: 'commentary' | 'final_answer';
    }
  /**
   * Presence only; the content of a thinking block is opaque to tether — and in
   * Claude Code 2.1.220 it is opaque on disk too: every `thinking` block in the
   * transcript carries a signature and an empty `thinking` string.
   */
  | { kind: 'thinking'; id: string; at: Timestamp }
  | {
      kind: 'tool_call';
      id: string;
      at: Timestamp;
      tool: string;
      input: unknown;
      callId: string;
    }
  | {
      kind: 'tool_result';
      id: string;
      at: Timestamp;
      callId: string;
      output: string;
      isError: boolean;
    }
  /** The provider compacted its own context. A divider, not a message. */
  | { kind: 'compaction'; id: string; at: Timestamp; trigger?: string }
  | { kind: 'status'; at: Timestamp; state: SessionState; detail?: string };

/** Derived from the provider's own live session registry file. */
export type SessionState = 'busy' | 'idle' | 'waiting';

/**
 * A session as the registry holds it and as the HTTP API returns it. The row and
 * the payload are the same shape on purpose — the routes send it out unchanged —
 * so it lives here, where a change to it is a compile error on both sides.
 *
 * `deadAt` non-null means the tmux session is gone; the row stays, because a dead
 * session is resumable rather than deleted.
 */
export interface Session {
  id: string;
  machineId: string;
  provider: string;
  /**
   * The provider's own session id. Null until the provider has one: Codex creates
   * no session identity until the first user message, so tether holds a
   * provisional row from spawn and back-fills it later.
   */
  providerSessionId: string | null;
  cwd: string;
  title: string;
  tmuxName: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deadAt: Timestamp | null;
}

/**
 * Server → client control frames: JSON, sent as WebSocket **text** frames. They
 * carry no in-process references, so an M3 remote agent can forward them
 * unchanged.
 *
 * Terminal output is deliberately absent. It travels as raw **binary** frames
 * on the same socket, PTY bytes straight into `term.write(Uint8Array)`: a
 * multi-byte UTF-8 glyph split across a chunk boundary corrupts silently the
 * moment anything in that path decodes or base64-encodes.
 */
export type ServerFrame =
  /** A conversation event with its monotonic per-session sequence number. */
  | { c: 'conv'; seq: number; e: ConversationEvent }
  /**
   * The client's `since` is outside the server's in-memory tail, so the gap
   * cannot be replayed: refetch `GET /api/sessions/:id/conversation` and start
   * again from the `seq` it returns. Sending a partial history instead would
   * leave a hole nothing later notices.
   */
  | { c: 'refetch' }
  /** Input `seq` will not be applied again. The client stops retrying it. */
  | { c: 'ack'; seq: number };

/**
 * Client → server control frames, also JSON text frames.
 *
 * `seq` is per client and monotonic, and the client retries until the matching
 * `ack` arrives. Input is the one channel where at-least-once is not good
 * enough — a duplicated prompt is a real, user-visible bug (report section 3).
 * The terminal channel needs no such thing: it is re-derived from tmux on every
 * attach, so there is nothing to replay.
 */
export type ClientFrame =
  /** Message text. Multi-line safe: delivered by tmux's paste buffer, then submitted. */
  | { c: 'input'; seq: number; text: string }
  /**
   * Literal text typed into the terminal, delivered as-is and **not** submitted.
   * This is what a terminal view sends for every printable keystroke, so that no
   * character a user can type has to survive being a tmux argv element: a
   * standalone `';'`, `'{'` or `'}'` is a command separator to tmux's own lexer
   * and the driver's argv guard refuses it, so those go by paste buffer instead.
   */
  | { c: 'text'; seq: number; text: string }
  /**
   * Non-printing keystrokes, as tmux key names: `['Enter']`, `['C-c']`,
   * `['Escape']`, `['Up']`. Printable characters belong in a `text` frame.
   */
  | { c: 'key'; seq: number; keys: string[] }
  /** Last viewer to send this wins; `window-size manual` keeps it off other sessions. */
  | { c: 'resize'; cols: number; rows: number };
