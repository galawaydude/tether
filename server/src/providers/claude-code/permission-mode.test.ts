/**
 * The parse is pure and gets ordinary unit tests. The *driver* is tested against
 * a real tmux running a stub that behaves the way Claude Code's footer does —
 * because what is being asserted is that pressing Shift+Tab and reading the
 * screen back converge, and a mocked pane would agree with whatever this module
 * already believes.
 *
 * The footer strings are copied from a live Claude Code 2.1.220 pane, captured
 * while cycling through all four modes, with the mapping cross-checked against
 * the `permission_mode` field on that session's own `UserPromptSubmit` and
 * `PreToolUse` hook payloads.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { capturePlainViewport, killServer, newSession } from '../../machine/tmux.ts';
import {
  MODES,
  isPermissionMode,
  readPermissionMode,
  setPermissionMode,
} from './permission-mode.ts';

/** Exactly as `capture-pane` returned them, footer glyphs included. */
const FOOTERS: Record<string, string> = {
  default: '  ⏸ manual mode on · ? for shortcuts · ← for agents',
  acceptEdits: '  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents',
  plan: '  ⏸ plan mode on (shift+tab to cycle) · ← for agents',
  auto: '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
};

test('every mode the footer names is read back as the CLI’s own word for it', () => {
  // The pane says "manual"; `--permission-mode`, the hook payload and the
  // transcript record all say `default`. Getting that mapping wrong would send
  // the cycle off by one for every user.
  for (const [mode, footer] of Object.entries(FOOTERS)) {
    assert.equal(readPermissionMode(`some earlier output\n${footer}`), mode);
  }
  assert.deepEqual([...MODES].sort(), Object.keys(FOOTERS).sort());
});

test('the footer is the last line, so the agent’s own words are not it', () => {
  // An agent that writes about plan mode, or pastes a transcript of one, must
  // not move the control. Only the final line is Claude Code's own chrome.
  const pane = ['I will switch to plan mode on your say-so', FOOTERS['auto'] as string].join('\n');
  assert.equal(readPermissionMode(pane), 'auto');

  // Trailing blank lines are the ordinary shape of a captured pane.
  assert.equal(readPermissionMode(`${FOOTERS['plan'] as string}\n\n\n`), 'plan');
});

test('anything not recognised is “tether cannot say”, never a guess', () => {
  // A pane mid-repaint, a different agent, a future footer wording. Each of
  // these has to disable the control rather than move the permission posture to
  // somewhere nobody chose.
  assert.equal(readPermissionMode(''), undefined);
  assert.equal(readPermissionMode('\n\n'), undefined);
  assert.equal(readPermissionMode('$ '), undefined);
  assert.equal(readPermissionMode('  ⏸ careful mode on · ? for shortcuts'), undefined);
  // Two readings on one line is not a reading.
  assert.equal(readPermissionMode('plan mode on / auto mode on'), undefined);
});

test('only the four modes the cycle reaches are accepted', () => {
  for (const mode of MODES) assert.ok(isPermissionMode(mode));
  // Real `--permission-mode` values that Shift+Tab never passes through, so the
  // control may not offer them and the route may not take them.
  for (const other of ['dontAsk', 'bypassPermissions', 'manual', '', 'DEFAULT']) {
    assert.ok(!isPermissionMode(other), other);
  }
  assert.ok(!isPermissionMode(undefined));
});

/**
 * A pane that behaves like Claude Code's footer: it prints a status line, and
 * every Shift+Tab advances it one place around the cycle and reprints. Nothing
 * about tether's own belief is baked in — the stub owns the order, so a driver
 * that assumed one would fail here.
 */
const STUB = `
const cycle = ${JSON.stringify(Object.values(FOOTERS))};
let at = 0;
const draw = () => process.stdout.write('\\u001b[2J\\u001b[H' + 'working\\n' + cycle[at] + '\\n');
draw();
process.stdin.setRawMode?.(true);
process.stdin.on('data', (buffer) => {
  // Shift+Tab is CSI Z; anything else is ordinary typing and moves nothing.
  if (buffer.includes('[Z')) { at = (at + 1) % cycle.length; draw(); }
});
`;

