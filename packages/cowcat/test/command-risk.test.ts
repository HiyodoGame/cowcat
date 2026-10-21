import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessCommand } from '../src/index.js';

/**
 * The two commands below are the measured pair from the beta session: the approval card
 * for them was identical, and only the model's prose distinguished an irreversible
 * remote deletion from a directory listing (ADR-095).
 */
test('a listing and an irreversible remote delete are not the same warning', () => {
  assert.equal(assessCommand('pwd && ls -la'), null);
  const warning = assessCommand('wrangler pages project delete kuangkuang --yes');
  assert.equal(warning?.risk, 'destructive');
  assert.match(warning.message, /不可逆/u);
});

test('destructive patterns are recognised even when spelled differently', () => {
  for (const command of ['rm -rf build', 'rm  -fr build', 'git reset --hard origin/main', 'git clean -fd']) {
    assert.equal(assessCommand(command)?.risk, 'destructive', command);
  }
});

test('remote writes and privilege escalation are their own kinds', () => {
  assert.equal(assessCommand('git push --force origin main')?.risk, 'remote-write');
  assert.equal(assessCommand('npm publish --access public')?.risk, 'remote-write');
  assert.equal(assessCommand('curl -X DELETE https://api.example.com/x')?.risk, 'remote-write');
  assert.equal(assessCommand('sudo rm -rf /')?.risk, 'destructive', 'destructive wins over privilege');
  assert.equal(assessCommand('chmod -R 777 .')?.risk, 'privilege');
});

test('an ordinary command, or no command at all, has no warning', () => {
  assert.equal(assessCommand('npm run build'), null);
  assert.equal(assessCommand('git status'), null);
  assert.equal(assessCommand(undefined), null);
});
