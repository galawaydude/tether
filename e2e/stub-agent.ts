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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** The Claude Code version `server/src/providers/claude-code/fixtures/` came from. */
const VERSION = '2.1.220';

/** Printed once, and the line the reload assertion counts. */
const GREETING = 'stub agent ready';

/**
 * Typed at the pane to act out a permission prompt, and then to answer it in
 * the terminal. Five asks because there are five ways one ends: tether approves
 * it, tether denies it, tether does not answer in time and Claude Code's own
 * prompt takes the question — which is the only path where `ANSWER` is ever
 * typed — and the two the terminal overlay adds, where tether does not hold at
 * all because nobody is watching the conversation, and then does again once it
 * is put away. Each carries its own `tool_use_id`, because a card is keyed by
 * one and a reused id would update the first card rather than make a second.
 */
const ASKS = {
  'ask to run something': { command: 'rm -rf ./build', callId: 'toolu_01StubPermissionPrompt' },
  'ask to run the other thing': { command: 'rm -rf ./dist', callId: 'toolu_02StubPermissionDeny' },
  'ask and wait it out': { command: 'rm -rf ./cache', callId: 'toolu_03StubPermissionTimeout' },
  'ask with the terminal up': {
    command: 'rm -rf ./one',
    callId: 'toolu_04StubPermissionUnwatched',
  },
  'ask with the terminal away': {
    command: 'rm -rf ./two',
    callId: 'toolu_05StubPermissionWatched',
  },
} as const;
const ANSWER = 'yes';

/** What the acted-out prompts are asking for. */
const TOOL = 'Bash';

/**
 * A typed ask only **arms** the tool call; this file is what fires it.
 *
 * The reason is tether's own: it holds a proposed call only while the
 * conversation is what is on screen, and the spec has to summon the terminal
 * over it to type at all. Firing inside the `line` handler would therefore race
 * the spec dismissing it again — and a test that goes green by winning a race is
 * worse than no test. Decoupling the trigger from the keystroke removes the race
 * instead of hiding it: the spec types, puts the terminal away, and only then
 * writes this file, and the poll below fires only once *both* have happened, in
 * whichever order they land. The spec that wants the opposite — a call proposed
 * with the terminal still up — gets it by writing the trigger without dismissing.
 */
const TRIGGER = join(process.cwd(), '.tether-e2e-fire');
const POLL_MS = 100;

/**
 * Typed at the pane to act out a `/resume`. Both are `let` for it: Claude Code
 * moves to a *different* session id and a *different* transcript file mid-session
 * and renames itself in its own registry file, and nothing announces any of it.
 * That file is the only evidence there is, which is why tether re-reads it.
 */
const RESUME = 'resume the old conversation';
const RESUMED = 'back in the resumed conversation';

let sessionId = randomUUID();

// `~/.claude/projects/<cwd with every non-alphanumeric byte hyphenated>/<uuid>.jsonl`,
// which is Claude Code's own `sanitizePath` over the *resolved* directory.
const project = join(
  homedir(),
  '.claude',
  'projects',
  realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'),
);
mkdirSync(project, { recursive: true });
let transcript = join(project, `${sessionId}.jsonl`);

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
 * the pane's pid. Claude Code records `/proc/<pid>/stat` field 22 on Linux and
 * the UTC `ps -o lstart=` value on macOS; both were captured from 2.1.220.
 */
const registry = join(homedir(), '.claude', 'sessions');
mkdirSync(registry, { recursive: true });

function processStart(pid: number): string {
  if (process.platform === 'linux') {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]!;
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    const started = result.stdout.trim();
    if (started !== '') return started;
  }
  throw new Error(`the e2e stub does not know ${process.platform}'s process start identity`);
}

const procStart = processStart(process.pid);

function publish(status: 'busy' | 'idle' | 'waiting'): void {
  writeFileSync(
    join(registry, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, procStart, sessionId, status }),
  );
}

