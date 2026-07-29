/**
 * The mapper, against a real Codex session.
 *
 * The fixture is the whole of one captured session, so these assert the
 * conversation the user actually had — not that individual record shapes parse.
 * `fixtures/README.md` says what was captured and what was trimmed.
 */

import type { ConversationEvent } from '@tether/shared';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MAX_OUTPUT } from '../cap.ts';
import { isErrorOutput, mapLines, mapRecord } from './events.ts';
import { CAPTURED_VERSION } from './spawn.ts';

function fixture(name: string): string[] {
  const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return text.split('\n').filter((line) => line !== '');
}

const SESSION = fixture(`rollout-${CAPTURED_VERSION}.jsonl`);

function kinds(events: readonly ConversationEvent[]): string[] {
  return events.map((e) => e.kind);
}

test('a real session maps to the conversation the user had', () => {
  const warnings: string[] = [];
  const { events, version } = mapLines(SESSION, (message) => warnings.push(message));

  assert.equal(version, CAPTURED_VERSION, 'the rollout says which Codex wrote it');
  assert.deepEqual(warnings, [], 'nothing in a captured session is unrecognised');

  // Three turns: ask → run → answer, twice over a shell command and once over a
  // patch. Commentary and the final answer are both present and both assistant.
  assert.deepEqual(kinds(events), [
    // turn 1 — a command the sandbox allowed outright
    'user',
    'assistant',
    'tool_call',
    'tool_result',
    'assistant',
    // turn 2 — denied by the sandbox, then approved by the user and re-run
    'user',
    'thinking',
    'assistant',
    'tool_call',
    'tool_result',
    'thinking',
    'tool_call',
    'tool_result',
    'assistant',
    // turn 3 — a patch, the other tool vocabulary
    'user',
    'assistant',
    'tool_call',
    'tool_result',
    'assistant',
  ]);

  const first = events[0];
  assert.equal(first?.kind === 'user' && first.text.includes('echo tether-p15-probe'), true);
});

test('a tool round-trip keeps its call id, its input and its result', () => {
  const { events } = mapLines(SESSION);
  const call = events.find((e) => e.kind === 'tool_call');
  assert.ok(call?.kind === 'tool_call');
  assert.equal(call.tool, 'Bash', 'Codex’s `exec_command` under the name tether uses');
  assert.deepEqual(
    (call.input as { cmd?: string }).cmd,
    'echo tether-p15-probe',
    '`arguments` is JSON in a string and is parsed, not shown raw',
  );

  const result = events.find((e) => e.kind === 'tool_result' && e.callId === call.callId);
  assert.ok(result?.kind === 'tool_result');
  assert.equal(result.isError, false);
  assert.ok(result.output.includes('tether-p15-probe'));
});

test('a patch is the other tool vocabulary, joined by the same call id', () => {
  const { events } = mapLines(SESSION);
  const call = events.find((e) => e.kind === 'tool_call' && e.tool === 'apply_patch');
  assert.ok(call?.kind === 'tool_call');
  assert.equal(typeof call.input, 'string', '`custom_tool_call.input` is the patch text itself');
  assert.ok(String(call.input).startsWith('*** Begin Patch'));

  const result = events.find((e) => e.kind === 'tool_result' && e.callId === call.callId);
  assert.ok(result?.kind === 'tool_result');
  assert.equal(result.isError, false, '`Exit code: 0` is the patch vocabulary’s success');
});

test('the sandbox refusal is an error, not a successful result', () => {
  const { events } = mapLines(SESSION);
  const refused = events.filter((e) => e.kind === 'tool_result' && e.isError);
  assert.equal(refused.length, 1, 'exactly the one attempt the sandbox denied');
  assert.ok(
    refused[0]?.kind === 'tool_result' && refused[0].output.includes('approval policy'),
    'and it is the prose refusal, which carries no exit code at all',
  );

  // The direction that matters: a status has to be *stated* to be believed.
  assert.equal(isErrorOutput('Process exited with code 0\nOutput:\n'), false);
  assert.equal(isErrorOutput('Process exited with code 1\nOutput:\n'), true);
  assert.equal(isErrorOutput('Exit code: 0\nWall time: 0.1 seconds\n'), false);
  assert.equal(isErrorOutput('some prose nobody promised a format for'), true);

  // Only the preamble states the status. What follows `Output:` is the command's
  // own stdout, and a command can print whatever it likes there — including the
  // line that would otherwise mark it a success it was not.
  assert.equal(
    isErrorOutput(
      [
        'Chunk ID: a03a9a',
        'Wall time: 0.0000 seconds',
        'Process exited with code 1',
        'Original token count: 5',
        'Output:',
        'Process exited with code 0',
        '',
      ].join('\n'),
    ),
    true,
    '`printf "Process exited with code 0"; exit 1` is a failure and must render as one',
  );
  assert.equal(
    isErrorOutput('Exit code: 1\nWall time: 0.1 seconds\nOutput:\nExit code: 0\n'),
    true,
    'and the patch vocabulary says it the same way',
  );
});

