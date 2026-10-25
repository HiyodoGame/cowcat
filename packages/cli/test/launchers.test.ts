import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryRoot = resolve(packageRoot, '../..');

test('repository launchers target the v2 CLI entry, never the deleted agent tree', () => {
  const cmd = readFileSync(resolve(repositoryRoot, 'bin/cowcat.cmd'), 'utf8');
  const posix = readFileSync(resolve(repositoryRoot, 'bin/cowcat'), 'utf8');
  assert.doesNotMatch(cmd, /agent[\\/]bin/);
  assert.doesNotMatch(posix, /agent[\\/]bin/);
  assert.ok(cmd.includes('node "%DIR%..\\packages\\cli\\dist\\src\\cli\\main.js" %*'), cmd);
  assert.ok(posix.includes('"$DIR/../packages/cli/dist/src/cli/main.js" "$@"'), posix);
  assert.equal(existsSync(resolve(packageRoot, 'dist/src/cli/main.js')), true);
});
