#!/usr/bin/env node
// Probe: does each lint pattern actually fire, with the message we expect?
//
// The project's own rule, learned in P1: a lint rule nobody has seen fail is a
// rule nobody can trust. Each probe prepends one import to one file, runs eslint on
// that file only, prints what was reported, then restores the file byte for byte.
//
// Usage: node tools/lint-probe.mjs
// Exits non-zero if any expectation fails.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'packages', 'cowcat');

// eslint's own entry point, spawned through the current node. NOT via `npx`:
// on Windows `npx`/`eslint` are .cmd shims, and Node refuses to spawn a .cmd without
// a shell since the CVE-2024-27980 fix — it fails with an empty stdout, which this
// script would faithfully report as "the rule did not fire" for every single probe.
// (It did, twice.)
//
// Resolved by path rather than by `require.resolve`, because eslint's "exports" map
// deliberately does not publish ./bin/eslint.js.
const ESLINT_BIN = join(PKG, 'node_modules', 'eslint', 'bin', 'eslint.js');
if (!existsSync(ESLINT_BIN)) {
  console.error(`cannot find eslint at ${ESLINT_BIN} — run "npm ci" in packages/cowcat first`);
  process.exit(2);
}

// expect: 'message' means eslint must complain; 'silent' means it must not.
//
// The two blocks are probed separately on purpose: kernel/policy/ports are owned by
// the original runtime-agnostic block, while everything else under src/ is owned by
// the P2 block (which is why src/index.ts — a barrel that belongs to neither group —
// is the probe target for the ProcessPort message).
const PROBES = [
  { file: 'src/index.ts', add: "import { spawn } from 'node:child_process';", expect: 'message', match: 'go through ProcessPort' },
  { file: 'src/index.ts', add: "import { readFileSync } from 'node:fs';", expect: 'message', match: 'go through ProcessPort' },
  // The composition root is the newest member of that general block: it decides WHICH
  // files to read, but the reading itself lives in adapters (ADR-009, ADR-064 ②).
  { file: 'src/host/host.ts', add: "import { readFileSync } from 'node:fs';", expect: 'message', match: 'go through ProcessPort' },
  { file: 'src/policy/env.ts', add: "import { readFileSync } from 'node:fs';", expect: 'message', match: 'stay runtime-agnostic' },
  { file: 'src/policy/env.ts', add: "import { z } from 'zod';", expect: 'message', match: 'decoding boundary' },
  { file: 'src/kernel/state.ts', add: "import { readFileSync } from 'node:fs';", expect: 'message', match: 'stay runtime-agnostic' },
  { file: 'src/policy/trust.ts', add: "import OpenAI from 'openai';", expect: 'message', match: 'ModelPort' },
  { file: 'src/ports/index.ts', add: "import Anthropic from '@anthropic-ai/sdk';", expect: 'message', match: 'ModelPort' },
  { file: 'src/adapters/node.ts', add: "import { spawn } from 'node:child_process';", expect: 'silent' },
  { file: 'src/adapters/node.ts', add: "import OpenAI from 'openai';", expect: 'silent' },
];

// JSON formatter, because the stylish one buries the message inside a table row — and
// a probe that greps the wrong format reports "did not fire" for a rule that fired.
function eslintOn(relPath) {
  let raw = '';
  try {
    raw = execFileSync(process.execPath, [ESLINT_BIN, '--format', 'json', relPath], {
      cwd: PKG,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // eslint exits 1 when it has findings: that output IS the finding. A spawn
    // failure has no stdout at all, so an empty result is reported, never swallowed.
    raw = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  const text = raw.trim();
  if (text === '') return [];
  try {
    const parsed = JSON.parse(text);
    return parsed.flatMap((result) =>
      result.messages.map((m) => ({ ruleId: m.ruleId, message: String(m.message).replace(/\s+/g, ' ') })),
    );
  } catch {
    console.log(`  (could not parse eslint output: ${text.slice(0, 300)})`);
    return [];
  }
}

let failed = 0;
for (const probe of PROBES) {
  const path = join(PKG, probe.file);
  const backup = join(tmpdir(), `lint-probe-${process.pid}-${probe.file.replace(/[\\/]/g, '_')}`);
  copyFileSync(path, backup);
  writeFileSync(path, `${probe.add}\n${readFileSync(path, 'utf8')}`, 'utf8');

  const all = eslintOn(probe.file);
  // Only the import gate is under test. The inserted import is deliberately unused, so
  // no-unused-vars fires on every probe and would otherwise drown the signal — which
  // is the second instrumentation trap this script exists to catch.
  const messages = all.filter((m) => m.ruleId === 'no-restricted-imports');
  console.log(`\nprobe ${probe.file}  +  ${probe.add}`);

  if (probe.expect === 'silent') {
    if (messages.length === 0) {
      console.log('  OK: no error, as expected (this layer is exempt)');
    } else {
      console.log(`  FAIL: expected silence, got ${JSON.stringify(messages)}`);
      failed += 1;
    }
  } else if (messages.length === 0) {
    console.log('  FAIL: the rule did not fire');
    failed += 1;
  } else if (messages.some((m) => m.message.includes(probe.match))) {
    console.log(`  OK: ${messages[0].ruleId} -> ${JSON.stringify(messages[0].message)}`);
  } else {
    console.log(`  FAIL: message did not mention ${JSON.stringify(probe.match)}; got ${JSON.stringify(messages)}`);
    failed += 1;
  }

  copyFileSync(backup, path);
  rmSync(backup, { force: true });
}

console.log(`\n${failed === 0 ? 'all probes behaved as expected' : `${failed} probe(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);