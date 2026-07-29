/**
 * The mapper, driven from real transcripts captured from Claude Code 2.1.220 —
 * see `fixtures/README.md` for how, and for why CI never runs a live agent.
 *
 * The load-bearing test is the last one: a record type tether has never seen must
 * cost the user detail and nothing else. The format will gain types before tether
 * learns about them, and a mapper that throws loses the session.
 */

import type { ConversationEvent } from '@tether/shared';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MAX_OUTPUT, mapLines, mapRecord } from './events.ts';
import { CAPTURED_VERSION } from './transcript.ts';

function fixture(name: string): string[] {
  const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return text.trim().split('\n');
}

const SESSION = fixture(`session-${CAPTURED_VERSION}.jsonl`);

function kinds(events: readonly ConversationEvent[]): string[] {
  return events.map((e) => e.kind);
}

test('a real session maps to the conversation the user had', () => {
  const warnings: string[] = [];
  const { events, version } = mapLines(SESSION, (message) => warnings.push(message));

  assert.equal(version, CAPTURED_VERSION, 'the fixture describes the version it came from');
  assert.deepEqual(warnings, [], 'nothing in a real session is unrecognised');

  // The prompt, the Read it caused, its result, the answer, then the compaction.
  assert.deepEqual(kinds(events), ['user', 'tool_call', 'tool_result', 'assistant', 'compaction']);

  const [user, call, result, answer, compaction] = events;
  assert.equal(
    user?.kind === 'user' && user.text,
    'Read note.txt with the Read tool and tell me in one short sentence what it says.',
  );
  assert.equal(call?.kind === 'tool_call' && call.tool, 'Read');
  assert.ok(call?.kind === 'tool_call' && (call.input as { file_path: string }).file_path);
  assert.equal(
    result?.kind === 'tool_result' && result.callId,
    call?.kind === 'tool_call' ? call.callId : undefined,
    'the result joins its call by id',
  );
  assert.equal(result?.kind === 'tool_result' && result.isError, false);
  assert.match(result?.kind === 'tool_result' ? result.output : '', /hello tether spike/);
  assert.match(answer?.kind === 'assistant' ? answer.text : '', /hello tether spike/);
  assert.equal(compaction?.kind === 'compaction' && compaction.trigger, 'manual');

  assert.ok(
    events.every((e) => e.at > Date.parse('2026-01-01')),
    'every event carries the record’s own timestamp',
  );
});

test('the noise Claude Code writes for itself is not conversation', () => {
  // The fixture holds attachments (skill listings, hook output, a file), the
  // compaction summary that is fed back to the model, and the `/compact` command
  // bookkeeping. None of it is something the user said or was told.
  const texts = mapLines(SESSION)
    .events.filter((e) => e.kind === 'user')
    .map((e) => e.text);
  assert.equal(texts.length, 1);
  assert.ok(!texts.some((t) => t.includes('<command-name>') || t.includes('local-command')));
});

test('a thinking block is presence, not content', () => {
  const { events } = mapLines(fixture(`thinking-${CAPTURED_VERSION}.jsonl`));
  assert.deepEqual(kinds(events), ['thinking']);
  assert.ok(events[0]?.kind === 'thinking' && events[0].id, 'it still has an id to render against');
  assert.ok(!('text' in (events[0] as object)), 'and no content, because there is none on disk');
});

test('an unknown record type is warned about and ignored, never thrown', () => {
  const warnings: string[] = [];
  const { events } = mapLines(fixture('unknown.jsonl'), (message) => warnings.push(message));

  assert.ok(
    warnings.some((w) => w.includes('weather-forecast')),
    `the unknown type is reported: ${warnings.join(' | ')}`,
  );
  // What survives: the text block beside the unknown one, the tool_result that
  // has an id to join on, and the message whose only fault was its timestamp.
  assert.deepEqual(kinds(events), ['assistant', 'tool_result', 'user']);
  assert.equal(events[1]?.kind === 'tool_result' && events[1].output, 'blocks, not a string');
  assert.equal(events[1]?.kind === 'tool_result' && events[1].isError, true);
  assert.equal(events[2]?.kind === 'user' && events[2].at, 0, 'an unparseable timestamp degrades');
});

test('nothing in the format can make the mapper throw', () => {
  for (const record of [null, 42, 'a string', [], {}, { type: 7 }, { type: 'user' }]) {
    assert.deepEqual(mapRecord(record).events, [], JSON.stringify(record));
  }
  assert.deepEqual(mapLines(['{not json', '']).events, []);
});

test('the ai-title record names the session', () => {
  const mapped = mapLines([
    JSON.stringify({ type: 'ai-title', aiTitle: 'tether spike', sessionId: 'x' }),
  ]);
  assert.equal(mapped.title, 'tether spike');
  assert.deepEqual(mapped.events, []);
});

test('a huge tool result is capped rather than replayed in full', () => {
  const { events } = mapLines([
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-07-29T04:53:44.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(MAX_OUTPUT * 2) }],
      },
    }),
  ]);
  const output = events[0]?.kind === 'tool_result' ? events[0].output : '';
  assert.ok(output.length < MAX_OUTPUT * 1.1);
  assert.match(output, /truncated by tether]$/);
});

test('a huge tool call input is capped the same way, with its shape kept', () => {
  const { events } = mapLines([
    JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      timestamp: '2026-07-29T04:53:44.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Write',
            input: { file_path: '/tmp/big.txt', content: 'x'.repeat(MAX_OUTPUT * 2) },
          },
        ],
      },
    }),
  ]);
  const input = events[0]?.kind === 'tool_call' ? (events[0].input as Record<string, string>) : {};
  assert.equal(input['file_path'], '/tmp/big.txt', 'the short fields are still there, unchanged');
  assert.ok(JSON.stringify(input).length < MAX_OUTPUT * 1.1);
  assert.match(input['content'] ?? '', /truncated by tether]$/);
});

test('two long fields of one input are each capped, not the second one starved', () => {
  const { events } = mapLines([
    JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      timestamp: '2026-07-29T04:53:44.000Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Edit',
            input: {
              file_path: '/tmp/big.txt',
              old_string: 'o'.repeat(MAX_OUTPUT * 2),
              new_string: 'n'.repeat(MAX_OUTPUT * 2),
            },
          },
        ],
      },
    }),
  ]);
  const input = events[0]?.kind === 'tool_call' ? (events[0].input as Record<string, string>) : {};

  assert.equal(input['file_path'], '/tmp/big.txt', 'a short field is never spent on a long one');
  for (const key of ['old_string', 'new_string']) {
    const text = input[key] ?? '';
    assert.ok(text.length > 1000, `${key} kept real content, not just a marker: ${text.length}`);
    assert.match(text, /truncated by tether]$/, `${key} says that it was cut`);
  }
  assert.ok(
    JSON.stringify(input).length < MAX_OUTPUT * 1.1,
    'and the whole input is still bounded by the one cap',
  );
});

test('a subagent’s own thread stays out of the main conversation', () => {
  const { events } = mapLines([
    JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      isSidechain: true,
      timestamp: '2026-07-29T04:53:44.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] },
    }),
  ]);
  assert.deepEqual(events, []);
});
