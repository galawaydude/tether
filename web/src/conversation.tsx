/**
 * The conversation view: the `conv` channel on one end, a list of rows on the
 * other. Every rendering decision is in `conversation.ts`; this file picks
 * elements and owns the socket.
 *
 * Two things it deliberately does not do:
 *
 *  - **It does not talk to the terminal.** The two views are two renderings of
 *    one process from two independent sources (report §3). There is no shared
 *    cursor, so there is nothing to reconcile, and anything that syncs them is
 *    inventing a consistency problem the design does not have.
 *  - **It does not rebuild the list per event.** Rows are appended by
 *    `addEvents` and carry a stable `key`, so an arriving event is one new node
 *    in the diff — or, for a `tool_result`, one card's contents.
 */

import type { ServerFrame, SessionState } from '@tether/shared';
import { useEffect, useRef, useState } from 'preact/hooks';

import { convSocketUrl, fetchConversation } from './api.ts';
import {
  addEvents,
  addPending,
  noRows,
  type Row,
  type Rows,
  type ToolRow,
} from './conversation.ts';
import type { Status } from './terminal.tsx';

/** Same shape of backoff as the terminal channel, and for the same phone. */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** Within this many pixels of the end, a new event scrolls the list along. */
const STICK_PX = 80;

export function ConversationView({
  sessionId,
  onStatus,
  onState,
}: {
  sessionId: string;
  onStatus: (status: Status) => void;
  /**
   * What the agent is doing, straight off the `state` frame. Reported up rather
   * than rendered here: the *waiting for you* banner belongs above both panes,
   * since a user staring at the terminal tab needs it just as much.
   */
  onState: (state: SessionState, detail?: string) => void;
}) {
  const [state, setState] = useState<Rows>(noRows);
  const [failed, setFailed] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  // Through a ref: the effect below owns the socket for the life of the session
  // and must not be torn down because a parent re-rendered.
  const status = useRef(onStatus);
  status.current = onStatus;
  const reportState = useRef(onState);
  reportState.current = onState;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let backoff = RECONNECT_MIN_MS;
    // The highest `seq` held, which is what a reconnect resumes from. Kept here
    // rather than read back out of state so a frame arriving between renders
    // still moves it.
    let since = 0;

    /**
     * The documented handshake: history over HTTP, then follow from its `seq`.
     * It is also the answer to `refetch`, which is why it is one function — a
     * client that has been gone longer than the server's tail starts again from
     * exactly here rather than from a second, subtly different path.
     *
     * It is reserved for exactly three cases — the first mount, a `refetch`, and
     * its own failure. Every other drop resumes through `connect`, because the
     * server's tail already answers `since` and refetching the whole transcript
     * on each of a phone's screen-locks is the cost this protocol exists to
     * avoid.
     */
    const load = async () => {
      status.current('connecting');
      try {
        const history = await fetchConversation(sessionId);
        if (closed) return;
        setFailed(false);
        // Replace rather than merge: this is the whole conversation, and merging
        // it into rows built from a stream that has since been declared unusable
        // is how a hole gets papered over instead of fixed.
        const fresh = addEvents(noRows(), history.events);
        setState(fresh);
        since = fresh.seq;
        connect();
      } catch {
        if (closed) return;
        setFailed(true);
        retry(load);
      }
    };

    const connect = () => {
      const ws = new WebSocket(convSocketUrl(sessionId, since));
      socket = ws;
      ws.onopen = () => {
        backoff = RECONNECT_MIN_MS;
        status.current('live');
      };
      ws.onmessage = (event: MessageEvent) => {
        const frame = parse(event.data);
        if (frame === undefined) return;
        if (frame.c === 'refetch') {
          // The gap is wider than the server's memory. Close first: `load`
          // reconnects, and two sockets on one session would double every event.
          ws.onclose = null;
          ws.close();
          socket = null;
          void load();
          return;
        }
        if (frame.c === 'state') {
          reportState.current(frame.state, frame.detail);
          return;
        }
        if (frame.c === 'pending') {
          // No `since` move: a proposal is not a transcript event and has no
          // position in the `seq` stream. `addPending` is a no-op if the record
          // already arrived, which is how the two orderings both come out right.
          setState((current) => addPending(current, frame.e));
          return;
        }
        if (frame.c !== 'conv') return;
        setState((current) => {
          const next = addEvents(current, [{ seq: frame.seq, e: frame.e }]);
          since = next.seq;
          return next;
        });
      };
      ws.onclose = () => {
        socket = null;
        if (closed) return;
        // Unlike the terminal channel this does not probe for an expired cookie:
        // both views are mounted together and the terminal already does it, so a
        // second probe on every drop would only double the requests.
        status.current('retrying');
        retry(connect);
      };
    };

    const retry = (next: () => void | Promise<void>) => {
      reconnect = setTimeout(() => void next(), backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    };

    void load();

    return () => {
      closed = true;
      clearTimeout(reconnect);
      if (socket !== null) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [sessionId]);

  // Stick to the end only when already there: a user reading back through a long
  // session must not be yanked to the bottom every time the agent says something.
  const stuck = useRef(true);
  useEffect(() => {
    const element = list.current;
    if (element === null || !stuck.current) return;
    element.scrollTop = element.scrollHeight;
  }, [state]);

  return (
    <div
      class="scroll conv"
      ref={list}
      onScroll={(event) => {
        const element = event.currentTarget;
        stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX;
      }}
    >
      {failed && (
        <p class="error" role="alert">
          Cannot read this conversation. The terminal tab still shows everything.
        </p>
      )}
      {state.rows.length === 0 && !failed && (
        <p class="muted">Nothing yet. The terminal tab shows the session as it starts.</p>
      )}
      {state.rows.map((row) => (
        <RowView key={row.key} row={row} />
      ))}
    </div>
  );
}

/** A text frame that is not a `ServerFrame` is the server's problem, not a crash. */
function parse(data: unknown): ServerFrame | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const frame: unknown = JSON.parse(data);
    return typeof frame === 'object' && frame !== null && 'c' in frame
      ? (frame as ServerFrame)
      : undefined;
  } catch {
    return undefined;
  }
}

