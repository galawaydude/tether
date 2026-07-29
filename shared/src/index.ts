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
  /** Raw keystrokes, as tmux key names: `['Enter']`, `['C-c']`, `['Escape']`. */
  | { c: 'key'; seq: number; keys: string[] }
  /** Last viewer to send this wins; `window-size manual` keeps it off other sessions. */
  | { c: 'resize'; cols: number; rows: number };