async function pane(t: TestContext): Promise<{ socket: string; name: string }> {
  const socket = `tether-mode-${randomUUID().slice(0, 8)}`;
  const dir = await mkdtemp(join(tmpdir(), 'tether-mode-'));
  const script = join(dir, 'stub.mjs');
  await writeFile(script, STUB);
  await chmod(script, 0o755);
  // The session runs in a temp directory, so the confinement gate is widened
  // rather than bypassed — the same rule every other tmux test here follows.
  const previous = process.env['TETHER_ALLOWED_ROOTS'];
  process.env['TETHER_ALLOWED_ROOTS'] = dir;
  const name = `mode-${randomUUID().slice(0, 8)}`;
  await newSession(socket, { name, cwd: dir, command: ['node', script] });
  t.after(async () => {
    process.env['TETHER_ALLOWED_ROOTS'] = previous;
    await killServer(socket);
    await rm(dir, { recursive: true, force: true });
  });
  // The stub's first paint has to be on screen before anything reads it.
  for (let i = 0; i < 50; i += 1) {
    if (readPermissionMode(await capturePlainViewport(socket, name)) !== undefined) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { socket, name };
}

test('it reaches every mode from every mode, and says what it confirmed', async (t) => {
  const { socket, name } = await pane(t);

  // Every ordered pair, so a driver that only ever works forwards — or that
  // happens to be right for one starting point — cannot pass.
  for (const from of MODES) {
    for (const to of MODES) {
      const start = await setPermissionMode(socket, name, from);
      assert.equal(start.ok, true, `could not reach ${from}`);

      const result = await setPermissionMode(socket, name, to);
      assert.deepEqual(result, { ok: true, mode: to, changed: from !== to });
      // The claim is checked against the pane itself, not against the return
      // value that just made it.
      assert.equal(readPermissionMode(await capturePlainViewport(socket, name)), to);
    }
  }
});

test('a second attempt on one pane is refused, not interleaved into the first', async (t) => {
  const { socket, name } = await pane(t);
  await setPermissionMode(socket, name, 'default');

  // Two concurrent read-press-reads on one pane press *between* each other's
  // read and read-back, so both confirm a mode the other one cycled into and
  // both return `ok` — and whichever the browser renders last claims a mode the
  // pane is no longer in, which is the one thing this axis exists not to do.
  const [first, second] = await Promise.all([
    setPermissionMode(socket, name, 'plan'),
    setPermissionMode(socket, name, 'auto'),
  ]);
  assert.deepEqual(second, { ok: false, reason: 'busy' });
  assert.deepEqual(first, { ok: true, mode: 'plan', changed: true });
  // The pane agrees with the one that ran, and the refused one pressed nothing.
  assert.equal(readPermissionMode(await capturePlainViewport(socket, name)), 'plan');

  // And the gate is released, not sticky: the next attempt is an ordinary one.
  assert.deepEqual(await setPermissionMode(socket, name, 'auto'), {
    ok: true,
    mode: 'auto',
    changed: true,
  });
});

test('a pane that does not say is left alone and reported, not guessed at', async (t) => {
  const socket = `tether-mode-${randomUUID().slice(0, 8)}`;
  const dir = await mkdtemp(join(tmpdir(), 'tether-mode-'));
  const previous = process.env['TETHER_ALLOWED_ROOTS'];
  process.env['TETHER_ALLOWED_ROOTS'] = dir;
  const name = `mode-${randomUUID().slice(0, 8)}`;
  // A pane with no footer at all — the shape of a different agent, or of Claude
  // Code before its first paint.
  await newSession(socket, { name, cwd: dir, command: ['node', '-e', 'setTimeout(()=>{},9e5)'] });
  t.after(async () => {
    process.env['TETHER_ALLOWED_ROOTS'] = previous;
    await killServer(socket);
    await rm(dir, { recursive: true, force: true });
  });

  assert.deepEqual(await setPermissionMode(socket, name, 'plan'), {
    ok: false,
    reason: 'unreadable',
  });
});

test('a pane that is gone is unreadable, not an exception carrying tether’s argv', async (t) => {
  const { socket, name } = await pane(t);
  // Established by killing a real Claude Code pane under a real `tether serve`:
  // `capture-pane` exits non-zero, and left to propagate that became a 500 whose
  // body was the whole tmux command line — an error surface that says nothing a
  // user can act on and leaks tether's own paths to whoever provoked it.
  await killServer(socket);

  assert.deepEqual(await setPermissionMode(socket, name, 'plan'), {
    ok: false,
    reason: 'unreadable',
  });
  // And the read on its own says the same, rather than throwing into a caller
  // that has no better answer than this one.
  assert.equal(await capturePlainViewport(socket, name).catch(() => 'threw'), 'threw');
});
