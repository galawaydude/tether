/**
 * The whole shell: log in, list sessions, open one. No router — there are three
 * screens and one of them is a modal, so a URL scheme would be state to keep in
 * sync for nothing.
 *
 * There are two shapes, not one with a media query bolted on. On a phone the
 * list and the open session are the same screen at different times. Past
 * `WIDE`, they are side by side — the list is a rail you switch sessions from
 * without going back — and a media query cannot do that, because it cannot
 * mount a component. Everything else about the two shapes is CSS.
 */

import type { Session, SessionState } from '@tether/shared';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import * as api from './api.ts';
import { ApiError } from './api.ts';
import { ConversationView } from './conversation.tsx';
import { CODEX, DEFAULT_PROVIDER, PROVIDERS, providerLabel, unresumableNote } from './providers.ts';
import { STATUS_TEXT, TerminalView, type Status } from './terminal.tsx';

/** How often the list refreshes. tmux reconciliation happens server-side per read. */
const POLL_MS = 5000;

/**
 * Where a rail beside the session starts paying: below this, 340px of list plus
 * a conversation is two cramped columns rather than one good one. It matches the
 * last block of `style.css`, which is where the rest of the desktop shape lives.
 */
const WIDE = '(min-width: 900px)';

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
  const wide = useWide();

  useEffect(() => {
    api.checkSession().then(
      () => setAuthenticated(true),
      () => setAuthenticated(false),
    );
  }, []);

  if (authenticated === null) return <p class="centre muted">Loading tether…</p>;
  if (!authenticated) return <Login onDone={() => setAuthenticated(true)} />;
  const signedOut = () => setAuthenticated(false);
  const list = (
    <Sessions
      onOpen={setOpen}
      onSignedOut={signedOut}
      rail={wide}
      openId={wide ? (open?.id ?? null) : null}
    />
  );
  const session =
    open === null ? null : (
      <SessionScreen
        // Keyed, so switching sessions in the rail rebuilds both panes rather
        // than pointing one live socket at a different tmux session.
        key={open.id}
        session={open}
        onBack={() => setOpen(null)}
        onSignedOut={signedOut}
      />
    );

  if (!wide) return session ?? list;
  return (
    <div class="workspace">
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
}: {
  session: Session;
  onBack: () => void;
  onSignedOut: () => void;
}) {
  const [summoned, setSummoned] = useState(false);
  // One chip, two channels: it reports on whichever pane is in front, because
  // "Reconnecting…" is only actionable about the thing being looked at. The
  // agent's own busy/idle/waiting chip sits beside it and is a different fact.
  const [status, setStatus] = useState<Record<Pane, Status>>({
    conversation: 'connecting',
    terminal: 'connecting',
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

  // Closing from inside the sheet hides the button that was focused, and a
  // browser drops focus to `<body>` when that happens — so a keyboard user who
  // dismissed the terminal would be tabbing from the top of the page again. The
  // control that summoned it is the honest place to land.
  const hatch = useRef<HTMLButtonElement>(null);
  const dismiss = () => {
    setSummoned(false);
    hatch.current?.focus();
  };

  return (
    // The `<main>` in both shapes: on a phone the list has unmounted, and in the
    // rail shape the list is the complementary landmark beside this one.
    <main class="screen">
      <header class="bar">
        <button class="ghost bar-back" onClick={onBack} aria-label="Back to sessions">
          ‹ Sessions
        </button>
        <div class="bar-title">
          <strong>{session.title}</strong>
          <span class="path">{session.cwd}</span>
        </div>
        {/* The escape hatch, and the only navigation left on this screen. A
            toggle rather than an open-only button: it is the control that is on
            screen in both states, and `aria-expanded` is then the truth about
            the thing it summons. */}
        <button
          ref={hatch}
          type="button"
          class="ghost bar-term"
          aria-expanded={summoned}
          onClick={() => setSummoned((open) => !open)}
        >
          Terminal
        </button>
        {/* Wrapped together so they occupy one whole row on a phone rather than
            wrapping only when their own text happens to be long — see `.bar`:
            a bar that changes height as a status word changes resizes the tmux
            pane underneath it. */}
        <div class="bar-chips">
          <span class={`chip chip-agent-${agent.state}`}>{STATE_TEXT[agent.state]}</span>
          <span class={`chip chip-${status[front]}`} role="status">
            {STATUS_TEXT[status[front]]}
          </span>
        </div>
      </header>

      {agent.state === 'waiting' && (
        <p class="waiting" role="status">
          <strong>Waiting for you.</strong>{' '}
          {agent.detail ?? 'The agent has stopped and wants an answer.'}{' '}
          {!summoned && (
            <button class="link" onClick={() => setSummoned(true)}>
              Open the terminal
            </button>
          )}
        </p>
      )}

      <div class="panes">
        {/*
         * `inert` while the terminal is over it, which is the platform's own
         * word for "visible but not to be interacted with": it takes the
         * conversation out of the tab order and the accessibility tree without
         * touching layout, so `scrollTop` and xterm's size survive — everything
         * `display: none` or an unmount would cost. The tab pair got this free
         * from hiding the pane; an overlay that deliberately leaves a strip of
         * the conversation showing has to say it. Preact removes the attribute
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
          <div class="termsheet-bar">
            <h2 class="termsheet-title">Terminal</h2>
            <p class="termsheet-note">The escape hatch.</p>
            <button type="button" class="ghost" onClick={dismiss}>
              Close
            </button>
          </div>
          <TerminalView
            session={session}
            onStatus={report('terminal')}
            onSignedOut={onSignedOut}
            sender={sender}
          />
        </section>
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
  onSignedOut,
  rail,
  openId,
}: {
  onOpen: (session: Session) => void;
  onSignedOut: () => void;
  /**
   * Whether this list is the rail beside an open session rather than the whole
   * screen. It decides the landmark and the class the rail's border keys off, and
   * nothing else: a document may have exactly one `<main>`, and in the rail shape
   * that is the session on the right, so here the list is a named complementary
   * landmark instead.
   */
  rail: boolean;
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

  // `.rail` is also what the desktop border keys off, so the class carries the
  // shape rather than the element name doing it.
  const Frame = rail ? 'aside' : 'main';
  return (
    <Frame class={rail ? 'screen rail' : 'screen'} aria-label={rail ? 'Sessions' : undefined}>
      <header class="bar">
        <h1 class="wordmark">tether</h1>
        <button
          class="ghost"
          onClick={async () => {
            await api.logout().catch(() => {});
            onSignedOut();
          }}
        >
          Sign out
        </button>
      </header>

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
        {sessions?.map((session) => {
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
                {session.deadAt === null && (
                  <button
                    class="ghost danger"
                    onClick={() => kill(session)}
                    aria-label="Kill session"
                  >
                    Kill
                  </button>
                )}
              </div>
            </div>
          );
        })}
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

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createSession(cwd.trim(), title.trim(), provider));
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
