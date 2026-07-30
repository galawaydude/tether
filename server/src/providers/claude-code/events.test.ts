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

import { MAX_OUTPUT } from '../cap.ts';
import { mapHook, mapLines, mapRecord, NEVER_HELD } from './events.ts';
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

  // The prompt, the Read it caused, its result, the answer, the compaction, and
  // then the `/compact` that caused it: the command and the line it printed.
  assert.deepEqual(kinds(events), [
    'user',
    'tool_call',
    'tool_result',
    'assistant',
    'compaction',
    'command',
    'command',
  ]);

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
  // The fixture holds attachments (skill listings, hook output, a file) and the
  // compaction summary that is fed back to the model. None of it is something the
  // user said or was told.
  const texts = mapLines(SESSION)
    .events.filter((e) => e.kind === 'user')
    .map((e) => e.text);
  assert.equal(texts.length, 1);
  assert.ok(!texts.some((t) => t.includes('<command-name>') || t.includes('local-command')));
});

test('a slash command is what it ran and what it printed, and nothing else', () => {
  // The composer can send a slash command, so this record is the *only* evidence
  // outside the pane that one landed — which is why it stopped being dropped.
  // `<command-message>` is the command's display name and `<local-command-caveat>`
  // is addressed to the model: neither is conversation, and neither survives.
  const commands = mapLines(SESSION).events.filter((e) => e.kind === 'command');
  assert.deepEqual(
    commands.map((e) => [e.text, e.output === true]),
    [
      ['/compact', false],
      ['Compacted (ctrl+o to see full summary)', true],
    ],
  );
  for (const command of commands) {
    assert.ok(!command.text.includes('<'), `a tag survived into ${command.text}`);
  }
});

test('a command’s argument is part of the command, whichever order the tags come in', () => {
  // Verified on 2.1.220 by running both: `/model` writes `<command-name>` then
  // `<command-message>` then `<command-args>`, and `/init` writes
  // `<command-message>` *first*. Matching each tag on its own rather than by
  // position is what makes one code path cover both.
  const args = (content: string): string =>
    mapRecord({ type: 'user', uuid: 'u', message: { role: 'user', content } })
      .events.map((e) => (e.kind === 'command' ? e.text : ''))
      .join('');

  assert.equal(
    args(
      '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>',
    ),
    '/model sonnet',
  );
  assert.equal(
    args('<command-message>init</command-message>\n<command-name>/init</command-name>'),
    '/init',
  );
  // An empty `<command-args>` is how a no-argument command is recorded.
  assert.equal(
    args('<command-name>/compact</command-name>\n<command-args></command-args>'),
    '/compact',
  );
  // Bookkeeping on its own is still dropped.
  assert.equal(args('<command-message>init</command-message>'), '');
  assert.equal(args('<local-command-caveat>Caveat: …</local-command-caveat>'), '');
  assert.equal(args('<local-command-stdout></local-command-stdout>'), '');
});

test('Claude Code’s own colour codes do not reach the browser', () => {
  // `/model sonnet` really writes `Set model to \x1b[1mSonnet 5\x1b[22m …` — the
  // name is bold on the way to a terminal. The browser is not one, so an SGR
  // sequence left in would show up as a literal `[1m` in the page.
  const { events } = mapRecord({
    type: 'user',
    uuid: 'u',
    message: {
      role: 'user',
      content: '<local-command-stdout>Set model to \x1b[1mSonnet 5\x1b[22m</local-command-stdout>',
    },
  });
  assert.deepEqual(
    events.map((e) => (e.kind === 'command' ? e.text : e.kind)),
    ['Set model to Sonnet 5'],
  );
});

