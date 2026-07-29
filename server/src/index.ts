import type { ServerFrame } from '@tether/shared';

/**
 * Placeholder module. The process entry point is `cli.ts`, the Fastify server
 * lives in `web/`, and the tmux driver in `machine/` — see report section 9.
 * This exists so the build, the test harness and CI are proven end to end.
 */
export const SERVER_NAME = 'tether-server';

/** Frames are JSON on the wire; this is the only encoding step both sides share. */
export function encodeFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}
