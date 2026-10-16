// Live multimodal check (opt-in, needs a configured provider + real key).
//
// Unlike the MCP live scripts, this one talks to YOUR configured provider — it
// reads the same config CowCat uses (COWCAT_HOME/config.json) and drives the real
// path: Read tool -> attachment reference -> provider wire format -> model.
//
//   node agent/test/live/multimodal.mjs
//
// What it proves, per case:
//   image    the picture actually reaches the model (it answers about colours it
//            could not know otherwise) + how the token estimate compares to the
//            provider's reported prompt_tokens
//   pdf      the document path works on this protocol: native document block on
//            Anthropic, best-effort text extraction on OpenAI-compatible
//   ipynb    cell rendering round-trips through a real model
// A refusal from the endpoint (e.g. a coding-plan model that rejects image_url)
// is reported as a FAIL with the errfmt hint rendering, so the failure is
// actionable rather than opaque.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveModelConfig } from '../../src/config.js';
import { OpenAIProvider } from '../../src/llm/openai.js';
import { AnthropicProvider } from '../../src/llm/anthropic.js';
import { ReadTool } from '../../src/tools/read.js';
import { visionCapability } from '../../src/vision.js';
import { parseApiError, formatApiErrorLines } from '../../src/errfmt.js';
import { makePngRgb, makePdf } from '../fixtures/media.mjs';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const eff = resolveModelConfig({ ...loadConfig() });
console.log(`provider: ${eff.provider} | model: ${eff.model} | protocol: ${eff.protocol}`);
console.log(`baseURL : ${eff.baseURL}`);
console.log(`apiKey  : ${eff.apiKey ? `present (len ${eff.apiKey.length})` : '(absent — cannot run live checks)'}`);
if (!eff.apiKey) {
  console.log('\n没有可用的 API key（config.json / 环境变量），跳过。');
  process.exit(2);
}
const cap = visionCapability(eff);
console.log(`vision  : catalog says "${cap.support}" (source: ${cap.source}${cap.modelId ? `, model ${cap.modelId}` : ''})`);
console.log('');

const provider = eff.protocol === 'anthropic' ? new AnthropicProvider(eff) : new OpenAIProvider(eff);
const dir = mkdtempSync(join(tmpdir(), 'cowcat-mm-live-'));

// Three vertical colour bars: red | green | blue. A model that cannot see the
// image cannot name them in order.
const BAR_W = 200;
const BAR_H = 200;
const barsPng = makePngRgb(BAR_W * 3, BAR_H, (x) => (x < BAR_W ? [255, 0, 0] : x < BAR_W * 2 ? [0, 170, 0] : [0, 0, 255]));

const PDF_TOKEN = 'KESTREL-7788';
const pdf = makePdf([
  'Quarterly engineering notes for the platform team.',
  `Project code: ${PDF_TOKEN}. Owner: platform reliability group.`,
  'The migration window remains unchanged and no downtime is expected.',
  'Follow-up items are tracked in the usual weekly review meeting.',
]);

const notebook = `${JSON.stringify({
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Smoke notebook', '\n', 'Cells below exercise the renderer.'] },
    { cell_type: 'code', execution_count: 1, metadata: {}, outputs: [{ output_type: 'stream', name: 'stdout', text: ['loaded\n'] }], source: ['def kestrel_load(path):\n', '    return path.strip()\n'] },
  ],
  metadata: { kernelspec: { name: 'python3' } },
  nbformat: 4,
  nbformat_minor: 5,
}, null, 2)}\n`;

const files = {
  bars: join(dir, 'bars.png'),
  pdf: join(dir, 'report.pdf'),
  nb: join(dir, 'smoke.ipynb'),
};
writeFileSync(files.bars, barsPng);
writeFileSync(files.pdf, pdf);
writeFileSync(files.nb, notebook);

