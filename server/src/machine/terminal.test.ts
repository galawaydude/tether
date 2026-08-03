/**
 * The exactness test from report section 3, against a real tmux and a real
 * `@xterm/headless`.
 *
 * This is the test the product rests on. tether promises that reconnecting loses
 * and duplicates nothing; if that is false the failure is a single missing line,
 * which is invisible until someone notices their conversation is wrong. The
 * spike's first run of this test failed at `scrollback_rows_reconstructed=299`
 * out of 300.
 *
 * The pane is filled with box-drawing glyphs at exactly the pane width. Three
 * bytes per glyph and 80 of them per row guarantees that a UTF-8 character is
 * split across a PTY chunk boundary, which is the only way to catch a path that
 * decodes somewhere in the middle. A mostly-ASCII pane passes on a broken build.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import type { Terminal as XTerminal } from '@xterm/headless';

import { createTerminals, directKeyBytes } from './terminal.ts';
import type { Terminals } from './terminal.ts';
import {
  killServer,
  killSession,
  newSession,
  paneSize,
  pasteText,
  resizeWindow,
  sendKeys,
  tmuxArgv,
} from './tmux.ts';

const execFileAsync = promisify(execFile);

// `@xterm/headless` ships a CommonJS bundle whose named exports node's ESM
// loader cannot see, though its typings declare them.
const { Terminal } = createRequire(import.meta.url)(
  '@xterm/headless',
) as typeof import('@xterm/headless');

const COLS = 80;
const ROWS = 10;
const CONTENT_LINES = 300;

function socketFor(t: TestContext): string {
  const socket = `tether-term-${randomUUID().slice(0, 8)}`;
  t.after(async () => {
    await killServer(socket);
    await rm(join(tmpdir(), `tmux-${process.getuid?.() ?? ''}`, socket), { force: true });
  });
  return socket;
}

function terminalsFor(t: TestContext, socket: string): Terminals {
  const terminals = createTerminals(socket, 10_000);
  t.after(() => terminals.closeAll());
  return terminals;
}

/** Ground truth: everything tmux holds for the pane, scrollback and viewport. */
async function truthRows(socket: string, session: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'tmux',
    tmuxArgv(socket, ['capture-pane', '-p', '-S', '-', '-t', session]),
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return trimTrailingBlanks(stdout.replace(/\n$/, '').split('\n'));
}

function trimTrailingBlanks(rows: readonly string[]): string[] {
  const out = [...rows];
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

function screenRows(term: XTerminal): string[] {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let i = 0; i < buffer.baseY + term.rows; i++) {
    rows.push(buffer.getLine(i)?.translateToString(true) ?? '');
  }
  return trimTrailingBlanks(rows);
}

/** How many times each distinct row appears — a lost or doubled line shows here. */
function multiplicity(rows: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row, (counts.get(row) ?? 0) + 1);
  return counts;
}

/**
 * A pane of `CONTENT_LINES` rows, each exactly `COLS` columns wide and mostly
 * box-drawing glyphs, plus a colour run so the `-e` capture carries real SGR.
 */
async function fillPane(socket: string, session: string, cwd: string): Promise<void> {
  const bar = '─'.repeat(COLS - 'LINE-000 '.length);
  await writeFile(
    join(cwd, 'gen.sh'),
    `i=1
while [ $i -le ${CONTENT_LINES} ]; do
  printf '\\033[3%dmLINE-%03d ${bar}\\033[0m\\n' $((i % 8)) $i
  i=$((i + 1))
done
`,
    'utf8',
  );
  await pasteText(socket, session, 'sh gen.sh');
  await sendKeys(socket, session, ['Enter']);
  await waitFor(
    async () =>
      (await truthRows(socket, session)).some((r) => r.startsWith(`LINE-${CONTENT_LINES}`)),
    'the generated pane content',
  );
}

async function waitFor(predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function startSession(t: TestContext, socket: string, name: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'tether-term-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  // The temp dir is outside the default roots, so it is passed as the root here.
  await newSession(socket, { name, cwd, command: ['/bin/sh'], roots: [cwd] });
  // Before any output: resizing afterwards would reflow what is already there.
  await resizeWindow(socket, name, COLS, ROWS);
  return cwd;
}

/**
 * Replay one attach into a fresh emulator, exactly as the browser would: binary
 * frames straight into `term.write(Uint8Array)`, nothing decoded on the way.
 */
async function reconstruct(terminals: Terminals, session: string): Promise<string[]> {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 10_000, allowProposedApi: true });
  let pending = 0;
  let quiet = 0;
  const detach = await terminals.attach(session, (bytes) => {
    assert.ok(bytes instanceof Uint8Array, 'the terminal channel is binary');
    pending++;
    quiet = 0;
    term.write(bytes, () => pending--);
  });
  // The attach repaint arrives asynchronously; settle on silence rather than a
  // fixed sleep, then flush xterm's own write queue.
  while (quiet < 6 || pending > 0) {
    await delay(50);
    quiet++;
  }
  await new Promise<void>((resolve) => term.write('', resolve));
  detach();
  const rows = screenRows(term);
  term.dispose();
  return rows;
}

