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
  | { kind: 'assistant'; id: string; at: Timestamp; text: string }
  /** Presence only; the content of a thinking block is opaque to tether. */
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
  | { kind: 'status'; at: Timestamp; state: SessionState; detail?: string };

/** Derived from the provider's own live session registry file. */
export type SessionState = 'busy' | 'idle' | 'waiting';

/**
 * Server → client WebSocket frames. One socket per open session, two logical
 * channels. These carry no in-process references, so an M3 remote agent can
 * forward them unchanged.
 */
export type ServerFrame =
  /** Raw terminal bytes, base64-encoded for JSON transport. */
  | { c: 'term'; d: string }
  /** A conversation event with its monotonic per-session sequence number. */
  | { c: 'conv'; seq: number; e: ConversationEvent };
