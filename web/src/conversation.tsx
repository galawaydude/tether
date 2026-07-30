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

import {
  answerPermission,
  ApiError,
  convSocketUrl,
  fetchConversation,
  setPermissionMode,
} from './api.ts';
import {
  addAnswer,
  addEcho,
  addEvents,
  addPending,
  diffExtras,
  errorAdvice,
  markUndelivered,
  noRows,
  rebuild,
  sendBlocked,
  toolResult,
  toolState,
  type Diff,
  type Row,
  type Rows,
  type ToolRow,
} from './conversation.ts';
import { markdown, type Block, type Span } from './markdown.ts';
import {
  axesFor,
  choiceIn,
  composerHint,
  lowersBar,
  modeFailure,
  type Axis,
  type Choice,
} from './options.ts';
import { copyLabel, providerLabel, whoLabel } from './providers.ts';
import type { Send, Status } from './terminal.tsx';

/** Same shape of backoff as the terminal channel, and for the same phone. */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** Within this many pixels of the end, a new event scrolls the list along. */
const STICK_PX = 80;

export function ConversationView({
  sessionId,
  provider,
  watching,
  onStatus,
  onState,
  sender,
  terminal,
}: {
  sessionId: string;
  /** Whose name goes over an assistant message. Nothing else here reads it. */
  provider: string;
  /**
   * Whether this pane is the one in front — which is the whole of what is
   * claimed, not that anyone is looking at it. Both panes stay mounted, so the
   * socket alone cannot tell the server, and the server holds the agent on a
   * permission prompt only for a viewer whose front pane is this one: a user
   * working in the terminal must not stall every tool call.
   */
  watching: boolean;
  onStatus: (status: Status) => void;
  /**
   * What the agent is doing, straight off the `state` frame. Reported up rather
   * than rendered here: the *waiting for you* banner belongs above both panes,
   * since a user with the terminal summoned over it needs it just as much.
   */
  onState: (state: SessionState, detail?: string) => void;
  /** Where a composed message goes: the terminal pane's socket. */
  sender: Send;
  /**
   * That socket's own status. The composer needs it: a session that has ended
   * or one the server no longer has can still be typed into, and the message
   * would sit under "Sending…" forever with nothing to say why.
   */
  terminal: Status;
}) {
  const [state, setState] = useState<Rows>(noRows);
  const [failed, setFailed] = useState(false);
  // Also reported up, but the composer needs it here: a message pasted at a
  // permission prompt answers the prompt.
  const [agent, setAgent] = useState<SessionState>('idle');
  const list = useRef<HTMLDivElement>(null);

  // Through a ref: the effect below owns the socket for the life of the session
  // and must not be torn down because a parent re-rendered.
  const status = useRef(onStatus);
  status.current = onStatus;
  const reportState = useRef(onState);
  reportState.current = onState;
  // The live socket and whether this pane is in front, both through refs: the
  // effect below owns the socket for the life of the session, so summoning the
  // terminal must send one frame rather than tear it down and cost a replay.
  const live = useRef<WebSocket | null>(null);
  const inFront = useRef(watching);
  inFront.current = watching;

  useEffect(() => {
    const socket = live.current;
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ c: 'watch', watching }));
    }
  }, [watching]);

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
        // The route's own cursor rather than one re-derived from the rows: it is
        // the documented handshake, and `connect` needs it now, whereas an
        // updater does not run until the next render.
        since = history.seq;
        setState((current) => rebuild(current, history.events));
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
      live.current = ws;
      ws.onopen = () => {
        backoff = RECONNECT_MIN_MS;
        status.current('live');
        // Said on every open rather than only on a change: a reconnect is a new
        // subscription on the server, and it defaults to watching.
        ws.send(JSON.stringify({ c: 'watch', watching: inFront.current }));
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
          live.current = null;
          void load();
          return;
        }
        if (frame.c === 'state') {
          setAgent(frame.state);
          reportState.current(frame.state, frame.detail);
          return;
        }
        if (frame.c === 'pending') {
          // No `since` move: a proposal is not a transcript event and has no
          // position in the `seq` stream. `addPending` only moves the buttons if
          // the record already arrived, which is how the two orderings both come
          // out right.
          setState((current) => addPending(current, frame.e, frame.deadline));
          return;
        }
        if (frame.c === 'answer') {
          setState((current) => addAnswer(current, frame.callId, frame.outcome));
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
        live.current = null;
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
      live.current = null;
      if (socket !== null) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [sessionId]);

  // The socket a composed message leaves on has closed for good, so anything
  // still outstanding is never arriving. `markUndelivered` returns the same
  // object when there is nothing to mark, which is every other status.
  useEffect(() => {
    setState((current) => markUndelivered(current, terminal));
  }, [terminal]);

  // Stick to the end only when already there: a user reading back through a long
  // session must not be yanked to the bottom every time the agent says something.
  const stuck = useRef(true);
  useEffect(() => {
    const element = list.current;
    if (element === null || !stuck.current) return;
    element.scrollTop = element.scrollHeight;
  }, [state]);

  return (
    <>
      <div
        class="scroll conv"
        ref={list}
        onScroll={(event) => {
          const element = event.currentTarget;
          stuck.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX;
        }}
      >
        {failed && (
          <p class="error" role="alert">
            Cannot read this conversation. The terminal still shows everything.
          </p>
        )}
        {state.rows.length === 0 && state.echoes.length === 0 && !failed && (
          <p class="muted">Nothing yet. The terminal shows the session as it starts.</p>
        )}
        {state.rows.map((row) => (
          <RowView key={row.key} row={row} provider={provider} sessionId={sessionId} />
        ))}
        {/* Keyed by position: an echo is retired from the front, so the key of
            everything behind it shifts by one and Preact re-renders text into
            cards that are already on screen rather than replacing them. */}
        {state.echoes.map((echo, at) => (
          <article
            class={`msg msg-user ${echo.undelivered === null ? 'msg-sending' : 'msg-undelivered'}`}
            key={`echo:${at}`}
          >
            {/* The same label the record that replaces it will carry, so the
                swap changes the note and nothing else. */}
            <h3 class="msg-who">{whoLabel('user', provider)}</h3>
            {/* Rendered the same way the record that replaces it will be, so a
                message with a code fence in it does not change shape a second
                later when the transcript catches up. */}
            <Markdown blocks={markdown(echo.text)} />
            <p class="msg-note">{echo.undelivered ?? 'Sending…'}</p>
          </article>
        ))}
      </div>
      <Composer
        agent={agent}
        provider={provider}
        terminal={terminal}
        onSend={(text) => {
          sender.current?.(text);
          setState((current) => addEcho(current, text));
        }}
        // An option is keystrokes, not a message: no echo, because nothing the
        // user wrote is outstanding. The agent's own answer to the command is
        // the confirmation, and it arrives through the transcript like
        // everything else on this screen.
        onApply={(keys) => {
          for (const key of keys) sender.current?.(key);
        }}
        sessionId={sessionId}
      />
    </>
  );
}

