import assert from 'node:assert/strict';
import test from 'node:test';

import { PLACEHOLDER, channelOf } from './app.ts';

test('web package resolves the shared contract and its test harness runs', () => {
  assert.match(PLACEHOLDER, /^tether/);
  assert.equal(
    channelOf({ c: 'conv', seq: 1, e: { kind: 'status', at: 0, state: 'idle' } }),
    'conv',
  );
});
