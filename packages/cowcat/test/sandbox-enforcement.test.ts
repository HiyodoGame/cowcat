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
  type ProcessResult,
} from '../src/index.js';
import { fakePlatform } from './fakes-ports.js';

// G1/G2/G3, against a REAL backend. This is the enforcement evidence for the system
// tier: the flags and the profile are pure functions tested elsewhere, and this file is
// the only place where the kernel gets a vote.
//
// ── What these tests prove, and what they do not ──────────────────────────────
// Borrowing the Verification Autonomy Levels from arXiv:2610.04504 — "zero is an
// outcome, not a guarantee" — what is asserted here is L2: objective ground truth for
// the cases these tests actually run, on the machine they actually ran on. It is NOT L3
// or L4 (decidable completeness), and it is not a security guarantee. A change to the
// kernel, a new mount option, or an unrun platform can all invalidate the claim without
// any test going red. Anyone citing "the sandbox is secure" is citing something these
// tests do not establish.
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
      fsProbe: {
        isDir: (path) => fs.kindOf(path) === 'directory',
        isFile: (path) => fs.kindOf(path) === 'file',
        canonical: (path) => fs.canonical(path),
      },
    }),
  });
}

interface Fixture {
  readonly root: string;
  readonly project: string;
  readonly home: string;
  readonly outside: string;
}

/**
 * A workspace with a readable file, a home directory holding a credential-shaped
 * directory, and a directory outside the read surface. The credential path is the one
 * that matters: it is the shape a real leak takes (research/p2-ports.md §2.5 measured
 * a sandboxed read as sufficient to expose it).
 */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'cowcat-sandbox-'));
  const project = join(root, 'proj');
  const home = join(root, 'home');
  const outside = join(root, 'outside');
  mkdirSync(project);
  mkdirSync(home);
  mkdirSync(outside);
  writeFileSync(join(project, 'readable.txt'), 'visible\n');
  writeFileSync(join(project, 'victim.txt'), 'must survive a sandboxed rm\n');
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'PRIVATE KEY MATERIAL\n');
  writeFileSync(join(outside, 'secret.txt'), 'must-not-be-readable\n');
  return { root, project, home, outside };
}

function systemSpec(f: Fixture, command: string, overrides: { readonly readDeny?: readonly string[] } = {}) {
  const fs = new NodeFs();
  const read = resolveEntries({ entries: [f.project, f.home], cwd: f.project, home: f.home, fs });
  const deny = resolveEntries({
    entries: overrides.readDeny ?? [...DEFAULT_READ_DENY.map(() => join(f.home, '.ssh')), f.outside],
    cwd: f.project,
    home: f.home,
    fs,
  });
  const write = resolveEntries({ entries: [f.project], cwd: f.project, home: f.home, fs });
  return {
    argv: [process.execPath, '-e', command],
    cwd: f.project,
    env: {},
    sandbox: defaultSandboxProfile({
      mode: 'system' as const,
      read: { profile: 'workspace' as const, allow: read.resolved, deny: deny.resolved },
      write: { allow: write.resolved, deny: [] },
      limitations: [...read.unsupported, ...deny.unsupported].map((entry) => `${entry.entry}: ${entry.why}`),
    }),
  };
}

interface Run {
  readonly result: ProcessResult;
  /**
   * The exact argv — and on macOS the whole SBPL profile — that was applied.
   *
   * A refusal is only diagnosable against the profile that produced it: "EPERM" and "this
   * line is not in the allow list" are different bugs, and without the profile the second
   * one is invisible. It is built once and cleaned up immediately, because on macOS this
   * creates a real scratch directory and the run below makes its own.
   */
  readonly applied: string;
}

function run(f: Fixture, command: string, signal = new AbortController().signal): Promise<Run> {
  const nodeFs = new NodeFs();
  const executor = createSandboxExecutor({
    platform,
    fsProbe: {
      isDir: (candidate) => nodeFs.kindOf(candidate) === 'directory',
      isFile: (candidate) => nodeFs.kindOf(candidate) === 'file',
      canonical: (candidate) => nodeFs.canonical(candidate),
    },
  });
  const spec = systemSpec(f, command);
  const preview = executor(spec);
  try {
    preview.cleanup?.();
  } catch {
    /* the record is worth more than the directory it left behind */
  }
  const applied = [preview.argv[0], ...preview.argv.slice(1)].join(' ');
  return realPort().run(spec, signal).then((result) => ({ result, applied }));
}

function node(expression: string): string {
  return `require("fs").${expression}`;
}

/**
 * Why a file is (or is not) there, in the failure message.
 *
 * Three of these cases failed once with a bare `true !== false` and no way to tell a
 * refusal from a wrong path from a test bug. A sandbox's whole job is to make refusals
 * quiet, so the test has to be the loud one.
 */
