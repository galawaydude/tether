import { defineConfig, devices } from '@playwright/test';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * One browser, one worker — and one server between every spec, which is why each
 * spec works in its own directory. The end-to-end tests exist to check the claims
 * nothing else can (report §8): that a reload loses nothing, that a permission
 * prompt is on screen before the transcript has anything to say, that a composed
 * message reaches the agent and appears exactly once, that each session shows its
 * own conversation, that a composer option control reaches the pane under the
 * agent that offers it, and that past 900px the layout is a different shape.
 *
 * Everything below the sandbox line is deliberate. `TETHER_ALLOWED_ROOTS` is
 * resolved through `realpath` because tether resolves the directory it is given
 * before confining it, and `/tmp` is a symlink on some systems. The socket is
 * private so the run cannot see — or kill — a real tether's tmux server.
 */

// Resolved for the same reason tether resolves it: containment is compared
// against real paths, never strings.
const dir = join(realpathSync(tmpdir()), 'tether-e2e');
const port = '8788';

/**
 * How long tether holds a proposed tool call, in seconds — short enough that
 * `permission.spec.ts` can watch one expire without a slow test, long enough
 * that a tap in the two specs above it is never racing this on a loaded CI box.
 * The spec reads it too, so the wait and the setting cannot drift apart.
 */
const holdSeconds = '15';
process.env['TETHER_E2E_HOLD_SECONDS'] = holdSeconds;

// Read by both halves: `e2e/serve.ts` sets the password, and the spec logs in
// with it. This config is evaluated in the runner and in every worker, so the
// environment is what carries these to the spec.
const password = process.env['TETHER_E2E_PASSWORD'] ?? 'a throwaway password for the e2e run';
process.env['TETHER_E2E_DIR'] = dir;
process.env['TETHER_E2E_PASSWORD'] = password;

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: process.env['CI'] !== undefined,
  // No retries, on purpose. This test covers the product's core claim, and a
  // flake retried into passing is worse than no test at all.
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}` },
  /**
   * Two viewports, and every spec belongs to exactly one of them — hence the
   * `testIgnore`, without which each project would run the other's spec at the
   * wrong width. The phone is the client tether is designed for and is where the
   * product claims are checked; the desktop project exists because past 900px
   * `app.tsx` renders a *different shape*, and a shape no test has ever rendered
   * is how the secure-context bug reached a real phone.
   *
   * They share the one `tether serve` and one session list, so each spec still
   * works in its own directory and reopens its session by name.
   */
  projects: [
    {
      name: 'phone',
      testIgnore: 'desktop.spec.ts',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'desktop',
      testMatch: 'desktop.spec.ts',
      // A plain viewport rather than `devices['Desktop Chrome']`: that descriptor
      // can carry `channel: 'chrome'`, and CI installs chromium only.
      use: { viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning e2e/serve.ts',
    url: `http://127.0.0.1:${port}/`,
    // Never adopt a server someone left running: it would have the real home
    // directory and the real state file.
    reuseExistingServer: false,
    // Playwright SIGKILLs the web server by default, which would leave the
    // sandbox's tmux server and the stub agent in it running. `e2e/serve.ts`
    // cleans up on SIGTERM — and cleans up again at startup, because a kill -9
    // from anywhere else must not make the next run's counts wrong.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      TETHER_E2E_DIR: dir,
      TETHER_E2E_PORT: port,
      TETHER_E2E_PASSWORD: password,
      HOME: dir,
      RCAGENT_STATE_DIR: join(dir, 'state'),
      RCAGENT_ALLOWED_ROOTS: dir,
      RCAGENT_TMUX_SOCKET: 'tether-e2e',
      RCAGENT_PERMISSION_TIMEOUT: holdSeconds,
      PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`,
    },
  },
});
