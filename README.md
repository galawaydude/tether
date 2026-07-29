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

Toolchain, CI and the tmux driver. Nothing runs end to end yet — this milestone
is being built one focused PR at a time.

## Development

Requires the Node version in [`.nvmrc`](.nvmrc) (`nvm use`) and **tmux 3.7 or
newer** — the tmux driver's tests drive a real server on a private socket, not a
mock, and older tmux crashes on the `window-size manual` that `tether.conf` sets
(so does tether itself; 3.7 is a hard floor, not just a test one).

```sh
npm ci        # installs all workspaces; builds shared/ declarations
npm test      # node:test across every package
npm run build # server (tsc) and web (vite)
```

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

`shared/` is types only and emits declarations, no JavaScript. Import from it
with `import type` — `verbatimModuleSyntax` enforces this.

## License

MIT — see [LICENSE](LICENSE).
