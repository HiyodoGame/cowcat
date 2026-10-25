import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replay, Session } from '../src/index.js';
import { MemoryEventStore, sessionDeps } from './support.js';

test('approval revocation removes only the selected standing grant and replays identically', async () => {
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_grants');
  await session.emit({ type: 'approval.answered', turnId: null, callId: 'c1', key: 'Bash\0npm test', verdict: 'always', by: 'user' });
  await session.emit({ type: 'approval.answered', turnId: null, callId: 'c2', key: 'Write\0"*"', verdict: 'session', by: 'user' });
  assert.deepEqual(session.state.grants, ['Bash\0npm test', 'Write\0"*"']);

  await session.emit({ type: 'approval.revoked', turnId: null, key: 'Bash\0npm test', by: 'user' });
  assert.deepEqual(session.state.grants, ['Write\0"*"']);
  assert.deepEqual(replay('sess_grants', store.events).grants, session.state.grants);
});
