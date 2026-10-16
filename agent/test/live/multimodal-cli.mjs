// Live CLI check for the multimodal batch: does the FULL path work — CLI ->
// loop -> Read -> provider, and CLI -> model -> NotebookEdit -> disk?
//
//   node agent/test/live/multimodal-cli.mjs
//
// Two invocations, because they need different trust states:
//   1. cwd = a fresh temp dir (untrusted -> read-only plan mode): the image must
//      still be readable and describable (Read is read-only).
//   2. cwd = an already-trusted project dir (from ~/.cowcat/state.json), with -y:
//      the model may call NotebookEdit on a notebook that lives in the temp dir.
//      The trusted dir itself must end up untouched (verified afterwards).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, readState } from '../../src/config.js';
import { makePngRgb } from '../fixtures/media.mjs';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', '..', 'bin', 'cowcat.mjs');
const cfg = loadConfig();
if (!cfg.apiKey) {
  console.log('没有可用的 API key，跳过（先在 CowCat 里配好 provider）。');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'cowcat-mm-cli-'));
const BAR = 120;
const barsPath = join(dir, 'bars.png');
writeFileSync(barsPath, makePngRgb(BAR * 3, BAR, (x) => (x < BAR ? [255, 0, 0] : x < BAR * 2 ? [0, 170, 0] : [0, 0, 255])));

const nbPath = join(dir, 'smoke.ipynb');
writeFileSync(nbPath, `${JSON.stringify({
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Smoke'] },
    { cell_type: 'code', execution_count: 1, metadata: {}, outputs: [], source: ['def kestrel_load(path):\n', '    return path.strip()\n'] },
  ],
  metadata: {}, nbformat: 4, nbformat_minor: 5,
}, null, 2)}\n`);

const runCli = (cwd, prompt, extraArgs = []) => {
  try {
    const out = execFileSync(process.execPath, [BIN, '-p', prompt, ...extraArgs], {
      cwd, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}\n${e.stderr || ''}`, code: e.status };
  }
};

// --- 1) image in an untrusted (read-only) cwd --------------------------------
const q1 = `读 ${barsPath} ，说出这条图片从左到右三个垂直色条的颜色，用逗号分隔。`;
const r1 = runCli(dir, q1);
const a1 = String(r1.out);
const colorsOk = /红(色)?\s*[,，、]\s*绿(色)?\s*[,，、]\s*蓝(色)?/.test(a1) || /red\s*[,;]?\s*green\s*[,;]?\s*blue/i.test(a1);
check('CLI(未信任目录/只读): 模型读图并答出颜色', colorsOk, `答案片段="${(a1.match(/[^\n]*(红|颜色|red)[^\n]*/) || [a1.slice(-80)])[0].trim().slice(0, 70)}"`);
check('CLI: 只读会话没有因图片被拒', !/denied|plan mode/i.test(a1) || colorsOk);

// --- 2) NotebookEdit through the model, in a trusted cwd ----------------------
const trusted = (readState().trustedProjects || [])[0] || null;
if (!trusted || !existsSync(trusted)) {
  console.log('SKIP  没有已信任目录可用（state.json 的 trustedProjects 为空），跳过 NotebookEdit 的 CLI 检查。');
} else {
  const before = readdirSync(trusted).sort().join(',');
  const q2 = `用 NotebookEdit 把 ${nbPath} 里第 2 个单元格（cell index 1）的源码改成：def kestrel_load(path):\\n    return 'PATCHED' 。改完只回答 done。`;
  const r2 = runCli(trusted, q2, ['-y']);
  const nb = JSON.parse(readFileSync(nbPath, 'utf8'));
  const src = (Array.isArray(nb.cells[1].source) ? nb.cells[1].source.join('') : nb.cells[1].source);
  check('CLI(已信任/-y): 模型调用 NotebookEdit 并落到磁盘', src.includes('PATCHED'), `cell[1].source="${src.replace(/\n/g, '\\n').slice(0, 60)}"`);
  check('CLI: 只改了目标单元格', nb.cells.length === 2 && nb.cells[0].cell_type === 'markdown'
    && (Array.isArray(nb.cells[1].source) ? nb.cells[1].source.join('') : '').includes('kestrel_load'));
  check('CLI: 已信任目录本身未被写入', readdirSync(trusted).sort().join(',') === before, `cwd=${trusted}`);
  if (!r2.ok) console.log(`      CLI 退出码 ${r2.code}（工具可能被拒；输出尾部: ${String(r2.out).slice(-160).replace(/\s+/g, ' ')}）`);
}

console.log('');
if (failures) {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
} else {
  console.log('ALL CHECKS PASSED');
}
