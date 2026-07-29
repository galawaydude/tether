# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Design authority

The product spec, stack rationale and the ordered PR breakdown for Milestone 1 live outside
this repo at `/home/galawaydude/Documents/Projects/firstmate/data/tether-arch/report.md`.
It is the result of verified empirical work — do not re-litigate the stack choices from it.
`README.md` carries the parts a user needs; the report carries the reasoning.

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
  (`web/src/keys.ts` → `Terminals.text`), never as a tmux key name: tmux's lexer
  eats a standalone `;`, `{` or `}` argument, so `machine/terminal.ts` routes
  exactly those — and anything with a newline — through the paste buffer, which
  reaches tmux on stdin and is never argv. The argv guard in `tmux.ts` is not
  relaxed for this and must not be; `isSeparatorArgument` is how a caller asks it
  what it would refuse. The other half is that `xterm.onData` is **not only the
  keyboard** — it also carries xterm's replies to terminal queries (OSC colour
  reports, DA, cursor position, focus in/out). `keys.ts` drops every escape
  sequence it does not recognise as a keystroke, because typing one of those into
  a pane puts `;rgb:0000/0000/0000` in the agent's prompt. Both are covered by
  `keys.test.ts` and by `terminal.test.ts` against real tmux.
- **The browser app is served by two named routes, not a wildcard**
  (`server/src/web/static.ts`). `@fastify/static` is registered with
  `serve: false` purely for `reply.sendFile`; `/` and `/assets/:file` are the only
  routes marked `public` besides `/api/login`. A wildcard would answer every
  unmatched path publicly and hand an unauthenticated caller a 404-vs-401 oracle
  for which API routes exist. `web`'s `prepare` builds `web/dist` on `npm ci` for
  the same reason `server`'s does — `tether serve` reads it at startup and only
  warns if it is absent.
- **All persistent state is one SQLite file outside the repo**, opened by
  `server/src/db.ts` — `~/.local/state/tether/tether.sqlite`, file `0600` in a `0700`
  directory (`$XDG_STATE_HOME`, or `$TETHER_STATE_DIR`, which tests and any manual run
  must set rather than touch the real one). Never write runtime state into the repo; a
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
- **The conversation is read from Claude Code's transcript, and parsed
  tolerantly on purpose.** `providers/claude-code/transcript.ts` finds and tails
  `~/.claude/projects/<sanitised cwd>/<provider session id>.jsonl`; `events.ts`
  maps records to `ConversationEvent`. The format is internal to a tool that
  ships weekly, so **an unknown record type, block or shape is warned about and
  ignored, never thrown** — a mapper that throws loses the user's session, and
  the terminal is a complete fallback for anything dropped. Two things the tailer
  must keep: it reads forward from a byte offset (never re-reads the file) and
  its carry is **bytes**, because a flush lands mid-line and mid-glyph routinely.
  `fs.watch` is only the fast path; the 1s stat poll is what makes it work on
  filesystems where the watcher silently delivers nothing. Fixtures in
  `providers/claude-code/fixtures/` are captured from a real session with the
  version recorded — **CI must never run a live agent** (real credentials, money
  per run). Verified while capturing them and worth knowing: `thinking` blocks
  reach disk with an **empty** `thinking` string, so the event is presence-only.
- **`machine/conversations.ts` has a cursor and `machine/terminal.ts` does not.**
  The asymmetry is deliberate: tmux re-derives the terminal exactly on every
  attach, conversation events are re-derivable from nothing the client holds.
  `seq` is the event's position in the mapped stream, which is why the HTTP
  history route and a live tailer agree without either persisting anything. A
  `since` older than the in-memory tail is answered with `refetch`, never with a
  partial history.
- **Fastify's schema defaults silently repair a bad body** (`removeAdditional` and
  `coerceTypes` are on): `additionalProperties: false` strips instead of rejecting, and
  `{"password": 123}` arrives as `"123"`. `buildServer` turns both off. Do not remove that
  `ajv.customOptions` block, and do not assume stock Fastify behaviour when reading the tests.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
