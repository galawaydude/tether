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
 *  - **It does not rebuild the list per event.** Transcript frames are batched,
 *    rows are immutable, and `RowView` is memoized, so a burst renders once and
 *    touches only its new nodes — or, for a `tool_result`, its one changed card.
 */

import type { ServerFrame, SessionState } from '@tether/shared';
import { memo } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';

import {
  answerPermission,
  ApiError,
  convSocketUrl,
  fetchConversation,
  IMAGE_TYPES,
  imageUrl,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_IMAGES,
  setPermissionMode,
  uploadImage,
  type UploadedImage,
} from './api.ts';
import { matchCommands, planSend, whereLabel } from './commands.ts';
import {
  addAnswer,
  AUTH_ADVICE,
  addEcho,
  addEvents,
  addPending,
  diffExtras,
  errorAdvice,
  historyPage,
  markUndelivered,
  messageContent,
  messageWithImages,
  noRows,
  rebuild,
  sendBlocked,
  suspectWarning,
  toolResult,
  toolState,
  type Diff,
  type HistoryPage,
  type Row,
  type Rows,
  type ToolRow,
} from './conversation.ts';
import type { Block, Span } from './markdown.ts';
import {
  axesFor,
  choiceIn,
  composerHint,
  lowersBar,
  modeFailure,
  type Axis,
  type Choice,
} from './options.ts';
import {
  AUTH_TERMINAL_LABEL,
  COMMAND_TERMINAL_LABEL,
  copyLabel,
  providerLabel,
  turnErrorLabel,
  whoLabel,
} from './providers.ts';
import type { Send } from './terminal.tsx';
import type { Status } from './status.ts';