// Drive the real path for one file: Read produces the tool_result (with an
// attachment when there is one), the question rides in the same user message,
// exactly like loop.js arranges it.
async function ask(filePath, question, { maxTokens = 120 } = {}) {
  const ctx = { cwd: dir, readSet: new Set(), config: eff };
  const read = ReadTool.execute({ file_path: filePath }, ctx);
  if (!read.ok) return { readError: read.error };
  const toolResult = { type: 'tool_result', tool_use_id: 'tu_1', content: read.output };
  if (read.attachments?.length) toolResult.attachments = read.attachments;
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: filePath } }] },
    { role: 'user', content: [toolResult, { type: 'text', text: question }] },
  ];
  const started = Date.now();
  const call = () => provider.chat({
    system: 'You answer questions about files that were just read. Be brief and literal.',
    messages, maxTokens, stream: false, timeoutMs: 90000,
  });
  try {
    let res;
    try {
      res = await call();
    } catch (e) {
      // One retry for transient network failures: a live check that fails on a
      // blip tells you nothing about the feature under test.
      if (!/fetch failed|ECONNRESET|socket hang up|ETIMEDOUT|EAI_AGAIN/i.test(String(e.message))) throw e;
      console.log(`      （网络瞬时错误，重试一次：${String(e.message).slice(0, 60)}）`);
      res = await call();
    }
    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return {
      text,
      usage: res.usage,
      ms: Date.now() - started,
      readOutput: read.output,
      attachmentTokens: (read.attachments || []).reduce((n, a) => n + a.tokens, 0),
    };
  } catch (e) {
    return { error: e, cause: e.cause?.code || e.cause?.message || null, ms: Date.now() - started, readOutput: read.output };
  }
}

function reportRefusal(label, error) {
  const parsed = parseApiError(error);
  const { lines } = formatApiErrorLines(parsed, { lang: 'zh' });
  if (parsed.hint === 'visionUnsupported') {
    check(`${label}: 上游拒绝被翻译成「模型可能不支持图片输入」`, true, `hint=${parsed.hint}`);
  } else {
    console.log(`      上游错误（hint=${parsed.hint ?? 'none'}）——不是视觉能力问题：`);
  }
  for (const l of lines) console.log(`      ${l}`);
}

// --- image -------------------------------------------------------------------
{
  const r = await ask(files.bars, '图里从左到右是三个垂直色条。只回答这三个颜色，用逗号分隔，不要解释。');
  if (r.readError) {
    check('image: Read 接受图片', false, r.readError);
  } else if (r.error) {
    check('image: 模型能描述图片内容', false, `request failed: ${r.error.message.slice(0, 200)}`);
    reportRefusal('image', r.error);
  } else {
    const seen = String(r.text);
    const ok = /红(色)?\s*[,，、]\s*绿(色)?\s*[,，、]\s*蓝(色)?/.test(seen)
      || /red\s*[,;]?\s*green\s*[,;]?\s*blue/i.test(seen);
    check('image: 模型能描述图片内容', ok, `answer="${seen.replace(/\s+/g, ' ').slice(0, 80)}" (${r.ms}ms)`);
    const pt = r.usage?.input_tokens ?? r.usage?.prompt_tokens ?? null;
    console.log(`      估算 ${r.attachmentTokens} tokens（附件） vs 上游报 ${pt ?? '?'}（prompt_tokens 含 system/文本）`);
    if (pt !== null) check('image: 估算与上游同量级（3x 以内，仅提示不阻塞）', pt <= r.attachmentTokens * 3 + 2000, `estimate=${r.attachmentTokens} actual_prompt=${pt}`);
  }
}

// --- pdf ---------------------------------------------------------------------
{
  const r = await ask(files.pdf, '这份 PDF 里出现的项目代号是什么？只回答代号本身。', { maxTokens: 60 });
  if (r.readError) {
    check('pdf: Read 接受 PDF', false, r.readError);
  } else if (r.error) {
    check('pdf: 模型读到了 PDF 内容', false, `request failed: ${r.error.message.slice(0, 200)}`);
    for (const l of formatApiErrorLines(parseApiError(r.error), { lang: 'zh' }).lines) console.log(`      ${l}`);
  } else {
    console.log(`      Read 输出首行: ${String(r.readOutput).split('\n')[0].slice(0, 110)}`);
    check('pdf: 模型读到了 PDF 内容', String(r.text).includes(PDF_TOKEN), `answer="${String(r.text).replace(/\s+/g, ' ').slice(0, 60)}" (${r.ms}ms)`);
  }
}

// --- notebook ----------------------------------------------------------------
{
  const r = await ask(files.nb, '第 2 个单元格（cell index 1）里定义的函数名是什么？只回答函数名。', { maxTokens: 60 });
  if (r.readError) {
    check('ipynb: Read 渲染 notebook', false, r.readError);
  } else if (r.error) {
    check('ipynb: 模型读到了单元格源码', false, `request failed: ${r.error.message.slice(0, 200)}`);
  } else {
    check('ipynb: 模型读到了单元格源码', /kestrel_load/.test(String(r.text)), `answer="${String(r.text).replace(/\s+/g, ' ').slice(0, 60)}" (${r.ms}ms)`);
    check('ipynb: 渲染含 cell 索引与输出', /--- cell \[1\] code/.test(r.readOutput) && /--- output \[1\.0\] stream/.test(r.readOutput));
  }
}

console.log('');
if (failures) {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
} else {
  console.log('ALL CHECKS PASSED');
}