function stateOf(result: ProcessResult, applied: string, path: string): string {
  return [
    `${path} exists=${String(existsSync(path))} exit=${String(result.exitCode)}`,
    `stderr=${result.stderr.trim().slice(0, 300)}`,
    `applied=${applied}`,
  ].join('\n');
}

function gone(result: ProcessResult, applied: string, path: string, why: string): void {
  assert.equal(existsSync(path), false, `${why}: ${stateOf(result, applied, path)}`);
}

function present(result: ProcessResult, applied: string, path: string, why: string): void {
  assert.equal(existsSync(path), true, `${why}: ${stateOf(result, applied, path)}`);
}

// ── the workspace has to be there, or nothing below proves anything ────────────

test('G0: a sandboxed run really runs, and the gateway reports what it applied', { skip }, async (t) => {
  const f = fixture();
  t.after(() => {
    rmSync(f.root, { recursive: true, force: true });
  });

  const { result, applied } = await run(f, `process.stdout.write("RAN:" + require("fs").readFileSync("readable.txt","utf8").trim())`);

  assert.equal(result.stdout, 'RAN:visible', result.stderr);
  assert.equal(result.exitCode, 0);
  // What was APPLIED, not what was asked for — the field an audit reads to answer
  // "was this run really sandboxed?" (03-policy-and-execution.md, principle 2).
  assert.equal(result.sandbox.mode, 'system');
  assert.equal(result.sandbox.backend, verdict?.name);
  // …and the result's `backend` is only a CLAIM. This is the evidence: the argv actually
  // handed to the kernel. Without it, the audit field is exactly as trustworthy as the
  // code that filled it in, which is the thing nobody re-checks after a refactor.
  const marker = verdict?.name === 'bwrap' ? '--unshare-net' : '(deny default)';
  assert.ok(applied.includes(marker), `the applied argv does not look like a ${String(verdict?.name)} sandbox: ${applied}`);
});

// ── G1: writes stay inside the granted scope ───────────────────────────────────

test('G1: a write inside the project reaches the host', { skip }, async (t) => {
  const f = fixture();
  t.after(() => {
    rmSync(f.root, { recursive: true, force: true });
  });

  // Without this, every refusal below would also pass on a sandbox that simply
  // refuses everything — which is the failure mode that makes a broken sandbox look
  // like a strict one.
  const { result, applied } = await run(f, node(`writeFileSync("written.txt","x")`));

  assert.equal(result.exitCode, 0, result.stderr);
  present(result, applied, join(f.project, 'written.txt'), 'a granted write must reach the host');
});

test('G1: rm works inside the project', { skip }, async (t) => {
  const f = fixture();
  t.after(() => {
    rmSync(f.root, { recursive: true, force: true });
  });

  // Not cosmetic: Seatbelt's move-blocking deny for read-denied paths OUTRANKS a
  // wildcard write allow, so unlink/create has to be re-opened for the write roots or
  // `rm` inside the project is impossible. The flag is easy to lose in a refactor and
  // the symptom is "the agent cannot delete anything", which reads as a permission bug.
  const { result, applied } = await run(f, node('unlinkSync("victim.txt")'));

  assert.equal(result.exitCode, 0, result.stderr);
  gone(result, applied, join(f.project, 'victim.txt'), 'rm inside the project must actually delete');
});

test('G1: a write under the host temp directory never reaches the host', { skip }, async (t) => {
  const f = fixture();
  t.after(() => {
    rmSync(f.root, { recursive: true, force: true });
  });

  // What happens INSIDE differs by backend, measurably: bwrap's private tmpfs makes the
  // path writable and the write lands nowhere (exit 0); seatbelt has no mount
  // namespace and refuses outright (EPERM). Both are correct isolation, so the
  // assertion is on the HOST side and says nothing about the exit code — getting that
  // backwards is easy, and it happened twice (research/p2-sandbox.md §2.1).
  const target = join(f.root, 'escaped.txt');
  const { result, applied } = await run(f, node(`writeFileSync(${JSON.stringify(target)},"x")`));

  gone(result, applied, target, 'a write into the sandbox scratch area must not reach the host');
});

test('G1: a write outside the granted scope does not reach the host', { skip }, async (t) => {
  const f = fixture();
  t.after(() => {
    rmSync(f.root, { recursive: true, force: true });
  });

  // /etc is bound read-only for toolchains on both backends, so this answers EROFS
  // (bwrap) / EPERM (seatbelt) rather than the ENOENT an unbound path gives.
  const etc = '/etc/cowcat-sandbox-escape-test';
  assert.equal(existsSync(etc), false, 'the fixture must not already exist');
  const { result, applied } = await run(f, node(`writeFileSync(${JSON.stringify(etc)},"x")`));

  assert.notEqual(result.exitCode, 0, result.stderr);
  gone(result, applied, etc, 'a write outside the allow-list must not reach the host');
});

