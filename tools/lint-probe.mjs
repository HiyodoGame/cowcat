#!/usr/bin/env node
// Probe: does each lint pattern actually fire, with the message we expect?
//
// The project's own rule, learned in P1: a lint rule nobody has seen fail is a
// rule nobody can trust. Each probe prepends one import to one file, runs eslint on
// that file only, prints what was reported, then restores the file byte for byte.
//
// Since T4a 3/3 the tree has four packages with layering rules of their own, so a probe
// names its package: `packages/tui` forbids the kernel across the WHOLE package,
// `packages/protocol` forbids both the kernel and the renderer, and `packages/cli` is the
// one place the kernel IS allowed — which is worth probing in the silent direction, since
// a rule that quietly started firing there would break the composition root's consumer.
//
// Usage: node tools/lint-probe.mjs
// Exits non-zero if any expectation fails.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = {
  cowcat: join(ROOT, 'packages', 'cowcat'),
  protocol: join(ROOT, 'packages', 'protocol'),
  tui: join(ROOT, 'packages', 'tui'),
  cli: join(ROOT, 'packages', 'cli'),
};

// eslint's own entry point, spawned through the current node. NOT via `npx`: on Windows
// `npx`/`eslint` are .cmd shims, and Node refuses to spawn a .cmd without a shell since the
// CVE-2024-27980 fix — it fails with an empty stdout, which this script would faithfully
// report as "the rule did not fire" for every single probe. (It did, twice.)
//
// Resolved by path rather than by `require.resolve`, because eslint's "exports" map
// deliberately does not publish ./bin/eslint.js.
const ESLINT_BINS = Object.fromEntries(
  Object.entries(PACKAGES).map(([name, dir]) => [name, join(dir, 'node_modules', 'eslint', 'bin', 'eslint.js')]),
);
for (const [name, bin] of Object.entries(ESLINT_BINS)) {
  if (!existsSync(bin)) {
    console.error(`cannot find eslint for packages/${name} at ${bin} — run "npm ci" there first`);
    process.exit(2);
  }
}

// expect: 'message' means eslint must complain; 'silent' means it must not.
const PROBES = [
  // packages/cowcat: kernel/policy/ports are owned by the runtime-agnostic block, while
  // everything else under src/ is owned by the P2 block (which is why src/index.ts — a
  // barrel that belongs to neither group — is the probe target for the ProcessPort
  // message).
  { pkg: 'cowcat', file: 'src/index.ts', add: "import { spawn } from 'node:child_process';", expect: 'message', match: 'go through ProcessPort' },
  { pkg: 'cowcat', file: 'src/index.ts', add: "import { readFileSync } from 'node:fs';", expect: 'message', match: 'go through ProcessPort' },
  // The composition root is the newest member of that general block: it decides WHICH
  // files to read, but the reading itself lives in adapters (ADR-009, ADR-064 ②).
  { pkg: 'cowcat', file: 'src/host/host.ts', add: "import { readFileSync } from 'node:fs';", expect: 'message', match: 'go through ProcessPort' },
  { pkg: 'cowcat', file: 'src/policy/env.ts', add: "import { readFileSync } from 'node:fs';", expect: 'message', match: 'stay runtime-agnostic' },
  { pkg: 'cowcat', file: 'src/policy/env.ts', add: "import { z } from 'zod';", expect: 'message', match: 'decoding boundary' },
  { pkg: 'cowcat', file: 'src/kernel/state.ts', add: "import { readFileSync } from 'node:fs';", expect: 'message', match: 'stay runtime-agnostic' },
  { pkg: 'cowcat', file: 'src/policy/trust.ts', add: "import OpenAI from 'openai';", expect: 'message', match: 'ModelPort' },
  { pkg: 'cowcat', file: 'src/ports/index.ts', add: "import Anthropic from '@anthropic-ai/sdk';", expect: 'message', match: 'ModelPort' },
  { pkg: 'cowcat', file: 'src/adapters/node.ts', add: "import { spawn } from 'node:child_process';", expect: 'silent' },
  { pkg: 'cowcat', file: 'src/adapters/node.ts', add: "import OpenAI from 'openai';", expect: 'silent' },

  // packages/protocol: the seam knows neither half (ADR-062).
  { pkg: 'protocol', file: 'src/index.ts', add: "import { createHost } from '@corescense/cowcat-core';", expect: 'message', match: 'host port' },
  { pkg: 'protocol', file: 'src/index.ts', add: "import '@opentui/core';", expect: 'message', match: 'no renderer' },
  { pkg: 'protocol', file: 'src/index.ts', add: "import { readFileSync } from 'node:fs';", expect: 'silent' },

  // packages/tui: the whole package reaches the kernel through the protocol (ADR-059 ③),
  // not just the directory that used to hold the bin.
  { pkg: 'tui', file: 'src/index.ts', add: "import { createHost } from '@corescense/cowcat-core';", expect: 'message', match: 'only through the protocol' },
  { pkg: 'tui', file: 'src/index.ts', add: "import '@opentui/core';", expect: 'silent' },

  // packages/cli: the one package that may see both halves (ADR-062 ③) — and it must not
  // reach past a package to the renderer it does not own.
  { pkg: 'cli', file: 'src/cli/host.ts', add: "import { createHost } from '@corescense/cowcat-core';", expect: 'silent' },
  { pkg: 'cli', file: 'src/cli/host.ts', add: "import { readFileSync } from 'node:fs';", expect: 'silent' },
  { pkg: 'cli', file: 'src/index.ts', add: "import '@opentui/core';", expect: 'message', match: 'reached through @corescense/cowcat-tui' },
];

// JSON formatter, because the stylish one buries the message inside a table row — and
// a probe that greps the wrong format reports "did not fire" for a rule that fired.
function eslintOn(pkg, relPath) {
  let raw = '';
  try {
    raw = execFileSync(process.execPath, [ESLINT_BINS[pkg], '--format', 'json', relPath], {
      cwd: PACKAGES[pkg],
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
  const path = join(PACKAGES[probe.pkg], probe.file);
  const backup = join(tmpdir(), `lint-probe-${String(process.pid)}-${probe.file.replace(/[\\/]/g, '_')}`);
  copyFileSync(path, backup);
  writeFileSync(path, `${probe.add}\n${readFileSync(path, 'utf8')}`, 'utf8');

  const all = eslintOn(probe.pkg, probe.file);
  // Only the import gate is under test. The inserted import is deliberately unused, so
  // no-unused-vars fires on every probe and would otherwise drown the signal — which
  // is the second instrumentation trap this script exists to catch.
  const messages = all.filter((m) => m.ruleId === 'no-restricted-imports');
  console.log(`\nprobe packages/${probe.pkg}/${probe.file}  +  ${probe.add}`);

  if (probe.expect === 'silent') {
    if (messages.length === 0) {
      console.log('  OK: no error, as expected (this import is allowed here)');
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

console.log(`\n${failed === 0 ? 'all probes behaved as expected' : `${String(failed)} probe(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
