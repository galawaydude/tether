# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Design authority

The product spec, stack rationale and the ordered PR breakdown for Milestone 1 live outside
this repo at `/home/galawaydude/Documents/Projects/firstmate/data/tether-arch/report.md`.
It is the result of verified empirical work — do not re-litigate the stack choices from it.
The Codex provider has its own empirical study next to it at
`../tether-codex-spike/report.md`, with the binding hook-install decision in
`../tether-codex-spike/decision-codex-hook-trust-install.md`.
`README.md` carries the parts a user needs; the reports carry the reasoning.

## Commands and layout

See the Development section of `README.md`. All checks are in root `package.json` scripts and
CI runs exactly those (`.github/workflows/ci.yml`).

## Sharp edges

- **`shared/` is types only.** It emits `.d.ts` and no JavaScript, and its `prepare` script
  builds it on `npm ci` so `tsc --noEmit` works on a fresh clone. Import from it with
  `import type`; `verbatimModuleSyntax` enforces that.
- **Each package has two tsconfigs**: `tsconfig.json` (noEmit) and a second one for the files
  it does not cover — `tsconfig.build.json` where the package emits, and `web/tsconfig.node.json`
  for web's Node-side files (`vite.config.ts` and the tests). Web's `tsconfig.json` is the
  browser program: `types: []` plus that split is what keeps Node globals out of it, since
  vite's own declarations pull `@types/node` into any program containing `vite.config.ts`.
  That Node-side program also sets `jsx`, because a web test reaching a type declared in a
  `.tsx` pulls the component file into it and `--jsx` unset is an error there, not a skip.
  `tsc --noEmit` at the repo root is not configured — use `npm run typecheck`.
- **TypeScript is pinned to 5.x.** TypeScript 7 is released but `typescript-eslint` still
  peers on `<6.1.0`; upgrading TS ahead of that breaks `npm install`.
- **npm 12 blocks dependency install scripts by default.** A dependency that silently fails
  to build is usually this; approve it with `npm install-scripts approve <pkg>`, which writes
  a version-pinned entry into the root `package.json`'s `allowScripts` — so bumping such a
  dependency needs a fresh approval. `node-pty` is approved there and ships no Linux prebuild,
  so `npm ci` compiles it and a machine with no C++ toolchain gets no PTY at all.
  `machine/terminal.ts` imports it lazily and `tether serve` then refuses to start with an
  instruction instead of an import crash; CI proves it built before running anything else.
- **`npx tether` only works because `server`'s `prepare` builds during `npm ci`.** npm links
  workspace bins before install finishes and skips a bin whose target is missing, so
  `dist/cli.js` has to exist by then — and it has to carry the exec bit itself, which is why
  `build` ends in `chmod +x`. `prepare` builds `@tether/shared` first: npm runs the two
  workspace `prepare` scripts in the wrong order otherwise and `server`'s `tsc` cannot find
  the declarations.
- **Every tmux command goes through `server/src/machine/tmux.ts`.** It carries
  `-L <socket> -f tether.conf` on _every_ invocation, so whichever command starts the
  server starts it with tether's config. The attach in `terminal.ts` needs a PTY rather
  than a pipe, so it takes its argv from that module's `tmuxArgv` — build a tmux argv
  anywhere else and `-f tether.conf` goes missing. `tether.conf` is a non-TS asset, so
  `tsc` does not copy it — `server`'s `build` script does, and anything that moves the
  file must move that `cp` too. The reason for each rule is in the module's own comments;
  the traps they defend against are in report §2/§3/§7.
- **The terminal is re-derived, never remembered.** `machine/terminal.ts` holds no byte
  log, no ring buffer, no sequence numbers and no resume cursor: every attach replays
  `capture-pane` and lets tmux's own attach repaint resync the viewport, which is
  idempotent by construction (report §3). If a change here starts needing a cursor, the
  change is wrong. Two things it does need and that are easy to remove by accident: the
  path is **binary from PTY to `term.write(Uint8Array)`** — any decode splits a UTF-8
  glyph on a chunk boundary — and `machine/escape.ts` strips alt-screen and mouse-tracking
  sequences while deliberately leaving `ESC[2J`/`ESC[J` alone, because the repaint is built
  on them. `terminal.test.ts` is the guard: real tmux, non-ASCII glyphs at full pane width,
  byte-exact against `capture-pane` ground truth. A mostly-ASCII pane passes on a broken build.
- **tmux 3.7 is a hard floor.** `tether.conf` sets `window-size manual`, and tmux
  before 3.7 sizes a not-yet-created window through a NULL pointer, so every detached
  `new-session` dies with `server exited unexpectedly`. Ubuntu 24.04 ships 3.4, hence
  the source build in `.github/workflows/ci.yml`. That message from any tmux command
  means the tmux on `PATH` is too old, not that the argv was wrong.
