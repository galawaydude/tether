import type { ServerFrame } from '@tether/shared';

/**
 * Placeholder shell. PR #7 replaces this with the Preact app — see report
 * section 9. It exists so the Vite build and the test harness are proven.
 */
export const PLACEHOLDER = 'tether — nothing to see yet';

/** Which of the socket's two logical channels a frame belongs to. */
export function channelOf(frame: ServerFrame): ServerFrame['c'] {
  return frame.c;
}
