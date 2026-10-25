import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWriteTool } from '../src/adapters/tools/write.js';

test('a checkpoint failure prevents the mutation instead of claiming an undo point', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-checkpoint-cwd-'));
  const home = mkdtempSync(join(tmpdir(), 'cowcat-checkpoint-home-'));
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const blocked = join(home, 'not-a-directory');
  writeFileSync(blocked, 'x');
  const tool = createWriteTool({ cwd, checkpoints: { rootDir: blocked } });
  const target = join(cwd, 'new.txt');
  const result = await tool.run(
    { file_path: target, content: 'new\n' },
    new AbortController().signal,
    { networkApproved: false, unsandboxedApproved: false },
    { sessionId: 'sess_checkpoint', callId: 'call_1' },
  );
  assert.equal(result.ok, false);
  assert.match(result.output, /checkpoint/);
  assert.equal(existsSync(target), false);
});
