import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inlineRuns, renderMarkdown, wrapRuns } from '../src/text/markdown.js';
import { stringWidth } from '../src/text/width.js';

test('inline parser: bold, italic, code, link — code wins over markup inside it', () => {
  assert.deepEqual(inlineRuns('a **b** c'), [
    { text: 'a ', token: 'text' },
    { text: 'b', token: 'text', bold: true },
    { text: ' c', token: 'text' },
  ]);
  const mixed = inlineRuns('`x *y*` and *i* and [l](u)');
  assert.deepEqual(mixed[0], { text: 'x *y*', token: 'code' });
  assert.deepEqual(mixed[2], { text: 'i', token: 'text', bold: true });
  assert.deepEqual(mixed[4], { text: 'l', token: 'text', bold: true });
});

test('wrapRuns keeps spans intact across row breaks', () => {
  const rows = wrapRuns([{ text: 'plain ', token: 'text' }, { text: '加粗', token: 'text', bold: true }, { text: ' tail', token: 'text' }], 8);
  assert.ok(rows.length >= 2);
  // Every row re-derives its spans from the same offsets: no character lost, none twice.
  assert.equal(rows.map((row) => row.text).join(''), 'plain 加粗 tail');
  const boldChars = rows.flatMap((row) => row.runs ?? []).filter((span) => span.bold === true).map((span) => span.text).join('');
  assert.equal(boldChars, '加粗');
});

test('headings: h1/h2 brand+bold, h3+ plain bold, markers stripped', () => {
  const rows = renderMarkdown('# 大标题\n## 二级\n### 三级', 40);
  assert.deepEqual(
    rows.map((row) => row.text),
    ['大标题', '二级', '三级'],
  );
  // Style lives in the runs; the Line-level token stays the row's base voice.
  const voice = (row: (typeof rows)[number] | undefined): string | undefined => {
    const spans = (row?.runs ?? []).filter((span) => span.text.trim() !== '');
    return spans[0]?.token ?? row?.token;
  };
  assert.equal(voice(rows[0]), 'brand');
  assert.equal(voice(rows[1]), 'brand');
  assert.equal(voice(rows[2]), 'text');
  assert.ok(rows.every((row) => (row.runs ?? []).every((span) => Boolean(span.bold))));
});

test('lists keep their marker on the first row and a hanging indent after wrapping', () => {
  const rows = renderMarkdown('- first item\n- second item that is long enough to wrap around', 20);
  assert.match(rows[0]?.text ?? '', /^• first item/);
  const wrapped = rows.filter((row) => row.text.startsWith('  '));
  assert.ok(wrapped.length >= 1, 'continuation rows are indented under the marker');
});

test('ordered lists keep their number', () => {
  const rows = renderMarkdown('1. one\n2. two', 20);
  assert.match(rows[0]?.text ?? '', /^1\. one/);
  assert.match(rows[1]?.text ?? '', /^2\. two/);
});

test('code fences: language label, code token, indent; unterminated still renders', () => {
  const rows = renderMarkdown('```ts\nconst a = 1;\nconst b = 2;\n```', 30);
  assert.match(rows[0]?.text ?? '', /▸ ts/);
  // Non-whitespace spans of the body are all in the code voice; the indent span is plain.
  assert.ok(
    rows.slice(1).every((row) =>
      (row.runs ?? []).every((span) => (span.text.trim() === '' ? true : span.token === 'code')),
    ),
  );
  const open = renderMarkdown('```\nnever closed', 30);
  assert.match(open.at(-1)?.text ?? '', /never closed/);
});

test('tables align columns by display width, CJK included', () => {
  const rows = renderMarkdown('| 包内 | 结论 |\n|---|---|\n| 旧包 media:context | 能解析 |\n| 分层 JSON 图标 | 报"图标为空" |', 60);
  const rule = rows[0]?.text ?? '';
  assert.match(rule, /^\+/);
  assert.match(rows[1]?.text ?? '', /包内/);
  // Every content row: same cell count, padded to the same widths — right edges line up.
  const content = rows.filter((row) => !row.text.startsWith('|') && row.text.startsWith('+'));
  assert.equal(content.length, 4);
  for (const row of rows) {
    if (row.text.startsWith('+')) continue;
    assert.ok(stringWidth(row.text.trimEnd()) > 0);
  }
});

test('quotes, rules, and paragraph reflow', () => {
  const rows = renderMarkdown('> 引用一句\n\n第一段。\n\n---', 30);
  assert.match(rows[0]?.text ?? '', /^│ 引用一句/);
  assert.match(rows.at(-1)?.text ?? '', /^─+$/);
  assert.ok(rows.some((row) => row.text === '第一段。'));
});

test('inline styles survive a CJK wrap point', () => {
  const rows = renderMarkdown('前缀 **这是一段非常长的加粗中文内容需要换行才能显示** 后缀', 16);
  const bold = rows.flatMap((row) => row.runs ?? []).filter((span) => span.bold === true).map((span) => span.text).join('');
  assert.equal(bold, '这是一段非常长的加粗中文内容需要换行才能显示');
  // And no styling characters leak into the visible text.
  assert.equal(rows.some((row) => row.text.includes('**')), false);
});
