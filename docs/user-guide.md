# User guide

## Using it

### The session list

Every session on the machine, live and dead, each tagged with the agent it is
running and grouped under the day it was last worked on, with a search box over
it that filters on title and directory. A live session shows what its agent is
doing — _Working_, _Idle_ or _Waiting for you_ — and just **live** where the
provider is not saying, rather than a badge that would be a guess. A live row
must be **Kill**ed before it can be removed. Dead rows carry **Remove**: after a
confirmation they disappear from tether's list and can no longer be resumed,
while the provider-owned Claude Code or Codex transcript stays untouched.

### The conversation

Opening a session lands you in the conversation, not a terminal: your prompts,
the agent's replies, and a collapsed card per tool call that opens onto its
input and result. A long session initially opens at its latest 512 events so a
phone never has to download and mount thousands of rows at once. **Load earlier**
walks backward through the complete transcript one bounded page at a time, and
**Back to latest** returns to the live conversation; history is accessible, not
deleted or accumulated into another multi-megabyte screen.

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

There is no second tab to choose. **Terminal** in the header opens the real TUI
as one full, uncluttered pane; that same control becomes **Conversation**, which
puts it away with both views exactly where you left them. The seven keys a phone
keyboard has not got (Esc, Tab, arrows, Ctrl-C) all fit in one fixed bar without
a sideways tray, and opening the pane focuses it for typing. Ordinary text,
Enter, Backspace, Tab, Escape and Ctrl keys write through the already-attached
PTY rather than spawning a tmux command for every press, so fast typing does not
build a server-side queue. It remains the complete fallback for anything the
conversation view cannot draw.

### Sending a message

You reply in the conversation's **composer**: a real text box, so the message is
composed on the phone and sent as one unit rather than a round trip per keystroke
with autocorrect fighting a raw byte stream. **Enter inserts a line break** — the
Send button is what sends — and a multi-line prompt arrives whole. It shows the
moment you send it and is replaced, not duplicated, by the transcript's own
record a moment later. **Copy** is available on touch screens as well as on
hover, copies the visible text (never an internal attachment path), and changes
to **Copied** so the tap is not silent.

Paste an image directly into that box, or choose **Image**. A local thumbnail
appears before anything is sent, can be opened full-size or removed, and up to
four PNG, JPEG, WebP or GIF images (8 MB each) may accompany one prompt. On Send,
tether stores the bytes privately under its state directory, passes the agent an
absolute readable path, and renders the image from an authenticated URL in the
conversation; it remains viewable after reload without writing into the project.

Send is refused, with the reason, while the agent is waiting on a permission
prompt, where a message would answer the dialog rather than the agent; when the
message is too long for the wire to carry; and once the session has ended or the
server no longer has it. Mid-turn is fine — the agent queues it.

### The option controls, and slash commands

Beside Send, **Agent options** expands the controls only while they are needed;
on a laptop the open controls share one compact horizontal tray. They are
deliberately **not the same for both agents**. An axis is offered
only where changing it was verified to move
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
to a readable column instead of running the full width of the window. The panel
button beside **tether** collapses that rail when the conversation needs the full
window; the matching button beside the session title restores it, and the choice
survives reload.

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