- **`cwd` is a trust boundary and `resolveCwd` in `machine/tmux.ts` is the only
  gate.** It resolves the path (symlinks included) _before_ checking it, and confines
  the result to `allowedRoots()` — the user's home unless `TETHER_ALLOWED_ROOTS` (a
  `:`-separated list) widens it. Containment is `path.relative`, never a string
  prefix: `/home/user2` is not inside `/home/user`. Everything that starts a session
  goes through it; do not add a second path check anywhere. Tests that start sessions
  in a temp directory set `TETHER_ALLOWED_ROOTS` rather than bypassing it.
  `machine/sessions.ts` holds the one create/delete sequence — tmux plus registry,
  rollback on a failed insert — that both the CLI and the HTTP routes call.
- **Terminal input is `text` frames plus `key` frames, and the split is
  load-bearing.** Every printable character a user types goes in a `text` frame
  (`web/src/keys.ts` → `Terminals.text`), never as a tmux key name, because tmux's
  lexer eats some arguments before the command sees them. What it eats is
  `mangledByLexer` in `server/src/machine/tmux.ts`: a standalone `;`, `{` or `}`,
  **or any argument ending in `;`**. An exact-match check is not enough and the
  failure is silent — tmux 3.7b strips a trailing `;`, eats the backslash of a
  trailing `\;`, and exits 0 either way, so `git status;` loses its `;` with
  nothing to catch. The rule has exactly one home, behind `checkArgs` and the
  exported `isSeparatorArgument`; `machine/terminal.ts` asks it, and routes what it
  flags — plus anything with a line break — through the paste buffer, which reaches
  tmux on stdin and is never argv. The guard is not relaxed for this and must not
  be. Its other half is blast radius: a frame the guard refuses is an undeliverable
  **frame**, not a dead attach, so `web/term-socket.ts` logs, ACKs and drops it and
  keeps the socket open — only a genuinely gone attach closes with
  `CLOSE_ATTACH_FAILED`. That is why a stray Alt+`;` costs one keystroke instead of
  a reconnect and a full replay, and it is the easiest thing here to undo by
  accident. On the browser side, `xterm.onData` is **not only the keyboard** — it
  also carries xterm's replies to terminal queries (OSC colour reports, DA, cursor
  position, focus in/out). `keys.ts` maps the sequences a keyboard really produces,
  modifier-encoded cursor keys included, and drops every other escape sequence,
  because typing one of those into a pane puts `;rgb:0000/0000/0000` in the agent's
  prompt. It also keeps a bracketed paste whole — markers consumed, newlines kept,
  one `text` frame — so the paste lands as a paste; splitting it submits a pasted
  prompt line by line. All of it is covered by `keys.test.ts`, `server.test.ts` and
  `terminal.test.ts` against real tmux.
- **The browser app may not use a secure-context-only web API.** tether is
  plain HTTP off loopback by design (Tailscale, `ssh -L`, a TLS proxy), so
  every device that is not the one running it — the phone this product exists
  for — loads an **insecure context**, where a browser withholds
  `crypto.randomUUID`, `crypto.subtle` and the rest of the secure-context set.
  `localhost` is the one secure origin, which is why the machine serving tether
  works and why nothing catches this: `e2e/` drives the app over loopback, where
  every such API is present. It cost a whole terminal pane once — `TerminalView`
  called `randomUUID` while building its client id, the effect threw before
  `connect()`, and a remote viewer got no socket at all: a chip stuck on
  "Connecting…" and a composer stuck on "Sending…" (the sender it calls is filled
  in by that same effect) while its conversation pane worked perfectly.
  `keys.ts`'s `newClientId` — `getRandomValues`, which carries no gate — and its
  test in `keys.test.ts` are the guard for that one; a new one needs its own.
- **The `term` socket's handshake completes before its route handler runs.**
  `@fastify/websocket` upgrades and _then_ calls the handler, so the browser's
  `onopen` has already fired — and its first act is to send its size and re-send
  every unACKed message — while `term-socket.ts` is still several tmux spawns
  from having an attach. A `ws` message with no listener is discarded, so the
  listener goes on **before** that `await` and queues into `handle`: a frame
  dropped in that window is never ACKed, and the client only re-sends on its
  _next_ reconnect, so one composed message sits on "Sending…" for the life of a
  socket that is otherwise working. The window is widest for a second viewer,
  whose attach is a `capture-pane` plus a `refresh-client` rather than a plain
  `attach-session` — which is why `server.test.ts`'s two-viewer test is the one
  test in that file that drives a real tmux.
- **The browser app is served by two named routes, not a wildcard**
  (`server/src/web/static.ts`). `@fastify/static` is registered with
  `serve: false` purely for `reply.sendFile`; `/` and `/assets/:file` are the only
  routes marked `public` besides `/api/login` and `/internal/hook`, which is not
  unauthenticated but authenticated differently (loopback plus the `0600` secret,
  see the hook entry below). A wildcard would answer every
  unmatched path publicly and hand an unauthenticated caller a 404-vs-401 oracle
  for which API routes exist. `web`'s `prepare` builds `web/dist` on `npm ci` for
  the same reason `server`'s does — `tether serve` reads it at startup and only
  warns if it is absent.
