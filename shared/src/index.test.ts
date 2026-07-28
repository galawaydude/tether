import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConversationEvent } from './index.ts';

test('the conversation contract is JSON round-trippable', () => {
  const event: ConversationEvent = {
    kind: 'tool_call',
    id: 'u1',
    at: 0,
    tool: 'Read',
    input: { file_path: '/tmp/note.txt' },
    callId: 'toolu_01',
  };

  assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
});
