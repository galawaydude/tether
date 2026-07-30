import assert from 'node:assert/strict';
import test from 'node:test';

import { axesFor, choiceIn, composerHint, lowersBar, modeFailure } from './options.ts';
import { CODEX, DEFAULT_PROVIDER, PROVIDERS } from './providers.ts';

const axisIds = (provider: string) => axesFor(provider).map((axis) => axis.id);

test('each provider gets its own axes and none of the other’s', () => {
  // The whole point of the table. Claude Code takes its model and effort as
  // slash-command *arguments*; Codex takes neither and has a permissions picker
  // instead. A shared set would mean one of them showing a control its CLI does
  // not have.
  assert.deepEqual(axisIds(DEFAULT_PROVIDER), ['permission-mode', 'model', 'effort']);
  assert.deepEqual(axisIds(CODEX), ['permissions']);

  const claude = new Set(axisIds(DEFAULT_PROVIDER));
  for (const id of axisIds(CODEX)) assert.ok(!claude.has(id), `${id} on both providers`);
});

test('an axis a provider does not have is absent, not rendered dead', () => {
  // Each of these is a control the reference client shows and tether verified it
  // cannot drive: Claude Code's fast mode has no slash command and no other
  // mid-session mechanism, and Codex's model/effort picker is an account-driven
  // list where a digit selects whatever happens to sit at that position. None
  // may appear as a dropdown that does the wrong thing quietly.
  //
  // Claude Code's permission mode is deliberately *not* in this list any more:
  // it has no slash command either, but the mode is readable off the pane, so it
  // can be set and confirmed rather than guessed at.
  for (const absent of ['fast', 'thinking']) {
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
  const [, model, effort] = axesFor(DEFAULT_PROVIDER);
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
  // whole table exists to avoid. Each `via` has its own shape of "does
  // something": keystrokes to type, or a mode the server's enum will accept.
  for (const provider of [DEFAULT_PROVIDER, CODEX]) {
    for (const axis of axesFor(provider)) {
      assert.ok(axis.choices.length > 1, `${axis.id} is not a choice`);
      for (const choice of axis.choices) {
        if (axis.via === 'keys') {
          assert.ok((choice.keys ?? []).length > 0, `${axis.id}/${choice.value} sends nothing`);
          for (const key of choice.keys ?? []) assert.ok(key.length > 0);
        } else {
          // The value *is* the mode, so a stray `keys` here would be a second
          // mechanism firing behind the request.
          assert.equal(choice.keys, undefined, `${axis.id}/${choice.value} has stray keys`);
          assert.ok(MODES.includes(choice.value), `${choice.value} is not a settable mode`);
        }
      }
    }
  }
});

/**
 * The modes Claude Code's Shift+Tab cycle passes through, in its own
 * `--permission-mode` vocabulary — mirrored from the server's `MODES`, which is
 * what the route's enum is built from, because `@tether/shared` emits types and
 * no JavaScript. A drift here is a 400 rather than a wrong mode.
 */
const MODES = ['default', 'acceptEdits', 'plan', 'auto'];

test('the permission-mode axis offers only modes the cycle can reach', () => {
  const [modes] = axesFor(DEFAULT_PROVIDER);
  assert.equal(modes?.id, 'permission-mode');
  assert.equal(modes?.via, 'permission-mode');
  assert.deepEqual(
    modes?.choices.map((choice) => choice.value),
    MODES,
  );
  // Real `--permission-mode` values Shift+Tab never passes through, one of which
  // also needs a spawn flag. Offering either would be a control that cycles the
  // pane forever and gives up.
  const offered = new Set(modes?.choices.map((choice) => choice.value));
  for (const unreachable of ['dontAsk', 'bypassPermissions']) {
    assert.ok(!offered.has(unreachable), unreachable);
  }
});

test('a failed permission-mode request never implies the mode changed', () => {
  // The two failures are genuinely different and only one of them pressed a key,
  // so they may not collapse into one sentence.
  const nothing = modeFailure('unreadable', 'Plan only');
  assert.match(nothing, /nothing was changed/i);
  assert.match(nothing, /terminal/i);

  const maybe = modeFailure('not_confirmed', 'Plan only');
  assert.match(maybe, /could not confirm/i);
  assert.notEqual(nothing, maybe);

  // A third failure that pressed nothing, and it may not read as either of the
  // other two: a refused second attempt is a "try again", not a broken pane.
  const busy = modeFailure('busy', 'Plan only');
  assert.match(busy, /nothing was changed/i);
  assert.notEqual(busy, nothing);

  // Whatever the server says, and whatever it does not: no sentence here may
  // claim the mode was set, because the only evidence for that is a read the
  // server did not manage.
  for (const code of [
    'unreadable',
    'not_confirmed',
    'busy',
    'session_dead',
    'wrong_provider',
    '',
  ]) {
    const said = modeFailure(code, 'Decide for me');
    assert.doesNotMatch(said, /\bis now\b|\bset to\b|\bchanged to\b/i, code);
    assert.ok(said.length > 20, code);
  }
});

test('a cycle that stalled names the mode the pane was left in', () => {
  // Reaching `plan` passes *through* `acceptEdits`, so a `not_confirmed` can
  // leave the pane with the permission bar already lowered — in a mode the user
  // never chose and never saw the warning for. The server reads that off the
  // screen and sends it; a sentence that dropped it would leave the one fact
  // worth acting on unsaid.
  const said = modeFailure('not_confirmed', 'Plan only', { mode: 'acceptEdits' });
  // The menu's own word for it, not the server's identifier.
  assert.match(said, /Accept edits/);
  assert.match(said, /could not confirm/i);
  // Naming where it stopped is still not claiming it was set — the target is
  // named as unreached, and the landed mode as observed.
  assert.doesNotMatch(said, /\bis now\b|\bset to\b|\bchanged to\b/i);

  // "tether cannot say" is every other shape of body, and falls back to the
  // sentence that points at the terminal without naming anything.
  const blind = modeFailure('not_confirmed', 'Plan only');
  for (const body of [null, {}, { mode: null }, { mode: '' }, { mode: 7 }, 'nope']) {
    assert.equal(modeFailure('not_confirmed', 'Plan only', body), blind, JSON.stringify(body));
  }
  // A mode this build has no label for is passed through as the server said it,
  // never dressed up as one of the four.
  assert.match(modeFailure('not_confirmed', 'Plan only', { mode: 'dontAsk' }), /dontAsk/);

  // Only the failure that pressed keys has anywhere to point: the other two
  // never touched the pane, so a landed mode there would be a claim about a
  // read that did not happen.
  for (const code of ['unreadable', 'busy']) {
    assert.equal(
      modeFailure(code, 'Plan only', { mode: 'acceptEdits' }),
      modeFailure(code, 'Plan only'),
      code,
    );
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

  // Claude Code's model and effort are cost and speed, so nothing on them is
  // gated — a warning on a cheap choice teaches a user to click past the ones
  // that matter.
  const [, model, effort] = axesFor(DEFAULT_PROVIDER);
  for (const axis of [model!, effort!]) {
    for (const choice of axis.choices) assert.equal(lowersBar(choice), null);
  }

  // Its permission mode is the opposite, and gets the same treatment as Codex's
  // presets: `acceptEdits` stops it asking before it writes, `auto` hands the
  // prompts to a model. Both are reachable in one tap from the composer, so both
  // say so first.
  const [modes] = axesFor(DEFAULT_PROVIDER);
  for (const value of ['acceptEdits', 'auto']) {
    const advice = lowersBar(choiceIn(modes!, value)!);
    assert.ok(advice !== null, `${value} lowers the bar silently`);
    assert.ok(advice!.length > 40, `${value} says too little to be a warning`);
  }
  // `plan` makes the agent do less, not more, and `default` is the baseline.
  for (const value of ['default', 'plan']) {
    assert.equal(lowersBar(choiceIn(modes!, value)!), null, value);
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
  assert.equal(composerHint('Codex'), 'Message Codex — / commands');
  assert.match(composerHint('Claude Code'), /^Message Claude Code — /);
  // A textarea is one row until it is typed in, so a placeholder that wraps at
  // 360px loses its second half. This is that width budget, checked in
  // characters because that is the part logic can see — the pixels are
  // `e2e/options.spec.ts`'s job.
  for (const provider of PROVIDERS) {
    assert.ok(composerHint(provider.label).length <= 32, `${provider.label} placeholder is long`);
  }
});
