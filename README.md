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
genuinely usable one-handed on a phone. Claude Code is the first provider in M1;
OpenAI Codex is the second, and is what turned "provider-neutral" from an
intention into a fact.

Out of scope for M1: providers beyond those two, multiple machines, multi-user
accounts, any hosted component, push notifications, TLS inside tether, git
worktree isolation, scheduled re-prompting, file browsing, image attachments,
Docker or SSH session targets, session sharing, usage dashboards, a mobile app.

## Status

Toolchain, CI, the tmux driver, authentication, the session registry, the HTTP
session API, the terminal transport, the conversation data layer, the browser app,
and the conversation view. Run `tether serve`, open the address it prints, and
you can log in, see the sessions on this machine, start one in a directory you name,
and follow it in two tabs: a **Conversation** — your prompts, the agent's replies,
and a collapsed card per tool call that opens onto its input and result — and a
live **Terminal**, with a bar for the keys a phone keyboard has not got (Esc, Tab,
arrows, Ctrl-C). Answering a permission prompt still means the terminal tab: Claude
Code does not write a pending tool call to its transcript until you have answered.
The composer is still to come, and a Codex session's _working_/_idle_/_waiting_
state is served over `conv` but not rendered yet, so a session shows only **live**
or **dead** for now. This milestone is being built one focused PR at a time.

```
GET    /api/machines/local/sessions            every session, live and dead
POST   /api/machines/local/sessions            {"cwd": "…", "title"?: "…", "provider"?: "…"}
GET    /api/machines/local/sessions/:id
POST   /api/machines/local/sessions/:id/resume restarts a dead session's conversation
DELETE /api/machines/local/sessions/:id        kills the tmux session and marks the row dead
GET    /api/sessions/:id/conversation          the whole conversation, with sequence numbers
WS     /api/sessions/:id/conv?since=<seq>      conversation events after `seq`, the last one you hold
WS     /api/sessions/:name/term                terminal bytes, both ways
```

The conversation is read from the provider's own transcript file rather than from
the terminal — `~/.claude/projects/<slug>/<uuid>.jsonl` for Claude Code,
`~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl` for Codex. Both are
append-only NDJSON, which is why they share one tailer and differ only in a
mapper. Those files are **internal to tools that ship frequently, not public
APIs**: a release can change one, and when it does the conversation view loses
detail — never the session, and never the terminal, which depends on none of it
and is always correct.

`conv` also carries `{"c":"state","state":"busy"|"idle"|"waiting"}`, which is the
session's current state rather than a record of anything — Codex sessions today,
since a Claude Code session has no state source yet. It deliberately has no
`seq`: a sequence number is a position in the transcript, and some of the evidence
for `waiting` does not come from the transcript at all.

`conv` answers a `since` it cannot replay from memory with `{"c":"refetch"}`,
which means "fetch the history route again"; it never sends a partial history.

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

`tether new` takes `--title`, `--provider` (`claude-code` or `codex`) and, after
`--`, a command to run instead of the provider's own
(`npx tether new ~/src/project -- /bin/sh`).

`ls`, `kill` and `resume` reconcile the registry against real tmux first, so a
session that died while tether was not running shows as **dead** rather than live.
Dead rows are kept, not deleted: they are what _Resume_ works from.

A reboot destroys every tmux session, so `resume` is how a machine restart stops
being data loss. It starts the provider's own resume (`claude --resume <id>`) in a
fresh tmux session under the same registry row (`codex resume <id>` for Codex), so
it is the same conversation —
the terminal scrollback is genuinely gone, the conversation is not. A session that
died before its first message has no conversation to restore; `resume` says so and
refuses rather than handing back a fresh session dressed up as the old one.

## Codex, and its optional hook

`npx tether new ~/src/project --provider codex` starts Codex instead. Everything
works: the conversation view, the terminal, session state while it is working and
when it is done, and resume after a reboot.

One thing needs your permission. tether cannot tell that a Codex session is
**waiting for you** to answer a permission prompt, because Codex does not write
that anywhere — the only way to know is a hook, and Codex trust-gates hooks. So:

