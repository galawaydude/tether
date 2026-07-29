/**
 * The status fold, driven by both captured vocabularies interleaved the way they
 * really arrive: the rollout says busy and idle, the hooks say waiting.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CAPTURED_VERSION } from './spawn.ts';
import { CodexStatus } from './status.ts';

function fixture(name: string): Record<string, unknown>[] {
  const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const HOOKS = fixture(`hooks-${CAPTURED_VERSION}.ndjson`);
const ROLLOUT = fixture(`rollout-${CAPTURED_VERSION}.jsonl`);

/** Both files in one stream, in the order the clock says they happened. */
function interleaved(): Record<string, unknown>[] {
  const stamped = [
    ...HOOKS.map((record) => ({ at: Number(record['at']), record })),
    ...ROLLOUT.map((record) => ({
      at: Date.parse(String(record['timestamp'])),
      record,
    })),
  ];
  return stamped.sort((a, b) => a.at - b.at).map((entry) => entry.record);
}

test('a session with no records yet is idle, not pretending to be busy', () => {
  assert.equal(new CodexStatus().state, 'idle');
});

test('the rollout alone gives busy and idle — which is what declining the hook costs', () => {
  const status = new CodexStatus();
  const seen: string[] = [];
  for (const record of ROLLOUT) {
    if (status.apply(record)) seen.push(status.state);
  }
  assert.deepEqual(seen, ['busy', 'idle', 'busy', 'idle', 'busy', 'idle'], 'three whole turns');
  assert.equal(status.state, 'idle');
  assert.ok(!seen.includes('waiting'), 'and no `waiting`: it is not in the rollout at all');
});

test('the PermissionRequest hook is what makes a session read as waiting', () => {
  const status = new CodexStatus();
  const seen: string[] = [];
  for (const record of interleaved()) {
    if (status.apply(record))
      seen.push(`${status.state}${status.detail ? `:${status.detail}` : ''}`);
  }
  assert.ok(seen.includes('waiting:Bash'), 'the shell command the user was asked about');
  assert.ok(seen.includes('waiting:apply_patch'), 'and the patch');
  assert.equal(status.state, 'idle', 'the session ends idle, with nothing left pending');
});

test('the answered prompt clears the badge, and only the answered one', () => {
  const status = new CodexStatus();
  // The hard case, straight from the capture: the sandbox-denied first attempt
  // and the retry that raised the prompt carry byte-identical `tool_input` on
  // the same turn, under different `tool_use_id`s.
  const request = HOOKS.find((r) => r['hook_event_name'] === 'PermissionRequest');
  const turn = HOOKS.filter((r) => r['turn_id'] === request?.['turn_id']);
  const [deniedPre, promptedPre, , post] = turn;
  assert.equal(turn.length, 4, 'two attempts, the prompt, and the completion');
  assert.deepEqual(deniedPre?.['tool_input'], promptedPre?.['tool_input'], 'identical inputs');
  assert.notEqual(deniedPre?.['tool_use_id'], promptedPre?.['tool_use_id']);

  for (const record of turn.slice(0, 3)) status.apply(record);
  assert.equal(status.state, 'waiting');

  // The completion of the *denied* call must not clear a prompt about the other
  // one — most-recent-wins is what picks the right `PreToolUse` to correlate to.
  status.apply({ ...post, tool_use_id: deniedPre?.['tool_use_id'] });
  assert.equal(status.state, 'waiting', 'a different call completing answers nothing');

  status.apply(post);
  assert.equal(status.state, 'busy', 'the correlated call completing does');
});

test('a PermissionRequest that correlates to nothing still shows, and still clears', () => {
  // The correlation is a correlation, not a key: when it finds nothing — a
  // restarted tether that missed the `PreToolUse`, a future Codex that stops
  // sending it — the badge must still go up, and any completion must take it
  // down. Silence would be the worst outcome: the user waits on a prompt tether
  // never mentioned.
  const status = new CodexStatus();
  status.apply({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    session_id: 's',
    turn_id: 't',
  });
  assert.equal(status.state, 'waiting');
  assert.equal(status.detail, 'Bash');

  status.apply({ hook_event_name: 'PostToolUse', tool_use_id: 'call_unrelated' });
  assert.equal(status.state, 'busy');
});

test('a turn finishing clears a prompt nothing else answered', () => {
  const status = new CodexStatus();
  status.apply({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  assert.equal(status.state, 'waiting');
  status.apply({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't' } });
  assert.equal(status.state, 'idle');
});

test('nothing that arrives can make the fold throw', () => {
  const status = new CodexStatus();
  for (const record of [null, 42, 'text', [], {}, { hook_event_name: 'FromTheFuture' }]) {
    assert.doesNotThrow(() => status.apply(record));
  }
  assert.equal(status.state, 'idle');
});

test('a hook log caught up after the rollout does not undo the rollout', async () => {
  // Exactly what a live session does: `Conversations` reads the rollout to its
  // end, then starts on the hook log and replays it from the beginning. Without
  // ordering by event time, that finished turn's `PreToolUse` lands last and a
  // session sitting idle reports as busy. Found by running it, not by reading it.
  const status = new CodexStatus();
  for (const record of ROLLOUT) status.apply(record);
  assert.equal(status.state, 'idle');

  for (const record of HOOKS) status.apply(record);
  assert.equal(status.state, 'idle', 'the replay says nothing about now');

  // And a genuinely new hook record still does.
  status.apply({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', at: Date.now() });
  assert.equal(status.state, 'waiting');
});

test('a record with no timestamp at all is still applied', async () => {
  // Ordering is a defence against replay, not a requirement on the format: a
  // record that cannot say when it happened is treated as happening now.
  const status = new CodexStatus();
  status.apply({ type: 'event_msg', payload: { type: 'task_started' }, at: Date.now() });
  status.apply({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  assert.equal(status.state, 'waiting');
});

test('a turn the user interrupted ends the badge, with no PostToolUse to end it', () => {
  // Captured live: Codex ends an interrupted turn with `turn_aborted` and not
  // `task_complete`, and if the interruption *was* the answer to a permission
  // prompt there is no `PostToolUse` either. Both fixtures are that one turn,
  // replayed in the order the clock says the two files were written in.
  const rollout = fixture(`interrupted-${CAPTURED_VERSION}.jsonl`);
  const hooks = fixture(`interrupted-hooks-${CAPTURED_VERSION}.ndjson`);
  const stream = [
    ...rollout.map((record) => ({ at: Date.parse(String(record['timestamp'])), record })),
    ...hooks.map((record) => ({ at: Number(record['at']), record })),
  ].sort((a, b) => a.at - b.at);

  const status = new CodexStatus();
  for (const entry of stream.slice(0, -1)) status.apply(entry.record);
  assert.equal(status.state, 'waiting', 'the prompt is up and the user has not answered');
  assert.equal(status.detail, 'Bash');

  // Nothing between the prompt and the answer: `function_call` is already on
  // disk when the prompt goes up, and the rollout writes nothing more until the
  // user has answered. That gap is what keeps a live `PermissionRequest` from
  // ever arriving behind a newer rollout record.
  status.apply(stream.at(-1)?.record);
  assert.equal(status.state, 'idle', 'escape is an answer, and the session is at its composer');
  assert.equal(status.detail, undefined);
});
