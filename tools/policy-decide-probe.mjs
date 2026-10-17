#!/usr/bin/env node
// Probe: what does decide() actually do when rules disagree?
//
// Why this exists: P3 has to re-argue `deny > ask > allow` from evidence rather
// than from the fact that decide.ts happens to contain those three words. Reading
// decide.ts tells you the intent; it does not tell you which branches the shipped
// DEFAULT_RULES can even reach. Probe: `DEFAULT_RULES` has no deny rule at all, so
// the deny arm of PRECEDENCE is dead in production and only tests ever exercise it.
// That is exactly the kind of claim that must not be settled by reading code.
//
// The project's own rule, learned in P1: a rule nobody has seen fail is a rule
// nobody can trust. Each case here states an expectation up front and is compared
// against the real return value. Exits non-zero if any expectation is wrong — a
// probe that only prints is a probe that cannot fail.
//
// Usage: node tools/policy-decide-probe.mjs
// Requires: npm run build in packages/cowcat (probes dist/, same as the tests).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DECIDE = join(ROOT, 'packages', 'cowcat', 'dist', 'src', 'policy', 'decide.js');
const DEFAULTS = join(ROOT, 'packages', 'cowcat', 'dist', 'src', 'policy', 'defaults.js');

if (!existsSync(DECIDE) || !existsSync(DEFAULTS)) {
  console.error(`cannot find built policy at ${DECIDE} — run "npm run build" in packages/cowcat first`);
  process.exit(2);
}

// pathToFileURL, not the raw path: a dynamic import() of "F:\..." is rejected by
// the ESM loader with ERR_UNSUPPORTED_ESM_URL_SCHEME. (It did, once.)
const { decide } = await import(pathToFileURL(DECIDE).href);
const { DEFAULT_RULES } = await import(pathToFileURL(DEFAULTS).href);

// The only ActionRequest shape the kernel builds today: run-turn.ts:111 fills
// exactly these four fields, so anything a rule reads beyond them reads undefined.
const req = (name, risk) => ({ kind: 'tool', callId: 'c1', name, risk });
const rule = (name, verdict, matches, reason) => ({ name, matches, verdict, ...(reason === undefined ? {} : { reason }) });
const always = () => true;

