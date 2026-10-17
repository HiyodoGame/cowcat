#!/usr/bin/env node
// Probe: what does "this folder is trusted" actually mean in v1?
//
// Why this exists: P3 has to build a trust model, and the only spec it has for the
// old one is trust.js (41 lines) plus docs/USAGE.md:214-220. Reading it suggests
// trust is a directory key. It does not tell you whether trusting a directory
// grants its children, whether trust survives a second grant, or which file the
// record lands in — and the repo has already been burned once by assuming a trust
// comparison was about spelling rather than identity (trust.js:14-21: 7 macOS CI
// failures, one root cause). So probe it instead of reading it.
//
// Each scenario uses a throwaway COWCAT_HOME. Nothing touches the real ~/.cowcat.
//
// Usage: node tools/legacy-trust-probe.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(join(ROOT, 'agent', 'src', rel)).href);
const { loadConfig } = await load('config.js');
const { trustProject, isTrustedProject, trustedProjects } = await load('trust.js');
const { canonicalPath, samePath } = await load('canonical.js');

const realCwd = process.cwd();
const realHome = process.env.COWCAT_HOME;

// Each scenario is `fn(ctx)` returning { got, expect, why }. ctx gives a fresh
// home + project tree and the helpers bound to that home.
function scenario(fn) {
  const base = mkdtempSync(join(tmpdir(), 'cowcat-trustprobe-'));
  const home = join(base, 'home');
  const proj = join(base, 'proj');
  const sub = join(proj, 'sub');
  mkdirSync(sub, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env.COWCAT_HOME = home;
  process.chdir(proj);
  const ctx = { base, home, proj, sub, cfg: loadConfig, files: { state: join(home, 'state.json'), config: join(home, 'config.json') } };
  let out;
  let error = null;
  try {
    out = fn(ctx);
  } catch (e) {
    error = e.message;
  } finally {
    process.chdir(realCwd);
    if (realHome === undefined) delete process.env.COWCAT_HOME;
    else process.env.COWCAT_HOME = realHome;
    rmSync(base, { recursive: true, force: true });
  }
  if (error) return { got: `threw: ${error}`, expect: undefined, why: '' };
  const ok = typeof out.expect === 'function' ? out.expect(out.got) : JSON.stringify(out.got) === JSON.stringify(out.expect);
  return { ...out, ok };
}

const CASES = [
  {
    id: 'T1 trustProject persists into state.json, not config.json',
    fn: (c) => {
      const cfg = c.cfg();
      trustProject(cfg, c.proj);
      return {
        got: { state: existsSync(c.files.state), config: existsSync(c.files.config) },
        expect: { state: true, config: false },
        why: 'writeState targets state.json only (config.js:106-108)',
      };
    },
  },
  {
    id: 'T2 the stored key is the canonical path',
    fn: (c) => {
      const cfg = c.cfg();
      trustProject(cfg, c.proj);
      const stored = JSON.parse(readFileSync(c.files.state, 'utf8')).trustedProjects;
      return {
        got: { count: stored.length, isCanonical: stored.length === 1 && samePath(stored[0], canonicalPath(c.proj)) },
        expect: { count: 1, isCanonical: true },
        why: 'trust.js:29 — stored canonical so the key is stable however the dir is reached',
      };
    },
  },
  {
    id: 'T3 trusting twice is idempotent',
    fn: (c) => {
      const cfg = c.cfg();
      trustProject(cfg, c.proj);
      trustProject(cfg, c.proj);
      const stored = JSON.parse(readFileSync(c.files.state, 'utf8')).trustedProjects;
      return {
        got: stored.length,
        expect: 1,
        why: 'dedup by identity at trust.js:35, then a Set at :36',
      };
    },
  },
  {
    id: 'T4 trust does NOT extend to a subdirectory',
    fn: (c) => {
      const cfg = c.cfg();
      trustProject(cfg, c.proj);
      const after = c.cfg();
      return {
        got: { child: isTrustedProject(after, c.sub), self: isTrustedProject(after, c.proj) },
        expect: { child: false, self: true },
        why: 'isTrustedProject is an exact samePath match (trust.js:22-24) — there is no ancestor walk',
      };
    },
  },
  {
    id: 'T5 trust does NOT extend to the parent directory',
    fn: (c) => {
      const cfg = c.cfg();
      trustProject(cfg, c.proj);
      const after = c.cfg();
      return {
        got: isTrustedProject(after, c.base),
        expect: false,
        why: 'same reason as T4, the other direction',
      };
    },
  },
  {
    id: 'T6 a legacy config.json entry is still honoured on read',
    fn: (c) => {
      writeFileSync(c.files.config, JSON.stringify({ trustedProjects: [c.proj] }));
      const cfg = c.cfg();
      return {
        got: isTrustedProject(cfg, c.proj),
        expect: true,
        why: 'readState spreads config.json first (config.js:98-100) — the migration path',
      };
    },
  },
  {
    id: 'T7 a non-array trustedProjects reads as empty, not as a crash',
    fn: (c) => {
      writeFileSync(c.files.state, JSON.stringify({ trustedProjects: 'oops' }));
      const cfg = c.cfg();
      return {
        got: trustedProjects(cfg),
        expect: [],
        why: 'trustedProjects() type-defends (trust.js:10-12)',
      };
    },
  },
  {
    id: 'T8 trust persists an installId alongside it rather than replacing state',
    fn: (c) => {
      const cfg = c.cfg();
      const before = cfg.installId;
      trustProject(cfg, c.proj);
      const after = c.cfg();
      return {
        got: { keptSameInstall: before === after.installId, hasInstall: typeof before === 'string' && before.length === 32 },
        expect: { keptSameInstall: true, hasInstall: true },
        why: 'writeState mutates a clone of the merged state (config.js:104), so fields survive',
      };
    },
  },
];

let failed = 0;
for (const c of CASES) {
  const r = scenario(c.fn);
  const ok = r.expect === undefined ? false : (typeof r.expect === 'function' ? r.expect(r.got) : JSON.stringify(r.got) === JSON.stringify(r.expect));
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.id}`);
  console.log(`       why: ${r.why || c.why}`);
  if (!ok) console.log(`       expected ${JSON.stringify(r.expect)}, got ${JSON.stringify(r.got)}`);
}

console.log(`\n${CASES.length - failed}/${CASES.length} expectations held`);
console.log('T4/T5 are the load-bearing ones: v1 trust is exact-directory only, with no inheritance.');
if (failed > 0) {
  console.error(`\n${failed} expectation(s) failed — do not cite this file's numbers in docs/research/p3-policy.md.`);
  process.exit(1);
}