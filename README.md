# tether

**tether is a self-hosted control plane for persistent coding-agent sessions.**

You run it on a machine you own. It starts coding agents in durable terminal
sessions on that machine, and gives you a browser UI — designed for a phone
first — to watch them, steer them, walk away, and come back to find the process
and the conversation exactly where you left them.

It is for a developer who runs coding agents on their own hardware (laptop, home
server, dev box) and wants to supervise them from wherever they are, without
handing their source code or their provider credentials to anyone else. tether
never sees, stores, brokers or proxies provider credentials: it launches the
provider's own CLI as your own OS user, and the CLI reads its own credential
file.

## Milestone 1

> You open tether in a browser and log in with a password. You see the sessions
> running on this machine, each with a title, a working directory, and a live
> state: _working_, _idle_, or _waiting for you_. You tap **New session**, pick a
> directory, and a Claude Code session starts. You watch it in a **conversation
> view** — your prompts, its replies, the tools it ran and what they returned.
> When it needs a decision, the session goes amber and you switch to the
> **terminal view**, which is the real Claude Code TUI, live, and you answer. You
> type a message, including a multi-line one, and send it. You close the tab,
> lose signal, get on a train, restart tether, come back an hour later — the
> agent is still running, the conversation is intact, the terminal scrollback is
> intact, and nothing is duplicated or missing.

Concretely: authentication, session list with live status, create session,
conversation view, terminal view, send input, detach, re-attach, and a UI that is
genuinely usable one-handed on a phone. Claude Code is the only provider in M1.

Out of scope for M1: other providers, multiple machines, multi-user accounts, any
hosted component, push notifications, TLS inside tether, git worktree isolation,
scheduled re-prompting, file browsing, image attachments, Docker or SSH session
targets, session sharing, usage dashboards, a mobile app.

## Status

Toolchain, CI, the tmux driver, authentication, the session registry, the HTTP
session API and the terminal transport. There is no web UI yet — but every session
the CLI can start, list and kill can now be driven over HTTP by an authenticated
client, and attached over the `term` WebSocket channel. This milestone is being
built one focused PR at a time.

```
GET    /api/machines/local/sessions        every session, live and dead
POST   /api/machines/local/sessions        {"cwd": "…", "title"?: "…", "provider"?: "…"}
GET    /api/machines/local/sessions/:id
DELETE /api/machines/local/sessions/:id    kills the tmux session and marks the row dead
```

Sessions are addressed as `(machineId, sessionId)` from day one, and `machineId` is
always `local`. That one path segment is what makes a second machine a later split
rather than a rewrite.

## Using it from a terminal

```sh
npm ci                            # also builds the CLI, so `npx tether` works

npx tether new ~/src/project      # starts Claude Code in a durable tmux session
npx tether ls                     # every session, live or dead
npx tether kill 1a2b3c4d          # any unambiguous id prefix
npx tether resume 1a2b3c4d        # bring a dead session's conversation back
```

`tether new` takes `--title` and, after `--`, a command to run instead of the
provider's own (`npx tether new ~/src/project -- /bin/sh`).

`ls`, `kill` and `resume` reconcile the registry against real tmux first, so a
session that died while tether was not running shows as **dead** rather than live.
Dead rows are kept, not deleted: they are what _Resume_ works from.

A reboot destroys every tmux session, so `resume` is how a machine restart stops
being data loss. It starts the provider's own resume (`claude --resume <id>`) in a
fresh tmux session under the same registry row, so it is the same conversation —
the terminal scrollback is genuinely gone, the conversation is not. A session that
died before its first message has no conversation to restore; `resume` says so and
refuses rather than handing back a fresh session dressed up as the old one.

## Access and security

**Reaching tether's web interface is equivalent to having a shell on the machine
it runs on.** A coding-agent session accepts arbitrary prompts and can run
commands, and the terminal view is a real terminal. Everything below follows from
that, and none of it is optional.