test('what a command printed is capped like any other provider output', () => {
  // `/context` prints a screenful and a custom command is free to pipe a whole
  // `git log -p` through one, so this is the same invariant `cap.ts` states for a
  // tool result: the terminal is the full-fidelity view, and a card may not put
  // megabytes in the replay buffer and on the wire.
  const { events } = mapRecord({
    type: 'user',
    uuid: 'u',
    message: {
      role: 'user',
      content: `<local-command-stdout>${'x'.repeat(MAX_OUTPUT * 2)}</local-command-stdout>`,
    },
  });
  const text = events[0]?.kind === 'command' ? events[0].text : '';
  assert.ok(text.length < MAX_OUTPUT * 1.1, `uncapped at ${text.length} characters`);
  assert.match(text, /truncated by tether/);
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

/**
 * The hook payloads, from a real permission prompt. Captured while a `Write` was
 * on screen waiting to be approved — the moment report §4 says the transcript
 * cannot describe.
 */
const HOOKS = fixture(`hooks-${CAPTURED_VERSION}.ndjson`).map(
  (line) => JSON.parse(line) as unknown,
);

function hooksOf(name: string): unknown[] {
  return HOOKS.filter((h) => (h as { hook_event_name?: string }).hook_event_name === name);
}

/** By tool rather than by position: the fixture's order is the session's, not a contract. */
function preToolUse(tool: string): unknown {
  const found = hooksOf('PreToolUse').find((h) => (h as { tool_name?: string }).tool_name === tool);
  assert.ok(found, `the fixture has a ${tool} PreToolUse`);
  return found;
}

test('a real PreToolUse becomes the tool card the transcript has not written yet', () => {
  const warnings: string[] = [];
  const signal = mapHook(preToolUse('Write'), (m) => warnings.push(m), 1234);

  assert.deepEqual(warnings, []);
  assert.deepEqual(signal, {
    signal: 'pending',
    // A `Write` is not on the skip list, so tether may block the agent on it
    // while the user decides.
    hold: 'perhaps',
    e: {
      kind: 'tool_call',
      // Not a transcript uuid, and it must not look like one: this event never
      // enters the `seq` stream.
      id: 'pending:toolu_01RMgXSU9fEUYVSU1gccJJKQ',
      at: 1234,
      tool: 'Write',
      input: {
        file_path:
          '/tmp/claude-1000/-home-galawaydude--treehouse-tether-0d5314-5-tether/50041aee-df95-443c-86c4-1e37819eea10/scratchpad/hookspike/out.txt',
        content: 'hello\n',
      },
      callId: 'toolu_01RMgXSU9fEUYVSU1gccJJKQ',
    },
  });
});

test('a read-only tool is proposed but not worth stopping the agent for', () => {
  // The reason this list exists at all: `PreToolUse` fires for *every* call and
  // nothing in the payload says whether Claude Code was going to prompt about it
  // (verified on 2.1.220 — an auto-allowed Read produces the same hook as a Bash
  // that opens a dialog). Holding a burst of reads is how a phone in hand would
  // make the agent crawl.
  const bash = mapHook({ ...(preToolUse('Bash') as object) });
  // `perhaps`, not `prompting`: Claude Code has not said it is about to ask.
  assert.equal(bash?.signal === 'pending' && bash.hold, 'perhaps');

  for (const tool of NEVER_HELD) {
    const signal = mapHook({
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_use_id: 'toolu_read',
      tool_input: {},
    });
    assert.equal(signal?.signal === 'pending' && signal.hold, 'never', tool);
  }

  // A tool this build has never heard of — an MCP server's, or next month's — is
  // held. Those are the ones that prompt, and a missing button costs the whole
  // feature where a needless hold costs one timeout.
  const unknown = mapHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__acme__deploy',
    tool_use_id: 'toolu_mcp',
    tool_input: {},
  });
  assert.equal(unknown?.signal === 'pending' && unknown.hold, 'perhaps');
});

test('a real Notification is the waiting state, in Claude Code’s own words', () => {
  const warnings: string[] = [];
  assert.deepEqual(
    mapHook(hooksOf('Notification')[0], (m) => warnings.push(m)),
    {
      signal: 'waiting',
      detail: 'Claude needs your permission',
    },
  );
  assert.deepEqual(warnings, []);
});

test('a tool_use_id joins the hook to the transcript record that follows it', () => {
  // The same call, from both sources. This is the whole reconciliation contract:
  // if these two ever stop agreeing, the optimistic card duplicates instead of
  // being replaced.
  const hook = mapHook(preToolUse('Write'));
  assert.equal(hook?.signal, 'pending');
  const fromTranscript = mapLines(SESSION).events.find((e) => e.kind === 'tool_call');
  assert.ok(fromTranscript, 'the fixture session has a tool call to compare the shape against');
  assert.deepEqual(Object.keys(hook.e).sort(), Object.keys(fromTranscript).sort());
});

test('a hook event this build does not know is one warning and nothing else', () => {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  assert.equal(mapHook({ hook_event_name: 'PreCompact' }, warn), undefined);
  assert.equal(mapHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, warn), undefined);
  assert.equal(mapHook('not an object', warn), undefined);
  assert.equal(mapHook(null, warn), undefined);
  assert.deepEqual(warnings, [
    'unknown hook event PreCompact',
    'PreToolUse hook without tool_name or tool_use_id',
    'hook payload is not an object',
    'hook payload is not an object',
  ]);
});

test('a huge tool input is capped the same way the transcript’s is', () => {
  const signal = mapHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_use_id: 'toolu_x',
    tool_input: { content: 'x'.repeat(MAX_OUTPUT * 2) },
  });
  assert.equal(signal?.signal, 'pending');
  const input = signal.e.input as { content: string };
  assert.ok(input.content.length < MAX_OUTPUT * 2);
  assert.match(input.content, /truncated by tether/);
});
