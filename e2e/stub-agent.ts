/**
 * The stub agent the end-to-end test runs instead of Claude Code.
 *
 * CI must never run a real agent (report §8): it would need real credentials and
 * it would cost money on every run. So this is the smallest thing that behaves
 * like one from tether's side — it prints, it prompts, and it writes a
 * Claude-Code-shaped transcript where the real one writes its own.
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

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** The Claude Code version `server/src/providers/claude-code/fixtures/` came from. */
const VERSION = '2.1.220';

/** Printed once, and the line the reload assertion counts. */
const GREETING = 'stub agent ready';

// `~/.claude/projects/<cwd with every non-alphanumeric byte hyphenated>/<uuid>.jsonl`,
// which is Claude Code's own `sanitizePath` over the *resolved* directory.
const project = join(
  homedir(),
  '.claude',
  'projects',
  realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'),
);
mkdirSync(project, { recursive: true });
const transcript = join(project, `${randomUUID()}.jsonl`);

function record(type: 'user' | 'assistant', text: string): void {
  appendFileSync(
    transcript,
    `${JSON.stringify({
      type,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      version: VERSION,
      message: { role: type, content: [{ type: 'text', text }] },
    })}\n`,
  );
}

record('assistant', GREETING);
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
  const reply = `echo ${text}`;
  record('assistant', reply);
  process.stdout.write(`${reply}\n`);
});
