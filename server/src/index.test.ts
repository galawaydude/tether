import assert from 'node:assert/strict';
import test from 'node:test';

import { SERVER_NAME, encodeFrame } from './index.ts';

test('server package builds and its test harness runs', () => {
  assert.equal(SERVER_NAME, 'tether-server');
  assert.equal(encodeFrame({ c: 'term', d: 'aGk=' }), '{"c":"term","d":"aGk="}');
});