/**
 * Run tether's hook the way Claude Code runs it: every `command` the project's
 * own `.claude/settings.local.json` lists for the event, through a shell, with
 * the payload on stdin — and then **read its stdout**, which on `PreToolUse` is
 * where a hook allows or denies the call. Nothing here knows where tether's
 * shim, secret or endpoint are; if the installer did not write that file, no
 * hook fires, which is also the real behaviour.
 *
 * The decision shape is copied from Claude Code's own documented one rather than
 * imported from `server/`, by the same rule as the transcript records above: a
 * stub that shared tether's idea of it would agree with a wrong one.
 */
function fire(
  event: 'PreToolUse' | 'Notification',
  extra: Record<string, unknown>,
): 'allow' | 'deny' | undefined {
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
  let decision: 'allow' | 'deny' | undefined;
  for (const group of settings.hooks?.[event] ?? []) {
    for (const handler of group.hooks) {
      const { stdout } = spawnSync('sh', ['-c', handler.command], { input: payload });
      for (const line of String(stdout ?? '').split('\n')) {
        if (line.trim() === '') continue;
        try {
          const said = JSON.parse(line) as {
            hookSpecificOutput?: { permissionDecision?: string };
          };
          const said_ = said.hookSpecificOutput?.permissionDecision;
          if (said_ === 'allow' || said_ === 'deny') decision = said_;
        } catch {
          // A hook that writes something unparseable decides nothing, which is
          // what Claude Code does with it too.
        }
      }
    }
  }
  return decision;
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
/**
 * The call, once something has decided about it — tether, or the user at the
 * pane. Either way the same two records reach the transcript with the same
 * `tool_use_id` the hook already announced, which is what the pending card is
 * reconciled by; only the result differs.
 */
function commit(call: { command: string; callId: string }, allowed: boolean): void {
  publish('busy');
  write('assistant', [
    { type: 'tool_use', id: call.callId, name: TOOL, input: { command: call.command } },
  ]);
  const output = allowed
    ? `removed ${call.command.replace('rm -rf ', '')}`
    : 'The user denied permission to run this command.';
  write('user', [
    {
      type: 'tool_result',
      tool_use_id: call.callId,
      content: output,
      ...(allowed ? {} : { is_error: true }),
    },
  ]);
  publish('idle');
  process.stdout.write(`${output}\n`);
}

/** The call the pane is being asked about, while Claude Code's own prompt is up. */
let asked: { command: string; callId: string } | undefined;

/** The call a typed ask has armed, waiting for {@link TRIGGER}. */
let armed: { command: string; callId: string } | undefined;

/**
 * The moment this whole path exists for: the agent has decided to run something
 * and is holding for an answer, with *nothing* in the transcript about it yet.
 * `PreToolUse` fires first and blocks — tether may answer it right there, which
 * is the tap from the conversation view. Only if it does not does the pane show
 * a dialog, and only then is `Notification` sent.
 */
setInterval(() => {
  const ask = armed;
  if (ask === undefined || !existsSync(TRIGGER)) return;
  armed = undefined;
  rmSync(TRIGGER, { force: true });

  publish('waiting');
  const decision = fire('PreToolUse', {
    permission_mode: 'default',
    tool_name: TOOL,
    tool_input: { command: ask.command, description: 'Clear a directory' },
    tool_use_id: ask.callId,
  });
  if (decision !== undefined) {
    commit(ask, decision === 'allow');
    return;
  }
  asked = ask;
  fire('Notification', {
    message: `Claude needs your permission to use ${TOOL}`,
    notification_type: 'permission_prompt',
  });
  process.stdout.write(`\n${TOOL} command\n  ${ask.command}\n\nDo you want to proceed? (y/n)\n`);
}, POLL_MS);

/**
 * A slash command, acted out the way 2.1.220 really does it — which is three
 * different ways, and the difference is the whole reason `web/src/commands.ts`
 * exists. Verified by running each in a pane and reading the transcript back:
 *
 *  - **A command with an argument applies and prints**, writing `<command-name>`
 *    with `<command-args>` beside it and then `<local-command-stdout>`. Those two
 *    records are the only evidence outside the pane that a command landed, so
 *    they are what the conversation shows.
 *  - **A bare command opens a chooser** and writes *nothing at all*. That is the
 *    `/resume` the captain used, and the case tether can only report rather than
 *    show.
 *  - **An unknown command is refused locally**, in the pane, for free — no turn,
 *    no prompt, nothing in the transcript.
 *
 * Copied from the real thing rather than imported from `server/`, by the same
 * rule as every other shape in this file: a stub that shared tether's idea of it
 * would agree with a wrong one. Notably it does **not** write a `user` record,
 * which is what makes "a command is not a prompt" a claim the spec can check.
 */

/**
 * What `/model x` and `/effort x` print, in the real thing's own words — these
 * are the two the composer's option bar sends (`web/src/options.ts`), so the
 * strings a spec asserts on are theirs and not this file's invention.
 */
const APPLIED: Record<string, (args: string) => string> = {
  '/model': (args) =>
    `Set model to \x1b[1m${args}\x1b[22m and saved as your default for new sessions`,
  '/effort': (args) => `Set effort level to ${args}`,
};

function command(text: string): void {
  const at = text.indexOf(' ');
  const name = at === -1 ? text : text.slice(0, at);
  const args = at === -1 ? '' : text.slice(at + 1).trim();

  const applied = APPLIED[name];
  if (applied !== undefined && args !== '') {
    const said = applied(args);
    write('user', [
      {
        type: 'text',
        text: `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args>${args}</command-args>`,
      },
    ]);
    // With the colour codes the real one writes: `/model` puts the model name in
    // bold on the way to a terminal, and a browser is not one.
    write('user', [{ type: 'text', text: `<local-command-stdout>${said}</local-command-stdout>` }]);
    // Stripped for the pane too, so a spec reading `.xterm-rows` matches the
    // words rather than an SGR sequence xterm has already consumed.
    // eslint-disable-next-line no-control-regex -- an SGR sequence is one
    process.stdout.write(`${said.replace(/\x1b\[[0-9;]*m/g, '')}\n`);
    return;
  }
  if (name === '/resume') {
    // The chooser, and nothing in the transcript — so the only place this exists
    // is the pane, which is exactly what tether has to say about it.
    process.stdout.write('Resume session\n  Search...\n  No conversations found\n');
    return;
  }
  process.stdout.write(`Unknown command: ${name}\n`);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
  const text = line.trim();
  if (text === '') return;

  // Before the `user` record, because a command is not a prompt: the real thing
  // writes command bookkeeping instead, or nothing at all.
  if (text.startsWith('/')) {
    command(text);
    return;
  }
  record('user', text);

  const ask = ASKS[text as keyof typeof ASKS];
  if (ask !== undefined) {
    armed = ask;
    return;
  }

  // The `/resume` above: the line just recorded belongs to the conversation
  // being left, and everything after it goes to a new file under a new id that
  // only `~/.claude/sessions/<pid>.json` names.
  if (text === RESUME) {
    sessionId = randomUUID();
    transcript = join(project, `${sessionId}.jsonl`);
    record('assistant', RESUMED);
    publish('idle');
    process.stdout.write(`${RESUMED}\n`);
    return;
  }

  // Answered at the pane, which only ever happens for a call tether did not
  // answer. A `yes` with no dialog up is not an approval of anything — it is
  // ordinary typing, and it must not run the last thing that was asked about.
  if (text === ANSWER && asked !== undefined) {
    const call = asked;
    asked = undefined;
    commit(call, true);
    return;
  }

  const reply = /^\[Image attached: [0-9a-f-]{36}\.(?:png|jpg|webp|gif) at ".*"\]$/.test(text)
    ? 'echo image received'
    : `echo ${text}`;
  record('assistant', reply);
  process.stdout.write(`${reply}\n`);
});