- **All persistent state lives outside the repo, and nearly all of it is one SQLite
  file**, opened by `server/src/db.ts` — `~/.local/state/tether/tether.sqlite`, file
  `0600` in a `0700` directory (`$XDG_STATE_HOME`, or `$TETHER_STATE_DIR`, which tests
  and any manual run must set rather than touch the real one). The rest is the Codex
  hook's shim and its per-session logs in that same directory, owned by
  `providers/codex/hooks.ts`. Never write runtime state into the repo; a
  path that is not in the repo cannot be committed by accident. `db.ts` owns the path
  and the mode bits — `machine/registry.ts` only adds its schema on top, applied on
  every open (`CREATE TABLE IF NOT EXISTS`). There is no migration framework, so a
  column added later must be added compatibly. `provider_session_id` is deliberately
  nullable: Codex has no session identity until the first user message, so the row is
  provisional from spawn and back-filled. It is also **not stable for the life of a
  session** — `/resume` and `--continue` move Claude Code to a different session id and
  a different transcript, verified live on 2.1.220 — so it is what the pane is running
  _now_, re-read from `~/.claude/sessions/<pane_pid>.json` rather than settled once.
  `Conversations` is the only writer: `#bind` records it and, for a session anyone is
  watching, restarts the tailer and sends `{c:'refetch'}` so the view follows.
  Rows are marked dead, never deleted: a dead row
  is what `resumeSession` (`machine/sessions.ts`) restarts through the provider's own
  resume, and `revive` is the only thing that clears `dead_at`. A row whose
  `provider_session_id` is still null has no conversation to restore, and resume refuses
  it rather than starting fresh — a new session presented as a resumed one is the failure
  mode that silently costs a user their work.
- **Tests run straight from TypeScript** via `node --test` and Node's built-in type
  stripping. There is no test build step; relative imports carry the `.ts` extension.
- **HTTP routes are default-deny.** A `preParsing` hook in `server/src/web/server.ts` rejects
  every request without a valid session unless the route sets `config: { public: true }`.
  It runs before body parsing, so an unauthenticated caller reaches neither the body parser
  nor a 404 that would tell it which paths exist.
  Adding a route therefore protects it automatically — and marking one public is a security
  decision, not a convenience. Reaching any route is equivalent to a shell on the machine.
  The `term` WebSocket is covered too — `@fastify/websocket` dispatches the upgrade through
  the normal router — but only because its route is registered inside `app.after()`, after
  that plugin's `onRoute` hook exists; register it earlier and it silently stays a plain
  HTTP route. The Origin guard needed extending by hand, since an upgrade is a `GET` and so
  is not state-changing, and a cross-origin page's upgrade carries the victim's cookie.
- **The conversation is read from the provider's own transcript, and parsed
  tolerantly on purpose.** Both providers append NDJSON, so `providers/tail.ts`
  is shared and only the paths and record vocabularies differ:
  `claude-code/transcript.ts` finds `~/.claude/projects/<sanitised cwd>/<id>.jsonl`,
  `codex/rollout.ts` finds `$CODEX_HOME/sessions/<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl`,
  and each directory's `events.ts` maps records to `ConversationEvent`. Which `<id>`
  comes from the pane, not from a scan — see `provider_session_id` above; the
  timestamp-and-mtime search in `findTranscript` is only what runs where the pane
  cannot say, and it is documented there as unable to settle either of the two cases
  that produced this bug. These
  formats are internal to tools that ship weekly, so **an unknown record type,
  block or shape is warned about and ignored, never thrown** — a mapper that
  throws loses the user's session, and the terminal is a complete fallback for
  anything dropped. Two things the tailer must keep: it reads forward from a byte
  offset (never re-reads the file) and its carry is **bytes**, because a flush
  lands mid-line and mid-glyph routinely. `fs.watch` is only the fast path; the 1s
  stat poll is what makes it work on filesystems where the watcher silently
  delivers nothing. Its reads are serialised through one promise chain rather than
  dropped while another is in flight, which is what lets `catchUp` promise "read to
  the end" rather than "a read happened" — see the Codex `PermissionRequest` entry
  for its one caller. Fixtures in each `fixtures/` directory are captured from a
  real session with the version recorded — **CI must never run a live agent**
  (real credentials, money per run). Verified while capturing them: Claude Code's
  `thinking` blocks reach disk with an **empty** `thinking` string and Codex's
  `reasoning` carries only `encrypted_content`, so the event is presence-only for
  both.

- **Two providers, one `switch`, and no `Provider` interface.** `providers/` has
  one directory each (`claude-code/`, `codex/`) plus what they genuinely share —
  `tail.ts`, `cap.ts` and `permission.ts` (the permission policy entry below).
  `machine/sessions.ts` holds the argv per provider and `machine/conversations.ts`
  picks the mapper; that is the whole seam, and report
  §4 chose it over an abstraction on purpose. Adding a third provider is a third
  directory, not a refactor. Codex specifics worth not rediscovering: it writes
  **nothing at all** until the first user message (hence the nullable
  `provider_session_id`), `event_msg/*` records win over the `response_item/*`
  they duplicate, `agent_message.phase` distinguishes commentary from the final
  answer and dropping it makes the view look duplicated, and there is no
  `isError` — success has to be _stated_ (`Process exited with code 0` /
  `Exit code: 0`), because a sandbox refusal is prose with no code in it at all.
  The browser's half of that seam is `web/src/providers.ts` — the picker in the
  New session sheet, the tag on a list row and the name over an assistant
  message all read it, so nothing else in the web app spells a provider id or
  names an agent. Its ids are literals mirroring `DEFAULT_PROVIDER` and `CODEX`,
  because `@tether/shared` emits types and no JavaScript; the create route's
  `enum` is the enforcement, so drift is a 400 rather than a session running the
  wrong agent under the right name.