const CASES = [
  // --- the precedence claim itself -------------------------------------------
  {
    id: 'P1 cross-verdict precedence ignores array order',
    // Written allow-first on purpose: if decide() walked the array and returned
    // the first match, this would be `allow`.
    rules: [rule('r-allow', 'allow', always), rule('r-ask', 'ask', always), rule('r-deny', 'deny', always)],
    request: req('X', 'write'),
    expect: (d) => d.verdict === 'deny' && d.rule === 'r-deny',
    why: 'allow first in the array must still lose to deny',
  },
  {
    id: 'P2 reversed array order gives the same verdict',
    rules: [rule('r-deny', 'deny', always), rule('r-ask', 'ask', always), rule('r-allow', 'allow', always)],
    request: req('X', 'write'),
    expect: (d) => d.verdict === 'deny' && d.rule === 'r-deny',
    why: 'verdict priority is a property of PRECEDENCE, not of rule order',
  },
  {
    id: 'P3 ask beats allow regardless of order',
    rules: [rule('r-allow', 'allow', always), rule('r-ask', 'ask', always)],
    request: req('X', 'write'),
    expect: (d) => d.verdict === 'ask' && d.rule === 'r-ask',
    why: 'the middle arm of PRECEDENCE',
  },

  // --- within one verdict, array order IS the tiebreak ------------------------
  {
    id: 'P4 same verdict takes the lowest array index',
    rules: [rule('first', 'deny', always), rule('second', 'deny', always)],
    request: req('X', 'write'),
    expect: (d) => d.rule === 'first',
    why: 'within a verdict the order is filter-preserving and find() takes the first',
  },

  // --- the "no match means ask" fallback -------------------------------------
  {
    id: 'P5 empty rule set falls back to ask',
    rules: [],
    request: req('X', 'write'),
    expect: (d) => d.verdict === 'ask' && d.rule === 'no-rule-matched',
    why: 'decide.ts:35 is the only source of this fallback',
  },
  {
    id: 'P6 the fallback reason names the tool',
    rules: [],
    request: req('rm_rf', 'exec'),
    expect: (d) => typeof d.reason === 'string' && d.reason.includes('rm_rf'),
    why: 'the reason is the only place the tool name survives into a Decision',
  },

  // --- reason: null vs '' — ?? vs || ----------------------------------------
  {
    id: 'P7 a rule with no reason yields null, not undefined',
    rules: [rule('r', 'allow', always)],
    request: req('X', 'read'),
    expect: (d) => d.reason === null && 'reason' in d,
    why: 'decide.ts:33 uses ?? null; the field must still be present',
  },
  {
    id: 'P8 an empty-string reason survives as an empty string',
    rules: [rule('r', 'allow', always, '')],
    request: req('X', 'read'),
    expect: (d) => d.reason === '',
    why: '?? does not fire on "", so a config author writing "" gets "" back — not null',
  },

  // --- a throwing matcher is not defended against ---------------------------
  {
    id: 'P9 a matcher that throws propagates out of decide',
    rules: [rule('boom', 'allow', () => { throw new Error('matcher exploded'); })],
    request: req('X', 'write'),
    expectThrows: 'matcher exploded',
    why: 'there is no try/catch in decide; run-turn.ts:48 catches it as a turn failure',
  },

  // --- what the shipped defaults can actually reach -------------------------
  {
    id: 'P10 DEFAULT_RULES contains no deny rule at all',
    rules: DEFAULT_RULES,
    request: req('X', 'write'),
    expect: (d) => DEFAULT_RULES.every((r) => r.verdict !== 'deny') && d.verdict !== 'deny',
    why: 'the deny arm of PRECEDENCE is unreachable with shipped defaults — only tests reach it',
  },
  {
    id: 'P11 DEFAULT_RULES allows reads',
    rules: DEFAULT_RULES,
    request: req('Read', 'read'),
    expect: (d) => d.verdict === 'allow' && d.rule === 'reads-are-free',
    why: 'reads-are-free',
  },
  {
    id: 'P12 DEFAULT_RULES asks on write, exec and network alike',
    rules: DEFAULT_RULES,
    request: req('Bash', 'exec'),
    expect: (d) => d.verdict === 'ask' && d.rule === 'mutations-need-approval',
    why: 'all three mutating risks share one rule; risk is the only dimension read',
  },

  // --- risk is the only dimension the defaults look at ----------------------
  {
    id: 'P13 two rules differing only in name never both win',
    rules: DEFAULT_RULES,
    request: req('Bash', 'read'),
    expect: (d) => d.verdict === 'allow',
    why: 'a tool named Bash with risk read is allowed — the defaults ignore the name',
  },
  {
    id: 'P14 the same tool name with a different risk gets a different verdict',
    rules: DEFAULT_RULES,
    request: req('Bash', 'write'),
    expect: (d) => d.verdict === 'ask',
    why: 'risk alone decides; there is no conflict detection on tool names',
  },
];

let failed = 0;
for (const c of CASES) {
  let ok;
  let got;
  if (c.expectThrows !== undefined) {
    try {
      decide(c.request, c.rules);
      ok = false;
      got = 'returned normally (expected a throw)';
    } catch (e) {
      ok = String(e.message).includes(c.expectThrows);
      got = `threw: ${e.message}`;
    }
  } else {
    const d = decide(c.request, c.rules);
    ok = c.expect(d);
    got = `${d.verdict} / ${d.rule} / ${JSON.stringify(d.reason)}`;
  }
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.id}`);
  console.log(`       why: ${c.why}`);
  if (!ok) console.log(`       got: ${got}`);
}

console.log(`\n${CASES.length - failed}/${CASES.length} expectations held`);
if (failed > 0) {
  console.error(`\n${failed} expectation(s) failed — the table in docs/research/p3-policy.md must not cite this file's numbers.`);
  process.exit(1);
}