```sh
npx tether codex-hook            # what is registered right now; changes nothing
npx tether codex-hook install    # explains what it adds, then adds it
npx tether codex-hook remove     # takes it back out
```

`install` prints exactly what it is about to write, and why, **before** it writes
anything — so that when Codex asks you to trust the hook, you are answering a
question you already understand. It adds one entry, appended after your existing
ones, backs up your `hooks.json` first, and never changes anything else in it.
The hook it registers is a script under `~/.local/state/tether/`; it appends one
JSON line per event to a log under that same directory and does nothing else.

**Declining is a supported answer, not a broken setup.** You lose the live
_waiting for you_ badge for Codex sessions and nothing else, and tether will
neither nag you nor retry. Codex also needs `hooks = true` under `[features]` in
`~/.codex/config.toml` before it runs any hook at all; tether tells you so and
leaves that file to you, since it is also where Codex records what you have
trusted.

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
- **No TLS inside tether**, by design — the platform solves it better, so
  [Reaching it from your phone](#reaching-it-from-your-phone) delegates it to
  Tailscale, an SSH tunnel or a reverse proxy. An off-loopback bind warns that it
  is serving plain HTTP at startup, and keeps warning every ten minutes.
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

## Reaching it from your phone

tether binds `127.0.0.1:8787` and terminates no TLS. That is the whole of its
transport story, so getting to it from somewhere else is a decision you make
once, here. Read the paragraph above again first: **whatever you put in front of
tether is what stands between the network and a shell on this machine.** Pick
accordingly — the three options below are in the order you should want them.

### Tailscale — recommended

A WireGuard network between your own devices. Free for personal use, no port is
opened on your router, and reaching tether then requires a device that is already
enrolled in your tailnet — a second factor considerably stronger than the
password. Install it on the machine and on the phone, then:

```sh
tailscale ip -4                                  # 100.101.102.103
tailscale status --json | grep '"DNSName"'       # my-box.tailnet-1234.ts.net.

npm run tether -- set-password
npm run tether -- serve \
  --host 100.101.102.103 \
  --allowed-host my-box.tailnet-1234.ts.net
```

Both flags are needed and neither is optional:

- `--host <tailscale ip>` binds to the tailnet interface **only**. `0.0.0.0`
  would work too and would also publish tether to every café Wi-Fi the laptop
  joins.
- `--allowed-host <tailscale name>` puts that name in the `Host` allowlist.
  Without it every request from `http://my-box.tailnet-1234.ts.net:8787` is
  refused, because the allowlist is what stops a hostile web page from resolving
  its own hostname to your machine and driving tether through your browser.
  Use the name without the trailing dot that `tailscale status` prints.

Then open `http://my-box.tailnet-1234.ts.net:8787` on the phone. Tailscale
carries the encryption, so plain HTTP over it is not plaintext on any wire —
tether still warns, because it cannot see what is in front of it.

### An SSH tunnel — nothing to install on the server

If you already have SSH to the machine, you need no tether configuration at all:
tether stays on loopback and the tunnel is the transport.

```sh
ssh -N -L 8787:127.0.0.1:8787 you@box
```

Then open `http://localhost:8787`. Phone SSH clients (Termius, Blink, JuiceSSH)
all do local port forwarding. It is the least convenient option to keep alive on
a phone that sleeps, and the easiest one to set up correctly.

### A reverse proxy — deliberate exposure

**This is the option that puts a shell on the internet.** One password is the
only thing in the way, and an auth bypass in tether would be an unauthenticated
remote code execution on this machine. Do not choose it because it is convenient;
choose it because you have decided to, and put your own authentication in front
of tether as well if you can.

Caddy gets a certificate on its own:

```
tether.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

```sh
npm run tether -- serve \
  --allowed-host tether.example.com \
  --trusted-proxy 127.0.0.1
```

tether keeps binding loopback — the proxy is on the same machine and reaches it
there. `--trusted-proxy` is what makes `X-Forwarded-Proto` and `X-Forwarded-For`
believed, and it is why the session cookie gets its `Secure` flag: without it a
client could set that header itself, so tether ignores it.

## Known risks

**The conversation view is built on file formats that are not public APIs.**
Claude Code writes its transcript to `~/.claude/projects/` and Codex writes its
rollout to `~/.codex/sessions/`. Both ship frequently and owe tether nothing. A
release can change the record shapes, and when it does the conversation view
loses detail — a tool card, a message, at worst the whole view. tether parses
them tolerantly for that reason: an unrecognised record is logged to stderr and
ignored, never thrown.

**The terminal view depends on none of it.** It is the real TUI over tmux, it is
always correct, and it is a complete fallback. If the conversation ever looks
wrong or empty after a provider upgrade, that is the failure to expect, the
terminal tab is the answer, and the session itself was never at risk.

## Development

Requires the Node version in [`.nvmrc`](.nvmrc) (`nvm use`), **tmux 3.7 or
newer**, and a **C++ toolchain** (`build-essential` and `python3` on Debian or
Ubuntu). tmux, because the driver's tests drive a real server on a private
socket, not a mock, and older tmux crashes on the `window-size manual` that
`tether.conf` sets (so does tether itself; 3.7 is a hard floor, not just a test
one). A toolchain, because `node-pty` ships no Linux prebuild and is compiled
during install.

```sh
npm ci        # installs all workspaces; builds shared/, server/ (the CLI), web/ and node-pty
npm test      # node:test across every package
npm run build # server (tsc) and web (vite) — rerun after editing either
```

`tether serve` serves the built app out of `web/dist`, so after editing `web/`
either rebuild it or run Vite's dev server alongside, which proxies `/api` — the
terminal and conversation WebSockets included — to a `tether serve` on the
default port:

```sh
npm run dev -w @tether/web   # http://localhost:5173, hot reload, real server behind it
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

npx playwright install chromium   # once; npm 12 blocks playwright's own postinstall
npm run test:e2e                  # the one end-to-end spec
```

`e2e/` is a single Playwright spec on a phone viewport, and it is the only test
here that is not a unit test: log in, start a session, watch it, type at it,
**reload the page**, and assert the conversation and the terminal come back
intact and exactly once. It runs against `e2e/stub-agent.ts` — a script that
prints, prompts and writes a Claude-Code-shaped transcript — put on `PATH` as
`claude`, so the session is created through the real code path. **CI never runs a
real agent**: that would need real credentials and would cost money per run.
Everything it touches (`HOME`, the state file, the tmux socket, the session root)
is redirected into a scratch directory by `playwright.config.ts`.

It has no retries, deliberately. This test covers the product's core claim, and a
flake retried into passing is worse than no test.

### Layout

| Package   | What it is                                                                    |
| --------- | ----------------------------------------------------------------------------- |
| `shared/` | Types both sides import: `Session`, `ConversationEvent`, the WebSocket frames |
| `server/` | The single Node process: HTTP, WebSockets, tmux, provider adapters            |
| `web/`    | The browser app                                                               |

Inside `server/src/`, `web/` is the HTTP and WebSocket layer and `machine/` (from
PR #2) drives tmux. `machine/` and `providers/` never import from `web/` — that
one rule is what makes the eventual remote-agent split a split rather than a
rewrite.

`providers/` holds one directory per provider — `claude-code/` and `codex/` —
plus the two files they genuinely share (`tail.ts`, which follows an append-only
file, and `cap.ts`, which bounds what a card may carry). There is no `Provider`
interface, registry or plugin loader: adding the second provider cost two
directories and one `switch`, which is smaller than the abstraction that would
have been designed to avoid it and cannot be wrong about a provider nobody has
built yet.

Neither provider's tests ever run a real agent — that would need real credentials
and cost money per CI run. Both are driven from captured fixtures, with the
provider version recorded next to them.

`shared/` is types only and emits declarations, no JavaScript. Import from it
with `import type` — `verbatimModuleSyntax` enforces this.

## License

MIT — see [LICENSE](LICENSE).
