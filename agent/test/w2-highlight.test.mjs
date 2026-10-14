// W2 Task 7: regex-lexer syntax highlighting for six languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getTheme } from '../src/tui/theme.js';
import { highlightCode, LANGUAGES, tokenizeLine } from '../src/tui/highlight.js';

const theme = getTheme('dark', '256');
const CYAN = '\x1b[38;5;74m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('highlight: LANGUAGES lists the six supported languages', () => {
  assert.deepEqual(LANGUAGES, ['js', 'ts', 'python', 'sh', 'json', 'md']);
});

test('highlight: js keywords, strings, comments and numbers map to spec colors', () => {
  const out = highlightCode('const n = 42 // note', 'js', theme);
  assert.ok(out.includes(`${theme.permission}const${RESET}`));
  assert.ok(out.includes(`${theme.success}42${RESET}`));
  assert.ok(out.includes(`${DIM}${theme.success}// note${RESET}`));
  const str = highlightCode('const s = "hi"', 'js', theme);
  assert.ok(str.includes(`${theme.error}"hi"${RESET}`));
});

test('highlight: js function call names are yellow, variables stay blue', () => {
  const out = highlightCode('foo(bar)', 'js', theme);
  assert.ok(out.includes(`${theme.warning}foo${RESET}`));
  assert.ok(out.includes(`${theme.permission}bar${RESET}`));
});

test('highlight: js block comment state persists across lines', () => {
  const out = highlightCode('/* a\nb */ const x', 'js', theme);
  assert.ok(out.includes(`${DIM}${theme.success}/*${RESET}`));
  assert.ok(out.includes(`${DIM}${theme.success}b */${RESET}`));
  assert.ok(out.includes(`${theme.permission}const${RESET}`));
});

test('highlight: js template string spans lines as one string', () => {
  const out = highlightCode('const s = `a\nb`;', 'js', theme);
  assert.ok(out.includes(`${theme.error}a${RESET}`));
  assert.ok(out.includes(`${theme.error}b\`${RESET}`));
});

test('highlight: python def, decorator, comment and builtins', () => {
  const out = highlightCode('@dec\ndef f():\n    pass  # note', 'python', theme);
  assert.ok(out.includes(`${theme.inactive}@dec${RESET}`));
  assert.ok(out.includes(`${theme.permission}def${RESET}`));
  assert.ok(out.includes(`${theme.warning}f${RESET}`));
  assert.ok(out.includes(`${DIM}${theme.success}# note${RESET}`));
  const bi = highlightCode('print(len(xs))', 'python', theme);
  assert.ok(bi.includes(`${CYAN}print${RESET}`));
  assert.ok(bi.includes(`${CYAN}len${RESET}`));
});

test('highlight: python triple-quoted string state persists across lines', () => {
  const out = highlightCode('s = """a\nb"""\nx = 1', 'python', theme);
  assert.ok(out.includes(`${theme.error}a${RESET}`));
  assert.ok(out.includes(`${theme.error}b"""${RESET}`));
  assert.ok(out.includes(`${theme.permission}x${RESET}`));
});

test('highlight: json keys cyan, strings red, numbers green, literals blue', () => {
  const out = highlightCode('{"key": "val", "n": 42, "ok": true}', 'json', theme);
  assert.ok(out.includes(`${CYAN}"key"${RESET}`));
  assert.ok(out.includes(`${theme.error}"val"${RESET}`));
  assert.ok(out.includes(`${theme.success}42${RESET}`));
  assert.ok(out.includes(`${theme.permission}true${RESET}`));
});

test('highlight: sh shebang comment, builtins and variables', () => {
  const out = highlightCode('#!/bin/bash\necho $VAR', 'sh', theme);
  assert.ok(out.includes(`${DIM}${theme.success}#!/bin/bash${RESET}`));
  assert.ok(out.includes(`${CYAN}echo${RESET}`));
  assert.ok(out.includes(`${CYAN}$VAR${RESET}`));
});

test('highlight: ts type annotations are cyan while js treats the same token as a name', () => {
  const ts = highlightCode('const s: string = 1', 'ts', theme);
  assert.ok(ts.includes(`${CYAN}string${RESET}`));
  const js = highlightCode('const s: string = 1', 'js', theme);
  assert.ok(js.includes(`${theme.permission}string${RESET}`));
  assert.ok(!js.includes(`${CYAN}string${RESET}`));
});

test('highlight: md heading markers get the keyword color', () => {
  const out = highlightCode('# Title', 'md', theme);
  assert.ok(out.includes(`${theme.permission}#${RESET}`));
  assert.ok(stripAnsi(out).includes('Title'));
});

test('highlight: unknown languages are returned verbatim without ANSI', () => {
  const code = 'mov a, b';
  assert.equal(highlightCode(code, 'cobol', theme), code);
  assert.equal(highlightCode(code, '', theme), code);
  assert.ok(!highlightCode(code, 'cobol', theme).includes('\x1b'));
});

test('highlight: language aliases normalize to canonical names', () => {
  const sample = 'const x = 1';
  const aliases = [
    ['javascript', 'js'], ['jsx', 'js'],
    ['typescript', 'ts'], ['tsx', 'ts'],
    ['py', 'python'], ['bash', 'sh'], ['shell', 'sh'], ['zsh', 'sh'],
    ['markdown', 'md'],
  ];
  for (const [alias, canon] of aliases) {
    assert.equal(highlightCode(sample, alias, theme), highlightCode(sample, canon, theme), alias);
  }
});

test('highlight: output is newline-terminated and preserves the source text', () => {
  const out = highlightCode('a\nb', 'js', theme);
  assert.ok(out.endsWith('\n'));
  assert.equal(stripAnsi(out), 'a\nb\n');
  assert.equal(stripAnsi(highlightCode('a\nb\n', 'js', theme)), 'a\nb\n');
});

test('highlight: strip-ansi output matches the source at every theme and level', () => {
  const sample = 'const n = 42 // answer';
  for (const name of ['dark', 'light']) {
    for (const level of ['16', '256', '24bit']) {
      const out = highlightCode(sample, 'js', getTheme(name, level));
      assert.equal(stripAnsi(out), sample + '\n', `${name}/${level}`);
    }
  }
});

test('tokenizeLine: ordered sticky rules split plain and token spans', () => {
  const rules = [
    { re: /\bif\b/y, token: 'keyword' },
    { re: /\d+/y, token: 'number' },
  ];
  assert.deepEqual(tokenizeLine(rules, 'ifx if 12', {}), [
    { text: 'ifx ', token: null },
    { text: 'if', token: 'keyword' },
    { text: ' ', token: null },
    { text: '12', token: 'number' },
  ]);
});

test('tokenizeLine: block-comment state carries across lines', () => {
  const rules = [
    { re: /\/\*/y, token: 'comment', enter: () => ({ inBlockComment: '*/' }) },
  ];
  const state = {};
  const first = tokenizeLine(rules, '/* x', state);
  assert.deepEqual(first, [
    { text: '/*', token: 'comment' },
    { text: ' x', token: 'comment' },
  ]);
  assert.equal(state.inBlockComment, '*/');
  const second = tokenizeLine(rules, 'y */ z', state);
  assert.deepEqual(second, [
    { text: 'y */', token: 'comment' },
    { text: ' z', token: null },
  ]);
  assert.deepEqual(state, {});
});
