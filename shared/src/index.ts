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

/**
 * A proposed or recorded tool call. Named because it travels twice: once
 * optimistically from the provider's own pre-tool hook, and again as the
 * transcript record that supersedes it. `callId` is what joins the two.
 */
export type ToolCallEvent = Extract<ConversationEvent, { kind: 'tool_call' }>;

/** What the session is doing, derived from whatever the provider publishes. */
export type SessionState = 'busy' | 'idle' | 'waiting';

/** The two answers a user can give a proposed tool call. */
export type PermissionDecision = 'allow' | 'deny';

/**
 * How a held proposal ended. `timeout` is not a failure: tether stops holding
 * and the provider's own permission prompt takes the question, which is the
 * surface that was always going to be correct.
 */
export type PermissionOutcome = PermissionDecision | 'timeout';

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
   *
   * **Not stable for the life of a tether session.** `/resume` and `--continue`
   * typed into the terminal move Claude Code to a different session id and a
   * different transcript, so this is what the pane is running *now*, re-read from
   * the pane rather than settled once at spawn.
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
  /**
   * What the session is doing now. Sent on subscribe and again whenever it
   * changes.
   *
   * Deliberately *not* a `conv` frame, and this is the reason `status` is the
   * one `ConversationEvent` with no `id`: `seq` is a position in the mapped
   * event stream, and a state that some of its evidence comes from outside that
   * stream — Claude Code's session registry file and its `Notification` hook, a
   * Codex `PermissionRequest` — has no position in it. State is the latest
   * answer, not a record; giving it a `seq` would make the history route and a
   * live tailer disagree about which event is number 12.
   */
  | { c: 'state'; state: SessionState; detail?: string }
  /**
   * A tool call the provider has *proposed* but not yet committed to its
   * transcript — the permission prompt the user is being asked to answer.
   *
   * Also outside the `seq` stream, and for the same reason: it is not a record,
   * it is a claim that will be superseded. The transcript's own `tool_call`
   * arrives later (or, on some builds, ~150ms earlier) with the same `callId`,
   * and the client keys on that to *replace* rather than append. Order between
   * the two is not guaranteed, so neither side may assume it.
   *
   * `deadline` present means tether is **holding the agent's own hook** on this
   * call and will answer it until then: the card gets Approve and Deny, and a
   * tap is what the agent is blocked on. Absent means tether is only reporting —
   * the provider's own prompt owns the answer — and the card must offer no
   * buttons, because a button that resolves nothing is worse than no button.
   */
  | { c: 'pending'; e: ToolCallEvent; deadline?: Timestamp }
  /**
   * A held proposal is over. Outside the `seq` stream for the same reason
   * `pending` is: it is the end of a claim, not a record — the transcript's own
   * `tool_call` still arrives afterwards for an allowed call and supersedes the
   * card by `callId`.
   *
   * Sent to *every* subscriber, which is what makes two phones, or a phone and a
   * terminal, converge rather than race: whoever answered first is the answer,
   * and the rest of them stop offering buttons.
   */
  | { c: 'answer'; callId: string; outcome: PermissionOutcome }
  /** Input `seq` will not be applied again. The client stops retrying it. */
  | { c: 'ack'; seq: number };

/**
 * Client → server on the `conv` channel — a vocabulary of one, and separate from
 * {@link ClientFrame} because the two sockets share none of it: there is no
 * sequencing here and nothing to ack.
 *
 * `watching` is whether the conversation pane is the one in front — which is all
 * the client claims here, and not whether the screen is on. The session screen
 * keeps both panes mounted, so being subscribed says nothing about it, and the
 * server holds a permission prompt only for a viewer whose front pane is the one
 * that answers it — in the browser app, `false` is exactly "the terminal is
 * summoned over the conversation". Absent, the server assumes `true`: that is
 * what opening a session lands on.
 */
export type ConvClientFrame = { c: 'watch'; watching: boolean };

/**
 * Client → server control frames on the terminal channel, also JSON text frames.
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