Set the password before anything else. There is one account, it is never
defaulted, and it can only be set from a terminal on the machine itself:

```sh
npm run tether -- set-password   # prompts; never echoes, never logs, never printed
npm run tether -- serve          # binds 127.0.0.1:8787
```

- **Loopback by default.** `--host` is the explicit opt-out, and it refuses to
  start unless a password is set.
- **No TLS inside tether**, by design. For remote access use Tailscale, an SSH
  tunnel (`ssh -L 8787:localhost:8787 you@box`), or a reverse proxy that already
  terminates TLS for you. Each of those also gives a second factor stronger than
  the password. An off-loopback bind warns about this at startup and keeps
  warning.
- **`--allowed-host <name>`** adds a hostname to the `Host` allowlist, which is
  what stops a malicious page from reaching the server by resolving its own
  hostname to `127.0.0.1`. A Tailscale name or a reverse-proxy name needs to be
  listed here; loopback names always are.
- **`--trusted-proxy <ip|cidr>`** is the only way `X-Forwarded-Proto` and
  `X-Forwarded-For` are believed. Without it a client cannot spoof the `Secure`
  cookie flag or its own address.
- **Sessions may only start inside the allowed roots.** "Start a session in
  directory X" is input that becomes a process working directory, so the path is
  resolved — symlinks and all — and then required to lie inside one of them.
  The default is your home directory; `TETHER_ALLOWED_ROOTS` widens it, taking a
  `:`-separated list like `PATH`:

  ```sh
  TETHER_ALLOWED_ROOTS=/srv/code:/mnt/work npm run tether -- serve
  ```

  It applies to `tether new` as well as to the API, and the startup banner prints
  the roots in force. There is no per-root permission model: there is one account,
  and it has full access to everything inside the roots.

State — the one SQLite file, holding the password hash and the session registry —
lives in `~/.local/state/tether/tether.sqlite` (`$XDG_STATE_HOME`, or
`$TETHER_STATE_DIR` to override), at mode `0600`. Nothing secret, and no runtime
state, is ever written inside the repository.

## Development

Requires the Node version in [`.nvmrc`](.nvmrc) (`nvm use`), **tmux 3.7 or
newer**, and a **C++ toolchain** (`build-essential` and `python3` on Debian or
Ubuntu). tmux, because the driver's tests drive a real server on a private
socket, not a mock, and older tmux crashes on the `window-size manual` that
`tether.conf` sets (so does tether itself; 3.7 is a hard floor, not just a test
one). A toolchain, because `node-pty` ships no Linux prebuild and is compiled
during install.

```sh
npm ci        # installs all workspaces; builds shared/, server/ (the CLI) and node-pty
npm test      # node:test across every package
npm run build # server (tsc) and web (vite) — rerun after editing server sources
```

`node-pty`'s install script is approved in the root `package.json` under
`allowScripts`, because npm 12 blocks dependency install scripts by default. If
`tether serve` reports that the native module is missing, install the toolchain
and re-run `npm ci`; the message says so too.

Other checks, all of which CI runs on every pull request:

```sh
npm run typecheck    # tsc --noEmit, per package
npm run lint         # eslint
npm run format:check # prettier --check   (npm run format to fix)
```

### Layout

| Package   | What it is                                                               |
| --------- | ------------------------------------------------------------------------ |
| `shared/` | Types both sides import: `ConversationEvent`, the WebSocket frame shapes |
| `server/` | The single Node process: HTTP, WebSockets, tmux, provider adapters       |
| `web/`    | The browser app                                                          |

Inside `server/src/`, `web/` is the HTTP and WebSocket layer and `machine/` (from
PR #2) drives tmux. `machine/` and `providers/` never import from `web/` — that
one rule is what makes the eventual remote-agent split a split rather than a
rewrite.

`shared/` is types only and emits declarations, no JavaScript. Import from it
with `import type` — `verbatimModuleSyntax` enforces this.

## License

MIT — see [LICENSE](LICENSE).
