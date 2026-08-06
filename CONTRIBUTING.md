# Contributing

## Development

Requires the Node version in [`.nvmrc`](.nvmrc) (`nvm use`), **tmux 3.7 or
newer**, and a **C++ toolchain** (`build-essential` and `python3` on Debian or
Ubuntu). tmux, because the driver's tests drive a real server on a private
socket, not a mock, and older tmux crashes on the `window-size manual` that
`tether.conf` sets (so does Remote Control Agent; 3.7 is a hard floor, not just a test
one). A toolchain, because `node-pty` ships no Linux prebuild and is compiled
during install. [`install.sh`](install.sh) sets up tmux and the toolchain and
checks Node — it does not install Node — and `./install.sh` inside a checkout
installs that checkout rather than cloning another.

```sh
npm ci        # installs all workspaces; builds shared/, server/ (the CLI), web/ and node-pty
npm test      # node:test across every package
npm run build # server (tsc) and web (vite) — rerun after editing either
```

`npm run rcagent -- <args>` runs the CLI from the working tree without installing
it.

`rcagent serve` serves the built app out of `web/dist`, so after editing `web/`
either rebuild it or run Vite's dev server alongside, which proxies `/api` — the
terminal and conversation WebSockets included — to an `rcagent serve` on the
default port:

```sh
npm run dev -w @tether/web   # http://localhost:5173, hot reload, real server behind it
```

`node-pty`'s install script is approved in the root `package.json` under
`allowScripts`, because npm 12 blocks dependency install scripts by default. If
`rcagent serve` reports that the native module is missing, install the toolchain
and re-run `npm ci`; the message says so too. The root `postinstall` then makes
`node-pty`'s `spawn-helper` executable, which its macOS prebuild ships without —
macOS starts every process through that helper, so without the bit every
terminal attach fails with `posix_spawnp failed` and nothing else does.

Other checks, all of which CI runs on every pull request:

```sh
npm run typecheck    # tsc --noEmit, per package
npm run lint         # eslint
npm run format:check # prettier --check   (npm run format to fix)
npm run check:pty    # a terminal really starts here: the helper bit, and a live PTY
npm audit --omit=dev --audit-level=high

shellcheck install.sh        # the installer is the only shell in the repo
bash install.sh --self-test  # versions, PATH, package plans, services, Funnel probes, checkout moves

npx playwright install chromium   # once; npm 12 blocks playwright's own postinstall
npm run test:e2e                  # the end-to-end specs
```

### Cutting a release

The install line installs the latest release tag, so **merging to `main` does not
ship anything.** Dispatch the release workflow from `main` with the next
`vX.Y.Z` version:

```sh
gh workflow run release.yml --ref main -f version=v0.4.0
gh run watch
```

The [Release workflow](.github/workflows/release.yml) reruns the complete CI
suite first. It then verifies the version is newer, creates an annotated tag on
the exact commit that passed, and publishes the GitHub release with generated
notes. A failed validation creates no tag, so the installer cannot see an
unvalidated release.

`install.sh` picks the highest `vX.Y.Z` tag out of `git ls-remote --tags`, so the
**tag** decides what gets installed. Prerelease tags and branches are ignored by
that query and reachable only as `RCAGENT_VERSION` (`TETHER_VERSION` remains an
alias). This also works for an
existing installation:

```sh
url=https://raw.githubusercontent.com/galawaydude/remote-control-agent/main/install.sh
curl -fsSL $url | RCAGENT_VERSION=v0.3.0 bash   # an older release
curl -fsSL $url | RCAGENT_VERSION=main   bash   # an unreleased change, to test it
```

The checkout stays shallow either way, so moving between refs stays as fast as
the first clone.

`install.sh` itself is fetched from `main` rather than from the tag, as
Homebrew's is: it is the thing that has to know how to find the current release,
so pinning it would mean editing the README's install line every time. Which
means a change to `install.sh` is live at merge, while everything it installs is
live at tag.

### The HTTP and WebSocket API

Sessions are addressed as `(machineId, sessionId)` from day one, and `machineId`
is always `local`. That one path segment is what makes a second machine a later
split rather than a rewrite.

