import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSandboxExecutor,
  defaultSandboxProfile,
  NodeFs,
  NodePlatform,
  NodeProcess,
  DEFAULT_READ_DENY,
  resolveEntries,
} from '../src/index.js';

import { fakePlatform } from './fakes-ports.js';

// The system tier, against a REAL backend.
//
// One test, on purpose. The G1/G2/G3 matrix is T6; what this file answers is narrower
// and more urgent: does the argv this codebase GENERATES actually run, and does it
// isolate? Everything else about the executor is a pure function tested elsewhere, so a
// green suite on Windows would otherwise say nothing about the one thing that can only
// be checked on a kernel.
//
// The skip reason is the probe's own classification, so an unusable machine says WHICH
// failure it hit (missing / userns-blocked / unsupported) instead of a bare "skipped".

const platform = new NodePlatform();
const verdict = platform.sandboxBackends()[0];
const skip =
  verdict === undefined
    ? `no backend probed on ${platform.platform}`
    : verdict.usable
      ? false
      : `${verdict.name} unusable here — [${verdict.reason}] ${verdict.detail || ''} ${verdict.fix ?? ''}`.trim();

function realPort(): NodeProcess {
  const fs = new NodeFs();
  return new NodeProcess({
    platform,
    sandboxCommand: createSandboxExecutor({
      platform,
      fsProbe: { isDir: (path) => fs.kindOf(path) === 'directory', isFile: (path) => fs.kindOf(path) === 'file' },
    }),
  });
}

/** A workspace with one readable file, one writable, and a secret outside it. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'cowcat-sandbox-'));
  const project = join(root, 'proj');
  const outside = join(root, 'outside');
  mkdirSync(project);
  mkdirSync(outside);
  writeFileSync(join(project, 'readable.txt'), 'visible\n');
  writeFileSync(join(outside, 'secret.txt'), 'must-not-be-readable\n');
  return { root, project, outside };
}

function systemSpec(project: string, command: string, home: string) {
  const fs = new NodeFs();
  const read = resolveEntries({ entries: [project, ...DEFAULT_READ_DENY.map(() => join(home, '.ssh'))], cwd: project, home, fs });
  const write = resolveEntries({ entries: [project], cwd: project, home, fs });
  return {
    argv: [process.execPath, '-e', command],
    cwd: project,
    env: {},
    sandbox: defaultSandboxProfile({
      mode: 'system' as const,
      read: { profile: 'workspace' as const, allow: read.resolved, deny: [] },
      write: { allow: write.resolved, deny: [] },
      limitations: read.unsupported.map((entry) => `${entry.entry}: ${entry.why}`),
    }),
  };
}

test('a sandboxed run really is sandboxed', { skip }, async (t) => {
  const { root, project, outside } = workspace();
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, 'home');
  mkdirSync(home);
  const port = realPort();

  // 1. The command runs at all, and the gateway reports the backend it actually applied.
  const ok = await port.run(
    systemSpec(project, 'process.stdout.write("RAN:" + require("fs").readFileSync("readable.txt","utf8").trim())', home),
    new AbortController().signal,
  );
  assert.equal(ok.stdout, 'RAN:visible');
  assert.equal(ok.sandbox.mode, 'system');
  assert.equal(ok.sandbox.backend, verdict?.name);

  // 2. A write inside the project reaches the host. Without this the other two
  //    assertions would pass on a sandbox that simply refuses everything.
  const wrote = await port.run(systemSpec(project, 'require("fs").writeFileSync("written.txt","x")', home), new AbortController().signal);
  assert.equal(wrote.exitCode, 0, wrote.stderr);
  assert.equal(existsSync(join(project, 'written.txt')), true, 'writes inside the project must reach the host');

  // 3. G2: a path outside the read surface is unreachable, and its CONTENTS never
  //    appear. The refusal is spelled differently by the two backends, and the spelling
  //    is a property of the platform, not of our code:
  //      bwrap    → ENOENT, because an unbound path is simply ABSENT
  //      seatbelt → EPERM, because the profile denies an operation on a real path
  //    Both mean the same thing to the user, and both are refusals the tool layer has to
  //    explain rather than let the model read as "the file does not exist" or "try
  //    another way" (research/p2-sandbox.md §2, §5).
  const denied = await port.run(
    systemSpec(project, `process.stdout.write(require("fs").readFileSync(${JSON.stringify(join(outside, 'secret.txt'))}, "utf8"))`, home),
    new AbortController().signal,
  );
  assert.equal(denied.stdout, '', 'the contents must never reach the caller');
  assert.doesNotMatch(denied.stdout, /must-not-be-readable/);
  assert.notEqual(denied.exitCode, 0);
  assert.match(denied.stderr, /ENOENT|EACCES|EPERM|No such file|not permitted|Permission denied/i, denied.stderr);

  // 4. G1: a write outside the project does not appear on the host.
  const escaped = join(root, 'escaped.txt');
  const wrote_out = await port.run(systemSpec(project, `require("fs").writeFileSync(${JSON.stringify(escaped)}, "x")`, home), new AbortController().signal);
  assert.notEqual(wrote_out.exitCode, 0);
  assert.equal(existsSync(escaped), false, 'a write outside the project must not reach the host');
});

test('a sandboxed run cannot reach the network when the policy says off', { skip }, async (t) => {
  const { root, project } = workspace();
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, 'home');
  mkdirSync(home);

  // A raw connect, not an HTTP request: the control has to be the namespace, because a
  // client that ignores HTTP_PROXY (Node's fetch, for one) must still fail.
  const result = await realPort().run(
    systemSpec(project, 'require("dns").lookup("example.com", (e, a) => process.stdout.write(e ? "DENIED" : "RESOLVED:" + a))', home),
    new AbortController().signal,
  );

  assert.equal(result.stdout, 'DENIED', `name resolution worked inside the sandbox: ${result.stdout} ${result.stderr}`);
});

test('the generated argv is the one a reader can check', () => {
  // Runs everywhere, including where no backend exists: the ARGUMENT is the product, and
  // a change to it should be visible in a diff rather than only in a CI log. The real
  // behaviour is the two tests above; this one is about the shape, so it declares a
  // usable backend rather than depending on the host having one.
  const argv = createSandboxExecutor({
    platform: fakePlatform({
      platform: 'linux',
      backends: [{ name: 'bwrap', usable: true, reason: 'ok', detail: '/usr/bin/bwrap', fix: null, hardening: [] }],
    }),
    fsProbe: { isDir: () => true, isFile: () => false },
  })({
    argv: ['/bin/bash', '-c', 'echo hi'],
    cwd: '/proj',
    env: {},
    sandbox: defaultSandboxProfile({
      mode: 'system',
      read: { profile: 'workspace', allow: ['/proj'], deny: [] },
      write: { allow: ['/proj'], deny: [] },
    }),
  });

  assert.equal(argv.argv[0], 'bwrap');
  assert.ok(argv.argv.includes('--unshare-pid'), 'pid namespace');
  assert.ok(argv.argv.includes('--unshare-net'), 'network off by default');
  assert.ok(argv.argv.includes('--tmpfs'), 'a private scratch filesystem');
  assert.ok(argv.argv.includes('--size'), 'capped, because the default is half of RAM');
});