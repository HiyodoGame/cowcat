import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCommand } from '../src/app/commands.js';
import { initialView, setPermissions } from '../src/app/view.js';
import { permissionsPanel } from '../src/components/permissions-panel.js';
import { textOf } from './scene.js';

test('/permissions lists grants and revokes only an explicit id', () => {
  const list = findCommand('permissions');
  assert.ok(list !== undefined);
  assert.deepEqual(list.run(initialView(), ''), { kind: 'permissions' });
  assert.deepEqual(list.run(initialView(), 'revoke grant_7'), { kind: 'revokeGrant', grantId: 'grant_7' });
  assert.equal(list.run(initialView(), 'revoke everything').kind, 'notice');
});

test('the permissions panel shows stable ids, scope and subject', () => {
  const view = setPermissions(initialView(), [
    { id: 'grant_7', key: 'Bash\0npm test', verdict: 'always' },
    { id: 'grant_9', key: 'Write\0"*"', verdict: 'session' },
  ]);
  const text = textOf([permissionsPanel(view, 72)]);
  for (const expected of ['grant_7', 'always', 'Bash', 'npm test', 'session', 'Write']) assert.match(text, new RegExp(expected));
});
