import type { ServerFrame } from '@tether/shared';

/**
 * Placeholder entry point. The real server (Fastify, auth, tmux) arrives in
 * PR #4 onwards — see report section 9. This exists so the build, the test
 * harness and CI are proven end to end before there is anything to break.
 */
export const SERVER_NAME = 'tether-server';

/** Frames are JSON on the wire; this is the only encoding step both sides share. */
export function encodeFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}
