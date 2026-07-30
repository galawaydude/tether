import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commandsFor,
  matchCommands,
  MATCH_LIMIT,
  planSend,
  whereLabel,
  type Command,
} from './commands.ts';
import { sendBlocked } from './conversation.ts';
import { CODEX, DEFAULT_PROVIDER } from './providers.ts';

const names = (provider: string) => commandsFor(provider).map((command) => command.name);
const find = (provider: string, name: string): Command => {
  const command = commandsFor(provider).find((entry) => entry.name === name);
  assert.ok(command !== undefined, `${name} missing from ${provider}`);
  return command;
};

test('a leading slash routes as a command and ordinary text does not', () => {
  assert.equal(planSend(DEFAULT_PROVIDER, 'fix the flaky test').plan, 'message');
  // Not a command in the middle of a line, and not one in a code fence: both
  // CLIs lex their own input box the same way, so what tether does with a line
  // is what typing it into the pane would have done.
  assert.equal(planSend(DEFAULT_PROVIDER, 'run /resume for me').plan, 'message');
  assert.equal(planSend(DEFAULT_PROVIDER, '/resume').plan, 'command');
  assert.equal(planSend(DEFAULT_PROVIDER, '/model sonnet').plan, 'command');
  // A bare slash is what a user has typed on the way to a command, with the list
  // showing under it. Sending it would only make the pane say `Unknown command`.
  assert.equal(planSend(DEFAULT_PROVIDER, '/').plan, 'message');
});

test('a command is sent verbatim — there is no protocol here', () => {
  // The whole mechanism: text on the terminal socket, exactly as the user typed
  // it. A command tether rewrote would be a command the pane did not receive.
  const plan = planSend(DEFAULT_PROVIDER, '/resume');
  assert.equal(plan.plan === 'command' && plan.send, '/resume');
  const args = planSend(DEFAULT_PROVIDER, '/model  sonnet');
  assert.equal(args.plan === 'command' && args.send, '/model  sonnet');
});

test('each provider gets its own command set and not the other’s', () => {
  // Established by driving the installed CLIs, not assumed. The sets overlap by
  // name and diverge on behaviour, which is why they are two tables.
  assert.ok(names(DEFAULT_PROVIDER).includes('/effort'));
  assert.ok(!names(CODEX).includes('/effort'));
  assert.ok(names(CODEX).includes('/permissions'));
  assert.ok(!names(DEFAULT_PROVIDER).includes('/permissions'));
  assert.ok(names(CODEX).includes('/plan'));
  assert.ok(!names(DEFAULT_PROVIDER).includes('/plan'));

  // `/cost` is Claude Code's; typing it at Codex is an unrecognised command, and
  // the note has to say tether cannot vouch for it rather than describing it.
  const foreign = planSend(CODEX, '/cost');
  assert.equal(foreign.plan, 'command');
  assert.match(foreign.plan === 'command' ? foreign.note : '', /does not know this command/);
});

test('a provider this build has not heard of gets no commands and no claims', () => {
  assert.deepEqual(commandsFor('some-future-agent'), []);
  // Still sent — the table is not the authority on what a CLI accepts — but
  // nothing is claimed about it, and the terminal is offered.
  const plan = planSend('some-future-agent', '/resume');
  assert.equal(plan.plan, 'command');
  assert.ok(plan.plan === 'command' && plan.hatch);
});

test('an unverifiable send reports rather than claiming success', () => {
  // Three kinds of "tether cannot show you this", and none of them may read as
  // done. Each says where the answer actually is and offers the way there.
  const picker = planSend(DEFAULT_PROVIDER, '/resume');
  assert.ok(picker.plan === 'command' && picker.hatch);
  assert.match(picker.plan === 'command' ? picker.note : '', /chooser tether cannot show/);

  const pane = planSend(DEFAULT_PROVIDER, '/cost');
  assert.ok(pane.plan === 'command' && pane.hatch);
  assert.match(pane.plan === 'command' ? pane.note : '', /terminal only/);

  const unknown = planSend(DEFAULT_PROVIDER, '/nobodys-command');
  assert.ok(unknown.plan === 'command' && unknown.hatch);
  assert.match(unknown.plan === 'command' ? unknown.note : '', /cannot say what it did/);

  // And the case that *can* be shown says so instead, with no terminal button:
  // `/model sonnet` writes `<local-command-stdout>` and the mapper now renders
  // it, so the conversation is the evidence.
  const shown = planSend(DEFAULT_PROVIDER, '/model sonnet');
  assert.ok(shown.plan === 'command' && !shown.hatch);
  assert.match(shown.plan === 'command' ? shown.note : '', /lands above/);
});

