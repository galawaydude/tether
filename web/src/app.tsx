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
    <Sessions onOpen={setOpen} onSignedOut={signedOut} openId={wide ? (open?.id ?? null) : null} />
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
        <div class="blank">
          <p class="wordmark">tether</p>
          <p class="muted">Pick a session on the left, or start a new one.</p>
        </div>
      )}
    </div>
  );
}

const TABS = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'terminal', label: 'Terminal' },
] as const;

type Tab = (typeof TABS)[number]['id'];

/**
 * The session screen: one header, two tabs, two panes.
 *
 * Both panes stay mounted and the inactive one is hidden with
 * `visibility: hidden` rather than `display: none` or an unmount. That is the
 * whole of "switching tabs preserves both scroll positions": a laid-out element
 * keeps its `scrollTop`, so neither view needs to save and restore one, and
 * xterm keeps a real size instead of being fitted to 0×0 and back on every
 * switch. Unmounting the terminal would additionally cost a full tmux replay per
 * tap, and unmounting the conversation a refetch.
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
  const [tab, setTab] = useState<Tab>('conversation');
  // One chip, two channels: it reports on whichever pane is in front, because
  // "Reconnecting…" is only actionable about the thing being looked at. The
  // agent's own busy/idle/waiting chip sits beside it and is a different fact.
  const [status, setStatus] = useState<Record<Tab, Status>>({
    conversation: 'connecting',
    terminal: 'connecting',
  });
  const report = (id: Tab) => (next: Status) =>
    setStatus((current) => (current[id] === next ? current : { ...current, [id]: next }));

  // The agent's own state, from the `conv` channel's `state` frame. It sits
  // above the tabs rather than inside the conversation pane: the terminal is
  // where a permission prompt is answered, so the tab a user is *not* on is
  // exactly the one they need this on.
  const [agent, setAgent] = useState<{ state: SessionState; detail?: string }>({ state: 'idle' });

  // The one thing the two panes do share, and only because the wire says so: a
  // composed message is an `input` frame on the terminal channel, which is where
  // input sequencing lives. Everything they show still comes from two
  // independent sources with no cursor between them (report §3).
  const sender = useRef<((message: string) => void) | null>(null);

  return (
    <div class="screen">
      <header class="bar">
        <button class="ghost bar-back" onClick={onBack} aria-label="Back to sessions">
          ‹ Sessions
        </button>
        <div class="bar-title">
          <strong>{session.title}</strong>
          <span class="path">{session.cwd}</span>
        </div>
        {/* Wrapped together so they occupy one whole row on a phone rather than
            wrapping only when their own text happens to be long — see `.bar`:
            a bar that changes height as a status word changes resizes the tmux
            pane underneath it. */}
        <div class="bar-chips">
          <span class={`chip chip-agent-${agent.state}`}>{STATE_TEXT[agent.state]}</span>
          <span class={`chip chip-${status[tab]}`} role="status">
            {STATUS_TEXT[status[tab]]}
          </span>
        </div>
      </header>

      {agent.state === 'waiting' && (
        <p class="waiting" role="status">
          <strong>Waiting for you.</strong>{' '}
          {agent.detail ?? 'The agent has stopped and wants an answer.'}{' '}
          {tab === 'conversation' && (
            <button class="link" onClick={() => setTab('terminal')}>
              Open the terminal
            </button>
          )}
        </p>
      )}

      {/* Toggle buttons rather than an ARIA tablist: a tablist owes a screen
          reader roving tabindex and arrow-key navigation, and two pressed-state
          buttons are correct as they stand and need neither. */}
      <nav class="tabs" aria-label="Views">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            class={id === tab ? 'tab tab-on' : 'tab'}
            aria-pressed={id === tab}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div class="panes">
        {TABS.map(({ id }) => (
          <div key={id} class={id === tab ? 'pane' : 'pane pane-off'}>
            {id === 'conversation' ? (
              <ConversationView
                sessionId={session.id}
                provider={session.provider}
                // Which tab is in front, not which pane is mounted: both are, so
                // the server would otherwise hold the agent on a permission
                // prompt while the user is answering it in the terminal.
                watching={tab === 'conversation'}
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
            ) : (
              <TerminalView
                session={session}
                onStatus={report('terminal')}
                onSignedOut={onSignedOut}
                sender={sender}
              />
            )}
          </div>
        ))}
      </div>
    </div>
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
  openId,
}: {
  onOpen: (session: Session) => void;
  onSignedOut: () => void;
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

  return (
    <main class="screen">
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
    </main>
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
