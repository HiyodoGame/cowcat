// Local PDF extraction report — the tool used to judge how the extractor behaves
// on REAL documents, without printing any of their text.
//
//   node agent/test/live/pdf-extract-report.mjs <file.pdf> [more.pdf ...]
//
// It prints, per file: detected size/page count, whether extraction succeeded,
// the character count, the printable/letter/CJK shares, and the refusal reason.
// Content never leaves the process, so private documents can be measured safely
// (that is the whole point: the numbers are enough to tell "works" from "noise").
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { extractPdfText } from '../../src/pdftext.js';
import { countPdfPages, sniffBuffer, formatBytes } from '../../src/imageinfo.js';
import { MAX_PDF_BYTES } from '../../src/attach.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.log('用法: node agent/test/live/pdf-extract-report.mjs <file.pdf> [...]');
  process.exit(2);
}

function shares(text) {
  let printable = 0;
  let latin = 0;
  let cjk = 0;
  let replacement = 0;
  const chars = [...text];
  for (const ch of chars) {
    const c = ch.codePointAt(0);
    if (ch === '\uFFFD') { replacement++; continue; }
    if (/[\p{L}\p{N}\p{P}\p{Zs}\n\t]/u.test(ch)) printable++;
    if (/[A-Za-z]/.test(ch)) latin++;
    if (c >= 0x4e00 && c <= 0x9fff) cjk++;
  }
  const n = chars.length || 1;
  return {
    printable: Math.round((printable / n) * 100),
    latin: Math.round((latin / n) * 100),
    cjk: Math.round((cjk / n) * 100),
    replacement,
  };
}

let failed = 0;
for (const file of files) {
  console.log(`\n${basename(file)}`);
  let buf;
  try {
    buf = readFileSync(file);
  } catch (e) {
    console.log(`  ! 读不到: ${e.message}`);
    failed++;
    continue;
  }
  const size = statSync(file).size;
  const info = sniffBuffer(buf);
  const pages = countPdfPages(buf);
  console.log(`  sniff=${info.kind} | ${formatBytes(size)} | 页数(粗计)=${pages || '未测出'}`
    + (size > MAX_PDF_BYTES ? ` | 超过 ${formatBytes(MAX_PDF_BYTES)} 上限，Read 会先按大小拒绝` : ''));
  const r = extractPdfText(buf);
  if (r.ok) {
    const s = shares(r.text);
    console.log(`  → 抽取成功: ${r.chars} 字符 | 可打印 ${s.printable}% | 拉丁字母 ${s.latin}% | 汉字 ${s.cjk}% | U+FFFD ${s.replacement}`);
    console.log(`    统计: 码表覆盖 ${r.stats ? Math.round(r.stats.mappedRatio * 100) : 'n/a'}% | 页面 ${r.stats?.pages ?? '-'} | 字体 ${r.stats?.fonts ?? '-'}${r.truncated ? ' | 已截断' : ''}`);
  } else {
    console.log(`  → 拒绝: ${r.reason}`);
    failed++;
  }
}
console.log(`\n${files.length - failed}/${files.length} 份可抽取`);
process.exitCode = failed ? 1 : 0;
