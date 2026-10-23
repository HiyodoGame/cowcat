import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GREP_MAX_FILE_BYTES, createGrepTool, type ToolGrant, type ToolResult } from '../src/index.js';

const signal = new AbortController().signal;
const noGrant: ToolGrant = { networkApproved: false, unsandboxedApproved: false };

function tree(files: Readonly<Record<string, string | Buffer>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-grep-')));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

async function runGrep(root: string, input: Record<string, unknown>): Promise<ToolResult> {
  return createGrepTool({ cwd: root }).run(input, signal, noGrant);
}

/** Output split from its trailing report lines, which are asserted separately. */
function split(result: ToolResult): { readonly body: readonly string[]; readonly report: readonly string[] } {
  const lines = result.output.split('\n');
  return {
    body: lines.filter((line) => line !== '' && !line.startsWith('[')),
    report: lines.filter((line) => line.startsWith('[')),
  };
}

test('files_with_matches is the default and names every matching file', async (t) => {
  const root = tree({ 'a.ts': 'foo\n', 'b/c.ts': 'foo\n', 'd.md': 'foo\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await runGrep(root, { pattern: 'foo' });

  assert.equal(result.ok, true);
  assert.deepEqual([...split(result).body].sort(), [join(root, 'a.ts'), join(root, 'b', 'c.ts'), join(root, 'd.md')].sort());
  assert.deepEqual(split(result).report, ['[3 file(s), 3 match(es)]']);
  assert.deepEqual(result.truncation, { truncated: false, dropped: 0, reason: null });
});

test('count reports hits per file', async (t) => {
  const root = tree({ 'a.ts': 'foo\nfoo\n', 'b.ts': 'foo\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const { body } = split(await runGrep(root, { pattern: 'foo', output_mode: 'count' }));

  assert.deepEqual(body, [`${join(root, 'a.ts')}: 2 match(es)`, `${join(root, 'b.ts')}: 1 match(es)`]);
});

test('content mode reports path, line number and text — the file name is not optional', async (t) => {
  // v1 printed `line:text` with no file name, which made a multi-file search unreadable.
  const root = tree({ 'a.ts': 'one\ntwo\nthree\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const { body } = split(await runGrep(root, { pattern: 'two', output_mode: 'content' }));

  assert.deepEqual(body, [`${join(root, 'a.ts')}:2:two`]);
});

test('context lines are included, and a gap between groups is marked', async (t) => {
  const root = tree({ 'a.txt': 'hit\n1\n2\n3\n4\n5\nhit\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const { body } = split(await runGrep(root, { pattern: 'hit', output_mode: 'content', '-C': 1 }));

  assert.deepEqual(body, [
    `${join(root, 'a.txt')}:1:hit`,
    `${join(root, 'a.txt')}:2:1`,
    '--',
    `${join(root, 'a.txt')}:6:5`,
    `${join(root, 'a.txt')}:7:hit`,
  ]);
});

test('files_with_matches stops at head_limit, and the truncation says the total is unknown', async (t) => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 10; index += 1) files[`a${String(index)}.txt`] = 'foo\n';
  // Sorted after the matches: if the walk kept going, this file would be counted as
  // "skipped (over 1 MiB)" in the report. Early exit means it is never even opened.
  files['z-huge.txt'] = 'x'.repeat(GREP_MAX_FILE_BYTES + 1);
  const root = tree(files);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await runGrep(root, { pattern: 'foo', head_limit: 3 });
  const { body, report } = split(result);

  assert.deepEqual(body, ['a0.txt', 'a1.txt', 'a2.txt'].map((name) => join(root, name)));
  assert.equal(report[0], '[3 file(s), 3 match(es), stopped at head_limit 3]');
  assert.equal(report.join('\n').includes('over 1 MiB'), false, 'the walk must stop, not skip files it will never report');
  assert.deepEqual(result.truncation, { truncated: true, dropped: null, reason: 'grep: head_limit 3' });
});

test('count also stops at head_limit instead of scanning everything', async (t) => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 6; index += 1) files[`a${String(index)}.txt`] = 'foo\n';
  const root = tree(files);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await runGrep(root, { pattern: 'foo', output_mode: 'count', head_limit: 2 });

  assert.equal(split(result).body.length, 2);
  assert.deepEqual(result.truncation, { truncated: true, dropped: null, reason: 'grep: head_limit 2' });
});

test('-i makes the search case-insensitive', async (t) => {
  const root = tree({ 'a.txt': 'Foo\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  assert.equal((await runGrep(root, { pattern: 'foo' })).output.startsWith('['), true);
  assert.equal(split(await runGrep(root, { pattern: 'foo', '-i': true })).body.length, 1);
});

test('multiline lets the pattern span lines and reports the start line', async (t) => {
  const root = tree({ 'a.txt': 'one\nfoo\nbar\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await runGrep(root, { pattern: 'foo\\nbar', multiline: true, output_mode: 'content' });

  // A multi-line match is printed as its own lines; the prefix marks where it starts.
  assert.equal(result.output, `${join(root, 'a.txt')}:2:foo\nbar\n[1 file(s), 1 match(es)]`);
});

test('type and glob narrow which files are searched', async (t) => {
  const root = tree({ 'a.ts': 'foo\n', 'b.md': 'foo\n', 'sub/c.ts': 'foo\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const typed = split(await runGrep(root, { pattern: 'foo', type: 'ts' }));
  assert.deepEqual([...typed.body].sort(), [join(root, 'a.ts'), join(root, 'sub', 'c.ts')].sort());

  // `*.ts` must match at the root: v1 matched this glob against absolute paths, where a
  // leading `*` can never match a drive letter or `/`.
  const globbed = split(await runGrep(root, { pattern: 'foo', glob: '*.ts' }));
  assert.deepEqual(globbed.body, [join(root, 'a.ts')]);
});

test('oversized and binary files are skipped and counted, not silently dropped', async (t) => {
  const root = tree({
    'a.txt': 'foo\n',
    'big.txt': 'foo\n'.repeat(GREP_MAX_FILE_BYTES),
    'bin.dat': Buffer.from([0x66, 0x6f, 0x6f, 0x00, 0x01]),
  });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await runGrep(root, { pattern: 'foo' });

  assert.equal(split(result).body.length, 1);
  assert.match(result.output, /1 file\(s\) skipped \(over 1 MiB\)/);
  assert.match(result.output, /1 binary file\(s\) skipped/);
});

test('no match is an empty result with a zero report, not a failure', async (t) => {
  const root = tree({ 'a.txt': 'nothing here\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await runGrep(root, { pattern: 'absent' });

  assert.equal(result.ok, true);
  assert.equal(result.output, '[0 file(s), 0 match(es)]');
});

test('paging with offset skips output lines and does not claim truncation', async (t) => {
  const root = tree({ 'a.txt': 'hit\nhit\nhit\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await runGrep(root, { pattern: 'hit', output_mode: 'content', offset: 1, head_limit: 0 });

  assert.deepEqual(split(result).body, [`${join(root, 'a.txt')}:2:hit`, `${join(root, 'a.txt')}:3:hit`]);
  assert.deepEqual(result.truncation, { truncated: false, dropped: 0, reason: null });
});

test('a single file can be the target', async (t) => {
  const root = tree({ 'a.txt': 'foo\n', 'b.txt': 'foo\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const { body } = split(await runGrep(root, { pattern: 'foo', path: 'a.txt' }));
  assert.deepEqual(body, [join(root, 'a.txt')]);
});

test('bad input is reported, not thrown: invalid regex, unknown type, missing path, invalid limit', async (t) => {
  const root = tree({ 'a.txt': 'foo\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const regex = await runGrep(root, { pattern: '[' });
  assert.equal(regex.ok, false);
  assert.match(regex.output, /invalid regex:/);

  const type = await runGrep(root, { pattern: 'foo', type: 'cobol' });
  assert.equal(type.ok, false);
  assert.match(type.output, /unknown type "cobol"/);

  const missing = await runGrep(root, { pattern: 'foo', path: 'nope' });
  assert.equal(missing.ok, false);
  assert.match(missing.output, /path not found:/);

  const limit = await runGrep(root, { pattern: 'foo', head_limit: -1 });
  assert.equal(limit.ok, false);
  assert.match(limit.output, /head_limit/);
});

test('the tool narrows on path and advertises its modes', () => {
  const tool = createGrepTool({ cwd: '.' });

  assert.equal(tool.spec.pathInput, 'path');
  const schema = tool.spec.inputSchema as Record<string, unknown>;
  assert.deepEqual(schema.required, ['pattern']);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties.output_mode?.enum, ['content', 'files_with_matches', 'count']);
});