test('G1 boundary: destruction INSIDE the granted scope is NOT prevented', { skip }, async (t) => {
  // This asserts a LIMIT of the guarantee, and that is the point. Scope expansion — an
  // agent deleting unrelated files on a benign task — is a real and distinct failure
  // mode from escaping (arXiv:2605.18583 measured a 17.1% overeager rate from removing
  // the consent declaration alone). It is an AUTHORIZATION problem, not a capability
  // one: these files are inside write.allow, so the sandbox is behaving correctly.
  //
  // Pinning it stops two opposite mistakes later: silently claiming the sandbox
  // prevents this, and "fixing" it here by denying rm (which would break every real
  // coding workflow). The control belongs to the approval gate in P3/P5.
  const f = fixture();
  t.after(() => {
    rmSync(f.root, { recursive: true, force: true });
  });

  // Separated by ';' rather than '&&': unlinkSync returns undefined, so '&&' would
  // short-circuit after the first delete and the second assertion would then pass for
  // the wrong reason — which is exactly what happened the first time.
  // `node()` prefixes the whole expression with `require("fs").`, so two statements need
  // two prefixes — and the second unlink needs `;` rather than `&&`, because unlinkSync
  // returns undefined and `&&` short-circuits after the first delete.
  const { result, applied } = await run(f, node('unlinkSync("victim.txt"); require("fs").unlinkSync("readable.txt")'));

  assert.equal(result.exitCode, 0, result.stderr);
  gone(result, applied, join(f.project, 'victim.txt'), 'in-scope deletion is not prevented');
  gone(result, applied, join(f.project, 'readable.txt'), 'in-scope deletion is not prevented');
});

// ── G2: reads stay inside the granted surface ─────────────────────────────────

test('G2: a file outside the read surface is unreachable', { skip }, async (t) => {
  const f = fixture();
  t.after(() => {
    rmSync(f.root, { recursive: true, force: true });
  });

  const secret = join(f.outside, 'secret.txt');
  const { result, applied } = await run(f, `process.stdout.write(require("fs").readFileSync(${JSON.stringify(secret)},"utf8"))`);

  // The refusal is spelled differently by the two backends and that is a property of
  // the platform, not of our code: bwrap reports ENOENT (an unbound path is simply
  // absent), seatbelt reports EPERM (the path exists and the profile refuses the
  // operation). Asserting the SEMANTICS — the contents never arrive — rather than one
  // backend's spelling.
  assert.equal(result.stdout, '', `the contents must never reach the caller: ${stateOf(result, applied, secret)}`);
  assert.doesNotMatch(result.stdout, /must-not-be-readable/);
  assert.notEqual(result.exitCode, 0, result.stderr);
  assert.match(
    result.stderr,
    /ENOENT|EACCES|EPERM|No such file|not permitted|Permission denied/i,
    `the refusal must be recognisable as a refusal: ${stateOf(result, applied, secret)}`,
  );
});

test('G2: a credential-shaped directory is unreachable even inside the allowed home', { skip }, async (t) => {
  const f = fixture();
  t.after(() => {
    rmSync(f.root, { recursive: true, force: true });
  });

  // The read surface here deliberately INCLUDES the home directory, and the deny still
  // holds. This is the ordering that Seatbelt gets wrong most easily: last match wins,
  // so the deny must be emitted after the allow (the builder emits it last, and
  // test/sandbox-seatbelt.test.ts pins that ordering).
  const key = join(f.home, '.ssh', 'id_rsa');
  const { result, applied } = await run(f, `process.stdout.write(require("fs").readFileSync(${JSON.stringify(key)},"utf8"))`);

  assert.equal(result.stdout, '', `a denied path must produce no output at all: ${stateOf(result, applied, key)}`);
  assert.doesNotMatch(result.stdout, /PRIVATE KEY/);
  assert.notEqual(result.exitCode, 0, result.stderr);
});

