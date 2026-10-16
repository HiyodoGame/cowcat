// The authoritative enforcement check for the macOS backend: real sandbox-exec,
// real kernel, real claims.
//
// Everything else in the sandbox suite is pure logic (policy → SBPL → messages)
// that runs anywhere. This file asserts the OUTCOMES the plan promises (§2,
// G1–G3) and only runs where Seatbelt actually works. On a machine without it
// the tests skip with the reason the preflight found — a skip is honest; a green
// tick would not be.
//
// This is the ONLY file that can prove the Phase 2 claims. It runs in the
// macOS CI leg (.github/workflows/ci-macos.yml), which is path-filtered and
// deliberately outside the required checks: macOS runners bill at 10x and this
// repository is private, so "every PR" is not affordable. When you touch
// src/sandbox/**, make sure that leg actually ran.
//
// macOS-specific traps this file is written around:
//   - the host temp dir is `/var/folders/…` (a symlink to `/private/var/…`) and
//     it is PER USER, so the sandbox's own scratch dir is a sibling of real
//     secrets. Reading it by absolute path has to fail;
//   - Seatbelt reports nothing itself — a denial surfaces as the sandboxed
//     command's own EPERM/ENOENT, which is what detectViolations() matches;
//   - a hidden path looks like a MISSING path, so the refusal has to say so or
//     the model concludes the file does not exist and goes looking for a way
//     around the sandbox (research §2.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BashTool } from '../src/tools/bash.js';
import { sandboxProbe } from '../src/sandbox/probe.js';

const probe = sandboxProbe({ force: true });
const seatbelt = (probe.backends || []).find((b) => b.name === 'seatbelt');
const skip = !seatbelt?.usable
  ? `seatbelt unusable here — ${seatbelt ? `[${seatbelt.reason}] ${seatbelt.detail || ''}` : `no seatbelt backend on ${probe.platform}`}`
  : false;

// Canonical: on macOS os.tmpdir() answers with the symlinked spelling while the
// kernel reports /private/var/… — and the policy canonicalizes (src/canonical.js).
// Fixtures must speak the kernel's language or the assertions are about spelling.
const TMP = await import('../src/canonical.js').then((m) => m.canonicalPath(tmpdir()));

const proj = mkdtempSync(join(TMP, 'cowcat-mac-'));
// Two "host secrets" in the two places a naive sandbox leaks from: the home
// directory (never in the workspace read surface) and the host temp directory
// (the sandbox gets its own private scratch dir in there, so its siblings must
// be unreachable).
const homeSecret = join(homedir(), `.cowcat-secret-${process.pid}`);
const hostTmpSecret = join(TMP, `cowcat-secret-${process.pid}`);
for (const f of [homeSecret, hostTmpSecret]) writeFileSync(f, 'host secret that the sandbox must not reach\n');

const run = (command) => BashTool.execute(
  { command, timeout: 30000 },
  { cwd: proj, config: { sandbox: 'system' }, env: {} },
);

test.after(() => {
  for (const f of [homeSecret, hostTmpSecret]) rmSync(f, { force: true });
  rmSync(proj, { recursive: true, force: true });
});

test('macOS sandbox: works inside the project, and the workspace is really there', { skip }, async () => {
  const res = await run(`echo hello > ${join(proj, 'inside.txt')} && cat ${join(proj, 'inside.txt')}`);
  assert.equal(res.exitCode, 0, res.output);
  assert.match(res.stdout, /hello/, res.output);
  assert.ok(existsSync(join(proj, 'inside.txt')), 'the project write landed on the real filesystem');
});

test('macOS sandbox: writes outside the project do not reach the host (G1)', { skip }, async () => {
  // The exit code is NOT the guarantee. The sandbox legitimately creates its own
  // TMPDIR, so a write there can "succeed" inside. What must never happen is the
  // HOST filesystem changing.
  const hostTmpVictim = join(TMP, `cowcat-hosttmp-${process.pid}`);
  const homeVictim = join(homedir(), `.cowcat-home-${process.pid}`);
  await Promise.all([run(`echo nope > ${hostTmpVictim}`), run(`echo nope > ${homeVictim}`)]);
  assert.ok(!existsSync(hostTmpVictim), 'nothing appeared in the host temp directory');
  assert.ok(!existsSync(homeVictim), 'nothing appeared in the host home directory');
});

test('macOS sandbox: the sandbox gets a private scratch dir, not the host one', { skip }, async () => {
  const res = await run('echo $TMPDIR');
  const reported = res.stdout.trim();
  assert.ok(reported, `TMPDIR must be set inside the sandbox: ${res.output}`);
  assert.notEqual(reported, TMP, `TMPDIR must not be the host per-user temp directory: ${res.output}`);
  assert.match(reported, /cowcat-sbx-/, `TMPDIR must be this call's private dir: ${reported}\n${res.output}`);
  // …and it is writable, or every build tool breaks.
  const w = await run('echo x > "$TMPDIR/probe" && cat "$TMPDIR/probe"');
  assert.equal(w.exitCode, 0, `the private scratch dir must be writable: ${w.output}`);
  assert.match(w.stdout, /^x/m);
});

