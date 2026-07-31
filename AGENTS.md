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

See the Development section of `README.md`. Every check is in root `package.json` scripts and
CI runs exactly those (`.github/workflows/ci.yml`), with one exception: the Installer step
runs `shellcheck install.sh` and `bash install.sh --self-test`, neither of which is an npm
script. Both are in README's list too, so a red CI is reproducible locally.

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
  means the tmux on `PATH` is too old, not that the argv was wrong. `install.sh` builds
  the **same pinned release and checksum** for a user's machine, so those two constants
  now live in two files and must be bumped together. It is the repo's only shell script
  and is held to `shellcheck` and to its own `bash install.sh --self-test`, both of
  which CI runs in one step before anything expensive, because nothing else in the
  repo's checks looks at shell at all. What that self-test covers is every branch in
  the file that can be silently wrong: the version parsing (a `tmux 3.4` read as new
  enough is a session that dies at birth), the PATH message, and the two Funnel
  questions below. Its consent rule is
  the Codex hook's, generalised: nothing outside tether's own directory changes without
  the exact commands on screen and a yes, declining prints them and stops, and no shell
  startup file is ever edited. A sentence it cannot back with something it actually
  checked is deleted rather than softened, because a caveat is itself new length and new
  claims. Two things about it that the script alone does not
  show. **It installs the highest `vX.Y.Z` tag, so merging to `main` ships nothing** —
  a change reaches the public install line only when a release is cut (README's
  Development → _Cutting a release_), and `install.sh` itself is the one exception,
  being fetched from `main` so that it is what knows how to find the current release.
  And the `tether` command is a **symlink into `~/.local/bin`**, not `npm link`: npm's
  global prefix is root-owned wherever Node came from a distro package or a tarball,
  which made the last step of the script the one that failed after every expensive
  consented thing had already been spent. Anything that moves `server/dist/cli.js`
  moves that symlink's target.
