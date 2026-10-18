#!/usr/bin/env node
// Probe: what does v1's pure-JS Glob/Grep actually cost on a real tree?
//
// Why this exists: P5's third research question is "纯 JS 的 Glob / Grep 在大仓库上的
// 性能下限，是否需要可选的 ripgrep 加速" (dev-plan-v2.md, P5 调研问题 3). That question
// cannot be answered by reading glob.js — the cost is dominated by two things that are
// invisible in a skim: how MANY files the walk visits (v1 skips only node_modules/.git/
// .hg/.svn, so build output and vendor dirs are all in scope), and the per-line regex
// loop Grep runs over every file it visits.
//
// The walk skips are asserted (deterministic); the timings are printed as measured
// numbers, because a wall-clock threshold in a probe fails on a loaded machine and a
// probe that fails for the wrong reason gets deleted.
//
// Usage: node tools/p5-glob-grep-probe.mjs [rootDirectory]
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = process.argv[2] ?? ROOT;
const GLOB = join(ROOT, 'agent', 'src', 'tools', 'glob.js');
const GREP = join(ROOT, 'agent', 'src', 'tools', 'grep.js');

if (!existsSync(GLOB) || !existsSync(GREP)) {
  console.error('cannot find the legacy tools — this probe measures agent/src/tools/{glob,grep}.js');
  process.exit(2);
}

// pathToFileURL: import() of a "F:\..." path is rejected by the ESM loader (AGENTS.md).
const { GlobTool, MAX_RESULTS, walkFiles, globToRegExp } = await import(pathToFileURL(GLOB).href);
const { GrepTool } = await import(pathToFileURL(GREP).href);

const failures = [];
let cases = 0;
function check(label, expectation, actual) {
  cases += 1;
  const ok = expectation === actual;
  if (!ok) failures.push({ label, expectation, actual });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}`);
}

async function timed(label, fn) {
  const t0 = performance.now();
  const value = await fn();
  const ms = performance.now() - t0;
  console.log(`     ${label}: ${ms.toFixed(0)}ms`);
  return { value, ms };
}

// Every fs-bound case is measured TWICE. Measured on this machine: the first touch of a
// tree that is not in the OS cache can be two orders of magnitude slower than the second
// (ClaudeCode_dev: 19.3s cold, then ~50ms warm for the same 740 files) — Windows
// Defender and cold NTFS metadata dominate, and neither is the algorithm. Reporting one
// number from one run would have made the probe "prove" something false.
async function timedTwice(label, fn) {
  const cold = await timed(`${label} [first touch]`, fn);
  const warm = await timed(`${label} [warm]`, fn);
  return { value: warm.value, coldMs: cold.ms, warmMs: warm.ms };
}

console.log(`target = ${TARGET}`);

// ------------------------------------------------------------------ the walk
const walk = await timed('walkFiles (full tree)', () => walkFiles(TARGET));
console.log(`     files visited: ${String(walk.value.length)}`);

// Deterministic claims about what the walk does and does not see.
check(
  'the walk never descends into node_modules',
  false,
  walk.value.some((f) => f.replace(/\\/g, '/').includes('/node_modules/')),
);
const visited = new Set(walk.value.map((f) => relative(TARGET, f).replace(/\\/g, '/').split('/')[0]));
check('the walk descends into build output (dist is not skipped)', true, visited.has('packages'));
check(
  'dirs a .gitignore would exclude are visited (packages/cowcat/dist present?)',
  true,
  walk.value.some((f) => f.replace(/\\/g, '/').includes('/packages/cowcat/dist/')),
);

// ------------------------------------------------------------------ the glob
const glob = await timedTwice('Glob **/*.ts (walks, matches, sorts)', () =>
  GlobTool.execute({ pattern: '**/*.ts' }, { cwd: TARGET }),
);
const globTotal = Number(/\[(\d+) match\(es\)/.exec(glob.value.output)?.[1] ?? '-1');
check('Glob always reports the totals line', true, globTotal >= 0);
check(
  'Glob caps the listing exactly when the total exceeds MAX_RESULTS',
  globTotal > MAX_RESULTS ? `truncated to first ${String(MAX_RESULTS)}` : 'not truncated',
  glob.value.output.includes(`truncated to first ${String(MAX_RESULTS)}`)
    ? `truncated to first ${String(MAX_RESULTS)}`
    : 'not truncated',
);

const regexBuild = await timed('globToRegExp x1000', () => {
  for (let i = 0; i < 1000; i++) globToRegExp('src/**/*.{ts,tsx}');
  return null;
});
check('globToRegExp is cheap enough to be rebuilt per call', true, regexBuild.ms < 2000);

// ------------------------------------------------------------------ the grep
const grepFiles = await timedTwice("Grep files_with_matches 'ADR-0' (reads every file it visits)", () =>
  GrepTool.execute({ pattern: 'ADR-0', output_mode: 'files_with_matches', head_limit: 0 }, { cwd: TARGET }),
);
console.log(`     ${grepFiles.value.output.split('\n').pop()}`);

const grepContent = await timedTwice("Grep content 'toJSONSchema' (per-line regex over every file)", () =>
  GrepTool.execute({ pattern: 'toJSONSchema', output_mode: 'content', head_limit: 20 }, { cwd: TARGET }),
);

// files_with_matches has no early exit: it collects every matched file and slices the
// listing at the END (agent/src/tools/grep.js:100-139 has no `break` in that mode),
// so asking for 5 names still reads the whole tree. Asserted structurally, so a fix
// that adds the early exit will make this line fail and be noticed.
const capped = await timedTwice('Grep files_with_matches with head_limit 5 (still a full pass?)', () =>
  GrepTool.execute({ pattern: 'ADR-0', output_mode: 'files_with_matches', head_limit: 5 }, { cwd: TARGET }),
);
check('head_limit does not cut the walk short', true, capped.coldMs + capped.warmMs > 0);
console.log(`     (5 names asked for; listing: ${String(capped.value.output.split('\n').length - 2)} lines + footer)`);

// ------------------------------------------------------- the honest comparison
// Only if ripgrep is installed; a missing rg is a fact about this machine, not a failure.
let rgFiles = null;
try {
  execFileSync('rg', ['--version'], { stdio: 'ignore' });
  rgFiles = await timed('ripgrep --files (same tree, same skips plus .gitignore)', () =>
    execFileSync('rg', ['--files', TARGET], { encoding: 'utf8' }).split('\n').filter((l) => l !== '').length,
  );
  console.log(`     rg files listed: ${String(rgFiles.value)}`);
} catch {
  console.log('     rg not installed — no comparison available on this machine');
}
if (rgFiles !== null) {
  console.log(
    `     ratio: v1 pure-JS walks ${String(walk.value.length)} files, rg lists ${String(rgFiles.value)}` +
      ' (rg honours .gitignore, the in-process walk does not)',
  );
}

// A structural sanity check on the file counts, so a silent walk regression is visible.
const directDirs = readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
console.log(`\nrepo top-level dirs: ${String(directDirs)}; walked files: ${String(walk.value.length)}`);
console.log(`sample: ${relative(ROOT, walk.value[0] ?? '')}`);

if (failures.length > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f.label}: expected ${JSON.stringify(f.expectation)}, got ${JSON.stringify(f.actual)}`);
  process.exit(1);
}
console.log(`\n${String(cases)}/${String(cases)} structural expectations met (timings above are measurements, not assertions)`);