test('a record’s id is its line in the rollout, however it reached the client', () => {
  // The history route hands over the whole file; the live tailer hands over
  // whatever landed since it last looked. Both must name the same record the
  // same way, or a refetch renumbers every card the browser is holding.
  const whole = mapLines(SESSION).events.map((e) => e.id);

  const live: string[] = [];
  for (let from = 0; from < SESSION.length; from += 3) {
    live.push(...mapLines(SESSION.slice(from, from + 3), () => {}, from).events.map((e) => e.id));
  }

  assert.deepEqual(live, whole);
  assert.equal(new Set(whole).size, whole.length, 'and a line number makes them unique');
});

test('commentary and the final answer are one turn, not duplicated text', () => {
  const { events } = mapLines(SESSION);
  const assistants = events.filter((e) => e.kind === 'assistant');
  const phases = assistants.map((e) => (e.kind === 'assistant' ? e.phase : undefined));

  // Every one of them says which it is: without that the UI shows what looks
  // like the same answer twice, because the TUI collapses commentary once the
  // final answer lands and a naive view cannot know to.
  assert.deepEqual(phases, [
    'commentary',
    'final_answer',
    'commentary',
    'final_answer',
    'commentary',
    'final_answer',
  ]);
  const texts = new Set(assistants.map((e) => (e.kind === 'assistant' ? e.text : '')));
  assert.equal(texts.size, assistants.length, 'and they are genuinely different text');
});

test('a thinking block is presence, not content', () => {
  const { events } = mapLines(SESSION);
  const thinking = events.filter((e) => e.kind === 'thinking');
  assert.ok(thinking.length > 0);
  for (const event of thinking) {
    assert.deepEqual(Object.keys(event).sort(), ['at', 'id', 'kind']);
  }
});

test('the system prompt and the accounting are not conversation', () => {
  const { events } = mapLines(SESSION);
  const text = JSON.stringify(events);
  assert.ok(
    !text.includes('You are Codex'),
    '`response_item/message` is dropped, developer included',
  );
  assert.ok(!text.includes('total_token_usage'), '`token_count` belongs on a header, not here');
  assert.ok(!text.includes('sandbox_policy'), '`turn_context` is configuration');
  assert.ok(!text.includes('task_started'), 'status is state, and state has no `seq`');
});

test('an unknown record type is warned about and ignored, never thrown', () => {
  const warnings: string[] = [];
  const { events } = mapLines(fixture('unknown.jsonl'), (message) => warnings.push(message));

  // One survivor: the user message with the unparseable timestamp — dropping a
  // real message over a bad clock would be worse than showing it at time 0.
  assert.deepEqual(kinds(events), ['user', 'tool_call', 'assistant']);
  assert.equal(events[0]?.kind === 'user' && events[0].at, 0);

  const call = events[1];
  assert.ok(call?.kind === 'tool_call');
  assert.equal(
    call.input,
    '{not json at all',
    'arguments that will not parse are shown as they are',
  );

  const future = events[2];
  assert.ok(future?.kind === 'assistant');
  assert.equal(future.phase, undefined, 'a phase from the future is dropped, not passed through');

  assert.ok(
    warnings.some((w) => w.includes('weather_forecast')),
    'a genuinely new record type is reported, so the operator learns the format moved',
  );
  assert.ok(warnings.some((w) => w.includes('a_payload_from_the_future')));
  assert.ok(warnings.some((w) => w.includes('quantum_tool_call')));
  assert.ok(warnings.some((w) => w.includes('without call_id')));
});

test('nothing in the format can make the mapper throw', () => {
  for (const record of [null, 42, 'text', [], {}, { type: 'event_msg' }, { payload: {} }]) {
    assert.doesNotThrow(() => mapRecord(record));
  }
  assert.doesNotThrow(() => mapLines(['', 'not json', '{"unclosed":']));
});

test('a huge tool result is capped rather than replayed in full', () => {
  const { events } = mapLines([
    JSON.stringify({
      timestamp: '2026-07-29T06:30:31.281Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_big',
        output: `Process exited with code 0\n${'x'.repeat(MAX_OUTPUT * 2)}`,
      },
    }),
  ]);
  const result = events[0];
  assert.ok(result?.kind === 'tool_result');
  assert.ok(result.output.length < MAX_OUTPUT * 1.1);
  assert.ok(result.output.endsWith('[truncated by tether]'));
});
