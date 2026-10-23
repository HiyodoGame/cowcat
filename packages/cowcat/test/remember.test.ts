// D10 T1 (ADR-135/136): the Remember memory-write tool 鈥?four targets, two write
// shapes, trust symmetry, caps. These tests hit the real filesystem under temp dirs
// (the tool is a disk writer; mocking fs would test the mock).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRememberTool } from '../src/adapters/tools/remember.js';
import type { ToolGrant } from '../src/index.js';

function fixture(trusted: boolean) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-remember-home-')));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-remember-cwd-')));
  mkdirSync(join(home, '.cowcat'), { recursive: true });
  const tool = createRememberTool({ cwd, home, trusted });
  return { home, cwd, tool };
}

const grant: ToolGrant = { networkApproved: false, unsandboxedApproved: false };

const run = (tool: ReturnType<typeof createRememberTool>, input: Record<string, unknown>) =>
  tool.run(input, new AbortController().signal, grant);

test('appends to the user-global instructions file, creating it', async () => {
  const { home, tool } = fixture(false);
  const result = await run(tool, { target: 'instructions-user', content: '## Lessons\n- never cache API keys in the repo.' });
  assert.equal(result.ok, true);
  const path = join(home, '.cowcat', 'AGENTS.md');
  assert.equal(readFileSync(path, 'utf8'), '## Lessons\n- never cache API keys in the repo.\n');
});

test('append preserves existing content; rewrite-cowcat-section manages only the marked section', async () => {
  const { cwd, tool } = fixture(true);
  const path = join(cwd, 'AGENTS.md');
  writeFileSync(path, '# Project rules\n\nHand-written, must survive.\n');

  await run(tool, { target: 'instructions-project', content: 'plain appended note' });
  assert.equal(readFileSync(path, 'utf8').includes('Hand-written, must survive.\n\nplain appended note\n'), true);

  // The marked section is created at the end when absent.
  await run(tool, { target: 'instructions-project', mode: 'rewrite-cowcat-section', content: 'memory v1' });
  let after = readFileSync(path, 'utf8');
  assert.equal(after.includes('plain appended note'), true, 'unmarked appends are outside the section');
  assert.match(after, /<!-- cowcat:memory -->\nmemory v1\n<!-- \/cowcat:memory -->/);

  // A second rewrite replaces the section only; unmarked content (hand-written or
  // earlier appends) is untouched — that is the point of the marker boundary.
  await run(tool, {
    target: 'instructions-project',
    mode: 'rewrite-cowcat-section',
    content: 'memory v2',
  });
  after = readFileSync(path, 'utf8');
  assert.equal(after.includes('Hand-written, must survive.'), true);
  assert.equal(after.includes('plain appended note'), true);
  assert.equal(after.includes('memory v1'), false, 'the marked section was replaced');
  assert.equal(after.indexOf('memory v2') >= 0, true);
  assert.equal(after.indexOf('<!-- cowcat:memory -->') >= 0 && after.indexOf('<!-- /cowcat:memory -->') >= 0, true);
});

test('an untrusted workspace refuses project targets with the reason, never writes', async () => {
  const { cwd, tool } = fixture(false);
  const result = await run(tool, { target: 'instructions-project', content: 'sneaky' });
  assert.equal(result.ok, false);
  assert.match(result.output, /not trusted/);
  assert.match(result.output, /ADR-030/);
  assert.equal(existsSync(join(cwd, 'AGENTS.md')), false);

  const skill = await run(tool, { target: 'skill-project', name: 'x', description: 'y', content: 'z' });
  assert.equal(skill.ok, false);
  assert.equal(existsSync(join(cwd, '.cowcat')), false, 'nothing on disk either way');
});

test('a trusted workspace writes project targets', async () => {
  const { cwd, tool } = fixture(true);
  const result = await run(tool, { target: 'instructions-project', content: 'project lesson' });
  assert.equal(result.ok, true);
  assert.equal(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), 'project lesson\n');
});

test('skill targets write a whole SKILL.md with exactly the two honoured frontmatter keys', async () => {
  const { home, cwd, tool } = fixture(true);
  const made = await run(tool, {
    target: 'skill-user',
    name: 'release-checklist',
    description: 'Steps before every release tag',
    content: '# Release\n\n1. Run the full test matrix.\n',
  });
  assert.equal(made.ok, true);
  const path = join(home, '.cowcat', 'skills', 'release-checklist', 'SKILL.md');
  const text = readFileSync(path, 'utf8');
  assert.match(text, /^---\nname: release-checklist\ndescription: "Steps before every release tag"\n---\n\n# Release\n/);

  // Whole-file replace on the second write.
  const replaced = await run(tool, {
    target: 'skill-project',
    name: 'release-checklist',
    description: 'v2',
    content: 'only the body remains',
  });
  assert.equal(replaced.ok, true);
  const v2 = readFileSync(join(cwd, '.cowcat', 'skills', 'release-checklist', 'SKILL.md'), 'utf8');
  assert.match(v2, /description: "v2"/);
  assert.equal(v2.includes('only the body remains'), true);
  assert.equal(v2.includes('# Release'), false, 'the previous body is gone 鈥?whole-file write');
});

test('caps and required fields refuse loudly, not silently', async () => {
  const { tool } = fixture(true);
  const tooLong = await run(tool, { target: 'instructions-user', content: 'x'.repeat(8 * 1024 + 1) });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.output, /8\d{3}|8192/);

  const tooBigSkill = await run(tool, { target: 'skill-user', name: 'n', description: 'd', content: 'x'.repeat(32 * 1024 + 1) });
  assert.equal(tooBigSkill.ok, false);

  const noDescription = await run(tool, { target: 'skill-user', name: 'n', content: 'body' });
  assert.equal(noDescription.ok, false);
  assert.match(noDescription.output, /name and description/);

  const badName = await run(tool, { target: 'skill-user', name: '../escape', description: 'd', content: 'body' });
  assert.equal(badName.ok, false);
  assert.match(badName.output, /skill name/);

  const longDesc = await run(tool, {
    target: 'skill-user',
    name: 'n',
    description: 'd'.repeat(1025),
    content: 'body',
  });
  assert.equal(longDesc.ok, false);
});
