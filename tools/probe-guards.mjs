#!/usr/bin/env node
// Probe the probes: does each of them actually FAIL when an expectation is wrong?
//
// Why this exists: P3 T1 shipped a rewritten legacy-config-probe.mjs that counted
// failed assertions and then never reported them — it printed "ok" for every case
// and exited 0 no matter what. A probe in that state is worse than no probe: it
// looks like evidence. The repo already has the same idea for a different surface
// (tools/lint-probe.mjs: "a lint rule nobody has seen fail is a rule nobody can
// trust"). This is that idea applied to the probes themselves.
//
// For each probe it writes a copy with ONE expectation deliberately broken, runs
// it, and requires the copy to:
//   1. exit non-zero,
//   2. name the failing case,
//   3. print a summary that is not "all passed",
//   4. tell the reader not to cite its numbers.
//
// The copy is written next to the original inside tools/, NOT into the temp dir:
// each probe resolves the repository root from its own location, so a copy
// elsewhere cannot import its dependencies and crashes instead of failing — and a
// crash has a non-zero exit code, which is exactly the false positive this script
// is meant to prevent. (That mistake was made once while building this file.)
//
// Usage: node tools/probe-guards.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// One uniquely-identifiable expectation per probe. If a probe is edited such that
// a marker disappears, this script reports it rather than silently passing — the
// markers are the whole mechanism.
const GUARDS = [
  {
    probe: 'policy-decide-probe.mjs',
    // P1/P2 both read `.verdict === 'deny' && d.rule === 'r-deny'`; breaking the
    // expression is enough and needs no structural edit.
    marker: "d.verdict === 'deny' && d.rule === 'r-deny'",
    replacement: "d.verdict === 'allow'",
  },
  {
    probe: 'legacy-config-probe.mjs',
    marker: "expect: 'system',",
    replacement: "expect: 'DELIBERATELY-WRONG',",
  },
  {
    probe: 'legacy-trust-probe.mjs',
    marker: 'expect: 1,',
    replacement: 'expect: 99,',
  },
];

let failed = 0;
for (const g of GUARDS) {
  const source = join(ROOT, 'tools', g.probe);
  const original = readFileSync(source, 'utf8');
  if (!original.includes(g.marker)) {
    failed++;
    console.log(`FAIL ${g.probe}`);
    console.log(`       marker not found: ${JSON.stringify(g.marker)} — update this script`);
    continue;
  }
  const copy = join(ROOT, 'tools', `.guard-${process.pid}-${g.probe}`);
  writeFileSync(copy, original.replaceAll(g.marker, g.replacement));

  let code = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [copy], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status ?? -1;
    out = String(e.stdout ?? '') + String(e.stderr ?? '');
  } finally {
    rmSync(copy, { force: true });
  }

  // The broken case must be REPORTED, not crashed into. A crash also exits
  // non-zero, so the content checks are what make this meaningful.
  const crashed = /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module|ERR_UNSUPPORTED_ESM_URL_SCHEME/.test(out);
  const checks = [
    ['exit code is non-zero', code !== 0],
    ['the failing case is named', /FAIL /.test(out)],
    // "5/10 expectations held" yes; "10/10 expectations held" means the guard is dead.
    ['the summary is not all-passed', /[0-9]+\/[0-9]+ expectations held/.test(out) && !/(\d+)\/\1 expectations held/.test(out)],
    ['the "do not cite" warning is printed', /do not cite|must not cite/.test(out)],
    ['it failed on an assertion, not a crash', !crashed],
  ];
  const bad = checks.filter(([, ok]) => !ok);
  failed += bad.length > 0 ? 1 : 0;
  console.log(`${bad.length === 0 ? 'ok  ' : 'FAIL'} ${g.probe}`);
  for (const [label, ok] of checks) {
    if (!ok) console.log(`       missing: ${label}`);
  }
  if (bad.length > 0) console.log(`       exit=${code}${crashed ? ' (looks like a crash)' : ''}\n${out.split('\n').slice(-6).join('\n')}`);
}

console.log(`\n${GUARDS.length - failed}/${GUARDS.length} probes fail loudly when broken`);
if (failed > 0) {
  console.error('\nat least one probe cannot fail — its "all passed" output is not evidence.');
  process.exit(1);
}
