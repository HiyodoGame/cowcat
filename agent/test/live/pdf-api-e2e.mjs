// API-level end-to-end for real PDFs: does the model actually RECEIVE the text
// that the local extractor produced?
//
//   node agent/test/live/pdf-api-e2e.mjs <file.pdf> [--show-snippet]
//
// How it proves something: it extracts the PDF locally (the same text the model
// will see), picks two probe lines — the first non-empty line and one from the
// middle — then asks the model to quote them back verbatim. A model that never
// got the text cannot reproduce a middle line, and it cannot cheat from the tool
// header either, because the file is copied to a temp dir as `sample.pdf`.
//
// Privacy: by default nothing from the document is printed — not the probes, not
// the model's answer — only lengths and match results. Pass --show-snippet for a
// public document when you want to eyeball the actual strings.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { loadConfig, resolveModelConfig } from '../../src/config.js';
import { OpenAIProvider } from '../../src/llm/openai.js';
import { AnthropicProvider } from '../../src/llm/anthropic.js';
import { ReadTool } from '../../src/tools/read.js';

const args = process.argv.slice(2);
const showSnippet = args.includes('--show-snippet');
const input = args.find((a) => !a.startsWith('--'));
if (!input) {
  console.log('用法: node agent/test/live/pdf-api-e2e.mjs <file.pdf> [--show-snippet]');
  process.exit(2);
}

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};
const show = (s, max = 90) => (showSnippet ? `"${String(s).slice(0, max)}"` : `(len ${[...String(s)].length}，未显示)`);

const eff = resolveModelConfig({ ...loadConfig() });
if (!eff.apiKey) {
  console.log('没有可用的 API key，跳过。');
  process.exit(2);
}
console.log(`provider: ${eff.provider} | model: ${eff.model} | protocol: ${eff.protocol}`);
console.log(`document: ${basename(input)}（${showSnippet ? '会显示片段' : '不显示内容'}）\n`);

// Neutral copy: the Read header carries the file name, and a telling name would
// let the model "answer" without reading anything.
const dir = mkdtempSync(join(tmpdir(), 'cowcat-pdf-e2e-'));
const neutral = join(dir, 'sample.pdf');
copyFileSync(input, neutral);

const ctx = { cwd: dir, readSet: new Set(), config: eff };
const read = ReadTool.execute({ file_path: neutral }, ctx);
if (!read.ok) {
  check('Read 抽取该 PDF', false, read.error);
  console.log('\n1 CHECK(S) FAILED');
  process.exit(1);
}
console.log(`抽取: ${String(read.output).length} 字符输出${read.attachments ? '（走 Anthropic document 块）' : '（本地文本抽取）'}`);
check('Read 抽取成功', true);

const text = String(read.output).split('\n').slice(1).join('\n'); // drop the [pdf] header line
const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length >= 6);
const probeA = lines[0];
console.log(`探针（开头文字）: ${show(probeA)}\n`);

const provider = eff.protocol === 'anthropic' ? new AnthropicProvider(eff) : new OpenAIProvider(eff);
const normalize = (s) => String(s)
  .replace(/[\s\u3000]+/g, '')
  .replace(/[，。、；：""''（）《》【】·．.,;:"'()<>[\]-]/g, '')
  .toLowerCase();

async function ask(question) {
  const toolResult = { type: 'tool_result', tool_use_id: 'tu_1', content: read.output };
  if (read.attachments?.length) toolResult.attachments = read.attachments;
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: neutral } }] },
    { role: 'user', content: [toolResult, { type: 'text', text: question }] },
  ];
  // A reasoning model spends tokens on thinking before it answers, so the budget
  // must cover both — 300 was consumed entirely by reasoning and produced an
  // empty answer (which then matched everything in a naive includes() check).
  try {
    const res = await provider.chat({
      system: 'You answer questions about a document that was just read. Quote exactly; never guess.',
      messages, maxTokens: 2000, stream: false, timeoutMs: 120000,
    });
    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const thinking = (res.content || []).filter((b) => b.type === 'thinking').reduce((n, b) => n + String(b.thinking || '').length, 0);
    return { ok: true, text, stopReason: res.stopReason ?? null, thinkingChars: thinking };
  } catch (e) {
    return { ok: false, error: `${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}` };
  }
}

// Longest run of characters the answer shares with the document, ignoring
// whitespace/punctuation. Used as a "the answer is really about THIS document"
// signal (a model without the document cannot produce long verbatim runs).
function longestSharedRun(answer, doc) {
  const a = normalize(answer);
  const d = normalize(doc);
  if (!a) return 0;
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    let len = 0;
    while (i + len < a.length && d.includes(a.slice(i, i + len + 1))) len++;
    if (len > best) best = len;
  }
  return best;
}

const qA = '这份文档最开头出现的文字是什么？请逐字复述你在文档最前面看到的内容（可以包含编号、独立字母、符号），只回答原文。';
const rA = await ask(qA);
if (!rA.ok) {
  check('模型复述文档开头文字', false, `请求失败: ${rA.error}`);
} else if (!rA.text) {
  check('模型复述文档开头文字', false, `回答为空（stop_reason=${rA.stopReason}，thinking ${rA.thinkingChars} 字符）`);
} else {
  // Robust form: the answer only has to be a verbatim slice of the document's
  // opening. Cover pages often lay large lettering out glyph by glyph (this
  // standard's text starts with lone "I"/"C"/"S" lines), so "the first line" is
  // ambiguous — but a verbatim substring of the head cannot be invented.
  const a = normalize(rA.text);
  const head = normalize(text.slice(0, 1500));
  const hit = a.length >= 4 && (head.includes(a) || a.includes(normalize(probeA)));
  check('模型复述文档开头文字（须是开头区域的逐字子串）', hit, `回答 ${show(rA.text, 60)}`);
}

const qB = '这份文档讲的是什么？用一到两句话概括它的主题和适用对象。';
const rB = await ask(qB);
if (!rB.ok) {
  check('模型概括文档主题', false, `请求失败: ${rB.error}`);
} else if (!rB.text) {
  check('模型概括文档主题', false, `回答为空（stop_reason=${rB.stopReason}，thinking ${rB.thinkingChars} 字符）`);
} else {
  const run = longestSharedRun(rB.text, text);
  check('模型概括文档主题，且与文档原文有实质重合', run >= 6, `最长重合 ${run} 字符 | 回答 ${show(rB.text, 70)}`);
}

console.log('');
if (failures) {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
} else {
  console.log('ALL CHECKS PASSED');
}
