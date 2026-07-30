import assert from 'node:assert/strict';
import test from 'node:test';

import { axesFor, choiceIn, composerHint, lowersBar } from './options.ts';
import { CODEX, DEFAULT_PROVIDER } from './providers.ts';

const axisIds = (provider: string) => axesFor(provider).map((axis) => axis.id);

test('each provider gets its own axes and none of the other’s', () => {
  // The whole point of the table. Claude Code takes its model and effort as
  // slash-command *arguments*; Codex takes neither and has a permissions picker
  // instead. A shared set would mean one of them showing a control its CLI does
  // not have.
  assert.deepEqual(axisIds(DEFAULT_PROVIDER), ['model', 'effort']);
  assert.deepEqual(axisIds(CODEX), ['permissions']);

  const claude = new Set(axisIds(DEFAULT_PROVIDER));
  for (const id of axisIds(CODEX)) assert.ok(!claude.has(id), `${id} on both providers`);
});

test('an axis a provider does not have is absent, not rendered dead', () => {
  // Each of these is a control the reference client shows and tether verified it
  // cannot drive: Claude Code's permission mode is a blind Shift+Tab cycle whose
  // current position tether cannot read, its fast mode has no slash command, and
  // Codex's model/effort picker is an account-driven list where a digit is a
  // guess. None may appear as a dropdown that does the wrong thing quietly.
  for (const absent of ['permission-mode', 'fast', 'thinking']) {
    assert.ok(!axisIds(DEFAULT_PROVIDER).includes(absent));
  }
  for (const absent of ['model', 'effort', 'fast']) {
    assert.ok(!axisIds(CODEX).includes(absent));
  }
});

test('a provider this build has not heard of offers nothing at all', () => {
  // Same rule as every other unknown in the web app: show what is known. An
  // invented control would send keystrokes into a TUI nobody has established
  // the vocabulary of.
  assert.deepEqual(axesFor('some-future-agent'), []);
  assert.deepEqual(axesFor(''), []);
});

test('applying a choice sends keystrokes a running pane really takes', () => {
  const [model, effort] = axesFor(DEFAULT_PROVIDER);
  // Verified live against Claude Code 2.1.220: the pane answers `Set model to
  // Sonnet 5` and `Set effort level to medium`, and both land in the transcript.
  assert.deepEqual(choiceIn(model!, 'sonnet')?.keys, ['/model sonnet']);
  assert.deepEqual(choiceIn(effort!, 'medium')?.keys, ['/effort medium']);

  // Verified live against codex-cli 0.145.0: `/permissions` opens a fixed
  // three-item picker and the digit applies immediately — `Permissions updated
  // to Approve for me`. Two frames, in this order.
  const [permissions] = axesFor(CODEX);
  assert.deepEqual(choiceIn(permissions!, 'ask')?.keys, ['/permissions', '1']);
  assert.deepEqual(choiceIn(permissions!, 'full')?.keys, ['/permissions', '3']);

  // Nothing may be a control that sends nothing, which is the failure this
  // whole table exists to avoid.
  for (const provider of [DEFAULT_PROVIDER, CODEX]) {
    for (const axis of axesFor(provider)) {
      assert.ok(axis.choices.length > 1, `${axis.id} is not a choice`);
      for (const choice of axis.choices) {
        assert.ok(choice.keys.length > 0, `${axis.id}/${choice.value} sends nothing`);
        for (const key of choice.keys) assert.ok(key.length > 0);
      }
    }
  }
});

test('a value that lowers the permission bar states what it means first', () => {
  const [permissions] = axesFor(CODEX);
  // Both of Codex's non-default presets stop it asking — `Approve for me` hands
  // the decision to its own reviewer, `Full access` removes it entirely — so
  // both carry the sentence, and neither may be applied before it is read.
  for (const value of ['auto', 'full']) {
    const advice = lowersBar(choiceIn(permissions!, value)!);
    assert.ok(advice !== null, `${value} lowers the bar silently`);
    assert.ok(advice!.length > 40, `${value} says too little to be a warning`);
  }
  // The default asks for everything, so there is nothing to warn about and a
  // warning there would teach a user to click past the ones that matter.
  assert.equal(lowersBar(choiceIn(permissions!, 'ask')!), null);

  // Claude Code's are cost and speed, not permission. `dontAsk` and
  // `bypassPermissions` are the two that would belong here and neither is
  // reachable from a running pane, so nothing on that provider is gated.
  for (const axis of axesFor(DEFAULT_PROVIDER)) {
    for (const choice of axis.choices) assert.equal(lowersBar(choice), null);
  }
});

test('no control on this screen is named “Message” or “Agent”', () => {
  // Playwright's `getByLabel` matches on a substring, and both of those words
  // already name something here — the composer's own textarea, and the provider
  // picker in the New session sheet. A control carrying either takes existing
  // specs down rather than failing its own.
  for (const provider of [DEFAULT_PROVIDER, CODEX]) {
    for (const axis of axesFor(provider)) {
      assert.doesNotMatch(axis.label, /message|agent/i);
      for (const choice of axis.choices) assert.doesNotMatch(choice.label, /message|agent/i);
    }
  }
});

test('the placeholder teaches, and names the agent that is running', () => {
  assert.equal(composerHint('Codex'), 'Message Codex — / for its commands, Enter for a new line');
  // The Enter rule is the one a phone user discovers by losing a half-written
  // prompt, so it is the one the placeholder spends its words on.
  assert.match(composerHint('Claude Code'), /Enter for a new line/);
});