test('replay reconstructs the pane exactly, and re-attaching never duplicates', async (t) => {
  const socket = socketFor(t);
  const terminals = terminalsFor(t, socket);
  const cwd = await startSession(t, socket, 's1');
  await fillPane(socket, 's1', cwd);

  const truth = await truthRows(socket, 's1');
  assert.ok(
    truth.filter((r) => r.startsWith('LINE-')).length >= CONTENT_LINES,
    `expected at least ${CONTENT_LINES} content rows in the ground truth, got ${truth.length}`,
  );
  assert.ok(
    truth.some((r) => r.includes('─'.repeat(20))),
    'the ground truth pane contains non-ASCII glyphs',
  );

  // Three attaches in a row: one fresh, then two reconnects. A trailing newline
  // left in the capture shows up as one extra row per reconnect, so a single
  // attach would not catch it.
  for (const attempt of [1, 2, 3]) {
    const rows = await reconstruct(terminals, 's1');
    assert.deepEqual(
      multiplicity(rows),
      multiplicity(truth),
      `attach ${attempt}: rows with wrong multiplicity`,
    );
    assert.deepEqual(rows, truth, `attach ${attempt}: reconstruction is not byte-exact`);
  }
});

test('two viewers of one session share a PTY and both see the whole pane', async (t) => {
  const socket = socketFor(t);
  const terminals = terminalsFor(t, socket);
  const cwd = await startSession(t, socket, 's1');
  await fillPane(socket, 's1', cwd);
  const truth = await truthRows(socket, 's1');

  const first = new Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: 10_000,
    allowProposedApi: true,
  });
  const detachFirst = await terminals.attach('s1', (b) => first.write(b));
  t.after(() => detachFirst());

  // The second viewer joins an attach that already happened, so its repaint has
  // to be asked for rather than arriving free with `attach-session`.
  const second = await reconstruct(terminals, 's1');
  assert.deepEqual(second, truth, 'the second viewer sees the same pane as the first');

  await new Promise<void>((resolve) => first.write('', resolve));
  const clients = await execFileAsync(
    'tmux',
    tmuxArgv(socket, ['list-clients', '-t', 's1', '-F', '#{client_tty}']),
    { encoding: 'utf8' },
  );
  assert.equal(
    clients.stdout.trim().split('\n').filter(Boolean).length,
    1,
    'one attach PTY per session, not per viewer',
  );
  first.dispose();
});

test('resize moves the pane, and window-size manual keeps it off other sessions', async (t) => {
  const socket = socketFor(t);
  const terminals = terminalsFor(t, socket);
  await startSession(t, socket, 's1');
  await startSession(t, socket, 's2');

  const detach = await terminals.attach('s1', () => {});
  t.after(() => detach());

  await terminals.resize('s1', 100, 30);
  await waitFor(async () => {
    const size = await paneSize(socket, 's1');
    return size.cols === 100 && size.rows === 30;
  }, 's1 to resize');
  assert.deepEqual(await paneSize(socket, 's2'), { cols: COLS, rows: ROWS });

  // The real proof of `window-size manual`: a client of the wrong size attaching
  // does not drag the window with it. Without it, one phone reflows everybody.
  const { spawn } = await import('node-pty');
  const stray = spawn('tmux', tmuxArgv(socket, ['attach-session', '-t', 's2']), {
    name: 'xterm-256color',
    cols: 132,
    rows: 43,
    encoding: null,
  });
  t.after(() => stray.kill());
  await delay(500);
  assert.deepEqual(await paneSize(socket, 's2'), { cols: COLS, rows: ROWS });
});

test('ordinary control keys take the attach PTY fast path, and mode-dependent keys do not', () => {
  assert.equal(directKeyBytes(['Escape', 'Tab', 'BSpace', 'Enter', 'C-c']), '\x1b\t\x7f\r\x03');
  assert.equal(directKeyBytes(['Up']), undefined);
  assert.equal(directKeyBytes(['M-x']), undefined);
});

