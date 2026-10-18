#!/usr/bin/env node
// Probe: what P6 can actually MEASURE from a non-TTY process.
//
// P6's open questions include "自研还是 ink，以实际终端的刷新率与闪烁做测量". That
// measurement needs a real terminal and a human eye, and this process is neither. So
// this probe measures the three things that ARE measurable here, and prints them as
// numbers rather than as claims:
//
//   1. what this machine's environment reports about the terminal (and what the legacy
//      detector concludes from it),
//   2. whether the legacy grapheme-aware width function agrees with a hand-annotated
//      corpus — the failure mode being a mis-sized row, which shifts every column after
//      it,
//   3. what it costs to build one 200x50 frame, which is the budget a 60fps redraw has
//      to fit in (16.7ms) — reported, not asserted: this machine's numbers say nothing
//      about anyone else's.
//
// Usage: node tools/p6-tui-probe.mjs
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
let cases = 0;
function check(label, expectation, actual) {
  cases += 1;
  const ok = JSON.stringify(expectation) === JSON.stringify(actual);
  if (!ok) failures.push({ label, expectation, actual });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}`);
}

// pathToFileURL: import() of a "F:\..." path is rejected by the ESM loader (AGENTS.md).
const wcwidth = await import(pathToFileURL(join(ROOT, 'agent', 'src', 'tui', 'wcwidth.js')).href);
const capabilities = await import(pathToFileURL(join(ROOT, 'agent', 'src', 'tui', 'capabilities.js')).href);

console.log('== 1. this machine ==');
const env = process.env;
const snapshot = {
  TERM: env.TERM ?? null,
  COLORTERM: env.COLORTERM ?? null,
  TERM_PROGRAM: env.TERM_PROGRAM ?? null,
  WT_SESSION: env.WT_SESSION !== undefined,
  KITTY_WINDOW_ID: env.KITTY_WINDOW_ID !== undefined,
  WEZTERM_VERSION: env.WEZTERM_VERSION ?? null,
  TMUX: env.TMUX !== undefined,
  CI: env.CI !== undefined,
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  columns: process.stdout.columns ?? null,
  rows: process.stdout.rows ?? null,
  node: process.version,
  platform: process.platform,
};
for (const [key, value] of Object.entries(snapshot)) console.log(`     ${key}: ${JSON.stringify(value)}`);
console.log('     detectCapabilities(env, isTTY=false):', JSON.stringify(capabilities.detectCapabilities({ env, stdinIsTTY: false, stdoutIsTTY: false })));
console.log('     detectCapabilities(env, isTTY=true): ', JSON.stringify(capabilities.detectCapabilities({ env, stdinIsTTY: true, stdoutIsTTY: true })));

console.log('\n== 2. grapheme-aware width (legacy wcwidth.js) ==');
// `expected` is the cell count a terminal is expected to advance by. Every entry below
// is either a plain East Asian Width case or a UTS#51 emoji-presentation case; the
// ambiguous ones are marked and NOT asserted, because deciding them needs a real
// terminal (they are the reason this file exists).
const corpus = [
  { label: 'ascii', text: 'abc', expected: 3 },
  { label: 'cjk (W)', text: '中文', expected: 4 },
  { label: 'hiragana (W)', text: 'こんにちは', expected: 10 },
  { label: 'hangul (W)', text: '한글', expected: 4 },
  { label: 'fullwidth latin (F)', text: 'ＡＢ', expected: 4 },
  { label: 'combining mark (Mn)', text: 'e\u0301', expected: 1 },
  { label: 'zwj family', text: '👨\u200d👩\u200d👧', expected: 2 },
  { label: 'flag (regional indicators)', text: '🇨🇳', expected: 2 },
  { label: 'box drawing (N)', text: '│─┌', expected: 3 },
  { label: 'powerline (N)', text: '\uE0B0\uE0B2', expected: 2 },
];
for (const entry of corpus) {
  check(`${entry.label} ${JSON.stringify(entry.text)}`, entry.expected, wcwidth.stringWidth(entry.text));
}

const ambiguous = [
  { label: 'keycap sequence (UTS#51 emoji presentation)', text: '1️⃣' },
  { label: 'text-presentation smiley (EAW=A)', text: '☺' },
  { label: 'emoji-presentation heart (VS16)', text: '❤️' },
  { label: 'sun, listed in RANGES_EMOJI as [0x2600,0x26ff]', text: '☀' },
  { label: 'octant glyph (Unicode 16, U+1CD00 block)', text: '\u{1CD00}' },
];
console.log('     findings (need a real terminal to settle — printed, not asserted):');
for (const entry of ambiguous) {
  const width = wcwidth.stringWidth(entry.text);
  const clusters = wcwidth.graphemes(entry.text).length;
  console.log(`       ${entry.label}: width=${String(width)} graphemes=${String(clusters)} codePoints=${String([...entry.text].length)}`);
}
// A code fact, not a terminal question: `inRanges` binary-searches, and RANGES_EMOJI is
// NOT sorted (the 0x2600/0x2700 blocks sit after 0x1fa70). So every codepoint in those
// blocks is looked up in a region of the array that cannot contain it.
console.log(
  `       ^ the last two are the same defect: RANGES_EMOJI is unsorted, so the binary search misses 0x2600-0x27BF entirely`,
);

console.log('\n== 3. cost of one frame (200x50) ==');
const WIDTH = 200;
const HEIGHT = 50;
const styled = (text) => `\x1b[38;2;120;180;255m${text}\x1b[0m`;
function frameLines() {
  const lines = [];
  for (let row = 0; row < HEIGHT; row += 1) {
    const cells = [];
    let used = 0;
    for (let i = 0; i < 40; i += 1) {
      const chunk = `cell${String(i)} `;
      if (used + chunk.length > WIDTH) break;
      cells.push(styled(chunk));
      used += chunk.length;
    }
    lines.push(cells.join(''));
  }
  return lines;
}
function timed(label, fn) {
  const start = performance.now();
  const value = fn();
  const ms = performance.now() - start;
  console.log(`     ${label}: ${ms.toFixed(2)}ms`);
  return value;
}
const built = timed('build 50 lines of styled text (first touch)', () => frameLines());
timed('build 50 lines of styled text (warm)', () => frameLines());
const diffed = timed('diff against a 1-line-changed previous frame', () => {
  const previous = built.slice();
  previous[25] = 'changed';
  let dirty = 0;
  for (let i = 0; i < previous.length; i += 1) if (previous[i] !== built[i]) dirty += 1;
  return dirty;
});
check('only the changed row is dirty', 1, diffed);

// A row that is one cell too wide wraps, and a wrap scrolls the whole frame — which is
// why width math has to be applied before writing, not left to the terminal.
const long = '中'.repeat(WIDTH) + 'overflow';
const sliced = wcwidth.sliceWidth(long, WIDTH);
check('sliceWidth keeps a CJK row inside the width', WIDTH, wcwidth.stringWidth(sliced.text));
check('sliceWidth leaves the rest', true, sliced.rest.length > 0);

console.log(`\n${failures.length === 0 ? 'all probes behaved as expected' : `${String(failures.length)} FAILED`} (${String(cases)} cases)`);
if (failures.length > 0) process.exitCode = 1;