- **`hooks.json` is a file tether does not own, and the trust gate is not
  tether's to bypass.** `providers/codex/hooks.ts` writes one entry, **appended**
  (Codex keys its trust hashes by group index, so inserting re-prompts the user
  for hooks they already trusted), after backing the file up, and refuses outright
  rather than rewriting a `hooks.json` whose shape it does not recognise.
  `--dangerously-bypass-hook-trust` must appear nowhere — not in code, not in
  docs, not as a fallback; that is a captain's decision, not a preference. The
  hook buys the live `waiting` badge and the Approve/Deny buttons: `busy` and
  `idle` come from the rollout and the prompt is always answerable in the pane, so
  **declining is a supported configuration** and nothing may
  warn, retry or nag about it. Explaining the prompt before it appears binds the
  UI as much as the CLI: `cli.ts`'s `codexHookExplanation` and `app.tsx`'s
  `CodexHookNote` are the only two places that say it, and the second says it
  only while Codex is the selected provider in the New session sheet. Neither may
  grow into a banner on the session list or a warning beside a Codex session
  running happily without the hook. Installing stays a CLI command on purpose —
  it writes to a file tether does not own.
  **The hooks.json `timeout` tether writes is a constant, and must stay one.**
  Claude Code's settings entry is _reconciled_ to the current hold; doing that here
  would re-hash a trusted entry and put a security prompt in front of the user
  every time an operator changed `TETHER_PERMISSION_TIMEOUT`. So
  `PERMISSION_TIMEOUT_SECONDS` and the shim's abort are fixed, the hold is clamped
  under them by `MAX_HOLD_MS` in `#holdFor`, and `reconcileProviderHooks` does not
  touch `hooks.json` at all. Verified: moving the hold from 20s to 180s leaves the
  file byte-identical. The price is that a Codex installation can go stale — no
  upgrade path rewrites it — so the invariant both providers are held to is stated
  once in `providers/permission.ts`: **tether may hold a turn only while the
  provider's own on-disk hook configuration carries the timeout that hold is sized
  against.** Claude Code satisfies it by reconciling the file; Codex satisfies it
  by reading it (`installedPermissionTimeout`, gated in `#codexCeiling` — a gate
  and not a clamp, because an older entry says `timeout: 3` and 3s minus
  `KILL_MARGIN_MS` is negative). A provider that can do neither may not hold. The
  only place a stale installation is ever mentioned to the user is
  `tether codex-hook status`, which the user typed; `not installed` stays neutral.
