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
- **The browser app is served by two named routes, not a wildcard**
  (`server/src/web/static.ts`). `@fastify/static` is registered with
  `serve: false` purely for `reply.sendFile`; `/` and `/assets/:file` are the only
  routes marked `public` besides `/api/login`. A wildcard would answer every
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
  provisional from spawn and back-filled. Rows are marked dead, never deleted: a dead row
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
  and each directory's `events.ts` maps records to `ConversationEvent`. These
  formats are internal to tools that ship weekly, so **an unknown record type,
  block or shape is warned about and ignored, never thrown** — a mapper that
  throws loses the user's session, and the terminal is a complete fallback for
  anything dropped. Two things the tailer must keep: it reads forward from a byte
  offset (never re-reads the file) and its carry is **bytes**, because a flush
  lands mid-line and mid-glyph routinely. `fs.watch` is only the fast path; the 1s
  stat poll is what makes it work on filesystems where the watcher silently
  delivers nothing. Fixtures in each `fixtures/` directory are captured from a
  real session with the version recorded — **CI must never run a live agent**
  (real credentials, money per run). Verified while capturing them: Claude Code's
  `thinking` blocks reach disk with an **empty** `thinking` string and Codex's
  `reasoning` carries only `encrypted_content`, so the event is presence-only for
  both.

- **Two providers, one `switch`, and no `Provider` interface.** `providers/` has
  one directory each (`claude-code/`, `codex/`) plus what they genuinely share —
  `tail.ts` and `cap.ts`. `machine/sessions.ts` holds the argv per provider and
  `machine/conversations.ts` picks the mapper; that is the whole seam, and report
  §4 chose it over an abstraction on purpose. Adding a third provider is a third
  directory, not a refactor. Codex specifics worth not rediscovering: it writes
  **nothing at all** until the first user message (hence the nullable
  `provider_session_id`), `event_msg/*` records win over the `response_item/*`
  they duplicate, `agent_message.phase` distinguishes commentary from the final
  answer and dropping it makes the view look duplicated, and there is no
  `isError` — success has to be _stated_ (`Process exited with code 0` /
  `Exit code: 0`), because a sandbox refusal is prose with no code in it at all.

- **`hooks.json` is a file tether does not own, and the trust gate is not
  tether's to bypass.** `providers/codex/hooks.ts` writes one entry, **appended**
  (Codex keys its trust hashes by group index, so inserting re-prompts the user
  for hooks they already trusted), after backing the file up, and refuses outright
  rather than rewriting a `hooks.json` whose shape it does not recognise.
  `--dangerously-bypass-hook-trust` must appear nowhere — not in code, not in
  docs, not as a fallback; that is a captain's decision, not a preference. The
  hook buys exactly one thing, the live `waiting` badge: `busy` and `idle` come
  from the rollout, so **declining is a supported configuration** and nothing may
  warn, retry or nag about it. `PermissionRequest` carries no `tool_use_id`, so
  `status.ts` correlates it to the preceding `PreToolUse` — a correlation, not a
  key, and the fixtures contain the case that proves it (two attempts, identical
  `tool_input`, different ids).

- **`{c:'state'}` is not a `conv` frame, and must not become one.** `seq` is a
  position in the mapped transcript; the evidence for `waiting` arrives by hook,
  outside it. Giving state a `seq` makes the history route and a live tailer
  disagree about which event is number 12. It is also why `status` is the one
  `ConversationEvent` variant with no `id`.
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
- **A `.conv` child needs `flex: none`.** The list is a column flex container,
  which shrinks its items to fit rather than overflowing; a collapsed tool card
  has no text holding it open, so every card renders as a 6px stripe without it.
- **Fastify's schema defaults silently repair a bad body** (`removeAdditional` and
  `coerceTypes` are on): `additionalProperties: false` strips instead of rejecting, and
  `{"password": 123}` arrives as `"123"`. `buildServer` turns both off. Do not remove that
  `ajv.customOptions` block, and do not assume stock Fastify behaviour when reading the tests.
- **`e2e/` is one Playwright spec and it asserts counts, not presence.** It drives the
  real `tether serve` (`e2e/serve.ts` calls the CLI's own `main`) inside a scratch
  `HOME`/state dir/tmux socket, with `e2e/stub-agent.ts` on `PATH` as `claude` — so the
  session is created through the production path and **CI still never runs a live
  agent**. What it checks that nothing else can is the reload: `toContainText` passes
  just as happily on a view that replayed itself twice. Two things not to
  "strengthen" by accident: the locators are scoped to `.conv` and `.xterm-rows`
  because both panes stay mounted, and the terminal comparison is of the **rendered
  screen** before versus after — the buffer above it legitimately holds the capture
  _under_ tmux's repaint, and byte-exactness of the recipe is `terminal.test.ts`'s job.
  `retries: 0` is deliberate. `npm ci` does not fetch the browser (npm 12 blocks
  playwright's postinstall); `npx playwright install chromium` does, and CI runs it.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
