/**
 * The whole shell: log in, list sessions, open one. No router — there are three
 * screens and one of them is a modal, so a URL scheme would be state to keep in
 * sync for nothing.
 */

import type { Session } from '@tether/shared';
import { useCallback, useEffect, useState } from 'preact/hooks';

import * as api from './api.ts';
import { ApiError } from './api.ts';
import { ConversationView } from './conversation.tsx';
import { STATUS_TEXT, TerminalView, type Status } from './terminal.tsx';

/** How often the list refreshes. tmux reconciliation happens server-side per read. */
const POLL_MS = 5000;

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

  useEffect(() => {
    api.checkSession().then(
      () => setAuthenticated(true),
      () => setAuthenticated(false),
    );
  }, []);

  if (authenticated === null) return <p class="centre muted">Loading tether…</p>;
  if (!authenticated) return <Login onDone={() => setAuthenticated(true)} />;
  const signedOut = () => setAuthenticated(false);
  if (open !== null) {
    return <SessionScreen session={open} onBack={() => setOpen(null)} onSignedOut={signedOut} />;
  }
  return <Sessions onOpen={setOpen} onSignedOut={signedOut} />;
}

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
const TABS = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'terminal', label: 'Terminal' },
] as const;

type Tab = (typeof TABS)[number]['id'];

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
  // "Reconnecting…" is only actionable about the thing being looked at. PR #10
  // adds the agent's own busy/idle/waiting badge beside it.
  const [status, setStatus] = useState<Record<Tab, Status>>({
    conversation: 'connecting',
    terminal: 'connecting',
  });
  const report = (id: Tab) => (next: Status) =>
    setStatus((current) => (current[id] === next ? current : { ...current, [id]: next }));

  return (
    <div class="screen">
      <header class="bar">
        <button class="ghost" onClick={onBack} aria-label="Back to sessions">
          ‹ Sessions
        </button>
        <div class="bar-title">
          <strong>{session.title}</strong>
          <span class="muted">{session.cwd}</span>
        </div>
        <span class={`chip chip-${status[tab]}`} role="status">
          {STATUS_TEXT[status[tab]]}
        </span>
      </header>

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
              <ConversationView sessionId={session.id} onStatus={report('conversation')} />
            ) : (
              <TerminalView
                session={session}
                onStatus={report('terminal')}
                onSignedOut={onSignedOut}
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
        <h1>tether</h1>
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
}: {
  onOpen: (session: Session) => void;
  onSignedOut: () => void;
}) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSessions(await api.listSessions());
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
        <h1 class="bar-title">Sessions</h1>
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
        {sessions?.map((session) => (
          <div class="row" key={session.id}>
            <button class="row-open" onClick={() => onOpen(session)}>
              <span class="row-title">{session.title}</span>
              <span class="muted row-cwd">{session.cwd}</span>
            </button>
            <span class={session.deadAt === null ? 'chip chip-live' : 'chip chip-ended'}>
              {session.deadAt === null ? 'live' : 'dead'}
            </span>
            {session.deadAt === null && (
              <button class="ghost danger" onClick={() => kill(session)} aria-label="Kill session">
                Kill
              </button>
            )}
          </div>
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
    </main>
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createSession(cwd.trim(), title.trim()));
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
