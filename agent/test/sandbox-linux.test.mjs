// The authoritative enforcement check for the system-level sandbox: real
// bubblewrap, real kernel, real claims.
//
// Everything else in the sandbox suite is pure logic (policy → argv → messages)
// that runs anywhere. This file asserts the OUTCOMES the plan promises (§2, G1–G3)
// and only runs where bubblewrap actually works. On a machine without it the
// tests skip with the reason the preflight found — a skip is honest; a green
// tick would not be.
//
// CI note: ubuntu-latest is Ubuntu 24.04, where AppArmor restricts unprivileged
// user namespaces by default. The workflow installs bubblewrap and applies the
// profile our own fix instructions name, so this file is also the regression test
// for that path: if the documented fix stops working, these tests skip and the
// workflow log says why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BashTool } from '../src/tools/bash.js';
import { sandboxProbe } from '../src/sandbox/probe.js';

const probe = sandboxProbe({ force: true });
const bwrap = (probe.backends || []).find((b) => b.name === 'bwrap');
// The skip reason is the classification itself, so an unusable environment says
// WHICH failure it hit (missing / userns-blocked / unsupported platform) instead
// of a bare "skipped".
const skip = !bwrap?.usable
  ? `bwrap unusable here — ${bwrap ? `[${bwrap.reason}] ${bwrap.detail || ''}` : `no bwrap backend on ${probe.platform}`}`
  : false;

const proj = mkdtempSync(join(tmpdir(), 'cowcat-sys-'));
// Two "host secrets" in the two places a naive sandbox leaks from: the home
// directory (never bound in the workspace read profile) and the host temp
// directory (the sandbox gets its own private /tmp, so the host one must be
// invisible even though the paths look the same).
const homeSecret = join(homedir(), `.cowcat-secret-${process.pid}`);
const hostTmpSecret = join(tmpdir(), `cowcat-secret-${process.pid}`);
for (const f of [homeSecret, hostTmpSecret]) writeFileSync(f, 'host secret that the sandbox must not reach\n');

const run = (command) => BashTool.execute(
  { command, timeout: 30000 },
  { cwd: proj, config: { sandbox: 'system' }, env: {} },
);

test('system sandbox: works inside the project, and the workspace is really there', { skip }, async () => {
  const res = await run(`echo hello > ${join(proj, 'inside.txt')} && cat ${join(proj, 'inside.txt')}`);
  assert.equal(res.exitCode, 0, res.output);
  assert.match(res.stdout, /hello/);
  assert.ok(existsSync(join(proj, 'inside.txt')), 'the project write landed on the real filesystem');
});

test('system sandbox: writes outside the project do not reach the host (G1)', { skip }, async () => {
  // The exit code is NOT the guarantee here. The sandbox legitimately has to
  // create an empty /home/<user> (to mount the allowed home files) and its own
  // /tmp, so a write to either path can "succeed" inside the sandbox — the first
  // CI run asserted the exit code and failed for exactly that reason. What must
  // never happen is the HOST filesystem changing.
  const hostTmpVictim = join(tmpdir(), `cowcat-hosttmp-${process.pid}`);
  const homeVictim = join(homedir(), `.cowcat-home-${process.pid}`);
  await Promise.all([run(`echo nope > ${hostTmpVictim}`), run(`echo nope > ${homeVictim}`)]);
  assert.ok(!existsSync(hostTmpVictim), 'nothing appeared in the host temp directory');
  assert.ok(!existsSync(homeVictim), 'nothing appeared in the host home directory');
  rmSync(hostTmpVictim, { force: true });
  rmSync(homeVictim, { force: true });
});

test('system sandbox: host files outside the read surface are unreachable (G2)', { skip }, async () => {
  const [fromHome, fromTmp] = await Promise.all([run(`cat ${homeSecret}`), run(`cat ${hostTmpSecret}`)]);
  for (const res of [fromHome, fromTmp]) {
    assert.notEqual(res.exitCode, 0, `reading must fail: ${res.output}`);
    assert.ok(!res.stdout.includes('host secret'), 'the content never reaches the tool result');
  }
  // Hidden paths look like missing ones; saying so is what stops the model from
  // concluding "the file does not exist" (or worse, hunting for a workaround).
  assert.match(fromHome.output, /\[sandbox\] system mode/, 'the refusal is explained as the sandbox');
});

test('system sandbox: credential paths are hidden, not merely unreadable (G2)', { skip }, async () => {
  const res = await run('ls -a ~/.ssh; cat ~/.ssh/id_rsa');
  assert.notEqual(res.exitCode, 0);
  assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(res.stdout), 'no key material in the result');
});

// Node's fetch ignores HTTP_PROXY by construction — which is exactly why the
// network control has to be a namespace, not an env var (research §2.5). Reused
// by the G3 test and the Phase 1b grant test.
const FETCH_CMD = 'node -e "fetch(\'https://example.com\').then(r=>console.log(\'REACHED\', r.status)).catch(e=>{console.error(\'blocked\', e.cause?.code || e.name); process.exit(3)})"';

test('system sandbox: no network, without relying on proxy environment variables (G3)', { skip }, async () => {
  const res = await run(FETCH_CMD);
  assert.notEqual(res.exitCode, 0, 'the fetch must fail');
  assert.ok(!res.stdout.includes('REACHED'), 'nothing was reached');
});

test('system sandbox: network "ask" grants the network for an approved call only (Phase 1b)', { skip }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'cowcat-ask-home-'));
  const prev = process.env.COWCAT_HOME;
  process.env.COWCAT_HOME = home;
  const config = { sandbox: { mode: 'system', network: 'ask' } };
  const call = (extra) => BashTool.execute(
    { command: FETCH_CMD, timeout: 30000 },
    { cwd: proj, config, env: {}, ...extra },
  );
  try {
    // Without the grant the namespace stays off, even though the policy is `ask`
    // (the approval is what turns it on, not the setting).
    const denied = await call({});
    assert.notEqual(denied.exitCode, 0, 'unapproved call must have no network');
    assert.ok(!denied.stdout.includes('REACHED'));

    const approved = await call({ networkApproved: true });
    assert.equal(approved.exitCode, 0, `approved call should reach the network: ${approved.output}`);
    assert.match(approved.stdout, /REACHED 200/);

    // The audit line must record which of the two it was.
    const lines = readFileSync(join(home, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const networks = lines.filter((l) => l.mode === 'system').map((l) => l.network);
    assert.deepEqual(networks.slice(-2), ['off', 'on'], `expected off then on, got ${networks.join(',')}`);
  } finally {
    if (prev === undefined) delete process.env.COWCAT_HOME;
    else process.env.COWCAT_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('system sandbox: the audit line records the enforced mode and backend', { skip }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'cowcat-sys-home-'));
  const prev = process.env.COWCAT_HOME;
  process.env.COWCAT_HOME = home;
  try {
    await run('echo audited');
    const lines = readFileSync(join(home, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = lines.at(-1);
    assert.equal(last.mode, 'system');
    assert.equal(last.backend, 'bwrap');
    assert.equal(last.network, 'off');
  } finally {
    if (prev === undefined) delete process.env.COWCAT_HOME;
    else process.env.COWCAT_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
