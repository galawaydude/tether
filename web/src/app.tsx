/**
 * The whole shell: log in, list sessions, open one. No router — there are three
 * screens and one of them is a modal. The one URL state that earns its keep is
 * `?session=<id>`: a browser refresh restores the open session instead of
 * dropping a captain back at the list while their agent keeps running.
 *
 * There are two shapes, not one with a media query bolted on. On a phone the
 * list and the open session are the same screen at different times. Past
 * `WIDE`, they are side by side — the list is a rail you switch sessions from
 * without going back — and a media query cannot do that, because it cannot
 * mount a component. Everything else about the two shapes is CSS.
 */

import type { Session, SessionState, TrustReport } from '@tether/shared';
import { Fragment } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import * as api from './api.ts';
import { ApiError } from './api.ts';
import { elapsedLabel } from './conversation.ts';
import { ConversationView } from './conversation.tsx';
import {
  CODEX,
  DEFAULT_PROVIDER,
  PROVIDERS,
  providerLabel,
  trustAsk,
  unresumableNote,
  WAITING_TERMINAL_LABEL,
} from './providers.ts';
import { crumbs, groupSessions } from './sessions.ts';
import { TerminalView } from './terminal.tsx';
import { STATUS_TEXT, agentStateTrusted, type Status } from './status.ts';

/** How often the list refreshes. tmux reconciliation happens server-side per read. */
const POLL_MS = 5000;

/**
 * Where a rail beside the session starts paying: below this, 340px of list plus
 * a conversation is two cramped columns rather than one good one. It matches the
 * last block of `style.css`, which is where the rest of the desktop shape lives.
 */
const WIDE = '(min-width: 900px)';
const SESSION_QUERY = 'session';
const RAIL_PREFERENCE = 'tether.sessions-collapsed';

function savedRailPreference(): boolean {
  try {
    return localStorage.getItem(RAIL_PREFERENCE) === '1';
  } catch {
    return false;
  }
}

function saveRailPreference(collapsed: boolean): void {
  try {
    localStorage.setItem(RAIL_PREFERENCE, collapsed ? '1' : '0');
  } catch {
    // Private browsing policies can refuse storage. Collapse still works for
    // this mount; persistence is convenience, never a requirement.
  }
}

/** One stable address for the open session, without introducing a router. */
function rememberSession(id: string | null): void {
  const url = new URL(location.href);
  if (id === null) url.searchParams.delete(SESSION_QUERY);
  else url.searchParams.set(SESSION_QUERY, id);
  history.replaceState(null, '', url);
}

async function restoreSession(): Promise<Session | null> {
  const id = new URL(location.href).searchParams.get(SESSION_QUERY);
  if (id === null) return null;
  try {
    return await api.getSession(id);
  } catch {
    // A stale bookmark is the session list, not a reload loop against a 404.
    rememberSession(null);
    return null;
  }
}

/**
 * `matchMedia`, not a resize listener: it fires only on the crossing, and it
 * carries no secure-context gate — which the browser app may not use, since
 * every device but the one running tether loads it over plain HTTP.
 */
function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return wide;
}

/**
 * How long the current turn has been running, once that is news — `null` the
 * rest of the time, which is nearly all of it. The clock starts when the turn
 * does and stops when it ends, so a session sitting idle costs no timer at all.
 *
 * The tick is 1s and unconditional while a turn runs, so **this is a leaf of its
 * own** rather than a hook on the session screen. A re-render is a re-render of
 * the component holding the state and everything under it: from the screen, one
 * tick would re-diff the whole conversation — every card, every markdown tree,
 * every diff row, thousands of nodes on a session with a few `Edit`s — once a
 * second, precisely while the agent is working. From here it re-renders one
 * `<span>`. The alternative to ticking unconditionally is a timer that only
 * starts at the threshold, which needs a second timer to arm it.
 */
function ElapsedChip({ running }: { running: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const startedAt = useRef<number | null>(null);
  if (running && startedAt.current === null) startedAt.current = Date.now();
  if (!running) startedAt.current = null;

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const elapsed = running ? elapsedLabel(startedAt.current, now) : null;
  // Mono, because it is the machine reporting. Nothing at all until the turn is
  // long enough to be worth saying — see `elapsedLabel`.
  return elapsed === null ? null : <span class="chip-elapsed">{elapsed}</span>;
}

/**
 * What the agent is doing, in the user's words rather than the provider's.
 * `waiting` is the one that matters — it is the whole reason PR #10 exists — so
 * it is the one that gets a banner rather than a chip.
 */
export const STATE_TEXT: Record<SessionState, string> = {
  busy: 'Working',
  idle: 'Idle',
  waiting: 'Waiting for you',
};

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
}