test('input is applied once: replays and out-of-order sequences are dropped', async (t) => {
  const socket = socketFor(t);
  const terminals = terminalsFor(t, socket);
  const cwd = await mkdtemp(join(tmpdir(), 'tether-term-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  // `cat` never requests bracketed paste, so tmux sends none, and the file ends
  // up holding exactly what was delivered — one line per applied input.
  const out = join(cwd, 'out.txt');
  await newSession(socket, {
    name: 's1',
    cwd,
    command: ['/bin/sh', '-c', `cat > ${out}`],
    roots: [cwd],
  });
  const detach = await terminals.attach('s1', () => {});
  t.after(() => detach());

  assert.equal(await terminals.input('s1', 'phone', 1, 'first line\nsecond line'), true);
  assert.equal(await terminals.input('s1', 'phone', 1, 'a replayed retry'), false);
  assert.equal(await terminals.input('s1', 'phone', 0, 'an out-of-order straggler'), false);
  assert.equal(await terminals.input('s1', 'phone', 2, 'third line'), true);
  // A different client keeps its own sequence, so seq 1 from it is fresh.
  assert.equal(await terminals.input('s1', 'laptop', 1, 'fourth line'), true);

  await waitFor(
    async () => (await readFile(out, 'utf8')).includes('fourth line'),
    'the pasted input to reach the pane',
  );
  assert.equal(
    await readFile(out, 'utf8'),
    'first line\nsecond line\nthird line\nfourth line\n',
    'multi-line input arrives whole, once, in order',
  );
});

test('typed text reaches the pane verbatim, separators included, and never submits', async (t) => {
  const socket = socketFor(t);
  const terminals = terminalsFor(t, socket);
  const cwd = await mkdtemp(join(tmpdir(), 'tether-term-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const out = join(cwd, 'out.txt');
  await newSession(socket, {
    name: 's1',
    cwd,
    command: ['/bin/sh', '-c', `cat > ${out}`],
    roots: [cwd],
  });
  const detach = await terminals.attach('s1', () => {});
  t.after(() => detach());

  // A standalone `;`, `{` or `}` is a command separator to tmux's own lexer, and
  // a trailing `;` is eaten by it too, so `send-keys` can never carry either —
  // the driver's argv guard refuses them before tmux gets the chance to silently
  // drop the character. They are also characters a user types constantly, so each
  // one has to arrive, and arrive as itself.
  const typed = ['const x = 1', ';', ' ', '{', '}', ' héllo ✅', ' git status;'];
  for (const [index, text] of typed.entries()) {
    assert.equal(await terminals.text('s1', 'phone', index + 1, text), true, text);
  }
  // A replayed sequence is dropped here exactly as it is for `input`.
  assert.equal(await terminals.text('s1', 'phone', 1, 'a replayed retry'), false);

  // Nothing above submitted anything: `cat` has written no line yet. Enter is a
  // key, and it is what makes the pane act on what was typed.
  await terminals.key('s1', 'phone', 100, ['Enter']);

  await waitFor(
    async () => (await readFile(out, 'utf8')).includes('\n'),
    'the typed text to reach the pane',
  );
  assert.equal(await readFile(out, 'utf8'), 'const x = 1; {} héllo ✅ git status;\n');
});

test('two viewers of one session cannot interleave their input', async (t) => {
  const socket = socketFor(t);
  const terminals = terminalsFor(t, socket);
  const cwd = await mkdtemp(join(tmpdir(), 'tether-term-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const out = join(cwd, 'out.txt');
  await newSession(socket, {
    name: 's1',
    cwd,
    command: ['/bin/sh', '-c', `cat > ${out}`],
    roots: [cwd],
  });
  const detach = await terminals.attach('s1', () => {});
  t.after(() => detach());

  // Two viewers submitting at once. Serialized per socket rather than per
  // session, the second paste lands inside the first's submit delay: one line
  // arrives holding both messages and the other arrives empty.
  await Promise.all([
    terminals.input('s1', 'phone', 1, 'from the phone'),
    terminals.input('s1', 'laptop', 1, 'from the laptop'),
  ]);
  await waitFor(
    async () => (await readFile(out, 'utf8')).split('\n').filter(Boolean).length === 2,
    'both messages to reach the pane',
  );
  assert.deepEqual(
    (await readFile(out, 'utf8')).split('\n').filter(Boolean).sort(),
    ['from the laptop', 'from the phone'],
    'each message is submitted whole and on its own line',
  );
});

test('a killed session ends its viewers instead of freezing them', async (t) => {
  const socket = socketFor(t);
  const terminals = terminalsFor(t, socket);
  await startSession(t, socket, 's1');

  // A viewer that is never told sits on a terminal that will never move again,
  // and cannot recover even if the session name comes back.
  let ended = false;
  const detach = await terminals.attach(
    's1',
    () => {},
    () => (ended = true),
  );
  t.after(() => detach());

  await killSession(socket, 's1');
  await waitFor(async () => ended, 'the viewer to be told the session ended');
});
