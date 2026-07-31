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

It runs **Claude Code** and **OpenAI Codex**. Those two, today, both fully — the
conversation view, the terminal, live session state, permission prompts you can
answer from your phone, and resume after a reboot. No other agent is supported.

## Read this before you install it

**Reaching tether's web interface is equivalent to having a shell on the machine
it runs on.** A coding-agent session accepts arbitrary prompts and can run
commands, and the terminal view is a real terminal.

**There is one account.** One password, no per-person logins, no per-directory
scoping, no read-only mode. Anyone you give that password to can start agents,
run commands, and read and change every file under the allowed roots, using
whatever provider logins are signed in on that machine — as you. Sharing the
link is not like sharing a document; it is like handing someone your laptop
unlocked. [Access and security](#access-and-security) is the section to read
before you put tether anywhere but loopback.

## Install

On Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/galawaydude/tether/main/install.sh | bash
```

Or read it first, which for a script that installs a tool like this one is a
reasonable thing to want:

```sh
curl -fsSL https://raw.githubusercontent.com/galawaydude/tether/main/install.sh -o install.sh
less install.sh
bash install.sh
```

It clones tether to `~/.local/share/tether` (`--dir` moves that), builds it, and
links `tether` into `~/.local/bin`.

**It installs the latest release, not the tip of `main`**, so the one-liner
cannot hand you a change that landed half an hour ago and half-landed.
`TETHER_VERSION=v0.1.0` installs a particular one instead.

**It asks before it installs a system package or runs `sudo`.** It prints the
exact commands first and waits for a yes; declining prints them for you to run
yourself and stops. `--yes` accepts them up front for an unattended run. It
never edits a shell startup file — if `~/.local/bin` is not on your PATH, it
shows you the line to add and leaves the file alone.

### What it needs, and the one that surprises people

- **Node**, the version in [`.nvmrc`](.nvmrc). The installer checks it and stops
  with the `nvm` command if it is missing or too old; it does not install Node.
- **tmux 3.7 or newer — a hard floor.** Older tmux crashes on the
  `window-size manual` that tether's tmux config sets, so every session dies at
  birth. **Debian and Ubuntu ship 3.4**, which means `apt install tmux` gives you
  something that looks installed and does not work. The installer checks the
  version rather than the presence, and on Linux offers to build the same pinned
  release CI builds and install it to `/usr/local/bin` — your distribution's tmux
  is left where it is. On macOS, Homebrew's tmux is current (3.7b) and it uses
  that.
- **A C++ toolchain on Linux** (`build-essential`, `python3`): `node-pty` ships
  no Linux prebuild and is compiled during install. macOS needs none — `node-pty`
  has prebuilds for both Darwin architectures.

### Upgrading, and uninstalling

**Upgrading is re-running the installer.** It fetches whatever the latest
release is now and checks it out over the existing clone, so there is no
separate upgrade command to remember or to keep working.

**Uninstalling is three paths, and the third one matters most:**

```sh
rm -f  ~/.local/bin/tether          # the command
rm -rf ~/.local/share/tether        # the checkout ($XDG_DATA_HOME, or --dir, move it)
rm -rf ~/.local/state/tether        # the password hash, the session registry, hook shims and logs
```

The last one is not a cache. It holds the hash of the password that guards a
shell on this machine, along with every session tether knows about — leaving it
behind leaves a credential behind. (`$XDG_STATE_HOME` or `$TETHER_STATE_DIR`
move it, if you set either.)

Everything else tether ever wrote is in a file that was already yours: the two
hook entries in a project's `.claude/settings.local.json`, and in
`~/.codex/config.toml` the Codex hook entry — `tether codex-hook remove` takes
that one out — and any folder you told it to trust, which is marked with a
comment so you can find it.

## First run

```sh
tether set-password    # prompts; never echoes, never logs, never printed
tether serve           # binds 127.0.0.1:8787
```

The password is never defaulted and can only be set from a terminal on the
machine itself. `serve` prints the address; open it in a browser on that machine,
log in, and tap **New session**. To reach it from a phone, see
[Reaching it from your phone](#reaching-it-from-your-phone) — do not skip
[Access and security](#access-and-security) on the way.

There is a CLI for the same things, which is sometimes quicker than a browser:

```sh
tether new ~/src/project      # starts a session in a durable tmux session
tether ls                     # every session, live or dead
tether kill 1a2b3c4d          # any unambiguous id prefix
tether resume 1a2b3c4d        # bring a dead session's conversation back
```

`tether new` takes `--title`, `--provider` (`claude-code` or `codex`) and, after
`--`, a command to run instead of the provider's own
(`tether new ~/src/project -- /bin/sh`).

`ls`, `kill` and `resume` reconcile the registry against real tmux first, so a
session that died while tether was not running shows as **dead** rather than
live. Dead rows are kept, not deleted: they are what _Resume_ works from. A
reboot destroys every tmux session, so `resume` is how a machine restart stops
being data loss — it starts the provider's own resume (`claude --resume <id>`,
`codex resume <id>`) in a fresh tmux session under the same registry row, so it
is the same conversation. The terminal scrollback is genuinely gone; the
conversation is not. A session that died before its first message has no
conversation to restore, and `resume` says so and refuses rather than handing
back a fresh session dressed up as the old one.

## Using it

### The session list

Every session on the machine, live and dead, each tagged with the agent it is
running and grouped under the day it was last worked on, with a search box over
it that filters on title and directory. A live session shows what its agent is
doing — _Working_, _Idle_ or _Waiting for you_ — and just **live** where the
provider is not saying, rather than a badge that would be a guess.

### The conversation

Opening a session lands you in the conversation, not a terminal: your prompts,
the agent's replies, and a collapsed card per tool call that opens onto its
input and result.

Messages are rendered as the markdown they are written in — headings, lists,
links, emphasis, quotes and above all **fenced code**, in a monospace box that
scrolls inside itself rather than widening the page. An `Edit` or a `Write` opens
onto the change itself: added and removed lines with a `+`/`−` gutter, not a
paragraph describing one. A call that failed says whether it is _retrying_ itself
or _needs you_, so a glance is enough to know whether to pick the phone up. A
whole **turn** the agent's own CLI reported as failed gets a row of its own, in
that CLI's words rather than tether's — and where the CLI itself typed the
failure as an authentication one, the row says nothing will retry it and offers
the way to the terminal, so an expired login reads as an expired login rather
than as a session that quietly stopped working. Any other failure is shown and
nothing is claimed about it. A turn that runs unusually long shows how long
beside the state chip — a fast one shows nothing, so the number appearing is
itself the news.

### The terminal

There is no second tab to choose. **Terminal** in the header summons the real
TUI over the conversation, with a bar for the keys a phone keyboard has not got
(Esc, Tab, arrows, Ctrl-C), and Close puts it away with both views exactly where
you left them. It is the real terminal over tmux, it is always correct, and it is
the complete fallback for anything the conversation view cannot draw.

### Sending a message

You reply in the conversation's **composer**: a real text box, so the message is
composed on the phone and sent as one unit rather than a round trip per keystroke
with autocorrect fighting a raw byte stream. **Enter inserts a line break** — the
Send button is what sends — and a multi-line prompt arrives whole. It shows the
moment you send it and is replaced, not duplicated, by the transcript's own
record a moment later.

Send is refused, with the reason, while the agent is waiting on a permission
prompt, where a message would answer the dialog rather than the agent; when the
message is too long for the wire to carry; and once the session has ended or the
server no longer has it. Mid-turn is fine — the agent queues it.

### The option controls, and slash commands

Beside Send is a row of option controls, and they are deliberately **not the same
for both agents**. An axis is offered only where changing it was verified to move
a running session, so Claude Code gets **Permission mode**, **Model** and
**Effort**, Codex gets its fixed three-preset **Permissions** — and an axis an
agent cannot be moved along mid-session, or can only be moved along by guessing
at a menu tether cannot see, is **absent** rather than a control that fails
quietly. They are menus, not readouts: each resets to the name of its axis once
applied, because tether cannot keep a value true against you typing in the
terminal, and the agent's own answer above the composer is the confirmation.
Permission mode is the one exception — tether reads it off the pane's own status
footer, so what it reports is the mode it **observed**, and it says so plainly
when it could not confirm one. A choice that lets the agent act with less asking
— Claude Code's _Accept edits_ and _Decide for me_, Codex's _Approve for me_ and
_Full access_ — states what it means and takes effect only once you have
confirmed it.

Anything no control covers is reachable by typing the agent's own **slash
command** into the same box. Type `/` and the ones tether knows for that agent
appear above it, one line each; a command is text addressed to the CLI rather
than a prompt, so it gets no message bubble, and it is refused for the same
reasons a message is — while the agent is waiting on a permission prompt above
all. What the composer adds is the one thing sending text cannot tell you:
**where the answer will turn up**. `/model sonnet`, `/effort high` and `/compact`
are recorded by Claude Code, so they land in the conversation as their own line.
`/cost` and `/status` answer in the terminal only. A chooser like `/resume`
leaves the agent waiting for a selection tether cannot draw, so the note that
says so carries **Show the terminal** beside it. A command tether has not heard
of is still sent, since refusing one would refuse every custom command you have —
it just says it cannot vouch for what happened. The single outright refusal is a
Codex command given an argument, because Codex sends that to the model as a paid
prompt instead of running the command.

### On a laptop

The phone is the primary target and gets one screen at a time — the list, then
the session you opened. A laptop gets a different shape rather than a stretched
one: past 900px the session list stays on screen as a rail beside the open
session, so switching sessions costs no trip back, and the conversation is capped
to a readable column instead of running the full width of the window.

## Answering a permission prompt from your phone

When an agent proposes a tool call it needs permission for, the card for that
call gets **Approve** and **Deny**, and the agent waits on your tap. The card
opens itself and shows the whole input — the command, the path, the diff —
because a button that says "Approve?" over a clipped line is worse than no
button.

**This works for both providers.** Claude Code needs no setup; Codex needs its
hook installed once ([below](#codex-and-its-optional-hook)), and then behaves
identically.

Three things worth knowing, because each is a moment where you need to know what
tether will do:

- **It only holds calls worth stopping for, and only while you are watching.**
  Claude Code runs its hook for _every_ tool call, so tether skips the read-only
  ones (`Read`, `Grep`, `Glob`, …); Codex needs no such list. Neither holds
  anything at all for a session no browser has open, so an agent reading twenty
  files does not slow down because your phone is unlocked.
- **Nobody answering is not a denial.** After 20 seconds tether stops holding,
  says so on the card, and the agent asks you in the terminal exactly as it would
  have. `TETHER_PERMISSION_TIMEOUT` is that number in seconds; `0` turns holding
  off entirely and leaves tether reporting prompts without answering them, which
  is a supported way to run it. A Codex hold is capped just under five minutes
  however high you set it, because the timeout in its hooks file is a fixed one —
  changing that value would put its trust prompt in front of you again.
- **If tether cannot be reached, nothing is decided for you.** The hook says
  nothing and the agent's own permission rules apply — never an automatic
  _allow_, because a server that is down must not be able to approve anything,
  and never an automatic _deny_, because a tether outage must not break every
  session on the machine. If tether was reachable and then failed, it says so in
  your session rather than falling back silently.

Whichever surface answers first wins. Approving on your phone means the agent
never shows the dialog, so a reflex keystroke in the terminal afterwards is
ordinary typing and approves nothing; answering in the terminal after a hold has
expired updates the card. There is no second answer either way.

**A command or path that reads as something it is not is named on the card.**
`rm -rf ./buіld` — a Cyrillic `і` in place of the Latin one — reads as
`rm -rf ./build` at any width, and an invisible character reads as nothing at
all; a phone shows less of the surrounding context than a desktop editor and gets
tapped faster, so this is where it matters most. When tether finds one on an
answerable card, it names the character, its code point and its script, and
**Approve** waits behind a one-tap acknowledgement while **Deny** stays live
throughout, because someone reading that warning most likely wants to refuse.

Answering is authenticated as the rest of the API is — an unauthenticated approve
would be an unauthenticated command running on your machine — so it needs a
logged-in session, and the hook's own secret buys no say in the decision.

### The Claude Code hook, and the file it writes in your project

Claude Code does not write a tool call to its transcript until the turn is
finished. Without help, the conversation view would go blank for exactly as long
as a permission prompt is on screen — the one moment you are most likely to be
looking at your phone. So when tether starts a Claude Code session it registers a
hook, and the view shows the tool call it is asking about while it is asking.

It writes one thing into your project: two entries in
`.claude/settings.local.json`, appended after anything already there. Your file
is backed up first — under `~/.local/state/tether/`, not beside the original, so
nothing tether writes can end up in a commit. If that file is not a shape tether
recognises, it changes nothing at all and says so — you get the session without
the accelerator. `.claude/settings.local.json` is git-ignored by convention, and
tether keeps it worth ignoring:

**No secret is ever written into your repository.** The entries contain only a
path to a script under `~/.local/state/tether/`. The shared secret and the URL to
post to are `0600` files beside that script, read when the hook runs. The
endpoint only listens on loopback, only accepts that secret, and only accepts a
payload naming a session tether is actually running.

### Codex, and its optional hook

`tether new ~/src/project --provider codex` starts Codex instead, and so does
picking **Codex** in the browser's New session sheet. Everything works: the
conversation view, the terminal, session state while it is working and when it is
done, and resume after a reboot.

Two things need your permission, and they are the same thing. tether cannot tell
that a Codex session is **waiting for you** to answer a permission prompt, and
cannot offer you **Approve** and **Deny** for it, because Codex does not write
that anywhere — the only way to reach it is a hook, and Codex trust-gates hooks.
So:

```sh
tether codex-hook            # what is registered right now; changes nothing
tether codex-hook install    # explains what it adds, then adds it
tether codex-hook remove     # takes it back out
```

`install` prints exactly what it is about to write, and why, **before** it writes
anything — so that when Codex asks you to trust the hook, you are answering a
question you already understand. It adds one entry, appended after your existing
ones, backs up your `hooks.json` first, and never changes anything else in it.
The hook it registers is a script under `~/.local/state/tether/`. It appends one
JSON line per event to a log under that same directory, and on the one event that
has an answer to return it asks tether over loopback whether you have answered
yet — the same secret-in-a-`0600`-file arrangement described above, and the same
fallback if tether is not running. It talks to nothing else.

Run `install` again after upgrading tether: it corrects its own entry if an older
tether wrote a different one, and Codex then asks you to review that entry once
more — a one-off, because the values tether writes are fixed rather than
following a setting. `tether codex-hook` is what tells you an installation has
gone stale; a stale one still reports _waiting for you_, but gets no Approve and
Deny, and its prompts are answered in the terminal as before.

The New session sheet says the same thing, next to the moment you pick Codex, so
the browser is not the one place you would meet the trust prompt unprepared. It
says it there and nowhere else: no banner on the session list, and no warning
beside a Codex session running happily without the hook.

**Declining is a supported answer, not a broken setup.** You lose the live
_waiting for you_ badge and the Approve/Deny buttons for Codex sessions — the
prompt is still there in the terminal, where it has always been — and nothing
else changes. tether will neither nag you nor retry. Codex also needs
`hooks = true` under `[features]` in `~/.codex/config.toml` before it runs any
hook at all; tether tells you so and changes no setting in that file, since it is
also where Codex records which hooks you have trusted. The one thing it ever
writes there is a folder you chose to trust — see
[Trusting a folder](#trusting-a-folder-before-the-agent-asks).

## Trusting a folder, before the agent asks

Both agents ask whether you trust a directory the first time they run in one. Met
in the terminal, that question is a cramped dialog behind an overlay you have to
summon. So the **New session sheet asks it first**: fill in a directory, and if
the agent you picked does not already trust it, tether says so — what trusting
means, that the agent will be able to read, change and run files there, and that
the answer is remembered — with a box to tick.

- **Tick it and the session starts with no prompt.** tether records your answer
  where that agent reads it: `hasTrustDialogAccepted` in `~/.claude.json` for
  Claude Code, `trust_level = "trusted"` under `[projects."…"]` in
  `~/.codex/config.toml` for Codex. Both files are the agent's, not tether's, so
  each is backed up first (under tether's state directory, never beside the
  original), merged rather than rewritten, and left alone entirely if tether
  cannot make sense of it. The Codex entry is marked with a comment so you can
  find it and take it out again.
- **Leave it unticked and the session still starts** — the agent asks you in the
  terminal, exactly as it did before any of this existed. That is a real answer,
  not an error, and it is the default: nothing is ever trusted because you left a
  box alone.
- **Codex trusts a repository, not a directory**, so a session in `repo/sub` is a
  question about `repo` — the sheet names that path rather than saying "this
  folder". Claude Code accepts a directory and everything under it.
- **If tether cannot read the agent's configuration, it says so and offers
  nothing.** A guess here would either hide a question you should answer or offer
  to write into a file tether has just failed to understand.

## Access and security

**Reaching tether's web interface is equivalent to having a shell on the machine
it runs on.** A coding-agent session accepts arbitrary prompts and can run
commands, and the terminal view is a real terminal. Everything below follows from
that, and none of it is optional.

**There is one account, and it has full access to everything inside the allowed
roots.** No per-person logins, no per-directory scoping, no audit of who did
what. The password is the whole of the authorisation model, and whoever holds it
acts as your OS user with your provider logins. Decide who gets it on that basis.

Set the password before anything else. It is never defaulted, and it can only be
set from a terminal on the machine itself:

```sh
tether set-password
tether serve
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
  resolved — symlinks and all — and then required to lie inside one of them. The
  default is your home directory; `TETHER_ALLOWED_ROOTS` widens it, taking a
  `:`-separated list like `PATH`:

  ```sh
  TETHER_ALLOWED_ROOTS=/srv/code:/mnt/work tether serve
  ```

  It applies to `tether new` as well as to the API, and the startup banner prints
  the roots in force. There is no per-root permission model.

State — the one SQLite file, holding the password hash and the session registry —
lives in `~/.local/state/tether/tether.sqlite` (`$XDG_STATE_HOME`, or
`$TETHER_STATE_DIR` to override), at mode `0600`. Nothing secret, and no runtime
state, is ever written inside the repository.

## Reaching it from your phone

tether binds `127.0.0.1:8787` and terminates no TLS. That is the whole of its
transport story, so getting to it from somewhere else is a decision you make
once, here. Read the section above again first: **whatever you put in front of
tether is what stands between the network and a shell on this machine.** Pick
accordingly — the options below are in the order you should want them.

### Tailscale — recommended

A WireGuard network between your own devices. Free for personal use, no port is
opened on your router, and reaching tether then requires a device that is already
enrolled in your tailnet — a second factor considerably stronger than the
password. Install it on the machine and on the phone, then:

```sh
tailscale ip -4                                  # 100.101.102.103
tailscale status --json | grep '"DNSName"'       # my-box.tailnet-1234.ts.net.

tether serve \
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
  its own hostname to your machine and driving tether through your browser. Use
  the name without the trailing dot that `tailscale status` prints.

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

### Tailscale Funnel — a public HTTPS address, nothing to install on the phone

Funnel puts your tailnet machine on the **public internet** at
`https://my-box.tailnet-1234.ts.net/`, with a real certificate, reachable from a
device that has never heard of Tailscale. That is its whole appeal and its whole
risk: it is the only option here that needs nothing installed on the other
device, and it is also **the option that puts your login page where anyone can
find it.** One password is then the only thing between the internet and a shell
on this machine. The address is not a secret, either: the certificate Funnel gets
for that name is published in the public certificate-transparency logs, so treat
the name as known rather than as a second factor.

```sh
tether serve \
  --allowed-host my-box.tailnet-1234.ts.net \
  --trusted-proxy 127.0.0.1

sudo tailscale funnel --bg 8787
```

tether keeps binding loopback; Funnel reaches it there, so `--trusted-proxy
127.0.0.1` is what makes the `X-Forwarded-Proto` Funnel sets believed, and it is
why the session cookie gets its `Secure` flag. `--allowed-host` is needed for the
same reason as above — the public name is what the browser will send.
`tailscale funnel status` says what is currently exposed, and
`sudo tailscale funnel reset` takes it down again.

The first request after an idle spell is slow, sometimes several seconds, while
Funnel wakes up. That is Funnel, not tether.

### A reverse proxy — deliberate exposure

**This is the other option that puts a shell on the internet**, and unlike Funnel
the certificate, the patching and the front door are yours. Do not choose it
because it is convenient; choose it because you have decided to, and put your own
authentication in front of tether as well if you can.

Caddy gets a certificate on its own:

```
tether.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

```sh
tether serve \
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

**The composer's option controls are the same kind of bet.** Each is a slash
command typed at the agent, or — for Claude Code's permission mode — a keystroke
plus a read of the words in the pane's own status line, so an agent that renames
a command or redraws that line can leave a control doing nothing. It can never
leave one lying: permission mode is reported only as the mode that was read back,
and every other control claims nothing at all, so the agent's own reply above the
composer is what says the change landed. Every axis was established against
Claude Code 2.1.220 and codex-cli 0.145.0; setting any of them by hand in the
terminal always works. So is the slash-command list beside them, and what it says
about where a command's answer turns up is a **prediction rather than a
promise**: an agent is free to stop and ask something the table could not foresee
— `/model opus` opens a _Switch model?_ confirmation on a session with a cached
conversation — which is why no note ever claims nothing else will happen, and why
the waiting banner is the correction.

**Folder trust is the same bet, and the one place tether takes it while
_writing_.** Where each agent records a trusted directory is its own business, and
`~/.claude.json` and `~/.codex/config.toml` can change shape in any release. Both
were established against Claude Code 2.1.220 and codex-cli 0.145.0. The
consequences are bounded on purpose: a file tether cannot make sense of gets no
checkbox and no write, a write it will not make refuses the session outright
rather than starting one on a promise it did not keep, and an existing file is
copied into tether's state directory before it is touched. What a stale reader
costs you is the question moving back into the terminal, where it has always been
answerable.

**The terminal view depends on none of it.** It is the real TUI over tmux, it is
always correct, and it is a complete fallback. If the conversation ever looks
wrong or empty after a provider upgrade, that is the failure to expect, summoning
the terminal is the answer, and the session itself was never at risk.

## Development

Requires the Node version in [`.nvmrc`](.nvmrc) (`nvm use`), **tmux 3.7 or
newer**, and a **C++ toolchain** (`build-essential` and `python3` on Debian or
Ubuntu). tmux, because the driver's tests drive a real server on a private
socket, not a mock, and older tmux crashes on the `window-size manual` that
`tether.conf` sets (so does tether itself; 3.7 is a hard floor, not just a test
one). A toolchain, because `node-pty` ships no Linux prebuild and is compiled
during install. [`install.sh`](install.sh) sets up tmux and the toolchain and
checks Node — it does not install Node — and `./install.sh` inside a checkout
installs that checkout rather than cloning another.

```sh
npm ci        # installs all workspaces; builds shared/, server/ (the CLI), web/ and node-pty
npm test      # node:test across every package
npm run build # server (tsc) and web (vite) — rerun after editing either
```

`npm run tether -- <args>` runs the CLI from the working tree without installing
it.

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
npm run test:e2e                  # the end-to-end specs
```

### Cutting a release

The install line installs the latest release tag, so **merging to `main` does not
ship anything.** A change reaches anyone running that line when a tag is cut:

```sh
git tag -a v0.2.0 -m v0.2.0 && git push origin v0.2.0
gh release create v0.2.0 --generate-notes
```

`install.sh` picks the highest `vX.Y.Z` tag out of `git ls-remote --tags`, so the
**tag** is what decides what gets installed and the GitHub release is the
changelog beside it. Anything that is not three numbers behind a `v` — a `-rc1`,
a branch — is ignored by that query and reachable only as `TETHER_VERSION`, which
is also how you install an older release deliberately.

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
GET    /api/machines/local/sessions            every session, live and dead, with each live one's state
GET    /api/machines/local/folder-trust?cwd=…&provider=…
                                               whether that agent already trusts that directory,
                                               and which directory the answer is about
POST   /api/machines/local/sessions            {"cwd": "…", "title"?: "…", "provider"?: "…",
                                                "trustFolder"?: true} — the last one is the only
                                                thing that ever records a folder as trusted
GET    /api/machines/local/sessions/:id
POST   /api/machines/local/sessions/:id/resume restarts a dead session's conversation
DELETE /api/machines/local/sessions/:id        kills the tmux session and marks the row dead
POST   /api/machines/local/sessions/:id/permission-mode
                                               {"mode": "default"|"acceptEdits"|"plan"|"auto"} — Claude
                                               Code only; answers with the mode read back off the pane
GET    /api/sessions/:id/conversation          the whole conversation, with sequence numbers
POST   /api/sessions/:id/permission            {"callId": "…", "decision": "allow" | "deny"}
WS     /api/sessions/:id/conv?since=<seq>      conversation events after `seq`, the last one you hold
WS     /api/sessions/:name/term                terminal bytes, both ways
```

The conversation is read from the provider's own transcript file rather than from
the terminal — `~/.claude/projects/<slug>/<uuid>.jsonl` for Claude Code,
`~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl` for Codex. Both are
append-only NDJSON, which is why they share one tailer and differ only in a
mapper. Neither file is a public API — see [Known risks](#known-risks).

`conv` also carries three frames that are not records of anything and
deliberately have no `seq` — a sequence number is a position in the transcript,
and none of these comes from it.
`{"c":"state","state":"busy"|"idle"|"waiting"}` is the session's current state,
from the agent's own status file and its hooks. `{"c":"pending","e":…}` is a tool
call the agent has named as the one it is asking about; the transcript's own
record for the same call carries the same `callId` and replaces that card rather
than adding a second one — in either order, which matters because Claude Code
writes its record _after_ the prompt and Codex writes it _before_. A `pending`
with a `deadline` is one tether is holding the agent on until then, so that card
is the one that gets Approve and Deny; without it tether is only reporting the
proposal. `{"c":"answer","callId":…,"outcome":"allow"|"deny"|"timeout"}` says a
hold is over — sent to every subscriber, so a second phone stops offering buttons
on a question that has already been answered.

`conv` answers a `since` it cannot replay from memory with `{"c":"refetch"}`,
which means "fetch the history route again"; it never sends a partial history.

### The end-to-end specs

`e2e/` is seven Playwright specs, and they are the only tests here that are not
unit tests. Six run at a phone viewport, which is the client tether is designed
for.

- **`session.spec.ts`** logs in, starts a session, watches it, types at it,
  **reloads the page**, and asserts the conversation and the terminal come back
  intact and exactly once. It summons the terminal over the conversation and
  dismisses it, asserting both keep their scroll position and that the terminal
  is not re-attached; it measures at 360×640 that nothing tether draws — the
  waiting banner included — changes the terminal's box or its row count, since a
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
  and that the composer leaves Send on screen with the keyboard up. It also sends
  **slash commands** from that box: that one is not drawn as a message, that a
  recorded one really arrives in the conversation, that a chooser's reaches the
  pane and is reported rather than claimed, and that the command list gives way
  rather than pushing Send off a 360×340 screen.
- **`identity.spec.ts`** starts two sessions in **one** directory and asserts each
  shows its own conversation and neither shows the other's, then acts out a
  `/resume` at one of their panes and asserts that view follows the agent to the
  conversation it resumed into.
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
  sentence is confirmed and that a mode change tether could not confirm never
  claims one — and that at 360×340, with the warning up, Cancel, the confirm and
  Send are all still on screen.
- **`desktop.spec.ts`** is the only one that runs at a laptop viewport
  (1280×800), because past 900px the app is a different shape rather than a wider
  phone: it measures the rail's box against the open session's, asserts the back
  button is **gone** rather than merely invisible, that the page has exactly one
  `<main>`, and that nothing makes it scroll sideways.

All seven run against `e2e/stub-agent.ts` — a script that prints, echoes what you
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

## License

MIT — see [LICENSE](LICENSE).