- **Codex's `PermissionRequest` is the whole of its answering path, and it is not
  a second copy of Claude Code's.** Four of the five registered events are
  fire-and-forget into the hook log; only this one POSTs to `/internal/hook` and
  writes a decision (`hookSpecificOutput.decision.behavior`, from Codex's own
  embedded `permission-request.command.output` schema — the shape is not in the
  fixtures, so `fixtures/README.md` records where it came from). It logs its line
  **before** it POSTs, and that ordering is load-bearing twice: the line is what
  sets the badge when tether is not listening, and the `PreToolUse` line before it
  is what the correlation reads. `PermissionRequest` carries no `tool_use_id`
  (Codex's own schema says so), so `CodexStatus#correlate` joins it to the
  preceding `PreToolUse` on `(session_id, turn_id, tool_input)` — a **correlation,
  not a key**, and the fixtures hold both hard cases: two attempts with identical
  `tool_input` under different ids, and an `apply_patch` whose `tool_input`
  differs from its `PreToolUse`'s by a trailing newline, which is why the
  comparison is `inputKey` (trimmed strings) rather than bytes. A failed
  correlation is _normal_ — a user may trust this entry and decline `PreToolUse` —
  and degrades to `waiting` plus the tool's name: the badge and no buttons, never
  a card keyed by a call tether guessed at. A **denied** call fires no
  `PostToolUse` at all, so nothing there clears the badge after a Deny;
  `task_complete` does, because Codex ends the turn on a denial (verified live
  against 0.145.0, twice: _Waiting for you_ → _Idle_ within 3s). Do not add a
  `busy` announcement on a settled decision to fill the apparent hole — it would
  publish a state tether never read. What keeps a wrong guess from being
  dangerous is that the hold **is** the blocked HTTP request, so a tap always
  answers the call Codex is really asking about; the correlation only decides which
  card wears the buttons. The two things the shared machinery had to learn for it:
  `HoldBasis` (`providers/permission.ts`) distinguishes Claude Code's `perhaps`
  from Codex's `prompting`, and only `prompting` is exempt from the
  "already in the transcript" check — Codex flushes its `function_call` _before_
  the dialog (report risk #2 does not exist for Codex), so a `pending` there adds
  buttons to a card the client already drew rather than proposing a new one. And
  `Tail.catchUp` exists for one caller: the blocked hook reads the log to its end
  itself, because the `PreToolUse` it needs is certainly on disk and waiting for
  `fs.watch` would be a race an agent's turn is blocked on.
- **The permission _policy_ is shared and the _plumbing_ is not.**
  `providers/permission.ts` holds what both providers must be held to identically:
  the three nested timeouts, `permissionTimeoutMs`, the `0600` secret and the
  endpoint file both shims read (still named `claude-hook.*` on disk, historically),
  and `HookSignal`. It is not a `Provider` interface — there is no behaviour in it
  either provider implements — it is the place a second hold length or a second
  fallback rule cannot be invented. Installing, where the hook goes, and what it
  may say when it runs stay in each provider's own `hooks.ts`.

- **The two providers' hooks share a purpose and almost no code, deliberately.**
  `providers/claude-code/hooks.ts` installs into `<cwd>/.claude/settings.local.json`
  — a file in the **user's own repo** — per project at spawn, with no trust gate.
  Codex's is one global trust-gated entry, installed once by a CLI command.
  Report §4 chose the seam; do not abstract over two examples beyond the policy
  that is genuinely one thing (`providers/permission.ts`, above). Both shims POST
  to `/internal/hook`, because a hook answers a permission prompt on **stdout** and
  answering needs request/response, which a log file could never become — but only
  Claude Code's POSTs on _every_ tool call; Codex's log carries the other four
  events and the POST is reserved for `PermissionRequest`.
- **The `PreToolUse` shim's stdout is a security boundary, and the hold is what
  makes it one.** `/internal/hook` keeps the request open while the user taps
  Approve or Deny; `Conversations.hook` returns the decision and the shim writes
  it. Four rules, each with a verified reason (Claude Code 2.1.220, spiked live):
  **(1) not everything is held.** `PreToolUse` fires for _every_ call and nothing
  in the payload — nor in `~/.claude/sessions/<pid>.json`, which reads `busy`
  throughout — says whether Claude Code was going to prompt, so a blanket hold
  costs the timeout on every auto-allowed call. `NEVER_HELD` in
  `providers/claude-code/events.ts` skips the read-only burst tools and
  `#holdFor` skips a session nobody is **watching** — which is not the same as
  subscribed, because the session screen keeps both panes mounted, so the `conv`
  socket is open the whole time a user works in the terminal. The client sends
  `{c:'watch'}` (the channel's whole client vocabulary) when the tab changes, and
  switching away mid-hold releases like the last viewer leaving does — a
  `timeout`, never a deny. Do not "fix" this by
  re-deriving Claude Code's permission rules; they are the user's own settings
  and the provider's to apply. **(2) Three timeouts, nested:** server hold <
  the shim's `AbortSignal` < the settings-file `timeout`, all derived from
  `permissionTimeoutMs()`. A hook killed at its `timeout` falls through, so the
  outer two are nets rather than mechanisms. The outermost lives on disk in a
  file tether does not own, so it can drift from the hold this process holds:
  `installHook` **reconciles its own settings entry's `timeout`** rather than
  skipping a project that already has one, and `reconcileProviderHooks` runs it
  `updateOnly` for every session with a running pane at `listen`, beside
  `writeHookEndpoint` and for the same reason — panes outlive the server, so a
  restart under a new `TETHER_PERMISSION_TIMEOUT` is the ordinary path. Those two
  are the only places the two values can diverge; reconcile a third there rather
  than patching where the symptom shows. Reconciled means that one field of
  tether's own handler and nothing else; at an unchanged hold the file is not
  written at all, and `updateOnly` additionally creates **nothing** — no
  directory, no settings file, no entry added back — because reconciling exists
  to stop an entry tether owns from drifting, never to reassert its presence in
  a repository a user removed it from. Installing may create; reconciling may
  only update.
  **(3) The fallback is neither allow
  nor deny** — saying nothing hands the question back to the provider's own
  rules; a reachable-then-failed tether says so through `systemMessage`, a
  refused connection stays silent because tether not running is ordinary.
  **(4) One hold, one settle.** `Conversations.answer` is single-shot, so a
  second tap, a second viewer, or a tap racing the timer is a 409. That is the
  whole of the reconciliation with the terminal, and it needs no more: an `allow`
  means Claude Code never shows a dialog, so a reflex keystroke afterwards is
  ordinary typing. What authorises a decision is the **session cookie** on
  `POST /api/sessions/:id/permission`, never the hook secret — an unauthenticated
  approve is an unauthenticated tool execution.
  **(5) A hold ends when its request does.** The third timeout lives in a file,
  and a _running_ agent enforces the one it loaded at startup, not the one on
  disk — verified against codex-cli 0.145.0 with a probe hook: moving
  `hooks.json` from `timeout: 3` to `300` under a running Codex still killed the
  probe at ~3s, and still ran it although the edit had changed its trust hash.
  So no amount of reading a config closes the window, and the wider invariant
  (stated in `providers/permission.ts`) is that **tether must never show an
  answerable card for a decision that cannot land** — a provider timeout tether
  never enumerated, a Ctrl-C'd pane, a killed agent, a provider tether has not
  met. `web/hooks.ts` watches **`reply.raw`** for `close` — never `request.raw`,
  which Fastify has already destroyed by the time the handler runs, so a listener
  there never fires — and tells an abandoned request from an ordinary reply by
  `writableFinished`, because `close` follows both. `Conversations.hook` then
  settles the hold as `timeout` on the `AbortSignal` it is handed. Shared by both
  providers on purpose: a false _approved_ is the worst thing this surface can
  say on either.
- **`{c:'pending'}`'s `deadline` is what puts buttons on a card, not `pending`.**
  tether reports far more proposals than it holds, and `{c:'answer'}` is how
  every viewer learns a hold is over — so neither frame carries a `seq`, for the
  same reason `state` does not. Both are replayed on subscribe, and a
  deadline-less `pending` is **authoritative**: it clears the buttons, and the
  `answer` behind it says how the hold ended, so a phone that reconnects after
  one is over does not come back tapping a dead card.
  `web/src/conversation.ts` owns the wording
  (`toolState`/`toolResult`), because what a card says about a permission it is
  holding is the most consequential copy in the product and a decision made in
  the `.tsx` leaves the test suite. An answerable card is the one card that opens
  itself and wraps rather than scrolls sideways: `rm -rf ./build` and `rm -rf /`
  differ at the right edge, and a clipped command is the "approving blind" the
  surface exists to prevent. One string there is still not
  provider-neutral: the expired-hold sentence hard-codes "Claude Code is asking
  in the terminal instead", so it names the wrong agent on a Codex card, while
  everything else on that card reads the same either way. The fix is to take the
  name from `providerLabel` in `web/src/providers.ts` — where the rest of the web
  app already reads a provider's name from, so it is the existing seam and not a
  new one — and it belongs to whoever next owns `web/src/conversation.ts`.
- **The hook secret is a `0600` file read at hook execution time, and the
  settings file gets only a path.** `settings.local.json` lives in the user's
  repository, so a token in it is one `git add` from being published (report
  §7); the same goes for the endpoint URL, which is rewritten after every
  `listen` so a session spawned under one `tether serve` reaches the next one
  on a new port. The secret is per installation — Claude Code names its own
  session and tether cannot know it at install time — and **per-session
  authorisation lives at the endpoint instead**: loopback checked against the
  real peer address (never `request.ip`, which `trustProxy` lets a header
  forge), constant-time secret compare, then a payload accepted only for a live
  registry row. A hook whose `session_id` no row holds is bound by
  `Conversations.bindProviderSession` — which is how the _first_ tool call of a
  session is not lost, and how the first after a `/resume` is not either. The
  payload's `cwd` is **not** consulted: a `cwd` can only ever say "one of
  these", since an agent run by hand in that directory posts the same one and
  two tether sessions in one directory post it identically. The join is the
  pane, whose `readSessionId` states which session it is running; no pane
  naming it means nothing is bound, which is what keeps a foreign transcript —
  a `resume` that hands back somebody else's conversation — out of a row.
- **`~/.claude/sessions/<pid>.json` outlives its process, so both guards in
  `providers/claude-code/status.ts` are mandatory.** It is deleted on a graceful
  exit and left behind by a `SIGKILL` or a reboot, and pids are reused — so
  `kill(pid, 0)` is not enough on its own. `procStart` is the identity check,
  and it is verified to be `/proc/<pid>/stat` **field 22** (`starttime`), found
  from the **last** `") "` because field 2 is a comm that can contain spaces and
  `)`. Anything unreadable or unverifiable is `undefined` — "tether cannot say"
  — never a guess: a session wrongly reported `waiting` is a phone notification
  that should not have fired. The file also carries `waitingFor`, which nothing
  reads yet. `undefined` is the _only_ thing the poller may not announce: a
  status it really read stands even over a `waiting` a `Notification` hook just
  set, because the file publishes `waiting` itself while a dialog is up (report
  §4e) and a `busy` after one is the user having answered — teach the poller to
  protect `waiting` from `busy` and the badge sticks forever instead. That makes
  a readable status file a _live announcer_, which is the trap in the poller's
  own test: it is the one test that runs with the poller on (every other passes
  `statusPollMs: 0`), and any moment where the file is readable before a
  "nothing was announced" count is a race with the tick timer that the truthful
  announcement wins. Write no status file until after the count.

- **`{c:'state'}` and `{c:'pending'}` are not `conv` frames, and must not become
  one.** `seq` is a position in the mapped transcript; the evidence for `waiting`
  arrives by hook, outside it, and a pending tool call is a claim the transcript
  will supersede rather than a record in it. Giving either a `seq` makes the
  history route and a live tailer disagree about which event is number 12. It is
  also why `status` is the one `ConversationEvent` variant with no `id`. The
  pending card is keyed by `callId` in `web/src/conversation.ts` — the same index
  a `tool_call` consults — so whichever of the two arrives second replaces the
  card the first one made, in either order.
- **`machine/conversations.ts` has a cursor and `machine/terminal.ts` does not.**
  The asymmetry is deliberate: tmux re-derives the terminal exactly on every
  attach, conversation events are re-derivable from nothing the client holds.
  `seq` is the event's position in the mapped stream, which is why the HTTP
  history route and a live tailer agree without either persisting anything. A
  `since` older than the in-memory tail is answered with `refetch`, never with a
  partial history.
- **The conversation view decides nothing in its JSX.** Web tests run under
  `node --test`, which strips types but cannot compile JSX, so anything decided
  inside a `.tsx` is untestable. `web/src/conversation.ts` therefore turns events
  into rows — including what a collapsed tool card shows versus an expanded one —
  and `conversation.tsx` only picks elements. Put a rendering decision in the
  `.tsx` and it silently leaves the test suite. `addEvents` is append-only and
  drops any `seq` at or below the highest applied, which is what makes the
  `since` replay after a reconnect free of duplicates. The mirror of the data
  layer's rule holds here too: an **unknown event kind becomes a grey note, never
  a throw** — one uncaught kind would blank the whole page.
- **The composer's message leaves on the _terminal_ pane's socket, and that is
  the only thing the two panes share.** A composed message is an `input` frame,
  and input sequencing — the per-client `seq`, the server's highest-applied map,
  the client's resend-until-`ack` — lives on that socket; a second one would be a
  second attach, a second full replay and a second sequence space nothing
  de-duplicates against the first. So `app.tsx` holds one `sender` ref,
  `terminal.tsx` fills it in, `conversation.tsx` calls it. The retry set holds
  only `input` frames: a lost keystroke costs a character, a lost message costs a
  prompt the user believes they sent, and a phone drops its socket on every
  screen-lock. Three rules that are easy to undo: **Enter inserts a newline** —
  the composer has no key handler at all, which is the implementation, and
  `e2e/composer.spec.ts` is what would catch a "convenience" that submits on it;
  the optimistic echo is retired by **arrival order, not by matching the text**,
  because a provider is free to record what it received rather than what was
  typed and a failed match leaves an echo standing beside its own record forever
  — the cost, accepted, is that **any** `user` event retires one, and the mappers
  give that kind to every user-role text block that is not command noise, so a
  message typed straight into the terminal or any other such record retires the
  oldest echo early and shows one message with another's text until its own
  record lands, still never two; a refetch therefore **carries the outstanding
  echoes across the rebuild** and re-retires them only past the `seq` already
  applied, since a message sent a moment ago cannot have been superseded by a
  transcript written before it arrived; and `sendBlocked` refuses only what could
  not arrive — `waiting`, because a message pasted at a permission prompt answers
  the dialog; a message over `MAX_TEXT`, which `parseClientFrame` drops and never
  ACKs, so it would be resent on every reconnect under a permanent "Sending…";
  and a terminal socket closed `ended` or `gone`, which is why those two closes
  are separate `Status` values — and an echo already outstanding at either close
  is **marked with that close, never dropped and never retired**
  (`markUndelivered`), since the text is what the user would lose and a record
  that turns up anyway must still retire it exactly once. Its note says only
  which close it was and never that the message was not delivered: the `ack` is
  an earlier milestone than the transcript record and lives in the terminal
  view's unacked set, so a message applied and queued mid-turn by an agent that
  then exits was delivered, and claiming otherwise is "Sending…" over-claiming in
  the other direction. `busy` and `retrying` are **not** refused: both
  providers queue a message mid-turn, the unacked set carries one across a
  reconnect, and that is the most valuable thing a phone can do.
- **The session screen keeps both panes mounted and hides one with
  `visibility: hidden`** (`app.tsx`, `.pane-off` in `style.css`). That one
  property is the whole of "switching tabs preserves both scroll positions", and
  it also keeps the hidden pane out of the tab order and the accessibility tree.
  `display: none` resets `scrollTop` and refits xterm to 0×0 and back on every
  tap; unmounting costs a full tmux replay or a conversation refetch. Note the
  consequence: nothing inside a hidden pane is focusable, so anything driving
  xterm's textarea has to switch tabs first. The two views share nothing else —
  they are two renderings of one process from two independent sources (report
  §3), and there is no cursor between them to reconcile.
- **The look is one system with three rules, and they are written down at the
  top of `web/src/style.css`**: amber means a human (the waiting badge and
  banner, Approve, Send, New session, the spine on your own messages) and
  nothing decorative may use it; the machine's own states are cool and never
  amber; monospace means the machine said it — paths, tool names, tool output,
  provider tags, state words. The spine — a short bar in a meaningful colour —
  is the app's one graphic idea, and it is the wordmark, the provider stripe on
  a session row and the edge of a user message. Adding a fourth accent, or an
  amber that is only decoration, is what breaks it.
- **There are two layouts and `app.tsx` picks between them.** Past `WIDE`
  (900px) it renders `.workspace`: the session list as a rail beside the open
  session. A media query cannot do that, because it cannot mount a component,
  which is why `useWide` exists — and it uses `matchMedia`, which carries no
  secure-context gate. Crossing the breakpoint remounts the session screen, so
  it costs one tmux replay and one conversation refetch; that is acceptable
  because a phone never crosses it (390×844 rotated is still 844) and nothing
  is lost, only re-derived. Which element is the `<main>` follows the shape, so
  neither layout has two or none: on a phone the list is the `<main>` and the
  open session replaces it, while in the rail shape the **right** pane is the
  `<main>` — the open session, or `.blank` when nothing is open — and the list
  becomes a complementary landmark named "Sessions" (`rail` is the only thing
  that prop decides). The rail's border keys off `.rail`, never off `main`: a
  border that follows the landmark moves the day the landmark does.
- **The desktop rail keeps the session list mounted beside the open session, so
  its 5s poll no longer stops when a session is opened.** On a phone `Sessions`
  unmounts and `clearInterval` runs; past `WIDE` it does not, so every tick is a
  `GET /api/sessions` for as long as a session is watched — `tmux list-sessions`
  via `reconcileWithTmux`, `tmux list-panes` via `statesFor`, and a
  `/proc/<pid>/stat` plus a status-file read per live session. That is the
  deliberate price of a **live** rail: on the hardware tether runs on it is
  negligible, and a stale list beside a running session is worse than the cost.
  It is desktop-only — the narrow branch is unchanged. Do not add
  visibility-pause machinery, tab-focus gating or a longer interval while a
  session is open; no pause mechanism is wanted here.
- **The session bar's height may not follow its own text.** The chips say
  "Connecting…" then "Live", "Idle" then "Waiting for you", and a bar that wraps
  only when its own text happens to be long changes height as a session runs —
  which resizes the terminal, which resizes the tmux pane, which makes the agent
  redraw its prompt into the scrollback. `e2e/session.spec.ts`'s reload
  comparison is what catches it, as one stray line in the "after" screen. Hence
  `.bar-chips` takes a whole row below 600px and `.bar` is `nowrap` above it:
  both heights are constant for every status word.
- **A `.conv` child needs `flex: none`.** The list is a column flex container,
  which shrinks its items to fit rather than overflowing; a collapsed tool card
  has no text holding it open, so every card renders as a 6px stripe without it.
- **Fastify's schema defaults silently repair a bad body** (`removeAdditional` and
  `coerceTypes` are on): `additionalProperties: false` strips instead of rejecting, and
  `{"password": 123}` arrives as `"123"`. `buildServer` turns both off. Do not remove that
  `ajv.customOptions` block, and do not assume stock Fastify behaviour when reading the tests.
- **`e2e/` is five Playwright specs and they assert counts and geometry, not presence.**
  They drive the real `tether serve` (`e2e/serve.ts` calls the CLI's own `main`) inside a
  scratch `HOME`/state dir/tmux socket, with `e2e/stub-agent.ts` on `PATH` as `claude` — so
  the session is created through the production path and **CI still never runs a live
  agent**. What `session.spec.ts` checks that nothing else can is the reload, what
  `permission.spec.ts` checks is the hook chain end to end, what `composer.spec.ts`
  checks is the compose chain end to end plus the Enter rule the composer entry above
  describes, which has no handler to unit-test, and what `identity.spec.ts` checks is that
  each session shows _its own_ conversation and keeps it — two sessions in one directory,
  then a `/resume` typed at one pane (which the stub acts out by moving to a new session
  id and a new transcript, announcing it only through its registry file). That last claim
  is the one found in live use rather than by a test. `desktop.spec.ts` is the only spec
  above the 900px breakpoint and the only test that renders the `.workspace` shape at
  all: it measures the rail's box against the session's, counts the back button at **0**
  rather than checking it is invisible (`display: none` is the point), counts exactly one
  `<main>`, and checks the page cannot scroll sideways. Two Playwright projects carry
  that, `phone` and `desktop`, each with a `testIgnore`/`testMatch` so neither runs the
  other's spec at the wrong width — they still share the one server, so the directory
  and by-name rules below apply to it too.
  `toContainText` passes just as happily
  on a view that replayed itself twice, on two cards for one tool call, and on an echo
  still standing beside its own record.
  `session.spec.ts` also measures the New session sheet's box against short viewports and
  starts no session at all, because a control clipped out of a fixed overlay is still in
  the DOM. Three things not to "strengthen" by accident: the locators are scoped to
  `.conv` and `.xterm-rows` because both panes stay mounted; the terminal comparison is of
  the **rendered screen** before versus after — the buffer above it legitimately holds the
  capture _under_ tmux's repaint, and byte-exactness of the recipe is
  `terminal.test.ts`'s job; and the specs share one server and one session list, so
  each takes its own directory and reopens its session **by name**, never `.row-open` —
  which is why `identity.spec.ts`, the one spec that deliberately puts two sessions in one
  directory, gives both a title.
  The stub knows nothing about where tether's shim, secret or endpoint are — it runs
  whatever `.claude/settings.local.json` lists — so a broken installer fails the test
  rather than quietly proving nothing. A typed ask only **arms** the stub and a
  trigger file fires it, because the hold needs the conversation pane in front and
  typing needs the other tab; the stub fires when both have landed, in either
  order, so nothing depends on which round-trip won. For the same reason the
  timeout case never taps Terminal — that would release the hold it is watching
  expire — and reads `.xterm-rows` through the hidden pane instead.
  `retries: 0` is deliberate. `npm ci` does not
  fetch the browser (npm 12 blocks playwright's postinstall);
  `npx playwright install chromium` does, and CI runs it.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