function RowView({ row }: { row: Row }) {
  switch (row.row) {
    case 'message':
      return (
        <article class={`msg msg-${row.who}`}>
          <h3 class="msg-who">{row.who === 'user' ? 'You' : 'Claude'}</h3>
          {/* `pre-wrap`, not a markdown pipeline: the events carry plain text and
              the agent's own line breaks, and a renderer would be a dependency
              plus an injection surface for output tether does not control. */}
          <p class="msg-text">{row.text}</p>
        </article>
      );
    case 'thinking':
      return (
        <p class="thinking">
          <span aria-hidden="true">✳</span> Thinking…
        </p>
      );
    case 'compaction':
      return <p class="divider">context compacted</p>;
    case 'note':
      return <p class="note">{row.text}</p>;
    case 'tool':
      return <ToolCard row={row} />;
  }
}

/**
 * `<details>` rather than a state hook: collapsed by default is the element's
 * own default, and the disclosure keyboard behaviour and screen-reader
 * announcement come with it. An agent session is mostly tool calls — a card that
 * opened itself would bury the conversation under file contents on a phone.
 */
function ToolCard({ row }: { row: ToolRow }) {
  return (
    <details class={`tool${row.failed ? ' tool-failed' : ''}${row.pending ? ' tool-pending' : ''}`}>
      <summary>
        <span class="tool-name">{row.tool}</span>
        <span class="tool-summary">{row.summary}</span>
        <span class="tool-state">
          {row.pending ? 'asking' : row.result === null ? '…' : row.failed ? 'error' : '✓'}
        </span>
      </summary>
      {row.input !== undefined && (
        <>
          <h4 class="tool-label">Input</h4>
          <pre class="tool-body">{format(row.input)}</pre>
        </>
      )}
      <h4 class="tool-label">Result</h4>
      {/* Not a decision this file makes: `pending` means the agent has proposed
          the call and is holding for an answer in the terminal. PR #14 puts the
          answer here; until then the sentence says where it is. */}
      <pre class="tool-body">
        {row.result ??
          (row.pending ? 'Waiting for you to answer in the terminal.' : 'Still running.')}
      </pre>
    </details>
  );
}

/** A single string input reads better raw than as a JSON-quoted one-liner. */
function format(input: unknown): string {
  return typeof input === 'string' ? input : (JSON.stringify(input, null, 2) ?? String(input));
}
