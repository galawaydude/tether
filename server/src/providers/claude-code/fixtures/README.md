# Transcript and hook fixtures

Captured from **Claude Code 2.1.220** on 2026-07-29. The version is in every
record's `version` field, which is exactly how `mapRecord` reports a mismatch at
runtime — these files are self-describing, so do not strip it.

CI must never run a real Claude Code session: it would need real credentials and
cost money per run. The mapper is driven from these files instead. To refresh
them, capture a live session by hand and record the version here.

| File                     | What it is                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session-2.1.220.jsonl`  | A real `claude -p` session: one `Read` tool round-trip, then `/compact`. Covers `user`, `assistant`, `attachment` (five kinds, including `file` and `hook_success`), `system`/`compact_boundary` with its `compactMetadata`, and the bookkeeping records around them.                                                          |
| `thinking-2.1.220.jsonl` | One real assistant record with a `thinking` block.                                                                                                                                                                                                                                                                             |
| `hooks-2.1.220.ndjson`   | Real hook payloads, captured **while a permission prompt was on screen** — the moment report §4 exists to close. One `PreToolUse` for the `Write` being asked about, the `Notification` that accompanied it, and a second `PreToolUse` (`Bash`) from the next turn. Every byte as Claude Code wrote it.                                                                                                       |
| `unknown.jsonl`          | Synthetic — necessarily so: no real transcript contains a record type tether does not know. A future record type, a future content block, a content field of the wrong shape, a `tool_result` with no `tool_use_id`, an unparseable timestamp, and a future `system` subtype. All of it must be ignored, none of it may throw. |

How `session-2.1.220.jsonl` was captured:

```sh
cd "$(mktemp -d)" && printf 'hello tether spike\n' > note.txt
claude -p --session-id <uuid> "Read note.txt with the Read tool and tell me in one short sentence what it says."
claude -p --resume <uuid> "/compact"
cp ~/.claude/projects/<sanitised cwd>/<uuid>.jsonl .
```

Two edits were made to that capture, and nothing else: repeated `hook_success`
attachments were dropped (one is enough to prove the shape) and `attachment`
`content` strings over 400 characters were truncated with a `[trimmed for the
fixture]` marker. Every other byte is as Claude Code wrote it.

How `hooks-2.1.220.ndjson` was captured: a real `claude` run inside tmux with a
`cat >> …` hook registered for `PreToolUse` and `Notification`, given a prompt
requiring approval (`Write` a new file), with the payloads taken while the
dialog was still up. Two things it records that are worth not rediscovering:
`notification_type` is `permission_prompt`, and the transcript's own `tool_use`
record for that same `tool_use_id` **had already reached disk** on this build.
The hook is still the low-latency edge, but the order is genuinely not
guaranteed, which is why reconciliation is by `callId` and works either way.

`thinking-2.1.220.jsonl` is one record from an interactive session, with its
opaque `signature` truncated — nothing reads it, and a long base64 blob in a
fixture is a secret scanner's problem waiting to happen. Note what it shows:
**`thinking` is the empty string on disk.** Across 1091 thinking blocks in this
machine's transcripts, not one carries its text — only that signature. That is
why `ConversationEvent`'s `thinking` variant is presence-only.
