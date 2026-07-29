/**
 * The stub agent the end-to-end test runs instead of Claude Code.
 *
 * CI must never run a real agent (report §8): it would need real credentials and
 * it would cost money on every run. So this is the smallest thing that behaves
 * like one from tether's side — it prints, it echoes what is typed at it, and
 * it writes a Claude-Code-shaped transcript where the real one writes its own.
 *
 * `e2e/serve.ts` puts a `claude` shim on `PATH` pointing here, so the session is
 * created through exactly the production path: `POST /sessions` →
 * `PROVIDER_COMMANDS` → tmux runs `claude`.
 *
 * The transcript path and record shapes are copied deliberately rather than
 * imported from `providers/claude-code/`: they are a fixture of Claude Code's
 * behaviour, and a stub that shares tether's idea of them would agree with a
 * wrong one.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** The Claude Code version `server/src/providers/claude-code/fixtures/` came from. */
const VERSION = '2.1.220';

/** Printed once, and the line the reload assertion counts. */
const GREETING = 'stub agent ready';

/** Typed at the pane to act out a permission prompt, and then to answer it. */
const ASK = 'ask to run something';
const ANSWER = 'yes';

/** What the acted-out prompt is asking for. One call, so one `tool_use_id`. */
const TOOL = 'Bash';
const COMMAND = 'rm -rf ./build';
const CALL_ID = 'toolu_01StubPermissionPrompt';

const sessionId = randomUUID();

// `~/.claude/projects/<cwd with every non-alphanumeric byte hyphenated>/<uuid>.jsonl`,
// which is Claude Code's own `sanitizePath` over the *resolved* directory.
const project = join(
  homedir(),
  '.claude',
  'projects',
  realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'),
);
mkdirSync(project, { recursive: true });
const transcript = join(project, `${sessionId}.jsonl`);

function write(type: 'user' | 'assistant', content: readonly unknown[]): void {
  appendFileSync(
    transcript,
    `${JSON.stringify({
      type,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      version: VERSION,
      message: { role: type, content },
    })}\n`,
  );
}

function record(type: 'user' | 'assistant', text: string): void {
  write(type, [{ type: 'text', text }]);
}

// ── the two things a real Claude Code publishes about itself ────────────────
//
// Both are copied from the real thing rather than imported from `server/`, by
// the same rule as the transcript above: a stub that shared tether's idea of
// them would agree with a wrong one.

/**
 * `~/.claude/sessions/<pid>.json`, which tether's badge polls. The pid is this
 * process's own — tmux `execvp`s the shim and the shim `exec`s node, so it is
 * the pane's pid — and `procStart` is `/proc/<pid>/stat` field 22, found from
 * the last `") "` because field 2 can contain spaces and a `)`.
 */
const registry = join(homedir(), '.claude', 'sessions');
mkdirSync(registry, { recursive: true });
const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
const procStart = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];

function publish(status: 'busy' | 'idle' | 'waiting'): void {
  writeFileSync(
    join(registry, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, procStart, sessionId, status }),
  );
}

/**
 * Run tether's hook the way Claude Code runs it: every `command` the project's
 * own `.claude/settings.local.json` lists for the event, through a shell, with
 * the payload on stdin. Nothing here knows where tether's shim, secret or
 * endpoint are — if the installer did not write that file, no hook fires, which
 * is also the real behaviour.
 */
function fire(event: 'PreToolUse' | 'Notification', extra: Record<string, unknown>): void {
  const settings = JSON.parse(
    readFileSync(join(process.cwd(), '.claude', 'settings.local.json'), 'utf8'),
  ) as { hooks?: Record<string, { hooks: { command: string }[] }[]> };
  const payload = JSON.stringify({
    session_id: sessionId,
    transcript_path: transcript,
    cwd: process.cwd(),
    hook_event_name: event,
    ...extra,
  });
  for (const group of settings.hooks?.[event] ?? []) {
    for (const handler of group.hooks) {
      spawnSync('sh', ['-c', handler.command], { input: payload });
    }
  }
}

record('assistant', GREETING);
publish('idle');
process.stdout.write(`${GREETING}\n`);

// `output` matters: with a TTY input and no output, readline turns on raw mode and
// then has nowhere to echo to, so everything typed is invisible in the pane.
//
// No prompt, deliberately. One `write` per turn means the pane is never caught
// half-updated between a reply and the prompt after it — which would make the
// before/after screen comparison in the spec a coin toss rather than a check.
const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  record('user', text);

  // The moment PR #10 exists for: the agent has decided to run something and is
  // holding for an answer, with *nothing* in the transcript about it yet. The
  // hook is the only thing that can say so, and the pane says what a real
  // permission dialog says.
  if (text === ASK) {
    publish('waiting');
    fire('PreToolUse', {
      permission_mode: 'default',
      tool_name: TOOL,
      tool_input: { command: COMMAND, description: 'Clear the build directory' },
      tool_use_id: CALL_ID,
    });
    fire('Notification', {
      message: `Claude needs your permission to use ${TOOL}`,
      notification_type: 'permission_prompt',
    });
    process.stdout.write(`\n${TOOL} command\n  ${COMMAND}\n\nDo you want to proceed? (y/n)\n`);
    return;
  }

  // Answered. Only now does the call reach the transcript — with the same
  // `tool_use_id` the hook already announced, which is what the pending card is
  // reconciled by.
  if (text === ANSWER) {
    publish('busy');
    write('assistant', [
      { type: 'tool_use', id: CALL_ID, name: TOOL, input: { command: COMMAND } },
    ]);
    write('user', [{ type: 'tool_result', tool_use_id: CALL_ID, content: 'removed ./build' }]);
    publish('idle');
    process.stdout.write('removed ./build\n');
    return;
  }

  const reply = `echo ${text}`;
  record('assistant', reply);
  process.stdout.write(`${reply}\n`);
});
