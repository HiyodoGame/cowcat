import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAtRefs } from '../src/app/atrefs.js';

/**
 * ADR-128 `@` parsing, narrowed per the review of #173 (P1-6): only tokens at a word
 * boundary, made of path characters, resolving to an existing file are references;
 * everything else stays text.
 */

function tempDir(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('existing files resolve; relative paths resolve against the given cwd', (t) => {
  const cwd = tempDir(t, 'cowcat-atrefs-');
  writeFileSync(join(cwd, 'notes.md'), 'x');
  writeFileSync(join(cwd, 'src'), 'x', { mode: 0o666 });
  const refs = parseAtRefs('看 @notes.md 和 @src', cwd);
  assert.deepEqual(refs, [join(cwd, 'notes.md'), join(cwd, 'src')]);
});

test('absolute paths pass through', (t) => {
  const cwd = tempDir(t, 'cowcat-atrefs-abs-');
  const file = join(cwd, 'a.txt');
  writeFileSync(file, 'x');
  assert.deepEqual(parseAtRefs(`读 @${file}`, cwd), [file]);
});

test('emails, npm scopes, and trailing punctuation are not references', (t) => {
  const cwd = tempDir(t, 'cowcat-atrefs-noise-');
  assert.deepEqual(parseAtRefs('发给 user@example.com', cwd), []);
  assert.deepEqual(parseAtRefs('装 @corescense/cowcat 这个包', cwd), []);
  assert.deepEqual(parseAtRefs('看 @不存在的文件.md。', cwd), []);
  assert.deepEqual(parseAtRefs('邮箱是 a@b,', cwd), []);
});

test('trailing CJK/fullwidth punctuation is left in the text, not the path', (t) => {
  const cwd = tempDir(t, 'cowcat-atrefs-punct-');
  writeFileSync(join(cwd, 'README.md'), 'x');
  const refs = parseAtRefs('读 @README.md。然后总结', cwd);
  assert.deepEqual(refs, [join(cwd, 'README.md')]);
});

test('nonexistent @tokens stay text — a plain sentence never refuses the send', (t) => {
  const cwd = tempDir(t, 'cowcat-atrefs-ghost-');
  assert.deepEqual(parseAtRefs('@ghost.md 是什么', cwd), []);
  assert.deepEqual(parseAtRefs('提到 @someone 而已', cwd), []);
});

test('a token glued to the previous word is not a reference', (t) => {
  const cwd = tempDir(t, 'cowcat-atrefs-glued-');
  writeFileSync(join(cwd, 'file.txt'), 'x');
  assert.deepEqual(parseAtRefs('path@file.txt', cwd), []);
});

test('empty and reference-free text yields no files', (t) => {
  const cwd = tempDir(t, 'cowcat-atrefs-empty-');
  assert.deepEqual(parseAtRefs('', cwd), []);
  assert.deepEqual(parseAtRefs('没有任何引用', cwd), []);
  assert.deepEqual(parseAtRefs('@', cwd), []);
});
