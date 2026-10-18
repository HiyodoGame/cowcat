import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GITIGNORE_LIMITATIONS, createGlobTool, globToRegExp, type ToolGrant, type ToolResult } from '../src/index.js';

const signal = new AbortController().signal;
const noGrant: ToolGrant = { networkApproved: false };

/** Builds a real tree: the walker's contract is about the filesystem, so no fake. */
function tree(files: Readonly<Record<string, string>>): string {
  // realpath, because macOS answers tmpdir() with a path that is not what the walker
  // emits when it joins (`/var` vs `/private/var`) — the same trap test/fs.test.ts records.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-glob-')));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

interface GlobRun {
  readonly result: ToolResult;
  readonly listed: readonly string[];
}

async function runGlob(root: string, input: Record<string, unknown>, cwd = root): Promise<GlobRun> {
  const tool = createGlobTool({ cwd });
  const result = await tool.run(input, signal, noGrant);
  // The footer lines are the tool's reports, not matches; strip them so a test about
  // matching cannot pass because of a message.
  const listed = result.output
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('['))
    .map((line) => line.replace(root, '').replace(/^[\\/]/, '').replace(/\\/g, '/'));
  return { result, listed };
}

test('a pattern matches recursively and the result is sorted', async (t) => {
  const root = tree({ 'a.ts': '', 'b/c.ts': '', 'b/d.js': '', 'docs/x.md': '' });
  t.after(() => { rmSync(root, { recursive: true, force: true }); });

  const { result, listed } = await runGlob(root, { pattern: '**/*.ts' });

  assert.equal(result.ok, true);
  assert.deepEqual(listed, ['a.ts', 'b/c.ts']);
});

test('the supported .gitignore subset excludes and re-includes the right paths', async (t) => {
  const root = tree({
    // Six supported forms, one per line, plus a negation that must win.
    '.gitignore': ['*.log', 'build/', '/root-only.txt', 'docs/*.md', '**/generated/**', '!keep.log'].join('\n'),
    'a.log': '',
    'sub/b.log': '',
    'keep.log': '',
    'build/drop.txt': '',
    'sub/build/drop.txt': '',
    'root-only.txt': '',
    'sub/root-only.txt': '',
    'docs/a.md': '',
    'docs/sub/b.md': '',
    'generated/x.ts': '',
    'sub/generated/y.ts': '',
    'node_modules/pkg/index.js': '',
    '.hidden/keep.ts': '',
    'src/app.ts': '',
  });
  t.after(() => { rmSync(root, { recursive: true, force: true }); });

  const { listed } = await runGlob(root, { pattern: '**/*.{ts,md,log,txt,js}' });
  assert.deepEqual([...listed].sort(), ['docs/sub/b.md', 'keep.log', 'src/app.ts', 'sub/root-only.txt'].sort());
});

test('a directory-only pattern does not hide a file with the same name', async (t) => {
  const root = tree({ '.gitignore': 'build/\n', 'build': 'a file', 'sub/build/inside.txt': '' });
  t.after(() => { rmSync(root, { recursive: true, force: true }); });

  const { listed } = await runGlob(root, { pattern: '**/*' });
  assert.deepEqual([...listed].sort(), ['.gitignore', 'build']);
});

test('the cap is reported as a truncation fact, not only as a note', async (t) => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 105; i += 1) files[`f${String(i).padStart(3, '0')}.txt`] = '';
  const root = tree(files);
  t.after(() => { rmSync(root, { recursive: true, force: true }); });

  const { result } = await runGlob(root, { pattern: '*.txt' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.truncation, { truncated: true, dropped: 5, reason: 'glob: first 100 matches' });
  assert.match(result.output, /\[105 match\(es\), truncated to first 100\]/);
});

test('a result that was not truncated says so, instead of saying nothing', async (t) => {
  const root = tree({ 'a.txt': '', 'b.txt': '' });
  t.after(() => { rmSync(root, { recursive: true, force: true }); });

  const { result } = await runGlob(root, { pattern: '*.txt' });

  assert.deepEqual(result.truncation, { truncated: false, dropped: 0, reason: null });
});

test('a nested .gitignore is reported as not in effect, not silently ignored', async (t) => {
  const root = tree({ 'sub/.gitignore': '*.ts\n', 'sub/a.ts': '' });
  t.after(() => { rmSync(root, { recursive: true, force: true }); });

  const { result, listed } = await runGlob(root, { pattern: '**/*.ts' });

  // It is NOT honoured: an unread file must not pretend to have authority.
  assert.deepEqual(listed, ['sub/a.ts']);
  assert.match(result.output, /\[\.gitignore: nested \.gitignore is not read: sub\/\.gitignore\]/);
});

test('a .gitignore pattern outside the subset is reported rather than approximated', async (t) => {
  const root = tree({ '.gitignore': '[a-z].txt\n', 'b.txt': '' });
  t.after(() => { rmSync(root, { recursive: true, force: true }); });

  const { result, listed } = await runGlob(root, { pattern: '*.txt' });

  assert.deepEqual(listed, ['b.txt']);
  assert.match(result.output, /unsupported \.gitignore pattern: "\[a-z\]\.txt"/);
});

test('the three unsupported .gitignore features are stated somewhere constant', () => {
  assert.equal(GITIGNORE_LIMITATIONS.length, 3);
});

test('a relative path resolves against the tool cwd, and results are absolute', async (t) => {
  const root = tree({ 'sub/a.ts': '' });
  t.after(() => { rmSync(root, { recursive: true, force: true }); });

  const tool = createGlobTool({ cwd: root });
  const result = await tool.run({ pattern: '*.ts', path: 'sub' }, signal, noGrant);

  assert.equal(result.ok, true);
  assert.equal(result.output.split('\n')[0], join(root, 'sub', 'a.ts'));
});

test('a missing directory and a file used as a directory are both ordinary failures', async (t) => {
  const root = tree({ 'a.txt': '' });
  t.after(() => { rmSync(root, { recursive: true, force: true }); });

  const missing = await runGlob(root, { pattern: '*', path: 'nope' });
  assert.equal(missing.result.ok, false);
  assert.match(missing.result.output, /directory not found:/);

  const file = await runGlob(root, { pattern: '*', path: 'a.txt' });
  assert.equal(file.result.ok, false);
  assert.match(file.result.output, /is not a directory/);
});

test('the tool declares the pattern as required and the directory as narrowable', () => {
  const tool = createGlobTool({ cwd: '.' });

  assert.equal(tool.spec.pathInput, 'path');
  assert.equal(tool.spec.risk, 'read');
  const schema = tool.spec.inputSchema as Record<string, unknown>;
  assert.deepEqual(schema.required, ['pattern']);
});

test('the pattern grammar is the legacy one', () => {
  assert.equal(globToRegExp('src/**/*.ts').test('src/a.ts'), true);
  assert.equal(globToRegExp('src/**/*.ts').test('src/a/b.ts'), true);
  assert.equal(globToRegExp('*.{ts,js}').test('a.js'), true);
  assert.equal(globToRegExp('*.{ts,js}').test('a.css'), false);
  assert.equal(globToRegExp('a?c.ts').test('abc.ts'), true);
  assert.equal(globToRegExp('[ab].ts').test('b.ts'), true);
  // `*` must not cross a segment: otherwise `*.ts` would match everything under src/.
  assert.equal(globToRegExp('*.ts').test('src/a.ts'), false);
});