- **Tailscale Funnel is the documented default, and `--funnel` is composition
  rather than control.** `machine/tailscale.ts` only ever _reads_ — one
  `tailscale status --json`, four fields — and `install.sh` is what turns Funnel
  on, because `tailscale funnel` needs root or an operator (`Access denied:
serve config denied` otherwise) and sets a machine-wide thing that outlives
  the server. So there is no Tailscale client here and none is wanted; adding
  one is the "network manager" this was scoped against. Three facts established
  by putting a header echo behind a real Funnel (tailscale 1.98.10, captured in
  the PR): it forwards `Host: <name>.ts.net` with **no port**, sets
  `X-Forwarded-Proto: https` and a real client `X-Forwarded-For`, and marks
  itself with `Tailscale-Funnel-Request: ?1`. That is why the composition is
  bind `127.0.0.1` + allow the derived name + trust `127.0.0.1`, and the three
  are one decision: the loopback bind is what makes trusting that proxy's
  `X-Forwarded-*` safe, and the trust is what gets the session cookie its
  `Secure` flag. **The password rule is extended, never excepted** — the check
  is no longer "off-loopback", because `--funnel` binds loopback and is the most
  exposed tether can be. A `--funnel` that could start without a password is the
  one regression here that publishes a shell. `Self.DNSName` carries a trailing
  dot and the capability set appears in both `Self.CapMap` and the deprecated
  `Self.Capabilities`; the precondition order is fixed, because a logged-out
  node reports **no** capabilities and asking about Funnel first tells someone
  to edit their ACLs when they need to sign in. `install.sh` reads that same
  JSON for the same reason, through the one `ts_status` helper so a fourth
  reader cannot forget **`--peers=false`** — every question it asks is about
  Self, and a full status carries a `DNSName` and a capability set per peer, so
  a match found anywhere in it is not an answer. It derives the published
  address from `Self.DNSName` there, and asks `tailscale serve status --json`
  (`AllowFunnel["<name>:443"]` **and** the `/` handler's `Proxy`, two questions
  and two different ports) whether Funnel is already armed. **Permitted and
  armed are different questions and each has exactly one source.** `AllowFunnel`
  is absent on every machine that has not armed Funnel yet, so it can never
  answer the first; permitted-but-unarmed is what a fresh machine _is_, and it
  has to go on and arm. And the permitted answer is **tri-state**: a capability
  set without `funnel` in it is a real no, but a status carrying no capability
  set at all is `unknown`, which is not a no — reporting it as one sends someone
  to add an attribute their policy already has, at the one step of the script
  with no command to offer. `unknown` therefore carries on and lets
  `tailscale funnel` refuse in its own words. Both are pure string functions
  taking the document as an argument, which is what lets `--self-test` drive
  them; the fresh-machine pair (`{}` serve status, a status with no `CapMap`) is
  the case that had no coverage and is now the point of that block. **The same
  tri-state is in `machine/tailscale.ts` and had to be**, since the installer
  ends by running `tether serve --funnel`: an `unknown` the script carried on
  past would otherwise die there under the very sentence it declined to print.
  An **empty** capability set is not the unknown case in either — it is a node
  granted nothing, which is a real refusal. Neither is scraped
  out of `tailscale funnel status` — human-readable output another tool owns
  must never be what a flow is gated on, and here that is not tidiness:
  `funnel status` _is_ `serve status`, so a tailnet-only `tailscale serve`
  prints an identical proxy line and would make the installer skip arming and
  publish a link to nothing. What proves the setup works is
  functional instead: one `curl` carrying the derived `Host`, which a plain
  `tether serve` refuses with the very 403 `--funnel` exists to prevent. And
  `tailscale funnel` **prompts**: without a terminal it waits rather than
  failing, so the installer passes `--yes` to the command it has already put on
  screen and taken a yes for. Anything else there would hang `curl | bash`.
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
  The second one is `copyText` in `conversation.tsx`, which is `execCommand`
  rather than `navigator.clipboard` for exactly this reason and says so — a
  deprecated API that works everywhere the app loads beats a modern one that is
  `undefined` on every device but the host.
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
  `providers/codex/hooks.ts`, and the backups tether takes before it writes a
  folder-trust entry into an agent's own config — in there too, never beside the
  original. Never write runtime state into the repo; a
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
  watching, restarts the tailer and sends `{c:'refetch'}` so the view follows. It has
  two callers, because the row has to follow the pane whether or not anybody is
  watching: the status poller, and the **session list**, which reads its badge
  through `Conversations.paneState` and holds no reader of its own. A badge may
  never again ask about the id the row _used_ to carry — that is what emptied it,
  `waiting` included, until somebody opened the conversation. Widening it costs no
  guard: the pid is a tether pane's, so a hand-run agent is in no pane and is never
  reached, and `status.ts`'s liveness and `procStart` checks are what say the file
  under that pid is really that pane's.
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
  `tail.ts`, `cap.ts`, `permission.ts` (the permission policy entry below) and
  `trust.ts` (the folder-trust entry below). `machine/sessions.ts` holds the argv,
  the resume and the trust locations per provider and `machine/conversations.ts`
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
- **Folder trust is read from each agent's own config, and the two schemes
  differ in ways an exact-path check gets wrong.** `providers/trust.ts` holds the
  tri-state, one `writeAtomically`, and the git resolution; each provider's
  `trust.ts` holds its own file; the switch is `PROVIDER_TRUST` beside the other
  two in `machine/sessions.ts`. Every rule was established by running the
  installed CLIs under a scratch `HOME` and reading the pane, and the surprising
  ones are why the code is not two `readFile`s: Claude Code
  (`$CLAUDE_CONFIG_DIR/.claude.json` else `~/.claude.json`,
  `projects["<dir>"].hasTrustDialogAccepted`) accepts a directory, **any path
  ancestor**, or the main repo root — but _not_ the repo root's ancestors — while
  Codex (`$CODEX_HOME/config.toml`, `[projects."<dir>"] trust_level`) matches
  **only the main repository root, exactly**, with no ancestor walk at all. Both
  resolve a linked worktree back to the repository it belongs to, so the git
  helper is `dirname(--git-common-dir)` and **never `--show-toplevel`**, which
  would key an entry the agent then ignores — in the shape this product is
  actually used in. `unknown` is a real answer and never a guess: an absent file
  is `untrusted` (nothing is trusted, which is determinable), a file that exists
  and cannot be understood is `unknown`, and the sheet then says tether cannot
  tell and offers nothing — because the file it would write is the one it just
  failed to read. Declining writes **nothing at all**, and a write happens only
  for a create request carrying `trustFolder: true`. Unlike the hook it is not
  best-effort: a refused config fails the create with `trust_not_recorded`,
  having started nothing, because a silent failure would drop the user into the
  prompt they had just answered to avoid. Codex's is the one place tether writes
  `config.toml` — the file holding its hook trust hashes — so the line scanner
  there **refuses rather than guesses** on any TOML it cannot reason about
  (multi-line strings, a bare `[projects]` table, a top-level `projects.…` dotted
  key): appending a second table for a key the reader missed is a duplicate-key
  error, i.e. tether breaking Codex while recording consent. One `scan` serves
  the read and the write so the two can never disagree. The wording lives in
  `web/src/providers.ts` (`trustAsk`) with the rest of the sentences that name an
  agent, and the ticked box is cleared whenever the directory or the provider
  changes — a tick must never outlive the question it was given for.
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
  `{c:'watch'}` (the channel's whole client vocabulary) when the terminal is
  summoned or dismissed, and summoning mid-hold releases like the last viewer
  leaving does — a `timeout`, never a deny. **Watching is exactly "the terminal
  overlay is closed"**, decided in `app.tsx` and covered by
  `e2e/permission.spec.ts`'s second test, which drives both halves: the terminal
  is summoned to answer the agent _there_, so holding then stalls it in front of
  the surface that answers it, behind an overlay hiding tether's own Approve.
  Getting it wrong is silent both ways — hold too much and agents stall, hold too
  little and the feature never fires — so it has a test rather than a comment
  alone. Do not "fix" this by
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
- **A clipped command is approving blind; a homoglyph is the same failure with no
  visual tell at all**, which is why `scanSuspects` in `web/src/conversation.ts`
  names the characters that make a command read as something it is not, and an
  answerable card holds Approve behind an acknowledgement — **Deny stays live**,
  because someone reading that warning most likely wants to refuse and must never
  acknowledge a warning in order to. Modelled on Zed's
  `crates/agent_ui/src/unicode_confusables.rs` with one difference that is the
  whole difficulty: Zed scans domains and paths, where **any** non-ASCII is
  surprising, so it flags all of them; a tool call's input is arbitrary text, and
  a guard that fires on ordinary non-English text trains people to tap through
  the one that matters. So bidi controls and invisibles are always flagged, and a
  visible character only when it can actually be mistaken for ASCII — a
  single-character NFKC fold, or a Latin-lookalike script sharing a _word_ with an
  ASCII letter. **The Latin block is exempt on purpose and must stay exempt**:
  `søren`, `kullanıcı` and `café` are all ASCII letters mixed with a non-ASCII
  Latin one, so the rule that would catch `ı` cries wolf on ordinary names. The
  false-positive test is the one that decides whether the feature is worth having.
  No dependency: a script name is four ranges, and `String.prototype.normalize`
  does the folds. `inputSuspects` scans every string in the **input**, keys
  included, rather than the fields the card happens to show — and never the
  result, which is arbitrary output nobody is deciding about. The acknowledgement
  takes a row of its own above the answers rather than Approve's place, or a
  double-tap on one spot acknowledges and then approves; `suspectWarning` caps how
  many characters it names so the panel's height is bounded without a scroll
  container, and `e2e/render.spec.ts`'s third test measures all three controls
  fully in the viewport at 360×640 on the arrival path.
- **The hook secret is a `0600` file read at hook execution time, and the
  settings file gets only a path.** `settings.local.json` lives in the user's
  repository, so a token in it is one `git add` from being published (report
  §7); the same goes for the endpoint URL, which is rewritten after every
  `listen` so a session spawned under one `tether serve` reaches the next one
  on a new port. The secret is per installation — Claude Code names its own
  session and tether cannot know it at install time — and **per-session
  authorisation lives at the endpoint instead**: loopback checked against the
  real peer address (never `request.ip`, which `trustProxy` lets a header
  forge), **and not proxied**, constant-time secret compare, then a payload
  accepted only for a live registry row. The second half of that first gate is
  what keeps it a gate at all under Funnel, which proxies from `127.0.0.1` and
  so gives every internet request a loopback peer: `isProxied` refuses anything
  carrying `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` or
  `Tailscale-Funnel-Request`, which a real Funnel always sets and the shim —
  POSTing to `127.0.0.1` — never does. A presence test can only over-refuse,
  never over-admit, which is the direction this boundary must fail in. A hook whose `session_id` no row holds is bound by
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
  partial history. What decides a `refetch` when the row is re-bound is **what
  was published, not how the row got bound**: `#restart` asks `live.following`
  (the transcript `#start` really attached to) and `live.seq`, because a bind can
  land while a search is still in flight — a client can hold event 1 from the
  fallback-located transcript before the _first_ identification arrives. The
  proxy that used to stand in for it, "a first identification abandons nothing",
  was false under load and re-sent seq 1 with no refetch; the browser's
  `addEvents` drops such a duplicate, which is exactly why nothing saw it. Its
  guard forces the window open with `ConversationsOptions.syncDelay` rather than
  waiting for a loaded CI box.
- **The conversation view decides nothing in its JSX.** Web tests run under
  `node --test`, which strips types but cannot compile JSX, so anything decided
  inside a `.tsx` is untestable. `web/src/conversation.ts` therefore turns events
  into rows — including what a collapsed tool card shows versus an expanded one —
  and `conversation.tsx` only picks elements. Put a rendering decision in the
  `.tsx` and it silently leaves the test suite. `addEvents` is append-only and
  drops any `seq` at or below the highest applied, which is what makes the
  `since` replay after a reconnect free of duplicates. The mirror of the data
  layer's rule holds here too: an **unknown event kind becomes a grey note, never
  a throw** — one uncaught kind would blank the whole page. The same split holds
  for the session list: `web/src/sessions.ts` owns the search filter, the day
  grouping and the breadcrumb segments, and `app.tsx` only picks elements. So
  does the wording of a control's accessible name — `copyLabel` lives in
  `providers.ts` beside `whoLabel`, and `providers.test.ts` pins the two rules
  that are not obvious from looking at them. **No accessible name in the
  conversation may contain the word "message"**, because the composer's own
  label is that word and Playwright's `getByLabel` matches on a substring, so
  one that does makes `getByLabel('Message')` ambiguous and takes two e2e specs
  down at once. And the **three** names that summon the terminal —
  `AUTH_TERMINAL_LABEL` on a failed turn's row, `COMMAND_TERMINAL_LABEL` on the
  composer's command note, `WAITING_TERMINAL_LABEL` on the waiting banner — must
  not contain one another, for the same substring reason applied to
  `getByRole({ name })`; any two of them can be on screen together. The test
  compares the strings the buttons actually render, which is why the buttons
  take their names from there rather than spelling them inline.
- **Agent text is rendered as markdown, and the safety of that is structural
  rather than a filter.** `web/src/markdown.ts` parses a **bounded** subset —
  headings, `*`-only emphasis, lists, links, inline code, block quotes, fenced
  code — into a tree of blocks and spans, and `conversation.tsx` picks an element
  per node and passes every string through as a **child**, so agent text becomes
  a text node. There is no `innerHTML` and no HTML string anywhere in the path,
  which is why a `<script>` in a fenced block needs no escaping to be harmless;
  keep it that way rather than adding a sanitiser. The one value that becomes
  live browser behaviour is a link's `href`, gated by `safeHref` — an allow-list
  of `http`/`https`/`mailto`, never a `javascript:` blocklist, because
  `java\nscript:` is a URL a blocklist misses and a browser honours. Three
  parser rules that look arbitrary and are not: `_` is **not** an emphasis
  marker (`old_string` is one identifier, not two words around an italic); a
  bare `**` matches and emits nothing, which is a lookbehind written as an
  alternative because a real `(?<!\*)` is a _parse-time_ SyntaxError on iOS
  Safari before 16.4 and would take the bundle down on exactly the phones this
  is for; and plain text emits a **bare string** rather than a `<span>`, because
  the e2e specs count `getByText(exact)` matches. No new dependency for any of
  it, and none is wanted.
- **An Edit is a diff, not a paragraph about one.** `toDiff` in
  `conversation.ts` reads the tool call's **input** — `old_string`/`new_string`,
  `Write`'s `content`, or Codex's `apply_patch` patch text, which is believed
  rather than recomputed — and the row carries the result, computed once where
  it is built. Codex hands that patch over in **two** shapes and both are read
  here: the rollout record's `input` is the patch string, the hook that proposes
  the same call wraps it as `{ command: … }`, and whichever arrives first builds
  the card (`toRow` only flips `pending` on the other), so a card built from the
  hook has to be right the first time. Each branch reports the input keys it
  consumed as `Diff.covers`, which is what `diffExtras` subtracts: on an
  **answerable** card anything the diff does not speak for is shown beside it —
  `replace_all` rewrites every match where the diff draws one — and that is a
  general rule rather than a list of known fields, precisely so the field nobody
  thought of is covered too. Nothing is drawn when the set is empty. It is not
  an LCS: the identical head and tail are trimmed and
  everything between is called changed, which is exactly what an `Edit` is, and
  where it is not it over-reports rather than mis-attributing a line. Two things
  the view must keep: the rows are a CSS table so a tinted row runs the full
  scroll width, so **every row has exactly two cells** (a third puts its text in
  a column of its own and shoves it off the right edge — hence the spoken
  "added"/"removed" living inside the gutter cell); and on an **answerable**
  card the diff wraps instead of scrolling, by the same rule as the command,
  since a removed line running past the right edge of a card the agent is
  blocked on is the same "approving blind". The `+`/`−` gutter is not
  decoration: red/green alone is the one distinction a large minority of people
  cannot make.
- **A failed card says whether to act, and that is the whole of the typed-error
  feature.** `errorAdvice` maps an output to _retrying itself_ or _needs you_,
  and `toolState` puts that word on the collapsed row, which is what a glance
  gets. Cases are added **one at a time as they are met**, each anchored to the
  start of the output — tool output is arbitrary text, and a `grep` that finds
  "rate limit" in a log must not be reported as the provider rate-limiting.
  `null` — no claim at all — is the right answer for anything not recognised.
  A failed **turn** carries the same claim from the other direction: the `error`
  event kind shows the provider's own sentence, and `AUTH_ADVICE` — the same
  `Advice` type, deliberately the same first sentence as the tool card's
  `authentication_error` entry — is added only where the provider _typed_ the
  failure as an authentication one, never matched out of its prose. Each
  provider's `events.ts` names the field and the version it was verified
  against; a false "your login expired" costs a real re-authentication, which is
  why anything else says nothing.
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
- **A slash command from the composer is just text on the terminal socket; the
  whole feature is knowing where its answer will show up.** `submit` in
  `conversation.tsx` branches on `planSend`, and a command
  goes out through the same `onApply` path an option's keystrokes use — **not**
  the message path, because a command writes no `user` record, so its optimistic
  echo would stand at "Sending…" forever. Both branches sit behind the same
  `sendBlocked`, which is what makes a command obey the permission rule a
  message already obeys. **What routes as a command is `isCommandLine`, and it
  prefers prose**: both routes put the same bytes on the same `input` frame and
  the CLI applies its own leading-slash rule to them, so the choice decides only
  which feedback tether shows and there is no delivery downside to trade
  against — a leading `/`, one line, and a name carrying **no further `/`** (no
  command in either set has one, while `/home/me/app.ts is broken` is a sentence
  about a path, and "tether does not know this command" over an ordinary
  sentence is the interface being confidently wrong about what the user did).
  `matchCommands` routes on the same rule so the list does not appear under a
  pasted path, with a bare `/` its one exception, being the affordance the
  placeholder points at. `web/src/commands.ts` is the per-provider table and its
  one field that matters is `answers`, established by running each command in a
  pane with tether's own input frame and reading the transcript back: Claude Code
  writes `<command-name>`/`<local-command-stdout>` for `/model x`, `/effort x`
  and `/compact`, writes **nothing at all** for `/resume`, `/cost` and `/status`,
  and moves to a **new session id and transcript** on `/clear`. Codex's set
  overlaps by name and not by behaviour — its commands take no argument, so
  `/model <name>` is a paid _prompt_ (the one thing tether refuses outright), and
  an unrecognised one leaves its text sitting in Codex's composer where the next
  message would be sent with it attached. Two rules the table is held to: it is
  **not a gate** — an unknown command is still sent, since refusing one would
  refuse every custom command a user has and both CLIs ship weekly, and what
  tether says is that it cannot vouch for it; and `answers` is a **prediction,
  not a promise** — `/model opus` was found on a real session opening a _Switch
  model?_ confirmation, and the correction is the machinery that already exists
  (the provider publishes `waiting`, `app.tsx`'s banner says so, the composer
  refuses to send), so there is no fourth value and no note may ever say "and
  nothing else will happen". The note's terminal button takes its name from
  `COMMAND_TERMINAL_LABEL` and may not be renamed to collide with the other two
  terminal-summoning names — the rule and its guard are in `providers.ts`, above.
- **The conversation shows slash commands, and it had to start doing so for the
  option bar to mean anything.** `COMMAND_NOISE` in
  `providers/claude-code/events.ts` had dropped every `<command-name>` and
  `<local-command-stdout>` record since PR #8, so PR #25's `/model` and `/effort`
  controls changed a running agent with nothing on screen to show it, despite
  their comments claiming the conversation was the confirmation. Those two tags
  now map to the `command` event kind — `<command-message>` and
  `<local-command-caveat>` are still dropped, being a display name and an
  instruction to the model. Two things easy to break: the tags are matched
  **wherever they sit**, because the order is not stable (`/model` writes
  `<command-name>` first, `/init` writes `<command-message>` first) and anchoring
  loses one of them entirely; and the stdout carries Claude Code's **own SGR
  codes** — `Set model to \x1b[1mSonnet 5\x1b[22m` — which reach a browser as a
  literal `[1m` unless stripped. The row is monospace and containerless by the
  house rules: the machine said it, and a command is not an artefact.
- **A composer option earns its control by being _verified_ to change a running
  pane — and "no slash command" is not the same as "not settable".**
  `web/src/options.ts` is the per-provider table and `Axis.via` is the seam: two
  mechanisms, deliberately not a plugin system. **`keys`** sends `input` frames
  on the terminal socket a composed message already uses (no new plumbing, and
  the resend-until-ACKed set finishes a two-frame picker across a reconnect);
  the agent's own answer in the conversation is the confirmation, so those
  controls are a **menu, not a display** — they reset to the axis name, because
  tether cannot keep a value true against a user typing in the pane.
  **`permission-mode`** is a route instead, because that axis is reached only by
  cycling Shift+Tab and a cycle is safe only if the mode can be read back;
  `server/src/providers/claude-code/permission-mode.ts` reads the pane's own
  status footer, steps **one** key at a time waiting for the footer to move, and
  confirms by reading again — so it never assumes the cycle order or length, and
  what the browser reports is what was **observed**, never what was asked for.
  The reference client owns its agent and can offer every axis it has; tether
  owns a TUI and can only type at it, so **the CLI's flag list is not the
  table** — the live evidence for every entry _and every omission_ is in those
  two files' comments. Four traps worth not rediscovering: it is **`BTab`, not
  `S-Tab`** (tmux resolves `S-Tab` against extended keys the application
  negotiated, and otherwise sends a plain tab); a dead pane makes `capture-pane`
  throw and must degrade to `unreadable` rather than a 500 carrying tether's own
  argv; the footer says **"manual"** for what the CLI, the hook payload and the
  transcript all call `default`; and `permission_mode` rides on the `PreToolUse`
  payload tether already receives, which is the better _record_ but says nothing
  about right now, which is why the footer is what the setter uses. A value that
  lowers the permission bar is **held** behind its sentence (`lowersBar`) on both
  providers, and `e2e/options.spec.ts` checks that by reading the pane _while the
  warning is up_ and by asserting a failed mode change never says "is now".
  `e2e/serve.ts` shims the stub as `codex` as well as `claude` for that spec; the
  stub writes a Claude-shaped transcript either way, so a Codex session there has
  no conversation and the spec asserts on keystrokes rather than rows — and the
  stub paints no footer, so the browser-side permission-mode tests are the
  unreadable case by construction. Reaching every mode from every mode is
  `permission-mode.test.ts`, against real tmux. Three things the gate and the
  read-back each needed to be true rather than nearly true: the confirm button
  behind the warning goes through the **same `sendBlocked` guard** every select
  and Send carry, re-asked inside `apply` because that path is the one with a
  person-paced gap in it and the agent can reach a permission prompt while the
  sentence is being read; `setPermissionMode` is **serialised per pane** in
  `permission-mode.ts`, since two concurrent read-press-reads press between each
  other's read and read-back and both then confirm a mode neither aimed at (a
  second viewer reaches that with no double-tap, hence the server and not the
  browser); and a `not_confirmed` **names the mode the pane was left in**, which
  is why `ApiError` carries the refusal's body at all — reaching `plan` cycles
  through `acceptEdits`, so a stalled cycle can lower the bar with no warning
  shown. The composer is also `flex: 0 1 auto` with `overflow-y: auto`: the
  warning is a third child outside the message box's height budget, and
  `e2e/options.spec.ts` asserts at 360×340 that the document never grew and that
  Cancel, the confirm and Send are each fully in the viewport.
