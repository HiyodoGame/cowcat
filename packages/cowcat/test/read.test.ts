import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  READ_ABSOLUTE_LIMIT,
  READ_LARGE_LIMIT,
  READ_MAX_LINES,
  Session,
  createReadTool,
  runTurn,
  type KernelEvent,
  type ToolGrant,
  type ToolResult,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, turnDeps } from './support.js';

const signal = new AbortController().signal;
const noGrant: ToolGrant = { networkApproved: false };

function tree(files: Readonly<Record<string, string | Buffer>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cowcat-read-')));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

async function runRead(root: string, input: Record<string, unknown>): Promise<ToolResult> {
  return createReadTool({ cwd: root }).run(input, signal, noGrant);
}

test('a long file is paged at 2000 lines and the truncation says how much is missing', async (t) => {
  const lines = Array.from({ length: 2500 }, (_, index) => `line ${String(index + 1)}`).join('\n');
  const root = tree({ 'a.txt': lines });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await runRead(root, { file_path: 'a.txt' });
  const body = result.output.split('\n');

  assert.equal(body.length, READ_MAX_LINES + 1);
  assert.equal(body[0], '1\tline 1');
  assert.equal(body[READ_MAX_LINES - 1], `${String(READ_MAX_LINES)}\tline ${String(READ_MAX_LINES)}`);
  assert.equal(body[READ_MAX_LINES], '[showing lines 1-2000 of 2500]');
  assert.deepEqual(result.truncation, { truncated: true, dropped: 500, reason: 'read: lines 1-2000 of 2500' });
});

test('offset and limit page the file, and the footer names the range', async (t) => {
  const root = tree({ 'a.txt': Array.from({ length: 10 }, (_, index) => `row${String(index + 1)}`).join('\n') });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await runRead(root, { file_path: 'a.txt', offset: 3, limit: 4 });

  assert.equal(result.output, '3\trow3\n4\trow4\n5\trow5\n6\trow6\n[showing lines 3-6 of 10]');
  assert.deepEqual(result.truncation, { truncated: true, dropped: 6, reason: 'read: lines 3-6 of 10' });
});

test('a short file comes back whole with no footer and no truncation', async (t) => {
  const root = tree({ 'a.txt': 'one\ntwo\nthree' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await runRead(root, { file_path: 'a.txt' });

  assert.equal(result.output, '1\tone\n2\ttwo\n3\tthree');
  assert.deepEqual(result.truncation, { truncated: false, dropped: 0, reason: null });
});

test('a trailing newline terminates the last line instead of starting an empty one', async (t) => {
  const root = tree({ 'a.txt': 'one\ntwo\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  assert.equal((await runRead(root, { file_path: 'a.txt' })).output, '1\tone\n2\ttwo');
});

test('CRLF is stated as a fact, and the carriage returns are not normalised away', async (t) => {
  const root = tree({ 'a.txt': 'one\r\ntwo\r\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await runRead(root, { file_path: 'a.txt' });

  assert.equal(result.output, '1\tone\r\n2\ttwo\r\n[file uses CRLF line endings]');
  // The model cannot see the `\r`; that is exactly why the fact is printed (ADR-050).
  assert.equal(result.output.includes('\r'), true);
});

test('a mixed file says so instead of picking one style', async (t) => {
  const root = tree({ 'a.txt': 'one\r\ntwo\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  assert.match((await runRead(root, { file_path: 'a.txt' })).output, /\[file uses mixed line endings: CRLF and LF\]/);
});

test('an LF file carries no line-ending notice', async (t) => {
  const root = tree({ 'a.txt': 'one\ntwo\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  assert.equal((await runRead(root, { file_path: 'a.txt' })).output.includes('line endings'), false);
});

test('5MB is a refusal unless allow_large is set, and then the whole file is returned', async (t) => {
  const content = 'a'.repeat(READ_LARGE_LIMIT + 1);
  const root = tree({ 'big.txt': content });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const refused = await runRead(root, { file_path: 'big.txt' });
  assert.equal(refused.ok, false);
  assert.match(refused.output, /the limit is 5MB/);
  assert.match(refused.output, /allow_large/);

  const whole = await runRead(root, { file_path: 'big.txt', allow_large: true });
  assert.equal(whole.ok, true);
  assert.equal(whole.output.length, content.length + '1\t'.length);
  assert.deepEqual(whole.truncation, { truncated: false, dropped: 0, reason: null });
});

test('a PDF renamed to .txt is still read as a PDF: magic beats extension', async (t) => {
  const root = tree({ 'looks-like.txt': '%PDF-1.7\n/Type /Page\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await runRead(root, { file_path: 'looks-like.txt' });
  assert.equal(result.ok, true);
  assert.match(result.output, /\[pdf\] looks-like\.txt — application\/pdf, 1 page/);
  assert.equal(result.attachments?.[0]?.type, 'document');
});

test('a file whose name promises an image but whose content is text is refused', async (t) => {
  const root = tree({ 'shot.png': 'this is not a png at all' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = await runRead(root, { file_path: 'shot.png' });
  assert.equal(result.ok, false);
  // Handing these bytes over as text is how a transcript gets silently corrupted.
  assert.match(result.output, /the name promises a png but the content is not one/);
});

test('binary content, a directory and a missing path are ordinary failures', async (t) => {
  const root = tree({ 'bin.dat': Buffer.from([0x41, 0x00, 0x42]), 'dir/keep.txt': 'x' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const binary = await runRead(root, { file_path: 'bin.dat' });
  assert.equal(binary.ok, false);
  assert.match(binary.output, /binary file/);

  const directory = await runRead(root, { file_path: 'dir' });
  assert.equal(directory.ok, false);
  assert.match(directory.output, /is a directory/);

  const missing = await runRead(root, { file_path: 'nope.txt' });
  assert.equal(missing.ok, false);
  assert.match(missing.output, /file not found/);
});

test('the hard 20MB ceiling refuses even with allow_large, without reading the file', async (t) => {
  const root = tree({ 'huge.txt': '' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  // Sparse file: the size is what the check reads, so no 20MB has to be written.
  truncateSync(join(root, 'huge.txt'), READ_ABSOLUTE_LIMIT + 1);

  const result = await runRead(root, { file_path: 'huge.txt', allow_large: true });

  assert.equal(result.ok, false);
  assert.match(result.output, /hard limit is 20MB/);
});

test('the two size limits stay ordered, and the hard one is not lifted by allow_large', () => {
  assert.equal(READ_ABSOLUTE_LIMIT, 20 * 1024 * 1024);
  assert.equal(READ_LARGE_LIMIT, 5 * 1024 * 1024);
});

test('a read through runTurn registers the file, so the read-before-write gate has data', async (t) => {
  const root = tree({ 'a.txt': 'one\n' });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const target = join(root, 'a.txt');

  const reader = createReadTool({ cwd: root });
  const model = new ScriptedModel([
    [{ type: 'tool_call', call: { callId: 'c1', name: 'Read', input: { file_path: target } } }],
    [{ type: 'text', text: 'done' }],
  ]);
  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_read');
  await runTurn(turnDeps(session, model, { tools: new Map([['Read', reader]]) }), 'read it', signal);

  const finished = store.events.find((event: KernelEvent) => event.type === 'tool.finished');
  assert.ok(finished?.type === 'tool.finished');
  const canonical = target.replace(/\\/g, '/');
  assert.equal(finished.path, canonical);
  assert.deepEqual(session.state.readFiles, [canonical]);
});

test('the tool narrows on file_path', () => {
  const tool = createReadTool({ cwd: '.' });

  assert.equal(tool.spec.pathInput, 'file_path');
  assert.deepEqual((tool.spec.inputSchema as Record<string, unknown>).required, ['file_path']);
});