/** The login lockout is a quarter of an hour; "900 seconds" is not how anyone reads that. */
function waitText(seconds: number): string {
  return seconds >= 90 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`;
}

export function App() {
  // `null` while the cookie is being checked: rendering the login form first and
  // replacing it a moment later is a flash of the wrong screen on every load.
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [open, setOpen] = useState<Session | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(savedRailPreference);
  const wide = useWide();
  const railClosed = wide && open !== null && railCollapsed;
  const setRail = useCallback((collapsed: boolean) => {
    setRailCollapsed(collapsed);
    saveRailPreference(collapsed);
  }, []);
  const openSession = useCallback((session: Session) => {
    setOpen(session);
    rememberSession(session.id);
  }, []);
  const closeSession = useCallback(() => {
    setOpen(null);
    rememberSession(null);
  }, []);
  const signedOut = useCallback(() => {
    closeSession();
    setAuthenticated(false);
  }, [closeSession]);
  const removedSession = useCallback(
    (id: string) => {
      if (open?.id === id) closeSession();
    },
    [closeSession, open?.id],
  );

  useEffect(() => {
    let live = true;
    api.checkSession().then(
      () =>
        void restoreSession().then((session) => {
          if (!live) return;
          setOpen(session);
          setAuthenticated(true);
        }),
      () => {
        if (live) setAuthenticated(false);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  if (authenticated === null) return <p class="centre muted">Loading tether…</p>;
  if (!authenticated) {
    return (
      <Login
        onDone={() =>
          void restoreSession().then((session) => {
            setOpen(session);
            setAuthenticated(true);
          })
        }
      />
    );
  }
  const list = (
    <Sessions
      onOpen={openSession}
      onRemoved={removedSession}
      onSignedOut={signedOut}
      rail={wide}
      collapsed={railClosed}
      {...(open === null ? {} : { onCollapse: () => setRail(true) })}
      openId={wide ? (open?.id ?? null) : null}
    />
  );
  const session =
    open === null ? null : (
      <SessionScreen
        // A dead row resumed under the same id needs fresh sockets just as much
        // as switching rows does. The provider process is new even though the
        // conversation identity deliberately is not.
        key={`${open.id}:${open.deadAt ?? 'live'}`}
        session={open}
        onBack={closeSession}
        onSignedOut={signedOut}
        onResumed={openSession}
        sessionsCollapsed={railClosed}
        onShowSessions={() => setRail(false)}
      />
    );

  if (!wide) return session ?? list;
  return (
    <div class={`workspace${railClosed ? ' workspace-rail-closed' : ''}`}>
      {list}
      {session ?? (
        // The `<main>` of this shape when nothing is open: the right-hand pane is
        // the primary content either way, and the rail beside it is complementary.
        <main class="blank">
          <p class="wordmark">tether</p>
          <p class="muted">Pick a session on the left, or start a new one.</p>
        </main>
      )}
    </div>
  );
}

/** The two channels a session screen holds open, both for its whole life. */
type Pane = 'conversation' | 'terminal';

/**
 * The session screen: the conversation, and a terminal summoned over it.
 *
 * There is no tab pair and no choice to make on arrival — opening a session
 * lands on the conversation, which is the interface. The terminal is an escape
 * hatch for what tether has no control for yet (slash commands, trust prompts,
 * crashes, an agent's own permission dialog after a hold expires), so it is
 * summoned from the header, covers the conversation while it is up, and is
 * dismissed back out of the way.
 *
 * Both panes still stay mounted and the one behind is hidden with
 * `visibility: hidden` rather than `display: none` or an unmount. That is the
 * whole of "summoning and dismissing preserves both scroll positions": a
 * laid-out element keeps its `scrollTop`, so neither view needs to save and
 * restore one, and xterm keeps a real size instead of being fitted to 0×0 and
 * back on every summon — which would resize the tmux pane and make the agent
 * redraw its prompt into the scrollback for every other viewer too. The overlay
 * occupies the same box open or closed for the same reason. Unmounting the
 * terminal would additionally cost a full tmux replay per tap, and unmounting
 * the conversation a refetch.
 *
 * The two views share nothing but this frame. They are two renderings of one
 * process from two independent sources (report §3) — there is no cursor between
 * them to get out of sync, and nothing here tries to reconcile them.
 */
function SessionScreen({
  session,
  onBack,
  onSignedOut,
  onResumed,
  sessionsCollapsed,
  onShowSessions,
}: {
  session: Session;
  onBack: () => void;
  onSignedOut: () => void;
  onResumed: (session: Session) => void;
  sessionsCollapsed: boolean;
  onShowSessions: () => void;
}) {
  const [summoned, setSummoned] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const resumable = session.deadAt !== null && session.providerSessionId !== null;

  const resume = async () => {
    if (!resumable || resuming) return;
    setResuming(true);
    setResumeError(null);
    try {
      // The exact provider conversation is already bound to this registry row;
      // no chooser in the terminal is involved.
      onResumed(await api.resumeSession(session.id));
    } catch (failure) {
      setResumeError(messageOf(failure));
      setResuming(false);
    }
  };
  // One chip, two channels: it reports on whichever pane is in front, because
  // "Reconnecting…" is only actionable about the thing being looked at. The
  // agent's own busy/idle/waiting chip sits beside it and is a different fact.
  const [status, setStatus] = useState<Record<Pane, Status>>({
    conversation: 'connecting',
    // A dead conversation has history to read but no terminal to attach. Do not
    // manufacture a failed PTY attempt just to rediscover the fact on the row.
    terminal: session.deadAt === null ? 'connecting' : 'ended',
  });
  const report = (id: Pane) => (next: Status) =>
    setStatus((current) => (current[id] === next ? current : { ...current, [id]: next }));

  // The agent's own state, from the `conv` channel's `state` frame. It sits
  // above both panes rather than inside the conversation: with the terminal
  // summoned it is exactly the thing that says why, and the banner under it is
  // what sends a user to the terminal in the first place.
  const [agent, setAgent] = useState<{ state: SessionState; detail?: string }>({ state: 'idle' });

  // The one thing the two panes do share, and only because the wire says so: a
  // composed message is an `input` frame on the terminal channel, which is where
  // input sequencing lives. Everything they show still comes from two
  // independent sources with no cursor between them (report §3).
  const sender = useRef<((message: string) => void) | null>(null);

  /** Which channel the header's chip reports on: the one that is on screen. */
  const front: Pane = summoned ? 'terminal' : 'conversation';

  /**
   * Whether anything derived from the `state` frame may still be shown.
   *
   * One predicate everywhere the agent's own state reaches the screen — the
   * chip, the banners and the live region — because the fault was never in any
   * one of them: it was **Idle** printed beside **Session not found**, two
   * sources contradicting each other with nothing saying which tether believed.
   * A rule applied to some of them would just move that contradiction to the
   * rest.
   *
   * Both channels and never `front`: the agent's state is one fact about one
   * process, so which pane happens to be on screen cannot be part of the answer
   * — and `ended` on either channel is the session being over for both, however
   * live the other one still looks. `agentStateTrusted` is where that is
   * decided, and where the reason for each state's side of the line is written.
   */
  const agentKnown = agentStateTrusted(status.conversation, status.terminal);

  // The banner's link focuses the same header toggle it operates, so a keyboard
  // user returns to one stable control whose visible label follows the pane.
  const hatch = useRef<HTMLButtonElement>(null);
  // The banner's link is the mirror of that: it is the control that summons, and
  // it is gone once the terminal is up because it would be offering what is
  // already on screen — so it hands focus to the header control for the same
  // reason, rather than dropping it to `<body>`.
  const summon = useCallback(() => {
    setSummoned(true);
    hatch.current?.focus();
  }, []);

  // Said in two places, and it has to be the same sentence in both: the banner
  // when the conversation is on screen, the terminal overlay when it is up.
  const waitingDetail = agent.detail ?? 'The agent has stopped and wants an answer.';

  return (
    // The `<main>` in both shapes: on a phone the list has unmounted, and in the
    // rail shape the list is the complementary landmark beside this one.
    <main class="screen">
      <header class="bar">
        <button class="ghost bar-back" onClick={onBack} aria-label="Back to sessions">
          <span aria-hidden="true">‹</span>
          <span class="bar-back-word">Sessions</span>
        </button>
        {sessionsCollapsed && (
          <button
            type="button"
            class="ghost bar-show-rail"
            aria-label="Show session sidebar"
            title="Show sessions"
            onClick={onShowSessions}
          >
            <span class="rail-icon" aria-hidden="true" />
          </button>
        )}
        <div class="bar-title">
          <strong>{session.title}</strong>
        </div>
        {session.deadAt === null ? (
          /* A toggle rather than an open-only control: it remains on screen in
             both states, and `aria-expanded` names the sheet it summons. */
          <button
            ref={hatch}
            type="button"
            class="ghost bar-term"
            aria-expanded={summoned}
            onClick={() => setSummoned((open) => !open)}
          >
            {summoned ? 'Conversation' : 'Terminal'}
          </button>
        ) : resumable ? (
          /* Resume is a conversation action. The row already names the exact
             provider session, so asking the provider to show a terminal chooser
             here would make the user select the same conversation twice. */
          <button
            type="button"
            class="primary bar-resume"
            aria-label="Resume session"
            disabled={resuming}
            onClick={() => void resume()}
          >
            {resuming ? 'Resuming…' : 'Resume'}
          </button>
        ) : null}
        {/* One non-wrapping status cluster. While the channel is healthy its
            state is a dot and the agent gets the word; when the channel is not
            healthy its own word replaces the agent's. That bound is what keeps
            this bar one fixed row at every phone width. */}
        <div class="bar-chips">
          {/* Gone entirely once the channel has finished, rather than shown
              stale beside it. "Idle" next to "Session not found" is tether
              reporting the agent alive and the session missing at the same
              time, which is what sent a captain looking for lost work — see
              `agentStateTrusted`. The 44px controls already fix this row's
              height, so changing its compact status contents moves no pane.

              The same `agentKnown` as the banners and the live region: this is
              the agent's fact wherever it is printed, and the chip beside it is
              the channel's. */}
          {agentKnown && status[front] === 'live' && (
            <span class={`chip chip-agent-${agent.state}`}>
              {STATE_TEXT[agent.state]}
              {/* Its own component, so the 1s tick re-renders this span and not
                  the conversation under it — see `ElapsedChip`. */}
              <ElapsedChip running={agent.state === 'busy'} />
            </span>
          )}
          <span class={`chip chip-${status[front]}`} role="status">
            {STATUS_TEXT[status[front]]}
          </span>
        </div>
      </header>

      {/* Where this session is. Out of the bar and onto its own strip, which is
          what lets the directory be read as a path rather than as a subtitle —
          and the strip is a row, so the branch it will one day sit beside is a
          segment to append rather than a redesign. Nothing is reserved for one
          here: tether does not know the branch yet, and a placeholder for a
          fact the server cannot supply is furniture.

          Its height is constant, which matters as much here as on `.bar`: this
          box sits above the pane xterm is fitted to. `nowrap`, fixed padding,
          and a directory that cannot change under a running session.

          Not a `<nav>`: a navigation landmark with nothing to navigate to is a
          landmark a screen-reader user lands in and leaves again. The segments
          are decoration over a fact, so the fact is said once, whole, in the
          hidden line — hearing "tmp tether-shots api" with the separators
          stripped is not hearing a path. */}
      <div class="crumbs">
        <span class="sr-only">Working directory: {session.cwd}</span>
        <span class="crumb-path" aria-hidden="true" title={session.cwd}>
          {crumbs(session.cwd).map((segment, at, all) => {
            // A phone gets the useful end of the path rather than seven tiny,
            // ellipsised fragments. CSS reveals the full chain in the rail layout.
            const earlier = at < all.length - 2 ? ' crumb-earlier' : '';
            return (
              <Fragment key={at}>
                <span class={`crumb-sep${earlier}`}>/</span>
                <span class={`${at === all.length - 1 ? 'crumb-last' : 'crumb-segment'}${earlier}`}>
                  {segment}
                </span>
              </Fragment>
            );
          })}
        </span>
      </div>

      {resumeError !== null && (
        <p class="error resume-error" role="alert">
          {resumeError}
        </p>
      )}

      {/* The one announcer of the agent's own state, and it is always in the
          tree: a live region inserted at the same moment as its text is
          announced unreliably, while one whose content changes is announced
          dependably. Empty until the agent stops, so busy/idle is not narrated
          — and separate from anything on screen, so what a blind user hears
          does not depend on whether the terminal happens to be summoned. */}
      <p class="sr-only" aria-live="polite" aria-atomic="true">
        {agentKnown && agent.state === 'waiting' ? `Waiting for you. ${waitingDetail}` : ''}
      </p>

      <div class="panes">
        {/*
         * `inert` while the terminal is over it, which is the platform's own
         * word for "visible but not to be interacted with": it takes the
         * conversation out of the tab order and the accessibility tree without
         * touching layout, so `scrollTop` and xterm's size survive — everything
         * `display: none` or an unmount would cost. Preact removes the attribute
         * outright for `false`, so there is no browser where this sticks on.
         */}
        <div class="pane" inert={summoned}>
          <ConversationView
            sessionId={session.id}
            provider={session.provider}
            /*
             * The watch/hold decision, and it is the same one the tab pair made
             * for the same reason: with the terminal summoned, nobody is
             * watching the conversation.
             *
             * Both panes are mounted whatever is on screen, so the socket alone
             * cannot say — and what the server does with this is hold a
             * proposed tool call (`#holdFor` in `machine/conversations.ts`).
             * The terminal is summoned precisely to answer the agent *there*:
             * a slash command, a trust prompt, or the provider's own permission
             * dialog after a hold expired. Holding while it is up would stall
             * the agent in front of the very surface that answers it, and the
             * conversation's own Approve/Deny is behind an overlay nobody can
             * see. Dismissing hands watching straight back, and a hold released
             * by summoning ends as a `timeout` — the question goes to the
             * provider's own prompt, which is where the user already is.
             */
            watching={!summoned}
            onStatus={report('conversation')}
            onState={(state, detail) =>
              setAgent((current) =>
                current.state === state && current.detail === detail
                  ? current
                  : { state, ...(detail === undefined ? {} : { detail }) },
              )
            }
            sender={sender}
            terminal={status.terminal}
            /*
             * The same control the waiting banner's link uses, for the same
             * reason: the composer can send a slash command, and some of them —
             * `/resume` above all — leave the agent on a chooser only the pane
             * can show. The note that says so carries this rather than telling a
             * phone user to go and find the header button.
             */
            onSummon={summon}
          />
        </div>
        {/* Over the conversation, never beside it: a permanently visible
            terminal would make watching permanently true and change when agents
            are held. Labelled rather than `role="dialog"` with a focus trap —
            the conversation behind stays live and a trap would need Escape to
            release it, which is a key the terminal itself has to receive. */}
        <section
          class={summoned ? 'pane termsheet' : 'pane termsheet pane-off'}
          aria-label="Terminal"
        >
          {/* No second terminal header: the always-visible session control now
              says Conversation and is the direct way back. This line overlays
              the terminal only while it has a reason to say. */}
          {agentKnown && agent.state === 'waiting' && summoned && (
            <p class="termsheet-waiting">
              <strong>Waiting for you.</strong> {waitingDetail}
            </p>
          )}
          {session.deadAt === null && (
            <TerminalView
              session={session}
              active={summoned}
              onStatus={report('terminal')}
              onSignedOut={onSignedOut}
              sender={sender}
            />
          )}
        </section>
        {/*
         * Inside `.panes` and absolutely positioned over it, never above it in
         * the flow. The banner mounts and unmounts as the agent stops and
         * starts, and anything that changes this container's height refits
         * xterm, which resizes the tmux pane, which makes the agent redraw its
         * prompt into the scrollback for *every other viewer* of the session —
         * the same rule `.bar`'s constant height defends. Overlaying costs the
         * conversation's topmost rows until it is scrolled, which is affordable
         * because the conversation sticks to its end; padding the panes to make
         * room would reintroduce exactly the resize this removes.
         *
         * Not rendered at all while the terminal is up: the sheet carries the
         * fact there instead, so nothing is laid over the way out.
         *
         * It is also the only thing on this overlay that takes a tap. The
         * conversation underneath stays live, because covering the top of a
         * list is not the same as disabling it.
         */}
        {agentKnown && agent.state === 'waiting' && !summoned && (
          <p class="waiting">
            <strong>Waiting for you.</strong> {waitingDetail}{' '}
            <button class="link" onClick={summon}>
              {WAITING_TERMINAL_LABEL}
            </button>
          </p>
        )}
      </div>
    </main>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onDone();
    } catch (failure) {
      // A wrong password and a lockout are ordinary states of this screen. The
      // lockout says how long, because "try again later" is not actionable.
      const wait = failure instanceof ApiError ? failure.retryAfter : null;
      setError(
        wait === null
          ? messageOf(failure)
          : `${messageOf(failure)} Try again in ${waitText(wait)}.`,
      );
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="centre">
      <form class="card" onSubmit={submit}>
        <h1 class="wordmark">tether</h1>
        <p class="tagline">Your agents, on your machine, from anywhere.</p>
        <label for="password">Password</label>
        <input
          id="password"
          type="password"
          autocomplete="current-password"
          // The only field on the only screen; not focusing it costs a tap.
          autofocus
          value={password}
          onInput={(event) => setPassword((event.target as HTMLInputElement).value)}
        />
        {error !== null && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" class="primary" disabled={busy || password === ''}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

function Sessions({
  onOpen,
  onRemoved,
  onSignedOut,
  rail,
  collapsed,
  onCollapse,
  openId,
}: {
  onOpen: (session: Session) => void;
  onRemoved: (id: string) => void;
  onSignedOut: () => void;
  /**
   * Whether this list is the rail beside an open session rather than the whole
   * screen. It decides the landmark and the class the rail's border keys off, and
   * nothing else: a document may have exactly one `<main>`, and in the rail shape
   * that is the session on the right, so here the list is a named complementary
   * landmark instead.
   */
  rail: boolean;
  /** Hidden desktop rail state. It stays mounted so its live poll and scroll
   * position survive; CSS and `inert` remove it from sight and interaction. */
  collapsed: boolean;
  onCollapse?: () => void;
  /**
   * Which row is the session on screen beside this list, or `null` on a phone,
   * where the list is never on screen at the same time as a session and a
   * highlighted row would be marking something the user cannot see.
   */
  openId: string | null;
}) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [states, setStates] = useState<api.SessionStates>({});
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  /**
   * What is typed in the search box. Client-side over the list already fetched
   * — a machine has a handful of sessions, so a server round trip per keystroke
   * would be latency bought with nothing.
   */
  const [query, setQuery] = useState('');

  const refresh = useCallback(async () => {
    try {
      const listed = await api.listSessions();
      setSessions(listed.sessions);
      setStates(listed.states);
      setError(null);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) return onSignedOut();
      setError(messageOf(failure));
    }
  }, [onSignedOut]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const kill = async (session: Session) => {
    if (!confirm(`Kill “${session.title}”? The agent process stops.`)) return;
    try {
      await api.killSession(session.id);
    } catch (failure) {
      setError(messageOf(failure));
    }
    await refresh();
  };

  const remove = async (session: Session) => {
    if (
      !confirm(
        `Remove “${session.title}” from tether?\n\n` +
          `Its ${providerLabel(session.provider)} transcript stays on disk, but tether will no longer list or resume it.`,
      )
    )
      return;
    setRemoving(session.id);
    try {
      await api.removeSession(session.id);
      onRemoved(session.id);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setRemoving(null);
    }
    await refresh();
  };

  const groups = groupSessions(sessions ?? [], query, Date.now());

  // `.rail` is also what the desktop border keys off, so the class carries the
  // shape rather than the element name doing it.
  const Frame = rail ? 'aside' : 'main';
  return (
    <Frame
      class={rail ? 'screen rail' : 'screen'}
      aria-label={rail ? 'Sessions' : undefined}
      aria-hidden={collapsed || undefined}
      inert={collapsed}
    >
      <header class="bar">
        <h1 class="wordmark">tether</h1>
        <div class="rail-actions">
          {rail && onCollapse !== undefined && (
            <button
              type="button"
              class="ghost rail-collapse"
              aria-label="Hide session sidebar"
              title="Hide sessions"
              onClick={onCollapse}
            >
              <span class="rail-icon" aria-hidden="true" />
            </button>
          )}
          <button
            class="ghost"
            onClick={async () => {
              await api.logout().catch(() => {});
              onSignedOut();
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Over the list rather than inside its scroller, so it is still there
          after scrolling. `type="search"` for the platform's own clear control
          and its keyboard; a placeholder is not an accessible name, so it also
          carries one. */}
      <div class="search">
        <input
          type="search"
          aria-label="Search sessions"
          placeholder="Search sessions…"
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
          value={query}
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
        />
      </div>

      <div class="scroll">
        {error !== null && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        {sessions === null && <p class="muted">Loading…</p>}
        {sessions?.length === 0 && (
          <p class="muted">No sessions yet. Start one below and it keeps running here.</p>
        )}
        {/* Grouped under the day each was last worked on, which is how anyone
            with more than a handful of these looks for one. `Date.now()` at
            render: the list already re-renders every `POLL_MS`, so "Today"
            becomes "Yesterday" on its own without a second timer. */}
        {groups.length === 0 && sessions !== null && sessions.length > 0 && (
          <p class="muted">Nothing matches “{query.trim()}”.</p>
        )}
        {groups.map((group) => (
          <Fragment key={group.day}>
            <h2 class="day">{group.day}</h2>
            {group.sessions.map((session) => {
              const note = unresumableNote(session);
              const on = session.id === openId;
              return (
                // The provider class is on the row as well as the tag: it is what
                // colours the spine down the left edge, which is the thing a scan of
                // the list reaches before it reaches a word.
                <div class={`row row-${session.provider}${on ? ' row-on' : ''}`} key={session.id}>
                  <button
                    class="row-open"
                    aria-current={on ? 'true' : undefined}
                    onClick={() => onOpen(session)}
                  >
                    {/* The provider first and colour-coded, because the question a
                        mixed list has to answer at a glance on a phone is which agent
                        this is — the title and the directory are often the same for
                        two sessions of different providers in the same project. */}
                    <span class="row-head">
                      <span class={`tag tag-${session.provider}`}>
                        {providerLabel(session.provider)}
                      </span>
                      <span class="row-title">{session.title}</span>
                    </span>
                    {/* Clipped at the right on a narrow row, so the full path is on
                        the element for a pointer that can hover one. */}
                    <span class="row-cwd" title={session.cwd}>
                      {session.cwd}
                    </span>
                    {note !== null && <span class="row-note">{note}</span>}
                  </button>
                  {/* Together, because they wrap together: a "Waiting for you" chip
                      and Kill are 200px of a 340px rail, and the row drops the pair
                      onto its own line rather than clipping the title to nothing. */}
                  <div class="row-side">
                    {/* The agent's own state where there is one, and only the
                        live/dead fact where there is not: a session whose provider is
                        not reporting must not be badged "idle", which is a claim. */}
                    {session.deadAt !== null ? (
                      <span class="chip chip-ended">dead</span>
                    ) : states[session.id] === undefined ? (
                      <span class="chip chip-live">live</span>
                    ) : (
                      <span class={`chip chip-agent-${states[session.id]!.state}`}>
                        {STATE_TEXT[states[session.id]!.state]}
                      </span>
                    )}
                    {session.deadAt === null ? (
                      <button
                        class="ghost danger"
                        onClick={() => void kill(session)}
                        aria-label="Kill session"
                      >
                        Kill
                      </button>
                    ) : (
                      <button
                        class="ghost danger"
                        disabled={removing === session.id}
                        onClick={() => void remove(session)}
                        aria-label="Remove session"
                      >
                        {removing === session.id ? 'Removing…' : 'Remove'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>

      <div class="foot">
        <button class="primary" onClick={() => setCreating(true)}>
          New session
        </button>
      </div>

      {creating && (
        <NewSession
          suggestions={sessions?.map((s) => s.cwd) ?? []}
          onClose={() => setCreating(false)}
          onCreated={(session) => {
            setCreating(false);
            onOpen(session);
          }}
        />
      )}
    </Frame>
  );
}

/**
 * What Codex's live “waiting for you” badge costs, said before it is bought.
 *
 * Codex trust-gates each entry in its own hooks file, so tether's hook means a
 * security prompt on the user's own machine. The captain's decision is to ask
 * once and explain first (`decision-codex-hook-trust-install.md`), which is a UI
 * obligation as much as a CLI one: a user who accepts because a tool told them
 * to has not made a decision.
 *
 * It appears here, next to the choice it is about, and nowhere else — no banner
 * on the list, no warning beside a Codex session that is running without it.
 * Declining is a supported configuration and everything but that one badge keeps
 * working, so a UI that kept mentioning it would be nagging about a working
 * setup. The install itself stays a CLI command on purpose: it writes to a file
 * tether does not own, and that should have to be asked for by name.
 */
function CodexHookNote() {
  return (
    <p class="note">
      Codex works here with no setup: the conversation, the terminal, and whether it is working or
      idle all come from files Codex already writes. Only the live “waiting for you” badge needs
      more — a small script tether adds to your Codex hooks file, which Codex then asks you to trust
      once. It appends one line to a log under tether’s own state directory and does nothing else.
      Run <code>tether codex-hook install</code> on the machine to add it (it explains everything
      first and backs the file up), or <code>tether codex-hook remove</code> to take it back out.
      Skip it and you lose that badge and nothing else.
    </p>
  );
}

function NewSession({
  suggestions,
  onClose,
  onCreated,
}: {
  suggestions: readonly string[];
  onClose: () => void;
  onCreated: (session: Session) => void;
}) {
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');
  const [provider, setProvider] = useState<string>(DEFAULT_PROVIDER);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [trust, setTrust] = useState<TrustReport | null>(null);
  const [accepted, setAccepted] = useState(false);

  /**
   * Ask whether the agent already trusts this directory, so the question can be
   * answered here instead of in the agent's own prompt in the terminal.
   *
   * Both the answer and the tick are cleared the moment either input changes, and
   * that reset is the load-bearing line: a box ticked for one directory must
   * never still be ticked for the next one typed, or tether would trust a folder
   * nobody agreed to. Debounced because this runs per keystroke, and every
   * failure — an offline server, a directory that does not exist yet, one outside
   * the allowed roots — leaves the sheet saying nothing at all. Start still
   * reports a refused directory in the server's own words.
   */
  useEffect(() => {
    setTrust(null);
    setAccepted(false);
    const dir = cwd.trim();
    if (dir === '') return;
    let live = true;
    const timer = setTimeout(() => {
      api
        .folderTrust(dir, provider)
        .then((report) => {
          if (live) setTrust(report);
        })
        .catch(() => {});
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [cwd, provider]);

  const ask = trust === null ? null : trustAsk(provider, trust.trust, trust.path, cwd.trim());

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // `accepted` alone is not enough: it survives no input change, but a tick
      // on an ask that has since become `unknown` (or trusted) must not travel.
      const trustFolder = accepted && ask?.accept !== undefined;
      onCreated(await api.createSession(cwd.trim(), title.trim(), provider, trustFolder));
    } catch (failure) {
      // `invalid_cwd` arrives with the server's own sentence, which names the
      // allowed roots. Showing it verbatim is the point: the server enforces the
      // confinement, so only the server can explain what would be accepted.
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="sheet" role="dialog" aria-modal="true" aria-label="New session">
      <form class="card" onSubmit={submit}>
        <h2>New session</h2>

        {/* A native `<select>`: two options, correct keyboard and screen-reader
            behaviour for free, and on a phone the platform's own picker. */}
        <label for="provider">Agent</label>
        <select
          id="provider"
          value={provider}
          onChange={(event) => setProvider((event.target as HTMLSelectElement).value)}
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {provider === CODEX && <CodexHookNote />}

        <label for="cwd">Working directory</label>
        <input
          id="cwd"
          list="known-dirs"
          placeholder="/home/you/code/project"
          inputMode="url"
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
          value={cwd}
          onInput={(event) => setCwd((event.target as HTMLInputElement).value)}
        />
        {/* Directories already in use, so the common case is one tap. */}
        <datalist id="known-dirs">
          {[...new Set(suggestions)].map((dir) => (
            <option key={dir} value={dir} />
          ))}
        </datalist>

        {/* Beside the directory it is about, and nowhere else in the product: a
            folder tether asked about once is not something to keep mentioning.
            Every word of it comes from `trustAsk`. */}
        {ask !== null && (
          <div class="note trust">
            {ask.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
            {ask.accept !== undefined && (
              <label class="trust-accept">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(event) => setAccepted((event.target as HTMLInputElement).checked)}
                />
                {ask.accept}
              </label>
            )}
          </div>
        )}

        <label for="title">Title (optional)</label>
        <input
          id="title"
          placeholder="defaults to the directory name"
          value={title}
          onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
        />

        {error !== null && (
          <p class="error" role="alert">
            {error}
          </p>
        )}

        <div class="actions">
          <button type="button" class="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" class="primary" disabled={busy || cwd.trim() === ''}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </div>
  );
}