test('G2: the home directory itself stays readable, or nothing would work', { skip }, async (t) => {
  const f = fixture();
  t.after(() => {
    rmSync(f.root, { recursive: true, force: true });
  });

  // The counterpart of the test above: a deny must not swallow its whole parent. If this
  // ever fails, the fix is in the policy, never in the test.
  //
  // The path below is the FRIENDLY spelling (`/var/folders/…`, what mkdtemp returned), and
  // that is deliberate rather than incidental. On Seatbelt a granted path answers
  // differently depending on how it is spelled — the profile grants `/private/var/…`, and
  // `/var/…` is refused because `subpath` matches the literal path (measured: OK vs EPERM
  // on the same file, same profile). Reading through the friendly spelling here is what
  // keeps that from regressing into a rule that grants something and silently denies it.
  const allowed = join(f.home, 'notes.txt');
  writeFileSync(allowed, 'home notes\n');
  const { result, applied } = await run(f, `process.stdout.write(require("fs").readFileSync(${JSON.stringify(allowed)},"utf8"))`);

  assert.equal(result.stdout, 'home notes\n', `a granted read must work: ${stateOf(result, applied, allowed)}`);
});

// ── G3: the network is off, at the namespace ───────────────────────────────────

test('G3: name resolution fails inside the sandbox', { skip }, async (t) => {
  const f = fixture();
  t.after(() => {
    rmSync(f.root, { recursive: true, force: true });
  });

  // DNS specifically, not an HTTP request: the control has to be the namespace, because
  // a client that ignores HTTP_PROXY (Node's fetch, for one) must still fail. Proved
  // with a raw /dev/tcp connect in research/p2-sandbox.md §2.
  const { result, applied } = await run(f, 'require("dns").lookup("example.com", (e) => process.stdout.write(e ? "DENIED" : "RESOLVED"))');

  assert.equal(result.stdout, 'DENIED', `name resolution worked inside the sandbox: ${stateOf(result, applied, '(dns)')}`);
});

// ── the private scratch directory ─────────────────────────────────────────────

test('the sandbox has its own scratch space, and the host\'s is not it', { skip }, async (t) => {
  const f = fixture();
  t.after(() => {
    rmSync(f.root, { recursive: true, force: true });
  });

  // The legacy suite caught this in CI on its first run: the host temp directory was in
  // write.allow, the later bind silently undid the tmpfs, and "writes stay inside the
  // project" became a half-truth. Two halves: the host's files are NOT visible, and ours
  // IS writable.
  const hostMarker = join(f.root, 'host-marker.txt');
  writeFileSync(hostMarker, 'host-only\n');

  const { result, applied } = await run(
    f,
    `const fs=require("fs");const p=process.env.TMPDIR||"/tmp";` +
      `process.stdout.write(JSON.stringify({visible:fs.existsSync(${JSON.stringify(hostMarker)}),` +
      `writable:(()=>{try{fs.writeFileSync(p+"/probe","x");fs.unlinkSync(p+"/probe");return true}catch{return false}})()}))`,
  );

  const probe = JSON.parse(result.stdout || '{}') as { visible?: boolean; writable?: boolean };
  assert.equal(probe.visible, false, `the host's temp files must not be readable from inside: ${stateOf(result, applied, hostMarker)} stdout=${result.stdout}`);
  assert.equal(probe.writable, true, `the sandbox needs a writable scratch space or every build tool breaks: ${stateOf(result, applied, '(TMPDIR)')} stdout=${result.stdout}`);
});

// ── a refusal has to be explicable ────────────────────────────────────────────

test('a sandboxed result carries enough to explain a refusal to the model', { skip }, async (t) => {
  const f = fixture();
  t.after(() => {
    rmSync(f.root, { recursive: true, force: true });
  });

  // The refusal itself is the enforcement; being able to EXPLAIN it is what stops the
  // agent from trying to defeat it. Two independent sources say this matters: the legacy
  // research ("an agent that does not understand the refusal tries to defeat it") and
  // Overeager-Gen (arXiv:2605.18583), where merely stating the scope changes behaviour by
  // 17.1 points — so the material for that explanation has to survive into the result
  // rather than living in a log nobody reads.
  const { result, applied } = await run(f, node('unlinkSync("victim.txt")'));

  assert.equal(result.exitCode, 0);
  assert.equal(result.sandbox.mode, 'system');
  assert.equal(result.sandbox.backend, verdict?.name);
  // The material for the explanation has to survive into the result: the refusal is the
  // enforcement, being able to explain it is what stops the agent defeating it.
  assert.ok(Array.isArray(result.sandbox.limitations), `limitations missing: ${stateOf(result, applied, '(project)')}`);
});

// ── the generated argv, checked without a backend ──────────────────────────────

test('the generated argv is the one a reader can check', () => {
  // Runs everywhere, including where no backend exists: the ARGUMENT is the product, and
  // a change to it should be visible in a diff rather than only in a CI log.
  const argv = createSandboxExecutor({
    platform: fakePlatform({
      platform: 'linux',
      backends: [{ name: 'bwrap', usable: true, reason: 'ok', detail: '/usr/bin/bwrap', fix: null, hardening: [] }],
    }),
    fsProbe: { isDir: () => true, isFile: () => false, canonical: (path) => path },
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