test('macOS sandbox: host files outside the read surface are unreachable (G2)', { skip }, async () => {
  const [fromHome, fromTmp] = await Promise.all([run(`cat ${homeSecret}`), run(`cat ${hostTmpSecret}`)]);
  for (const res of [fromHome, fromTmp]) {
    assert.notEqual(res.exitCode, 0, `reading must fail: ${res.output}`);
    assert.ok(!res.stdout.includes('host secret'), `the content never reaches the tool result: ${res.output}`);
  }
  // A hidden path looks like a missing one; saying so is what stops the model
  // from concluding "the file does not exist" (or hunting for a workaround).
  assert.match(fromHome.output, /\[sandbox\] system mode/, `the refusal is explained as the sandbox: ${fromHome.output}`);
});

test('macOS sandbox: credential paths are unreachable, not merely unreadable (G2)', { skip }, async () => {
  const res = await run('ls -a ~/.ssh; cat ~/.ssh/id_rsa');
  assert.notEqual(res.exitCode, 0, res.output);
  assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(res.stdout), `no key material in the result: ${res.output}`);
});

test('macOS sandbox: rm still works inside the project', { skip }, async () => {
  // The move-blocking rules deny file-write-unlink on read-denied paths AND pin
  // their parent directories. srt had to re-allow unlink/create for the write
  // roots to keep `rm` usable; if that regresses, an agent cannot clean up.
  const res = await run(`echo x > ${join(proj, 'rm-me.txt')} && rm ${join(proj, 'rm-me.txt')} && echo removed`);
  assert.equal(res.exitCode, 0, res.output);
  assert.match(res.stdout, /removed/, res.output);
  assert.ok(!existsSync(join(proj, 'rm-me.txt')));
});

// Node's fetch ignores HTTP_PROXY by construction — which is exactly why the
// network control has to be a profile, not an env var (research §2.5).
const FETCH_CMD = 'node -e "fetch(\'https://example.com\').then(r=>console.log(\'REACHED\', r.status)).catch(e=>{console.error(\'blocked\', e.cause?.code || e.name); process.exit(3)})"';

test('macOS sandbox: no network, without relying on proxy environment variables (G3)', { skip }, async () => {
  const res = await run(FETCH_CMD);
  assert.notEqual(res.exitCode, 0, `the fetch must fail: ${res.output}`);
  assert.ok(!res.stdout.includes('REACHED'), `nothing was reached: ${res.output}`);
});

test('macOS sandbox: an approved call STILL gets no network, and says why (Phase 2 boundary)', { skip }, async () => {
  const home = mkdtempSync(join(TMP, 'cowcat-mac-home-'));
  const prev = process.env.COWCAT_HOME;
  process.env.COWCAT_HOME = home;
  const config = { sandbox: { mode: 'system', network: 'ask' } };
  const call = (extra) => BashTool.execute(
    { command: FETCH_CMD, timeout: 30000 },
    { cwd: proj, config, env: {}, ...extra },
  );
  try {
    const denied = await call({});
    assert.notEqual(denied.exitCode, 0, `unapproved call must have no network: ${denied.output}`);
    assert.ok(!denied.stdout.includes('REACHED'));

    // The approved call is refused outright instead of running with a network it
    // cannot use. Measured on macOS 15: even with EVERY mach service and EVERY
    // unix socket allowed, getaddrinfo does not come back up inside the sandbox
    // (tools/seatbelt-smoke.mjs --net). "Granted but broken" would read as a
    // broken sandbox and send the agent hunting for a way around it.
    const approved = await call({ networkApproved: true });
    assert.ok(approved.error, `approved call must be refused, not run: ${approved.output}`);
    assert.match(approved.error, /network-not-supported/, 'the refusal names the reason');
    // A refused call carries `error` and NO `output` — reading output here is a
    // TypeError, not a failure message. (Learned the hard way: these tests skip on
    // every non-macOS machine, so nothing local would have caught it.)
    const out = approved.output || '';
    assert.ok(!out.includes('REACHED'), 'nothing was reached');
    assert.ok(!out.includes('DNSOK'), 'nothing resolved');

    // And nothing ran unsandboxed behind the refusal: a blocked line is audited.
    const lines = readFileSync(join(home, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.at(-1).decision, 'blocked');
    assert.equal(lines.at(-1).backend, 'seatbelt');
  } finally {
    if (prev === undefined) delete process.env.COWCAT_HOME;
    else process.env.COWCAT_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('macOS sandbox: the audit line records the enforced mode and backend', { skip }, async () => {
  const home = mkdtempSync(join(TMP, 'cowcat-mac-sys-home-'));
  const prev = process.env.COWCAT_HOME;
  process.env.COWCAT_HOME = home;
  try {
    await run('echo audited');
    const lines = readFileSync(join(home, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = lines.at(-1);
    assert.equal(last.mode, 'system');
    assert.equal(last.backend, 'seatbelt');
    assert.equal(last.network, 'off');
  } finally {
    if (prev === undefined) delete process.env.COWCAT_HOME;
    else process.env.COWCAT_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('macOS sandbox: the private scratch dir does not outlive the call', { skip }, async () => {
  const res = await run('echo $TMPDIR');
  const reported = res.stdout.trim();
  assert.ok(reported.startsWith(TMP), `sanity: the scratch dir lives under the temp root (${reported}): ${res.output}`);
  assert.ok(!existsSync(reported), `the scratch dir must be removed when the command ends: ${reported}`);
});