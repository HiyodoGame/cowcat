import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCommand } from '../src/app/commands.js';
import { initialView, setPermissions } from '../src/app/view.js';
import { permissionsPanelLines } from '../src/components/permissions-panel.js';

test('/permissions lists grants and revokes only an explicit id', () => {
  const list = findCommand('permissions');
  assert.ok(list !== undefined);
  assert.deepEqual(list.run(initialView(), ''), { kind: 'permissions' });
  assert.deepEqual(list.run(initialView(), 'revoke grant_7'), { kind: 'revokeGrant', grantId: 'grant_7' });
  const invalid = list.run(initialView(), 'revoke everything');
  assert.equal(invalid.kind, 'notice');
});

test('the permissions panel shows stable ids, scope and subject', () => {
  const view = setPermissions(initialView(), [
    { id: 'grant_7', key: 'Bash\0npm test', verdict: 'always' },
    { id: 'grant_9', key: 'Write\0"*"', verdict: 'session' },
  ]);
  const text = permissionsPanelLines(view, 72).map((row) => row.text).join('\n');
  assert.match(text, /grant_7/);
  assert.match(text, /always/);
  assert.match(text, /Bash/);
  assert.match(text, /npm test/);
  assert.match(text, /session/);
  assert.match(text, /Write/);
});
