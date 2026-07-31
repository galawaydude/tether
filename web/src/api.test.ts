import assert from 'node:assert/strict';
import test from 'node:test';

import { unhandled } from './api.ts';

test('a status code with no wording of its own says refused or failed, whichever it was', () => {
  // "The server refused this" was said for every non-ok status, 500 included.
  // A refusal is something the user's request earned; a 5xx is the server
  // failing at something it accepted, and pointing the user at their own
  // request for it sends them looking in the wrong place entirely.
  assert.match(unhandled(418), /refused/);
  assert.match(unhandled(499), /refused/);
  assert.match(unhandled(500), /failed/);
  assert.match(unhandled(502), /failed/);
  assert.doesNotMatch(unhandled(500), /refused/);
});