test('every note names the command it is about', () => {
  // A status line that says "Sent." while the box has been cleared is a line the
  // user cannot check. Each one repeats the command back.
  for (const message of ['/resume', '/cost', '/model sonnet', '/nobodys-command']) {
    const plan = planSend(DEFAULT_PROVIDER, message);
    assert.ok(plan.plan === 'command' && plan.note.includes(message), message);
  }
});

test('a Codex command that takes no argument is refused, not paid for', () => {
  // Verified by PR #25 at the cost of a turn: Codex's slash commands take no
  // argument, so `/model gpt-5.6-terra` reaches the *model* as a prompt and the
  // model answers that it cannot switch itself. Nothing is sent.
  const refused = planSend(CODEX, '/model gpt-5.6-terra');
  assert.equal(refused.plan, 'refuse');
  assert.match(refused.plan === 'refuse' ? refused.note : '', /as a prompt/);

  // The bare form of the same command is fine, and opens the picker.
  assert.equal(planSend(CODEX, '/model').plan, 'command');

  // Codex's `/resume` is the exception and really does take a search term —
  // verified: `/resume nothinghere` answers `No saved chat found matching`.
  assert.equal(planSend(CODEX, '/resume nothinghere').plan, 'command');

  // Claude Code takes arguments on the same command, so the identical text is
  // not refused there. This is the one difference the two tables exist for.
  assert.equal(planSend(DEFAULT_PROVIDER, '/model sonnet').plan, 'command');
});

test('a command is refused while a permission prompt is open', () => {
  // The composer's own guard, unchanged and deliberately shared: text pasted at
  // a provider's permission dialog *answers the dialog*, and a slash command is
  // no less dangerous there than a prompt. `planSend` never sees these — the
  // composer checks `sendBlocked` first, for a command exactly as for a message.
  assert.equal(
    sendBlocked('waiting', '/resume', 'live'),
    'Answer the prompt in the terminal first.',
  );
  assert.equal(
    sendBlocked('waiting', 'ordinary text', 'live'),
    'Answer the prompt in the terminal first.',
  );
  // And a session nothing can reach refuses both too.
  assert.notEqual(sendBlocked('idle', '/resume', 'ended'), null);
  assert.notEqual(sendBlocked('idle', '/resume', 'gone'), null);
  // Busy is not refused: both CLIs queue a command typed mid-turn, which is the
  // most valuable thing a phone can do.
  assert.equal(sendBlocked('busy', '/resume', 'live'), null);
});

test('the list teaches what a slash means, and only while one is being typed', () => {
  // The placeholder says `/ commands` and cannot say *which*; this is which.
  assert.deepEqual(matchCommands(DEFAULT_PROVIDER, 'fix the test'), []);
  assert.equal(matchCommands(DEFAULT_PROVIDER, '/').length, MATCH_LIMIT);
  assert.deepEqual(
    matchCommands(DEFAULT_PROVIDER, '/re').map((command) => command.name),
    ['/resume', '/review'],
  );
  // Past the first space the user is writing an argument, not choosing a command.
  assert.deepEqual(matchCommands(DEFAULT_PROVIDER, '/model '), []);
  assert.deepEqual(matchCommands(DEFAULT_PROVIDER, '/model sonnet'), []);
  // A prefix nothing matches shows nothing rather than the whole list.
  assert.deepEqual(matchCommands(DEFAULT_PROVIDER, '/zzz'), []);
  // Each provider's own list, again.
  assert.deepEqual(
    matchCommands(CODEX, '/pe').map((command) => command.name),
    ['/permissions'],
  );
});

test('the list marks only the commands that answer where this pane cannot show', () => {
  // A badge on every row would make the two that matter invisible.
  assert.equal(whereLabel(find(DEFAULT_PROVIDER, '/resume')), 'asks in terminal');
  assert.equal(whereLabel(find(DEFAULT_PROVIDER, '/cost')), 'terminal only');
  assert.equal(whereLabel(find(DEFAULT_PROVIDER, '/compact')), '');
});

test('/clear says the terminal, although it is instant and dramatic', () => {
  // Verified on 2.1.220: `/clear` moves the pane to a new session id and a new
  // transcript file — the same behaviour `CLAUDE.md` records for `/resume` and
  // `--continue`. So there is no line to render saying it cleared, and claiming
  // the answer appears above would be claiming an empty screen is a confirmation.
  assert.equal(find(DEFAULT_PROVIDER, '/clear').answers, 'terminal');
});