/**
 * The composer: a real textarea and a real button, and **no submit on Enter**.
 *
 * That is the whole point of it. Typing a TUI's prompt character by character
 * from a phone means a round trip per keystroke and a running fight with
 * autocorrect (report §3, risk 5); composing the message locally and sending it
 * as one unit makes both stop mattering. Enter therefore has to be a line break
 * — a textarea's own default, which is why nothing here handles a key at all —
 * because submitting a half-written multi-line prompt because someone reached
 * for a line break is a small disaster on a phone, and the phone keyboard's
 * return key is *right there*.
 *
 * A `<form>` around a textarea is safe for exactly the same reason: Enter only
 * submits a form implicitly from a single-line control.
 */
function Composer({
  agent,
  provider,
  terminal,
  onSend,
  onApply,
  sessionId,
}: {
  agent: SessionState;
  provider: string;
  terminal: Status;
  onSend: (text: string) => void;
  onApply: (keys: readonly string[]) => void;
  sessionId: string;
}) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  /** A choice held back until its warning has been read. Never more than one:
   *  a second warning stacked behind the first is a warning nobody reads. */
  const [held, setHeld] = useState<{ axis: Axis; choice: Choice; note: string } | null>(null);
  /** What the last permission-mode request actually did, once the server has
   *  read the pane back. Never what was asked for. */
  const [outcome, setOutcome] = useState<{ busy: boolean; text: string } | null>(null);

  // The message as it would be sent, so the refusal measures what the server
  // will measure rather than what is on screen.
  const message = text.trim();
  const blocked = sendBlocked(agent, message, terminal);
  // The same two facts, minus the length rule: an option's keystrokes are a
  // handful of characters, so only "nothing can reach this session" and "answer
  // the prompt in the terminal first" can stop them — the second because a
  // slash command pasted at a permission dialog answers the dialog.
  const optionsBlocked = sendBlocked(agent, '', terminal) !== null;
  // A permission-mode request is a read-press-read on a pane nobody else may be
  // pressing at, so a second one while the first is in flight is refused by the
  // server and would only ever report a mode it did not aim at. The control says
  // so rather than taking a tap that cannot land.
  const modeInFlight = outcome !== null && outcome.busy;
  const axes = axesFor(provider);

  const submit = (event: Event) => {
    event.preventDefault();
    if (message === '' || blocked !== null) return;
    onSend(message);
    setText('');
    if (box.current !== null) box.current.style.height = '';
  };

  /**
   * Apply a choice. Keystroke axes are fire-and-forget — the agent's own answer
   * lands in the conversation above. The permission-mode axis is a request, and
   * its **response is the only thing allowed to be reported**: the server sends
   * back the mode it confirmed by reading the pane, so a failure says so rather
   * than leaving a control that looks like it worked.
   */
  const apply = (choice: Choice, axis: Axis) => {
    // Re-asked here rather than only on the controls, because this is the one
    // path with a person-paced gap in it: a value that lowers the bar is held
    // behind its sentence, and the agent can reach a permission prompt — or the
    // socket can close — while that sentence is being read. Sending then pastes
    // into a live dialog, where the Enter behind the text answers it.
    if (sendBlocked(agent, '', terminal) !== null) return;
    if (axis.via === 'keys') {
      onApply(choice.keys ?? []);
      return;
    }
    setOutcome({ busy: true, text: `Setting permission mode to ${choice.label}…` });
    setPermissionMode(sessionId, choice.value)
      .then(() => setOutcome({ busy: false, text: `Permission mode is now ${choice.label}.` }))
      .catch((error: unknown) => {
        // The server's own code, so the sentence can distinguish "nothing was
        // pressed" from "keys were pressed and it did not arrive", and its body,
        // which carries the mode the pane was last seen in. Anything else falls
        // through to the neutral wording.
        const code = error instanceof ApiError ? error.code : '';
        const body = error instanceof ApiError ? error.body : null;
        setOutcome({ busy: false, text: modeFailure(code, choice.label, body) });
      });
  };

  const pick = (axis: Axis, value: string) => {
    const choice = choiceIn(axis, value);
    if (choice === undefined) return;
    // Whatever the last request said is about a choice nobody is making now.
    setOutcome(null);
    const note = lowersBar(choice);
    // Held, not applied: a value that stops the agent asking before it acts has
    // to say so first, in the same spirit as the Codex hook's own consent.
    if (note !== null) setHeld({ axis, choice, note });
    else apply(choice, axis);
  };

  return (
    <form class="composer" onSubmit={submit}>
      <label class="sr-only" for="composer-text">
        Message
      </label>
      <textarea
        id="composer-text"
        ref={box}
        class="composer-text"
        rows={1}
        placeholder={composerHint(providerLabel(provider))}
        aria-describedby={blocked === null ? undefined : 'composer-blocked'}
        value={text}
        onInput={(event) => {
          const element = event.currentTarget;
          setText(element.value);
          // Grow to fit, capped by CSS `max-height`. Reset first: without it the
          // box only ever gets taller, since `scrollHeight` of an already-tall
          // element is its own height.
          element.style.height = '';
          element.style.height = `${element.scrollHeight}px`;
        }}
      />
      {held !== null && (
        <div class="composer-warn" role="group" aria-label={`Confirm ${held.axis.label}`}>
          <p role="alert">
            <strong>{held.choice.label}</strong> — {held.note}
          </p>
          <div class="composer-warn-acts">
            <button type="button" onClick={() => setHeld(null)}>
              Cancel
            </button>
            <button
              type="button"
              class="primary"
              disabled={optionsBlocked || (held.axis.via === 'permission-mode' && modeInFlight)}
              onClick={() => {
                apply(held.choice, held.axis);
                setHeld(null);
              }}
            >
              {`Set ${held.axis.label.toLowerCase()} to ${held.choice.label}`}
            </button>
          </div>
        </div>
      )}
      <div class="composer-bar">
        {/* Each control is a menu of values, never a display of the agent's
            current one — tether cannot read most of those from a running pane,
            and a stale value beside a live agent is worse than no value. So it
            shows the axis, resets to it after applying, and the pane's own
            answer in the conversation above is the confirmation. */}
        {axes.map((axis) => (
          <select
            key={axis.id}
            class="composer-opt"
            aria-label={axis.label}
            disabled={optionsBlocked || (axis.via === 'permission-mode' && modeInFlight)}
            value=""
            onChange={(event) => {
              const element = event.currentTarget;
              const value = element.value;
              element.value = '';
              if (value !== '') pick(axis, value);
            }}
          >
            <option value="">{axis.label}</option>
            {axis.choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        ))}
        <button
          type="submit"
          class="composer-send primary"
          disabled={message === '' || blocked !== null}
        >
          Send
        </button>
      </div>
      {/* What the permission-mode request *did*, which is the only thing this
          axis is allowed to claim — the server read the pane back to say it. */}
      {outcome !== null && (
        <p class={`composer-note ${outcome.busy ? '' : 'composer-said'}`} role="status">
          {outcome.text}
        </p>
      )}
      {blocked !== null && (
        <p class="composer-note" id="composer-blocked" role="status">
          {blocked}
        </p>
      )}
    </form>
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

/**
 * Copy, and deliberately **not** `navigator.clipboard`.
 *
 * That API is secure-context only, and tether is plain HTTP off loopback by
 * design — so it is present on the machine serving the app and absent on the
 * phone this product exists for, which is exactly the failure mode
 * `CLAUDE.md`'s insecure-context entry records costing a whole terminal pane.
 * `execCommand('copy')` carries no such gate. It is deprecated and it is also
 * the only thing here that works everywhere this app is loaded.
 *
 * ponytail: a textarea and one call, no permission flow and no fallback chain.
 * If a browser ever drops `execCommand` this needs `navigator.clipboard` in
 * front of it, guarded on being defined rather than on the context.
 */
function copyText(text: string): void {
  // Where focus was, because removing the textarea drops it to `<body>`: the
  // actions are revealed by `:focus-within`, so a keyboard user who did not get
  // their button back has lost both the row and their place in the tab order.
  const was = document.activeElement;
  const box = document.createElement('textarea');
  box.value = text;
  // Off-screen but focusable: `display: none` cannot be selected from.
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.append(box);
  // Focused explicitly: where `select()` alone does not move focus, the copy
  // takes the document's existing selection instead of this text.
  box.focus();
  box.select();
  try {
    document.execCommand('copy');
  } finally {
    box.remove();
    if (was instanceof HTMLElement) was.focus();
  }
}

/**
 * The one per-message action, and it is furniture only where there is a pointer
 * to reveal it with — `style.css` does not render it at all on a touch screen,
 * where a permanent button on every message is density a 360px phone cannot
 * spend. Inside the `<article>`, so hover and focus scope to one message.
 */
function MessageActions({ text, label }: { text: string; label: string }) {
  return (
    <div class="msg-actions">
      <button type="button" class="ghost" aria-label={label} onClick={() => copyText(text)}>
        Copy
      </button>
    </div>
  );
}

/**
 * The markdown tree → elements, and that is the whole of it: every string
 * arrives as a *child*, which Preact makes a text node out of, so nothing an
 * agent writes can become markup. There is no `dangerouslySetInnerHTML` in this
 * file and no HTML string anywhere behind it. The one attribute taken from
 * agent text is `href`, and `markdown.ts` has already refused everything that
 * is not `http`, `https` or `mailto`.
 *
 * Keyed by position because a block list is rebuilt whole from one immutable
 * string — a message's text never changes under it, so position is stable.
 */
function Markdown({ blocks }: { blocks: readonly Block[] }) {
  return (
    <div class="msg-text md">
      {blocks.map((block, at) => (
        <BlockView key={at} block={block} />
      ))}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.block) {
    case 'p':
      return (
        <p class="md-p">
          <Spans spans={block.spans} />
        </p>
      );
    case 'heading': {
      // Demoted three levels and clamped, so a message's own `#` sits *under*
      // the `<h3>` naming who said it rather than above it: a screen reader
      // walking headings must not find the page's outline inverted by something
      // an agent wrote. The size is the class's job, not the element's.
      const Tag = `h${Math.min(6, block.level + 3)}` as 'h4';
      return (
        <Tag class={`md-h md-h${block.level}`}>
          <Spans spans={block.spans} />
        </Tag>
      );
    }
    case 'quote':
      return (
        <blockquote class="md-quote">
          <Spans spans={block.spans} />
        </blockquote>
      );
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag class="md-list">
          {block.items.map((item, at) => (
            <li key={at} class={`md-item md-depth${item.depth}`}>
              <Spans spans={item.spans} />
            </li>
          ))}
        </Tag>
      );
    }
    case 'code':
      // The language is a label, not a lexer: highlighting is a dependency, and
      // what makes code legible on a phone is the monospace box and the fact
      // that it scrolls inside itself rather than widening the page.
      return (
        <div class="md-code">
          {block.lang !== null && <span class="md-lang">{block.lang}</span>}
          <pre>
            <code>{block.text}</code>
          </pre>
        </div>
      );
  }
}