/** From `server/src/web/conversation.ts`; this channel's only close code. */
const CLOSE_NO_SESSION = 4404;

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
  onSummon,
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
  /**
   * Raise the terminal. The composer needs it for the slash commands that answer
   * only there — a chooser like `/resume` leaves the agent waiting for a
   * selection on a screen the conversation cannot show, so the note that says so
   * has to carry the way in rather than telling a phone user to go and find it.
   */
  onSummon: () => void;
}) {
  const [state, setState] = useState<Rows>(noRows);
  const [failed, setFailed] = useState(false);
  const [earliest, setEarliest] = useState<number | null>(null);
  const [archive, setArchive] = useState<HistoryPage | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // Whether a live update should keep the current page pinned to its end. Also
  // set when moving between bounded history pages, whose natural entry point is
  // their newest event.
  const stuck = useRef(true);
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
    // A transcript flush often contains a burst of records. The server keeps
    // their order but sends one frame per event; rendering once per frame makes
    // a long conversation re-diff itself dozens of times in one browser frame.
    // Coalesce only transcript events and flush before every out-of-band update.
    let queued: Extract<ServerFrame, { c: 'conv' }>[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flushEvents = () => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      if (queued.length === 0 || closed) return;
      const batch = queued;
      queued = [];
      setState((current) => addEvents(current, batch));
    };
    const queueEvent = (frame: Extract<ServerFrame, { c: 'conv' }>) => {
      queued.push(frame);
      since = Math.max(since, frame.seq);
      flushTimer ??= setTimeout(flushEvents, 16);
    };

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
        setEarliest(history.before ?? history.events[0]?.seq ?? null);
        setArchive(null);
        setHistoryError(null);
        setState((current) => rebuild(current, history.events, history.truncated === true));
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
          // A refetch supersedes anything queued from the stream being left.
          clearTimeout(flushTimer);
          flushTimer = undefined;
          queued = [];
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
          // Keep wire order against a transcript card this may put buttons on.
          flushEvents();
          // No `since` move: a proposal is not a transcript event and has no
          // position in the `seq` stream. `addPending` only moves the buttons if
          // the record already arrived, which is how the two orderings both come
          // out right.
          setState((current) => addPending(current, frame.e, frame.deadline));
          return;
        }
        if (frame.c === 'answer') {
          flushEvents();
          setState((current) => addAnswer(current, frame.callId, frame.outcome));
          return;
        }
        if (frame.c !== 'conv') return;
        queueEvent(frame);
      };
      ws.onclose = (event: CloseEvent) => {
        socket = null;
        live.current = null;
        flushEvents();
        if (closed) return;
        // `CLOSE_NO_SESSION` on *this* channel is the one honest use of it: the
        // route sends it only where `getSession` found no row at all. Reporting
        // that as "Reconnecting…" was a sentence about a session that is not
        // coming back, and it retried against it for the life of the mount.
        if (event.code === CLOSE_NO_SESSION) {
          status.current('gone');
          return;
        }
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
      clearTimeout(flushTimer);
      queued = [];
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
  useEffect(() => {
    const element = list.current;
    if (element === null || !stuck.current) return;
    element.scrollTop = element.scrollHeight;
  }, [state, archive]);

  const showEarlier = async () => {
    const before = archive?.first ?? earliest;
    if (before === null || before <= 1 || loadingEarlier) return;
    setLoadingEarlier(true);
    setHistoryError(null);
    try {
      const history = await fetchConversation(sessionId, before);
      const page = historyPage(history.events, history.truncated === true, history.before);
      if (page === null) {
        setHistoryError('No earlier history was found.');
        return;
      }
      stuck.current = true;
      setArchive(page);
    } catch (failure) {
      setHistoryError(
        failure instanceof ApiError ? failure.message : 'Could not load earlier history.',
      );
    } finally {
      setLoadingEarlier(false);
    }
  };

  const backToLatest = () => {
    stuck.current = true;
    setArchive(null);
    setHistoryError(null);
  };
  const shown = archive?.view ?? state;

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
        {archive === null && state.truncated && (
          <div class="note history-note">
            <span>Earlier conversation is available in fast, bounded pages.</span>
            <button
              type="button"
              class="ghost"
              disabled={loadingEarlier || earliest === null}
              onClick={() => void showEarlier()}
            >
              {loadingEarlier ? 'Loading…' : 'Load earlier'}
            </button>
          </div>
        )}
        {archive !== null && (
          <div class="note history-note">
            <span>
              Earlier history, events {archive.first}–{archive.last}.
            </span>
            <span class="history-actions">
              {archive.more && (
                <button
                  type="button"
                  class="ghost"
                  disabled={loadingEarlier}
                  onClick={() => void showEarlier()}
                >
                  {loadingEarlier ? 'Loading…' : 'Load earlier'}
                </button>
              )}
              <button type="button" class="ghost" onClick={backToLatest}>
                Back to latest
              </button>
            </span>
          </div>
        )}
        {historyError !== null && (
          <p class="error" role="alert">
            {historyError}
          </p>
        )}
        {shown.rows.length === 0 && shown.echoes.length === 0 && !failed && (
          <p class="muted">Nothing yet. The terminal shows the session as it starts.</p>
        )}
        {shown.rows.map((row) => (
          <RowView
            key={row.key}
            row={row}
            provider={provider}
            sessionId={sessionId}
            onSummon={onSummon}
          />
        ))}
        {/* Keyed by position: an echo is retired from the front, so the key of
            everything behind it shifts by one and Preact re-renders text into
            cards that are already on screen rather than replacing them. */}
        {shown.echoes.map((echo, at) => (
          <EchoView
            key={`echo:${at}`}
            source={echo.text}
            undelivered={echo.undelivered}
            provider={provider}
            sessionId={sessionId}
          />
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
        onSummon={onSummon}
        sessionId={sessionId}
      />
    </>
  );
}

function MessageImages({
  images,
  sessionId,
}: {
  images: readonly { id: string }[];
  sessionId: string;
}) {
  if (images.length === 0) return null;
  return (
    <div class="msg-images">
      {images.map((image, at) => {
        const src = imageUrl(sessionId, image.id);
        return (
          <a
            key={image.id}
            href={src}
            target="_blank"
            rel="noreferrer"
            aria-label={`View pasted image ${at + 1} full size`}
          >
            <img src={src} alt={`Pasted image ${at + 1}`} loading="lazy" />
          </a>
        );
      })}
    </div>
  );
}

function EchoView({
  source,
  undelivered,
  provider,
  sessionId,
}: {
  source: string;
  undelivered: string | null;
  provider: string;
  sessionId: string;
}) {
  const content = messageContent(source);
  return (
    <article class={`msg msg-user ${undelivered === null ? 'msg-sending' : 'msg-undelivered'}`}>
      <h3 class="msg-who">{whoLabel('user', provider)}</h3>
      {content.text !== '' && <Markdown blocks={content.blocks} />}
      <MessageImages images={content.images} sessionId={sessionId} />
      <p class="msg-note">{undelivered ?? 'Sending…'}</p>
    </article>
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
type DraftImage = { key: number; file: File; preview: string };
let nextDraftImage = 1;

function Composer({
  agent,
  provider,
  terminal,
  onSend,
  onApply,
  onSummon,
  sessionId,
}: {
  agent: SessionState;
  provider: string;
  terminal: Status;
  onSend: (text: string) => void;
  onApply: (keys: readonly string[]) => void;
  onSummon: () => void;
  sessionId: string;
}) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<readonly DraftImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const imagesNow = useRef<readonly DraftImage[]>([]);
  imagesNow.current = images;
  const box = useRef<HTMLTextAreaElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  // Object URLs hold the pasted bytes. Release every one when this composer is
  // replaced; successful sends and explicit removes release theirs sooner.
  useEffect(
    () => () => {
      for (const image of imagesNow.current) URL.revokeObjectURL(image.preview);
    },
    [],
  );
  /** A choice held back until its warning has been read. Never more than one:
   *  a second warning stacked behind the first is a warning nobody reads. */
  const [held, setHeld] = useState<{ axis: Axis; choice: Choice; note: string } | null>(null);
  /**
   * A permission-mode request being in flight, and it is a **lock rather than a
   * note**: `apply` sets it and only the request settling clears it, so nothing
   * that clears what the composer *says* can unlock the control. Derived state
   * would put that invariant back in the hands of every future caller — the two
   * below are cleared by whoever last made a claim stale, which is exactly the
   * wrong owner for it.
   */
  const [modeBusy, setModeBusy] = useState(false);
  /**
   * What the permission-mode request did, once the server has read the pane back
   * — never what was asked for.
   */
  const [outcome, setOutcome] = useState<string | null>(null);
  /**
   * Where the last slash command's answer is going to turn up, and `hatch` asks
   * for the way into the terminal beside it — which is what a command that answers
   * only there needs.
   *
   * Its own state rather than the request's above, because the two settle
   * independently: a mode result landing must not replace the one hatch a user has
   * to reach the chooser the agent is sitting on.
   */
  const [said, setSaid] = useState<{ text: string; hatch: boolean } | null>(null);

  // The message as it would be sent, so the refusal measures what the server
  // will measure rather than what is on screen.
  const message = text.trim();
  const blocked = sendBlocked(agent, message, terminal);
  // The same two facts, minus the length rule: an option's keystrokes are a
  // handful of characters, so only "nothing can reach this session" and "answer
  // the prompt in the terminal first" can stop them — the second because a
  // slash command pasted at a permission dialog answers the dialog.
  const optionsBlocked = sendBlocked(agent, '', terminal) !== null;
  const axes = axesFor(provider);

  /** The commands worth showing under a half-typed one. Empty for ordinary text,
   *  which is the whole of when this list is not there. */
  const matches = matchCommands(provider, text);

  const clearText = () => {
    setText('');
    if (box.current !== null) box.current.style.height = '';
  };

  const clearImages = () => {
    for (const image of imagesNow.current) URL.revokeObjectURL(image.preview);
    imagesNow.current = [];
    setImages([]);
    if (imageInput.current !== null) imageInput.current.value = '';
  };

  const addImages = (files: readonly File[]) => {
    setImageError(null);
    const accepted: DraftImage[] = [];
    for (const file of files) {
      if (imagesNow.current.length + accepted.length >= MAX_MESSAGE_IMAGES) {
        setImageError(`Attach up to ${MAX_MESSAGE_IMAGES} images to one prompt.`);
        break;
      }
      if (!IMAGE_TYPES.has(file.type)) {
        setImageError('Use a PNG, JPEG, WebP or GIF image.');
        continue;
      }
      if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
        setImageError(`Each image must be no larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
        continue;
      }
      accepted.push({ key: nextDraftImage++, file, preview: URL.createObjectURL(file) });
    }
    if (accepted.length > 0) setImages((current) => [...current, ...accepted]);
  };

  const removeImage = (key: number) => {
    setImages((current) => {
      const removed = current.find((image) => image.key === key);
      if (removed !== undefined) URL.revokeObjectURL(removed.preview);
      return current.filter((image) => image.key !== key);
    });
    setImageError(null);
  };

  /** Whatever the composer last said is about something nobody is doing now.
   *  Notes only: a request in flight keeps its own control disabled through
   *  `modeBusy`, which is not this to clear. */
  const clearNotes = () => {
    setSaid(null);
    setOutcome(null);
  };

  /**
   * Send, and the only branch in it is what the text *is* — `planSend` decides,
   * and it prefers prose wherever the line is ambiguous, since both routes put the
   * same bytes on the same frame and the choice only picks the feedback.
   *
   * A slash command goes out on the same path an option's keystrokes do — the
   * terminal socket, one `input` frame, resend-until-ACKed — and deliberately
   * **not** the message path: a command is addressed to the agent's CLI, so an
   * optimistic "You" bubble would be attributing it to the conversation, and the
   * echo behind it retires on a `user` transcript record that a command never
   * writes. So it would stand at "Sending…" for the life of the session.
   *
   * Both branches are behind the same `blocked` check, which is what makes a
   * command obey the permission rule a message already obeys: text pasted at a
   * provider's own permission dialog answers the dialog, and a slash command is
   * no less dangerous there than a prompt.
   */
  const submit = async (event: Event) => {
    event.preventDefault();
    if ((message === '' && images.length === 0) || blocked !== null || sending) return;
    clearNotes();

    // An attachment is a prompt even when its caption begins with `/`: routing
    // it as a slash command would run the command and silently leave the image
    // out. Upload first so the one input frame carries paths that already exist.
    if (images.length > 0) {
      setSending(true);
      setImageError(null);
      try {
        const uploaded: UploadedImage[] = [];
        for (const image of images) uploaded.push(await uploadImage(sessionId, image.file));
        const composed = messageWithImages(message, uploaded);
        const nowBlocked = sendBlocked(agent, composed, terminal);
        if (nowBlocked !== null) {
          setImageError(nowBlocked);
          return;
        }
        onSend(composed);
        clearText();
        clearImages();
      } catch (failure) {
        setImageError(
          failure instanceof ApiError ? failure.message : 'Could not attach that image. Try again.',
        );
      } finally {
        setSending(false);
      }
      return;
    }

    const plan = planSend(provider, message);
    if (plan.plan === 'message') {
      onSend(message);
      clearText();
      return;
    }
    // Refused, so the text stays in the box: the note says what to change about
    // it, and clearing it would make the user type the whole command again.
    if (plan.plan === 'refuse') {
      setSaid({ text: plan.note, hatch: false });
      return;
    }
    onApply([plan.send]);
    setSaid({ text: plan.note, hatch: plan.hatch });
    clearText();
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
    // Locked here and unlocked only where the request settles, which is what keeps
    // the control shut for the whole of the server's read-press-read:
    // `permission-mode.ts` serialises per pane, so a second concurrent request
    // presses between the first one's read and its read-back and both then confirm
    // a mode neither tap aimed at.
    setModeBusy(true);
    setOutcome(`Setting permission mode to ${choice.label}…`);
    setPermissionMode(sessionId, choice.value)
      .then(() => setOutcome(`Permission mode is now ${choice.label}.`))
      .catch((error: unknown) => {
        // The server's own code, so the sentence can distinguish "nothing was
        // pressed" from "keys were pressed and it did not arrive", and its body,
        // which carries the mode the pane was last seen in. Anything else falls
        // through to the neutral wording.
        const code = error instanceof ApiError ? error.code : '';
        const body = error instanceof ApiError ? error.body : null;
        setOutcome(modeFailure(code, choice.label, body));
      })
      .finally(() => setModeBusy(false));
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
      {/* What `/` means, since the placeholder can only say that it means
          something. In flow — see `.composer-cmds` — and safe there because this
          composer lives inside the conversation `.pane`, so the height it takes
          comes out of `.scroll` beside it and never out of `.panes`, which is the
          box xterm is fitted to: appearing and disappearing on a keystroke cannot
          resize the tmux pane for the session's other viewers. It is the only
          shrinkable child of this panel (`flex: 0 1 auto; min-height: 0`) and
          `.composer-bar` is `flex: none`, which is what keeps Send in the viewport
          at 360×340. */}
      {matches.length > 0 && (
        <ul class="composer-cmds" aria-label="Commands">
          {matches.map((command) => (
            <li key={command.name}>
              {/* Fills the box rather than sending: a command may still want an
                  argument, and a list that sent on a tap would make a mis-tap
                  irreversible on the one surface where `/clear` is in reach. */}
              <button
                type="button"
                class="ghost"
                onClick={() => {
                  setText(command.name);
                  box.current?.focus();
                }}
              >
                <span class="cmd-name">{command.name}</span>
                <span class="cmd-summary">{command.summary}</span>
                <span class="cmd-where">{whereLabel(command)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <label class="sr-only" for="composer-text">
        Message
      </label>
      <div class="composer-shell">
        {images.length > 0 && (
          <div class="composer-images" aria-label="Images attached to this prompt">
            {images.map((image, at) => (
              <div class="composer-image" key={image.key}>
                <a
                  href={image.preview}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`View pasted image ${at + 1} full size`}
                >
                  <img src={image.preview} alt={`Pasted image ${at + 1}`} />
                </a>
                <button
                  type="button"
                  class="composer-image-remove"
                  aria-label={`Remove pasted image ${at + 1}`}
                  onClick={() => removeImage(image.key)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          id="composer-text"
          ref={box}
          class="composer-text"
          rows={1}
          placeholder={composerHint(providerLabel(provider))}
          aria-describedby={
            [
              blocked === null ? null : 'composer-blocked',
              imageError === null ? null : 'image-error',
            ]
              .filter((id) => id !== null)
              .join(' ') || undefined
          }
          value={text}
          onPaste={(event) => {
            const pasted = [...(event.clipboardData?.items ?? [])]
              .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
              .map((item) => item.getAsFile())
              .filter((file): file is File => file !== null);
            if (pasted.length === 0) return;
            event.preventDefault();
            addImages(pasted);
          }}
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
                disabled={optionsBlocked || (held.axis.via === 'permission-mode' && modeBusy)}
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
          <input
            ref={imageInput}
            class="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            tabindex={-1}
            onChange={(event) => addImages([...(event.currentTarget.files ?? [])])}
          />
          <button
            type="button"
            class="ghost composer-attach"
            aria-label="Add image"
            title="Paste an image into the text box, or choose one"
            disabled={sending || images.length >= MAX_MESSAGE_IMAGES}
            onClick={() => imageInput.current?.click()}
          >
            <span aria-hidden="true">＋</span>
            <span>Image</span>
          </button>
          {/* Each control is a menu of values, never a display of the agent's
            current one — Remote Control Agent cannot read most of those from a running pane,
            and a stale value beside a live agent is worse than no value. So it
            shows the axis, resets to it after applying, and the pane's own
            answer in the conversation above is the confirmation.

            The options scroll inside their own one-line strip while Send stays
            fixed at the edge. Three always-visible rows of agent settings were
            taking more space than the message on the phone this UI is for. */}
          <details class="composer-settings">
            <summary>Agent options</summary>
            <div class="composer-options">
              {axes.map((axis) => (
                <select
                  key={axis.id}
                  class="composer-opt"
                  aria-label={axis.label}
                  disabled={optionsBlocked || (axis.via === 'permission-mode' && modeBusy)}
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
            </div>
          </details>
          <button
            type="submit"
            class="composer-send primary"
            disabled={(message === '' && images.length === 0) || blocked !== null || sending}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
      {/* What the permission-mode request *did*, which is the only thing this
          axis is allowed to claim — the server read the pane back to say it. */}
      {outcome !== null && (
        <p class={`composer-note ${modeBusy ? '' : 'composer-said'}`} role="status">
          {outcome}
        </p>
      )}
      {/* Where the last command's answer is going, in the same treatment: two
          different claims, and neither may stand in for the other. */}
      {said !== null && (
        <p class="composer-note composer-said" role="status">
          {said.text}
          {/* The way in, beside the sentence that says it is needed. A command
              whose answer is a chooser has left the agent waiting on a screen
              this pane cannot show, and "open the terminal" as prose on a phone
              is an instruction to go and find a button. */}
          {said.hatch && (
            <>
              {' '}
              {/* This name is one of three that must not contain one another —
                  the rule, the guard and the strings themselves live in
                  `providers.ts`. The part that is local to here: this one and
                  the waiting banner's appear together routinely, because
                  sending `/resume` puts Claude Code into `waiting` within a
                  second, so both are on screen at once. */}
              <button type="button" class="link" onClick={onSummon}>
                {COMMAND_TERMINAL_LABEL}
              </button>
            </>
          )}
        </p>
      )}
      {imageError !== null && (
        <p class="composer-note composer-image-error" id="image-error" role="alert">
          {imageError}
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
 * Copy across both kinds of origin tether supports.
 *
 * `navigator.clipboard` is the clean path where a browser exposes it, but it is
 * secure-context-only and tether is plain HTTP off loopback by design. Feature
 * detection—not an origin guess—keeps the phone path on `execCommand('copy')`,
 * which has no such gate. A permission refusal on the modern path falls back as
 * well; a button that stays silent after one failed API call is not a copy
 * feature.
 */
async function copyText(text: string): Promise<boolean> {
  // Modern where the browser exposes it; remote plain HTTP withholds it, so its
  // absence or refusal falls through to the path that works there too.
  if (navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission policy and browser settings can refuse even in a secure
      // context. The fallback below has a different permission model.
    }
  }

  // Where focus was, because removing the textarea drops it to `<body>`: a
  // keyboard user whose button is not restored has lost their place.
  const was = document.activeElement;
  const box = document.createElement('textarea');
  box.value = text;
  // Off-screen but focusable: `display: none` cannot be selected from.
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.append(box);
  box.focus();
  box.select();
  try {
    return document.execCommand('copy');
  } finally {
    box.remove();
    if (was instanceof HTMLElement) was.focus();
  }
}

/**
 * One action per text-bearing message, visible on touch as well as pointer
 * devices. Its success state is local to the row so copying one reply cannot
 * make every identical button claim it was copied.
 */
function MessageActions({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div class="msg-actions">
      <button
        type="button"
        class="ghost"
        aria-label={copied ? `${label} — copied` : label}
        onClick={() => {
          void copyText(text).then((ok) => {
            if (!ok) return;
            setCopied(true);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1600);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
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

const RowView = memo(function RowView({
  row,
  provider,
  sessionId,
  onSummon,
}: {
  row: Row;
  provider: string;
  sessionId: string;
  onSummon: () => void;
}) {
  switch (row.row) {
    case 'message':
      return (
        <article class={`msg msg-${row.who}`}>
          <h3 class="msg-who">{whoLabel(row.who, provider)}</h3>
          {/* Markdown, and not a dependency: `markdown.ts` is a bounded subset
              that returns data, and this renders data. Copy still copies what
              the agent actually wrote. */}
          {row.text !== '' && <Markdown blocks={row.blocks} />}
          <MessageImages images={row.images} sessionId={sessionId} />
          {row.text !== '' && (
            <MessageActions text={row.text} label={copyLabel(row.who, provider)} />
          )}
        </article>
      );
    case 'thinking':
      return (
        <p class="thinking">
          <span aria-hidden="true">✳</span> Thinking…
        </p>
      );
    case 'command':
      // Monospace and no box: the machine said it, and a command is not a
      // message. Its own line rather than a card — a card the size of
      // `Set model to Sonnet 5` is furniture.
      return <p class={row.output ? 'cmd cmd-out' : 'cmd'}>{row.text}</p>;
    case 'compaction':
      return <p class="divider">context compacted</p>;
    case 'error':
      // The provider's own sentence, in a box, because a box means an artefact
      // and this is one: its CLI wrote it, the model did not. The app's own line
      // goes underneath and only for the case it can stand behind.
      return (
        // A plain `<div>`, not an `<aside>`: this row is part of the
        // conversation's own flow rather than complementary to it, and an
        // `<aside>` here has no sectioning ancestor, so it would map to an
        // unnamed `complementary` landmark — one per failed turn, in the same
        // landmark list as the rail's named one.
        <div class={`turn-error${row.auth ? ' turn-error-act' : ''}`}>
          {/* The box says whose words these are to anyone who can see it; this
              is the same attribution for anyone who cannot, and the counterpart
              of the `msg-who` heading a message carries. */}
          <h3 class="sr-only">{turnErrorLabel(provider)}</h3>
          <p class="turn-error-text">{row.text}</p>
          {row.auth && (
            <p class="turn-error-advice">
              {AUTH_ADVICE.text}{' '}
              {/* The tappable half. Neither provider emits a sign-in URL into
                  anything outside the pane — Claude Code's five auth messages
                  say "Please run /login" and carry no link, Codex says "log out
                  and sign in again" — and reading one off the screen would be
                  the terminal-parsing the plan rejects. So what is tappable is
                  the way there, which is the same escape hatch the composer's
                  command note offers for the same reason: an answer that lives
                  on a screen this pane cannot show.

                  Its wording lives in `providers.ts` with the rest of the
                  accessible names, held apart from the composer note's "Show the
                  terminal" and the waiting banner's "Open the terminal" by a
                  test there: all three can be on screen together and
                  `getByRole({ name })` matches on a substring.

                  ponytail: it summons and does not also send `/login`. That
                  would land a Claude Code user directly on the login chooser —
                  but it is Claude Code's command alone (Codex signs in with a
                  shell command, so the same text would sit unsent in its
                  composer), so it is a per-provider table entry for one step.
                  Add it when someone signs in often enough to mind. */}
              <button type="button" class="link" onClick={onSummon}>
                {AUTH_TERMINAL_LABEL}
              </button>
            </p>
          )}
        </div>
      );
    case 'note':
      return <p class="note">{row.text}</p>;
    case 'tool':
      return <ToolCard row={row} sessionId={sessionId} provider={provider} />;
  }
});

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
function ToolCard({
  row,
  sessionId,
  provider,
}: {
  row: ToolRow;
  sessionId: string;
  provider: string;
}) {
  const answerable = row.answerable;
  const advice = row.failed && row.result !== null ? errorAdvice(row.result) : null;
  // What the diff does not itself say, on a card that is being approved.
  // `null` — which is nearly always — draws nothing at all, not an empty box.
  const extras = diffExtras(row);
  // Characters that make the command or the path read as something it is not.
  const warning = suspectWarning(row.suspects);
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
      <pre class="tool-body">{toolResult(row, provider)}</pre>
      {/* On a card nobody is deciding on the same finding is a note and gates
          nothing: the call has run, and there is no answer to hold back. */}
      {answerable === null && warning !== null && <p class="tool-warn">{warning}</p>}
      {answerable !== null && (
        <Answer
          sessionId={sessionId}
          callId={answerable.callId}
          deadline={answerable.deadline}
          warning={warning}
        />
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
 *
 * A `warning` names characters that make what is on the card read as something
 * it is not, and it holds **Approve** back until it has been acknowledged.
 * **Deny stays live throughout**, and that asymmetry is the whole point: someone
 * reading this warning most likely wants to refuse, and being made to
 * acknowledge a warning in order to refuse is a surface arguing for the
 * dangerous answer. The acknowledgement is one tap in the place Approve will be,
 * so the panel does not grow taller than the buttons it replaces.
 */
function Answer({
  sessionId,
  callId,
  deadline,
  warning,
}: {
  sessionId: string;
  callId: string;
  deadline: number;
  warning: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(() => remaining(deadline));
  const [acked, setAcked] = useState(false);
  const held = warning !== null && !acked;

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
      {warning !== null && (
        <p class="tool-warn" id={`warn-${callId}`} role="alert">
          {warning}
        </p>
      )}
      {/* Its own row, above, rather than in Approve's place: sharing that place
          would make a double-tap on the same pixels acknowledge and then approve,
          which is the blind approval the warning exists to prevent. */}
      {held && (
        <button type="button" class="tool-ack" onClick={() => setAcked(true)}>
          I have read this
        </button>
      )}
      <div class="tool-answer-buttons">
        <button type="button" class="ghost danger" disabled={busy} onClick={() => answer('deny')}>
          Deny
        </button>
        <button
          type="button"
          class="primary"
          disabled={busy || held}
          aria-describedby={warning === null ? undefined : `warn-${callId}`}
          onClick={() => answer('allow')}
        >
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
