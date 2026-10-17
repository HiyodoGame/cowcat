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
// Updated by P3 T1 (ADR-027): rules are data (`when: {...}`), not a `matches`
// function. That makes one of the original cases unrepresentable — see P9.
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
const { decide, validateRules } = await import(pathToFileURL(DECIDE).href);
const { DEFAULT_RULES } = await import(pathToFileURL(DEFAULTS).href);

// The ActionRequest shape the kernel builds today: run-turn.ts:111 fills four
// fields, so anything a rule reads beyond them reads undefined.
const req = (name, risk) => ({ kind: 'tool', callId: 'c1', name, risk });
// Was `matches: () => true` before ADR-027; the data form of "do not care".
const EVERY = {};
const rule = (name, verdict, when, reason) => ({ name, when, verdict, ...(reason === undefined ? {} : { reason }) });

const CASES = [
  // --- the precedence claim itself -------------------------------------------
  {
    id: 'P1 cross-verdict precedence ignores array order',
    // Written allow-first on purpose: if decide() walked the array and returned
    // the first match, this would be `allow`.
    rules: [rule('r-allow', 'allow', EVERY), rule('r-ask', 'ask', EVERY), rule('r-deny', 'deny', EVERY)],
    request: req('X', 'write'),
    expect: (d) => d.verdict === 'deny' && d.rule === 'r-deny',
    why: 'allow first in the array must still lose to deny',
  },
  {
    id: 'P2 reversed array order gives the same verdict',
    rules: [rule('r-deny', 'deny', EVERY), rule('r-ask', 'ask', EVERY), rule('r-allow', 'allow', EVERY)],
    request: req('X', 'write'),
    expect: (d) => d.verdict === 'deny' && d.rule === 'r-deny',
    why: 'verdict priority is a property of PRECEDENCE, not of rule order',
  },
  {
    id: 'P3 ask beats allow regardless of order',
    rules: [rule('r-allow', 'allow', EVERY), rule('r-ask', 'ask', EVERY)],
    request: req('X', 'write'),
    expect: (d) => d.verdict === 'ask' && d.rule === 'r-ask',
    why: 'the middle arm of PRECEDENCE',
  },

  // --- within one verdict, array order IS the tiebreak ------------------------
  {
    id: 'P4 same verdict takes the lowest array index',
    rules: [rule('first', 'deny', EVERY), rule('second', 'deny', EVERY)],
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
    why: 'the fallback is the only source of `no-rule-matched`',
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
    rules: [rule('r', 'allow', EVERY)],
    request: req('X', 'read'),
    expect: (d) => d.reason === null && 'reason' in d,
    why: 'the field uses ?? null; it must still be present',
  },
  {
    id: 'P8 an empty-string reason survives as an empty string',
    rules: [rule('r', 'allow', EVERY, '')],
    request: req('X', 'read'),
    expect: (d) => d.reason === '',
    why: '?? does not fire on "", so a config author writing "" gets "" back — not null',
  },

  // --- a rule that cannot be honoured ---------------------------------------
  {
    id: 'P9 a rule narrowing on a field the request lacks does NOT match',
    // This case used to be "a matcher that throws propagates out of decide". ADR-027
    // removed the function form, so that case no longer exists: a rule can no
    // longer run code at all. What replaced it is the new fail-closed rule — a
    // `when` selector with no corresponding request field must not match, because
    // matching would silently widen the rule.
    rules: [rule('needs-path', 'allow', { path: '/repo/src' })],
    request: req('X', 'read'),
    expect: (d) => d.verdict === 'ask' && d.rule === 'no-rule-matched',
    why: 'absent field means "no match", never "do not care"',
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
    id: 'P13 a tool named Bash with risk read is allowed',
    rules: DEFAULT_RULES,
    request: req('Bash', 'read'),
    expect: (d) => d.verdict === 'allow',
    why: 'the defaults ignore the tool name entirely',
  },
  {
    id: 'P14 the same tool name with a different risk gets a different verdict',
    rules: DEFAULT_RULES,
    request: req('Bash', 'write'),
    expect: (d) => d.verdict === 'ask',
    why: 'risk alone decides; there is no conflict detection on tool names',
  },

  // --- the shipped defaults must also survive validation --------------------
  {
    id: 'P15 DEFAULT_RULES pass validateRules',
    rules: DEFAULT_RULES,
    request: req('Read', 'read'),
    expect: () => validateRules(DEFAULT_RULES).length === 0,
    why: 'a default that the loader would skip would be a silent policy hole',
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