- **The conversation is the interface and the terminal is summoned over it.**
  There is no tab pair: opening a session lands on the conversation, and
  `.termsheet` (`app.tsx`, `style.css`) is an overlay a header control raises and
  its own Close puts away. Both panes still stay mounted and the one behind is
  hidden with `visibility: hidden` (`.pane-off`) — that one property is the whole
  of "summoning preserves both scroll positions", and it also keeps the hidden
  pane out of the tab order and the accessibility tree. `display: none` resets
  `scrollTop` and refits xterm to 0×0 and back on every tap, which resizes the
  tmux pane for every other viewer too; unmounting costs a full tmux replay or a
  conversation refetch. The overlay's box is therefore **identical open and
  closed** — only `visibility` changes — and it is inset at the top so a strip of
  the conversation shows, which is what makes it read as summoned rather than as
  the other half of a pair. Two consequences: nothing inside a hidden pane is
  focusable, so anything driving xterm's textarea has to summon first; and the
  conversation is visible-but-covered while the overlay is up, so it carries
  `inert` — the platform's own word for it, and the one thing that takes it out
  of the tab order without touching layout. The two views share nothing else —
  they are two renderings of one process from two independent sources (report
  §3), and there is no cursor between them to reconcile.
- **Nothing tether draws may change `.panes`' height**, which is the general form
  of the `.bar` rule below: that box is what xterm is fitted to, so a change to it
  resizes the tmux pane and makes the agent redraw its prompt into the scrollback
  for every other viewer. Everything stacked above the panes is therefore fixed
  height by construction — `.bar`, and `.crumbs`, the breadcrumb strip carrying
  the working directory, which is `nowrap` with constant padding over a value
  that cannot change under a running session. A branch added to that strip later
  has to keep both properties. The waiting banner is the piece that comes and goes
  while a session runs, so `.waiting` is **positioned inside `.panes`, not stacked
  above them** — mounting it moves nothing, at the price of covering the
  conversation's topmost rows until it is scrolled (affordable: the conversation
  sticks to its end; padding the panes to make room is the resize being avoided).
  While the terminal is up the banner is not rendered at all and its sentence
  hangs off the **bottom** of the sheet's header instead (`.termsheet-waiting`,
  `top: 100%` on a positioned `.termsheet-bar`), so nothing lies over the way
  out, the header keeps its height, and the reason wraps to as many lines as it
  needs — `agent.detail` is "Claude needs your permission to use Bash", and a
  reason ellipsised at "permission to…" is the "approving blind" this surface
  exists against. Each is gated on the surface it belongs to — `.waiting` on
  `!summoned`, `.termsheet-waiting` on `summoned` — so neither exists while
  nothing can see it: out of flow the sheet's line would cost no layout to leave
  mounted behind a hidden overlay, but then every assertion about it passes over
  a closed sheet. Neither overlay may swallow a tap: `.waiting` is
  `pointer-events: none` with its own link back to `auto`, so a tool card under
  it still opens, and `.termsheet-waiting` lies over a terminal a user may be
  typing at. The one announcer of agent state is a separate always-present
  `.sr-only` live region in `app.tsx` — always present because a live region
  inserted with its text is announced unreliably, and separate so what a blind
  user hears does not depend on which surface is up. All of it is guarded by
  `session.spec.ts`'s geometry test at 360×640, which measures `.term`'s
  rectangle and xterm's row count through the hidden pane with
  `getBoundingClientRect` — Playwright reports no box for `visibility: hidden`,
  which is the state being asserted about — plus the waiting line's overflow in
  both axes and an `elementFromPoint` hit test through the banner — which asserts
  the **conversation** got the tap, not merely that the banner did not, since a
  second inert layer in between would pass the weaker form with the rows
  underneath just as unreachable.
