import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atCandidates, atCandidatesAsync, loadFileCandidates } from '../src/app/atcomplete.js';

test('async candidates match the existing synchronous walk', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-atcomplete-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(dir, 'src', 'nested'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'ignored'), { recursive: true });
  writeFileSync(join(dir, 'root.ts'), 'root');
  writeFileSync(join(dir, 'src', 'nested', 'file.ts'), 'file');
  writeFileSync(join(dir, 'node_modules', 'ignored', 'file.ts'), 'ignored');

  assert.deepEqual(await atCandidatesAsync(dir), atCandidates(dir));
});

test('candidate loading is asynchronous and a stale generation is discarded', async () => {
  let resolve: ((files: readonly string[]) => void) | undefined;
  const pending = new Promise<readonly string[]>((accept) => {
    resolve = accept;
  });
  let settled = false;
  const result = loadFileCandidates('/workspace', () => false, () => pending).then((files) => {
    settled = true;
    return files;
  });

  assert.equal(settled, false);
  resolve?.(['src/a.ts']);
  assert.equal(await result, null);
  assert.deepEqual(await loadFileCandidates('/workspace', () => true, () => Promise.resolve(['src/a.ts'])), ['src/a.ts']);
});
