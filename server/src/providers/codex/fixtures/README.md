# Codex fixtures

Captured from **codex-cli 0.145.0** on 2026-07-29, against tmux 3.7b. The version
is in `session_meta.cli_version`, which is exactly how `mapRecord` reports it at
runtime — the rollout is self-describing, so do not strip it.

CI must never run a real Codex session: it would need real credentials and cost
money per run. The mapper, the status fold and the hook reader are driven from
these files instead. To refresh them, capture a live session by hand and record
the version here.

| File                    | What it is                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rollout-0.145.0.jsonl` | One real session, three turns: an auto-approved `exec_command`, an `exec_command` that needed approval (with the sandbox-denied first attempt before it), and an `apply_patch`. Covers every record type the mapper knows and every one it deliberately drops.                                                                                                                      |
| `hooks-0.145.0.ndjson`  | The eleven hook events that same session fired, in the shim's own on-disk form (the payload plus tether's `at` and `ppid`). Both `PermissionRequest` records are here, including the one whose `tool_input` is byte-identical to two different `PreToolUse` records — which is the correlation's hard case.                                                                         |
| `unknown.jsonl`         | Synthetic — necessarily so: no real rollout contains a record type tether does not know. A future top-level type, a future `event_msg` and `response_item` payload type, a missing payload, a payload that is not an object, tool records with no `call_id`, unparseable arguments, an unparseable timestamp and a future `phase`. All of it must be ignored, none of it may throw. |

## How the capture was made

Against a **private `CODEX_HOME`** in a scratch directory, on a private tmux
socket, with `auth.json` symlinked (not copied) to the real one and the symlink
deleted at teardown. The real `~/.codex` was read but never written:
`hooks.json` and `config.toml` hashed identically before and after.

```sh
tmux -L tp15 -f tmux.conf new-session -d -s cx -x 100 -y 30 \
  -e CODEX_HOME="$LAB/codexhome" -c "$LAB/work" \
  -- codex --ask-for-approval untrusted --sandbox read-only
# hooks.json in that private home registered a capture script on the five events
# in `HOOK_EVENTS`; the trust prompt was accepted interactively, with `t`.
```

The hook trust prompt was accepted the way a user accepts it, in the TUI. It was
**not** bypassed: `--dangerously-bypass-hook-trust` is not used here, in shipped
code, or in the docs — see the head of `../hooks.ts`.

Three edits were made to the capture and nothing else:

- The scratch path was rewritten to `/home/tester/work`, so the fixtures do not
  carry this machine's directory layout.
- Records that are pure bulk and that the mapper explicitly drops were trimmed to
  a marker: `session_meta.base_instructions` (the whole system prompt),
  `world_state`, `thread_settings_applied`, `turn_context`, the
  `response_item/message` bodies, and `reasoning.encrypted_content` — the last
  one because a long opaque blob in a fixture is a secret scanner's problem
  waiting to happen, and nothing reads it: `thinking` is presence-only.
- Nothing else. Every field the mapper, the fold or the join reads is byte-exact
  as Codex wrote it.

## Two things the capture settled that are worth keeping

**`PermissionRequest` really does carry no `tool_use_id`,** and the correlation
really is ambiguous: `call_mNy2…` (sandbox-denied) and `call_LNqe…` (the one that
raised the prompt) have byte-identical `tool_input` on the same `turn_id`. See
`CodexStatus#correlate`.

**An interrupted turn ends differently.** `turn_aborted` carries
`reason: "interrupted"` and a duration, and `task_complete` never arrives. A fold
that only knows `task_complete` leaves an interrupted session reporting busy
forever, at its composer, doing nothing.

**`tool_name` is only partly Claude Code's vocabulary.** The hooks say `Bash`
where the rollout says `exec_command`, but both say `apply_patch`. That is one
rename, not a table — `events.ts` has it as one entry, deliberately.