- **The look is one system with four rules, and they are written down at the
  top of `web/src/style.css`**: amber means a human (the waiting badge and
  banner, Approve, Send, New session, the spine on your own messages) and
  nothing decorative may use it; the machine's own states are cool and never
  amber; monospace means the machine said it — paths, tool names, tool output,
  provider tags, state words; and **a box means an artefact while prose means
  the agent**. That fourth rule is the load-bearing one and the reason the
  screen reads as a conversation rather than a log: your own messages are a
  bordered box and tool calls are cards, and **the agent's reply has no
  container at all** — no border, no fill, no indent. Putting it back in one
  undoes the whole effect. The spine — a short bar in a meaningful colour — is
  the app's one graphic idea, and it is the wordmark, the provider stripe on a
  session row and the left edge of a user message. Adding a fifth accent, or an
  amber that is only decoration, is what breaks it. The theme is **dark, and
  dark only** — no toggle, no `prefers-color-scheme` branch, no light fallback —
  and two things follow from dark rather than being new colours: `--accent` and
  `--accent-ink` hold the _same_ amber, because amber reads on a dark surface
  and only needed a darkened second value on white (both names stay: one carries
  `--on-accent` text, one is read as ink); and every translucent tint —
  `.chip`, `.tag`, `.error` — is mixed into `--wash`, which is **darker than any
  surface**, because mixing a bright tone into the surface it sits on lifts that
  surface toward the text and the ratio then cannot be won by choosing a
  brighter tone at all. `.termsheet` declares no palette of its own: it picks
  `--wash` for its frame, and the terminal (`.term`, whose colour must stay
  byte-identical to `TerminalView`'s xterm `theme.background`) is one step
  darker again. **The floor is 5.6:1 on every surface a token is actually used
  on, including the tint a chip lays down for itself** — the measured worst case
  is 5.69:1 — and the way to check a change is to compute it, not to look at it.
  Three consecutive rounds regressed contrast or tap size by eye.
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
- **`e2e/` asserts counts and geometry, not presence.** _What_ each spec covers is
  listed once, in `README.md`'s Development section; this entry is only the rules a
  spec must not break.
  - They drive the real `tether serve` (`e2e/serve.ts` calls the CLI's own `main`)
    inside a scratch `HOME`/state dir/tmux socket, with `e2e/stub-agent.ts` on `PATH`
    as `claude` **and** as `codex` (the composer-option entry above says why the second
    shim is there), so a session is created through the production path and **CI still
    never runs a live agent**.
  - `toContainText` passes just as happily on a view that replayed itself twice, on two
    cards for one tool call, and on an echo still standing beside its own record — hence
    counts and measured boxes. A control clipped out of a fixed overlay is still in the
    DOM, and `display: none` is the point of the desktop back button, so that one is
    counted at **0** rather than checked for invisibility.
  - Three things not to "strengthen" by accident: locators are scoped to `.conv` and
    `.xterm-rows`, because both panes stay mounted; the terminal comparison is of the
    **rendered screen** before versus after — the buffer above it legitimately holds the
    capture _under_ tmux's repaint, and byte-exactness of the recipe is
    `terminal.test.ts`'s job; and the specs share one server and one session list, so
    each takes its own directory and reopens its session **by name**, never `.row-open`
    (which is why the one spec that deliberately puts two sessions in one directory
    gives both a title).
  - A locator inside the conversation while the terminal overlay is up must be a **CSS**
    one: the pane is `inert`, so every role locator reads zero there and one that did
    would prove nothing.
  - The stub knows nothing about where tether's shim, secret or endpoint are — it runs
    whatever `.claude/settings.local.json` lists — so a broken installer fails the test
    rather than quietly proving nothing. A typed ask only **arms** it and a trigger file
    fires it, because the hold needs the conversation on screen and typing needs the
    terminal over it; it fires when both have landed, in either order, so nothing depends
    on which round-trip won. Writing the trigger _without_ dismissing is how the
    watch/hold test gets the opposite case, and the timeout case never summons the
    terminal — that would release the hold it is watching expire — reading `.xterm-rows`
    through the hidden pane instead. A spec that needs new agent behaviour appends to the
    transcript the stub already opened rather than teaching the stub a new trick.
  - Two Playwright projects, `phone` and `desktop`, each with a `testIgnore`/`testMatch`
    so neither runs the other's spec at the wrong width. `e2e/ui.ts` is the harness beside
    `serve.ts`: the summon/dismiss recipe is spelled there once rather than in every spec
    that needs it,
    and evidence screenshots are namespaced by spec, because the shared
    `TETHER_E2E_SHOTS` directory plus one worker meant a number reused in a second spec
    silently overwrote the first spec's image.
  - `e2e/ui.ts` also owns **`reachable`**, the one definition of that word in the suite,
    because four panels in this product outgrew a small phone and a reviewer — never a
    test — caught every one: a control is reachable when, _after being scrolled to
    through its own container_, its box is wholly in the viewport, is 44px tall, has
    nothing hit-testing on top of it, and the **document** does not scroll in either
    axis — which folds in the sideways check two other specs hand-roll. Every failure
    names the control and the viewport, and `KEYBOARD_UP` (360×340) is where two of the
    four only failed, so the sheet, the permission card, the composer and the waiting
    banner are each asserted there. Resizing to it refits xterm and so resizes the tmux
    pane, so a spec that measures at `KEYBOARD_UP` may not then read `.xterm-rows` for a
    line printed before the resize — that line is in the scrollback now, and `retries: 0`
    makes the miss a hard failure. Read the pane first, measure after. It found a live one on its first run: `.sr-only` was
    `position: absolute` with no offsets, so the diff gutter's "added"/"removed" sat at a
    static position partway down a scrolled conversation and grew the document by 348px.
  - `retries: 0` is deliberate. `npm ci` does not fetch the browser (npm 12 blocks
    playwright's postinstall); `npx playwright install chromium` does, and CI runs it.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