function Spans({ spans }: { spans: readonly Span[] }) {
  return (
    <>
      {spans.map((span, at) => {
        switch (span.span) {
          case 'code':
            return (
              <code key={at} class="md-inline-code">
                {span.text}
              </code>
            );
          case 'strong':
            return <strong key={at}>{span.text}</strong>;
          case 'em':
            return <em key={at}>{span.text}</em>;
          case 'link':
            // A new tab: this app is a live session, and following a link in
            // place costs a terminal replay and a conversation refetch.
            return (
              <a key={at} class="md-link" href={span.href} target="_blank" rel="noreferrer">
                {span.text}
              </a>
            );
          default:
            // A bare string, deliberately: an extra element around plain text
            // would be one more node per run for nothing.
            return span.text;
        }
      })}
    </>
  );
}

function RowView({ row, provider, sessionId }: { row: Row; provider: string; sessionId: string }) {
  switch (row.row) {
    case 'message':
      return (
        <article class={`msg msg-${row.who}`}>
          <h3 class="msg-who">{whoLabel(row.who, provider)}</h3>
          {/* Markdown, and not a dependency: `markdown.ts` is a bounded subset
              that returns data, and this renders data. Copy still copies what
              the agent actually wrote. */}
          <Markdown blocks={row.blocks} />
          <MessageActions text={row.text} label={copyLabel(row.who, provider)} />
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
      return <ToolCard row={row} sessionId={sessionId} />;
  }
}

/**
 * `<details>` rather than a state hook: collapsed by default is the element's
 * own default, and the disclosure keyboard behaviour and screen-reader
 * announcement come with it. An agent session is mostly tool calls — a card that
 * opened itself would bury the conversation under file contents on a phone.
 *
 * One exception, and it is the whole point of this PR: a card the agent is
 * *blocked* on opens itself. Approving what a collapsed card shows — a tool name
 * and one clipped line — is approving blind, which the captain's decision names
 * as worse than the terminal. Open, the card is the command, the path, the diff:
 * enough to decide on a phone.
 */
function ToolCard({ row, sessionId }: { row: ToolRow; sessionId: string }) {
  const answerable = row.answerable;
  const advice = row.failed && row.result !== null ? errorAdvice(row.result) : null;
  // What the diff does not itself say, on a card that is being approved.
  // `null` — which is nearly always — draws nothing at all, not an empty box.
  const extras = diffExtras(row);
  return (
    <details
      class={`tool${row.failed ? ' tool-failed' : ''}${row.pending ? ' tool-pending' : ''}${
        answerable === null ? '' : ' tool-answerable'
      }${advice?.act === true ? ' tool-act' : ''}`}
      open={answerable !== null}
    >
      <summary>
        <span class="tool-name">{row.tool}</span>
        <span class="tool-summary">{row.summary}</span>
        <span class="tool-state">{toolState(row)}</span>
      </summary>
      {row.diff !== null ? (
        <>
          <DiffView diff={row.diff} />
          {extras !== null && (
            <>
              <h4 class="tool-label">Also</h4>
              <pre class="tool-body">{extras}</pre>
            </>
          )}
        </>
      ) : (
        row.input !== undefined && (
          <>
            <h4 class="tool-label">Input</h4>
            <pre class="tool-body">{format(row.input)}</pre>
          </>
        )
      )}
      <h4 class="tool-label">Result</h4>
      {advice !== null && (
        <p class={`tool-advice${advice.act ? ' tool-advice-act' : ''}`}>{advice.text}</p>
      )}
      <pre class="tool-body">{toolResult(row)}</pre>
      {answerable !== null && (
        <Answer sessionId={sessionId} callId={answerable.callId} deadline={answerable.deadline} />
      )}
    </details>
  );
}

/**
 * A change as a change: added lines, removed lines and the path they are in.
 *
 * A `+`/`-` in the text as well as the colour, because colour alone is not a
 * distinction — a red/green pair is exactly the one a large minority of people
 * cannot make, and this is the card that says what an agent is about to do to a
 * file. The marker is `aria-hidden` and each line carries its own word instead,
 * so a screen reader hears "added"/"removed" rather than "plus".
 *
 * It scrolls inside its own box in both directions, like `.tool-body` — except
 * on an answerable card, where the same wrap-don't-clip rule applies as to a
 * command: a line that runs past the right edge of a card the agent is blocked
 * on is a line nobody read before approving it.
 */
function DiffView({ diff }: { diff: Diff }) {
  const added = diff.lines.filter((line) => line.at === 'add').length;
  const removed = diff.lines.filter((line) => line.at === 'del').length;
  return (
    <>
      <h4 class="tool-label">
        Change
        <span class="diff-count">
          <span class="diff-added">+{added}</span> <span class="diff-removed">−{removed}</span>
        </span>
      </h4>
      {diff.path !== null && <p class="diff-path">{diff.path}</p>}
      <div class="tool-body diff">
        {/* Exactly two cells on every row, always: the rows lay out as a CSS
            table so a tinted row runs the full scroll width, and a row with a
            third cell would put its text in a column of its own and shove it off
            the right edge. The spoken word therefore lives *inside* the gutter
            cell rather than beside it. */}
        {diff.lines.map((line, at) => (
          <div key={at} class={`diff-line diff-${line.at}`}>
            <span class="diff-mark">
              <span aria-hidden="true">
                {line.at === 'add' ? '+' : line.at === 'del' ? '−' : ' '}
              </span>
              {(line.at === 'add' || line.at === 'del') && (
                <span class="sr-only">{line.at === 'add' ? 'added ' : 'removed '}</span>
              )}
            </span>
            <span class="diff-text">{line.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * Approve and Deny, plus how long tether will keep holding.
 *
 * The countdown is not decoration. Tapping nothing is a real outcome with a real
 * consequence — the question goes back to the agent's own prompt in the terminal
 * — and a user who cannot see it coming would read the buttons vanishing as a
 * bug. It counts down to the server's own deadline rather than from a duration
 * started at render, so a phone that was asleep resumes near the truth — as near
 * as the two clocks agree, which is the one thing this cannot check. What ends
 * the hold is the `answer` frame either way; this number only describes it.
 *
 * Both buttons disable on the first tap. The server refuses a second answer
 * anyway (one hold, one settle), but a button that still looks tappable after it
 * has been tapped is how a user ends up believing they denied something they
 * approved.
 */
function Answer({
  sessionId,
  callId,
  deadline,
}: {
  sessionId: string;
  callId: string;
  deadline: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(() => remaining(deadline));

  useEffect(() => {
    const timer = setInterval(() => setLeft(remaining(deadline)), 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  const answer = async (decision: 'allow' | 'deny') => {
    setBusy(true);
    setError(null);
    try {
      await answerPermission(sessionId, callId, decision);
      // No optimistic update: the `answer` frame is what clears the buttons, and
      // it is the same frame every other viewer gets. One source, one truth.
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof ApiError ? failure.message : 'Could not send that answer.');
    }
  };

  return (
    <div class="tool-answer">
      {error !== null && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="tool-answer-buttons">
        <button type="button" class="ghost danger" disabled={busy} onClick={() => answer('deny')}>
          Deny
        </button>
        <button type="button" class="primary" disabled={busy} onClick={() => answer('allow')}>
          Approve
        </button>
      </div>
      <p class="muted tool-answer-note" role="status">
        {left > 0
          ? `${left}s left, then Claude Code asks in the terminal instead.`
          : 'Handing back to the terminal…'}
      </p>
    </div>
  );
}

function remaining(deadline: number): number {
  return Math.max(0, Math.round((deadline - Date.now()) / 1000));
}

/** A single string input reads better raw than as a JSON-quoted one-liner. */
function format(input: unknown): string {
  return typeof input === 'string' ? input : (JSON.stringify(input, null, 2) ?? String(input));
}