```
GET    /api/machines/local/sessions            every listed session, live and dead, with each live one's state
GET    /api/machines/local/folder-trust?cwd=…&provider=…
                                               whether that agent already trusts that directory,
                                               and which directory the answer is about
POST   /api/machines/local/sessions            {"cwd": "…", "title"?: "…", "provider"?: "…",
                                                "trustFolder"?: true} — the last one is the only
                                                thing that ever records a folder as trusted
GET    /api/machines/local/sessions/:id
POST   /api/machines/local/sessions/:id/resume restarts a dead session's conversation
POST   /api/machines/local/sessions/:id/forget removes a dead row from the app; transcript untouched
DELETE /api/machines/local/sessions/:id        kills the tmux session and marks the row dead
POST   /api/machines/local/sessions/:id/permission-mode
                                               {"mode": "default"|"acceptEdits"|"plan"|"auto"} — Claude
                                               Code only; answers with the mode read back off the pane
GET    /api/sessions/:id/conversation?before=… one bounded history page, with absolute sequence numbers
POST   /api/sessions/:id/images                stores one private pasted image (raw supported image bytes)
GET    /api/sessions/:id/images/:file          serves it inline to an authenticated viewer
POST   /api/sessions/:id/permission            {"callId": "…", "decision": "allow" | "deny"}
WS     /api/sessions/:id/conv?since=<seq>      conversation events after `seq`, the last one you hold
WS     /api/sessions/:name/term                terminal bytes, both ways
```

The conversation is read from the provider's own transcript file rather than from
the terminal — `~/.claude/projects/<slug>/<uuid>.jsonl` for Claude Code,
`~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl` for Codex. Both are
append-only NDJSON, which is why they share one tailer and differ only in a
mapper. Neither file is a public API — see
[Known risks](docs/security.md#known-risks).

`conv` also carries three frames that are not records of anything and
deliberately have no `seq` — a sequence number is a position in the transcript,
and none of these comes from it.
`{"c":"state","state":"busy"|"idle"|"waiting"}` is the session's current state,
from the agent's own status file and its hooks. `{"c":"pending","e":…}` is a tool
call the agent has named as the one it is asking about; the transcript's own
record for the same call carries the same `callId` and replaces that card rather
than adding a second one — in either order, which matters because Claude Code
writes its record _after_ the prompt and Codex writes it _before_. A `pending`
with a `deadline` is one Remote Control Agent is holding until then, so that card
gets Approve and Deny; without it the app is only reporting the
proposal. `{"c":"answer","callId":…,"outcome":"allow"|"deny"|"timeout"}` says a
hold is over — sent to every subscriber, so a second phone stops offering buttons
on a question that has already been answered.

`conv` answers a `since` it cannot replay from memory with `{"c":"refetch"}`,
which means "fetch the history route again"; it never sends a partial history.

### The end-to-end specs

`e2e/` is eight Playwright specs, and they are the only tests here that are not
unit tests. Seven run at a phone viewport, which is the client the app is designed
for.

- **`session.spec.ts`** logs in, starts a session, watches it, types at it,
  **reloads the page**, and asserts the URL restores that same open session and
  the conversation and terminal come back intact and exactly once. It summons
  the terminal over the conversation and
  dismisses it, asserting both keep their scroll position, that all seven phone
  keys fit without sideways scrolling and that the terminal is not re-attached.
  It kills another session, reviews its saved conversation and resumes it from
  that screen, then sends a new prompt without ever opening the terminal. It
  measures at 360×640 that nothing Remote Control Agent draws — the waiting banner included —
  changes the terminal's box or its row count, since a
  change there resizes the tmux pane for every other viewer; and it opens the New
  session sheet at the shortest full-height phones **and at a phone with its
  keyboard up** (360×340) and asserts that both ends of its card — the **Agent**
  picker and **Start** — stay reachable, since the sheet is the one screen that
  grows with its copy.
- **`permission.spec.ts`** drives the hook chain end to end: it acts out three
  permission prompts and answers them three ways. **Approve** on the card runs
  the command and the transcript's own record then replaces that card rather than
  adding a second one; **Deny** blocks it and the command never runs; and one
  that nobody answers is handed back to the agent's own prompt in the terminal,
  answered there, and still reconciles to one card. It types the reflex `yes` at
  the pane after a tap has already approved something, and asserts that approves
  nothing. It asserts the watch rule the overlay decides: a tool call proposed
  while the terminal is summoned is **not** held — the agent's own prompt takes
  the question straight away — and the same session holds the next one once the
  terminal is put away. Every control that ends a hold is measured rather than
  merely found: the card's **Approve** and **Deny**, and the waiting banner's
  **Open the terminal**, are each reachable at the phone's own size and again
  with the keyboard up (360×340).
- **`composer.spec.ts`** composes a message and asserts it reaches the agent and
  appears exactly once, that Enter in the box is a line break rather than a send,
  and that the composer leaves Send on screen with the keyboard up. It verifies
  that Copy is visible, writes the exact text and confirms success; pastes a real
  PNG, checks its local preview, private upload, rendered image and reload; and
  also sends **slash commands** from that box: that one is not drawn as a message, that a
  recorded one really arrives in the conversation, that a chooser's reaches the
  pane and is reported rather than claimed, and that the command list gives way
  rather than pushing Send off a 360×340 screen.
- **`identity.spec.ts`** starts two sessions in **one** directory and asserts each
  shows its own conversation and neither shows the other's, then acts out a
  `/resume` at one of their panes, asserts that view follows the agent to the
  conversation it resumed into, then reloads and proves the resumed binding
  survives with it.
- **`history.spec.ts`** opens a transcript longer than the browser's row bound and
  reloads it. The newest conversation returns directly rather than a blank page,
  the cursor still covers the whole transcript, and the view says that older rows
  are hidden instead of mounting thousands of markdown trees on a phone.
- **`render.spec.ts`** writes what an agent actually writes into the transcript
  and asserts what the conversation makes of it: markdown rather than a wall of
  characters, a `<script>` in a fenced block that is text in the page rather than
  a node in it, an `Edit` drawn as a diff, a failed call that says _retrying_ or
  _needs you_ — and, on an **answerable** `Edit`, a diff that wraps with Approve
  still on screen, since nothing on a card the agent is blocked on may be off it.
  It drives the hook chain a second time, for the guard that holds **Approve**
  behind an acknowledgement when a command carries lookalike characters. It
  checks at every step that the page itself has not moved sideways.
- **`options.spec.ts`** drives the composer's option controls under both agents:
  that each provider is offered its own and only its own, that a keystroke axis
  really reaches the pane, that a bar-lowering choice does nothing until its
  sentence is confirmed and that a mode change Remote Control Agent could not confirm never
  claims one — and that at 360×340, with the warning up, Cancel, the confirm and
  Send are all still on screen.
- **`desktop.spec.ts`** is the only one that runs at a laptop viewport
  (1280×800), because past 900px the app is a different shape rather than a wider
  phone: it measures the rail's box against the open session's, collapses and
  reloads it, restores it with the same selected row, asserts the back button is
  **gone** rather than merely invisible, checks the open Agent options share one
  compact row, that the page has exactly one `<main>`, and that nothing makes it
  scroll sideways.

All eight run against `e2e/stub-agent.ts` — a script that prints, echoes what you
type at it, writes a Claude-Code-shaped transcript, publishes its own status
file, acts out a slash command the three ways the real one does (applied and
recorded, a chooser in the pane and nothing on disk, or refused locally), moves
to a new session id and a new transcript on a `/resume`, and fires whatever hook
the project's settings register **and honours the decision that hook writes
back**, exactly as Claude Code does. It is put on `PATH` as both `claude` and
`codex`, so a session under either agent is created through the real code path.
It writes that same Claude-shaped transcript either way, so a Codex session in
the suite has no conversation and the spec that starts one asserts on the
keystrokes the pane received instead.

**CI never runs a real agent**: that would need real credentials and would cost
money per run. Everything the specs touch (`HOME`, the state file, the tmux
socket, the session root) is redirected into a scratch directory by
`playwright.config.ts`. They have no retries, deliberately: these tests cover the
product's core claims, and a flake retried into passing is worse than no test.

### Layout

| Package   | What it is                                                                    |
| --------- | ----------------------------------------------------------------------------- |
| `shared/` | Types both sides import: `Session`, `ConversationEvent`, the WebSocket frames |
| `server/` | The single Node process: HTTP, WebSockets, tmux, provider adapters            |
| `web/`    | The browser app                                                               |

Inside `server/src/`, `web/` is the HTTP and WebSocket layer and `machine/`
drives tmux. `machine/` and `providers/` never import from `web/` — that one rule
is what makes the eventual remote-agent split a split rather than a rewrite.

`providers/` holds one directory per provider — `claude-code/` and `codex/` —
plus the four files they genuinely share (`tail.ts`, which follows an
append-only file, `cap.ts`, which bounds what a card may carry, `permission.ts`,
which is the one place the permission timeouts, the hook secret and the signals
both hooks speak are decided, and `trust.ts`, which holds the folder-trust
tri-state and nothing about either agent's own file). There is no `Provider`
interface, registry or plugin loader: adding the second provider cost two
directories and one `switch`, which is smaller than the abstraction that would
have been designed to avoid it and cannot be wrong about a provider nobody has
built yet.

Neither provider's tests ever run a real agent — that would need real credentials
and cost money per CI run. Both are driven from captured fixtures, with the
provider version recorded next to them.

`shared/` is types only and emits declarations, no JavaScript. Import from it
with `import type` — `verbatimModuleSyntax` enforces this.
