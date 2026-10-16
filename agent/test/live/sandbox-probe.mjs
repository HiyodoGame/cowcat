// Phase 0 baseline probe: what can a Bash command actually reach TODAY?
//
//   node agent/test/live/sandbox-probe.mjs
//
// This is the "before" measurement the sandbox plan asks for (§8.1-5). Without
// it, "system mode blocks X" is an unfalsifiable claim: we would have no idea
// whether X was reachable in the first place. Each check runs through the REAL
// BashTool with sandbox 'off' and 'light', so the table shows what these two
// modes permit, not what an abstract shell could do.
//
// Not part of `npm test`: it touches the live home directory and the network.
// Read-only except for one temp file outside the project, removed in the same
// process. Secrets are never printed — only whether a file was readable and how
// many bytes it had.
//
// `system` is deliberately absent: Phase 0 only reports which backend is
// available (see src/sandbox/probe.js); wiring it into the Bash tool is Phase 1.
import { writeFileSync, statSync, readdirSync, accessSync, unlinkSync, mkdtempSync, constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BashTool } from '../../src/tools/bash.js';
import { sandboxProbe, formatSandboxProbe } from '../../src/sandbox/probe.js';
import { cowcatHome } from '../../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- child probe
// Runs INSIDE the sandboxed command: prints one `PROBE <name> ok|denied <detail>`
// line. Doing this in a file instead of `node -e "..."` avoids arguing about
// quoting across Git Bash / cmd / sh, which is where such probes usually break.
function ghTokenPath() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'GitHub CLI', 'hosts.yml');
  }
  return join(homedir(), '.config', 'gh', 'hosts.yml');
}

const CHILD_CHECKS = {
  'read-ssh': () => `entries=${readdirSync(join(homedir(), '.ssh')).length}`,
  'read-gh-token': () => `bytes=${statSync(ghTokenPath()).size}`,
  'env-token': () => {
    const v = process.env.COWCAT_PROBE_TOKEN;
    if (v === undefined) throw new Error('COWCAT_PROBE_TOKEN absent');
    return `value=${v === 'planted-value' ? 'visible' : 'rewritten'}`;
  },
  'net-fetch': async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch('https://example.com', { signal: ctl.signal });
      return `status=${res.status}`;
    } finally { clearTimeout(t); }
  },
  'write-tmp': () => {
    const f = join(tmpdir(), `cowcat-probe-${process.pid}`);
    writeFileSync(f, 'x');
    unlinkSync(f);
    return 'wrote+removed outside cwd';
  },
  'write-cowcat-home': () => {
    accessSync(cowcatHome(), constants.W_OK);
    return 'cowcatHome is writable';
  },
};

if (process.argv[2] === '--child') {
  const name = process.argv[3];
  const fn = CHILD_CHECKS[name];
  try {
    // eslint-disable-next-line no-console
    console.log(`PROBE ${name} ok ${await fn()}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`PROBE ${name} denied ${e.code || e.message}`);
  }
  process.exit(0);
}

// -------------------------------------------------------------- driver
const CHECKS = Object.keys(CHILD_CHECKS);
const MODES = ['off', 'light'];

const tmpProj = mkdtempSync(join(tmpdir(), 'cowcat-sandbox-probe-'));

async function runCheck(mode, name) {
  const res = await BashTool.execute(
    { command: `node "${SELF}" --child ${name}`, timeout: 30000 },
    { cwd: tmpProj, config: { sandbox: mode }, env: { COWCAT_PROBE_TOKEN: 'planted-value' } },
  );
  const line = (res.stdout || '').split('\n').find((l) => l.startsWith('PROBE '));
  if (!line) return { status: 'no-output', detail: (res.output || res.error || '').slice(0, 80) };
  const [, , status, ...rest] = line.split(' ');
  return { status, detail: rest.join(' ') };
}

const results = {};
for (const mode of MODES) {
  results[mode] = {};
  for (const name of CHECKS) results[mode][name] = await runCheck(mode, name);
}

const pad = (s, n) => String(s).padEnd(n);
console.log('\n=== backend preflight (Phase 0) ===');
for (const l of formatSandboxProbe(sandboxProbe({ force: true }))) console.log(`  ${l}`);

console.log('\n=== what a Bash command can reach (cwd = temp project) ===');
console.log(`  ${pad('check', 20)}${pad('off', 34)}light`);
for (const name of CHECKS) {
  const cells = MODES.map((m) => {
    const r = results[m][name];
    return `[${r.status}] ${r.detail}`.slice(0, 33);
  });
  console.log(`  ${pad(name, 20)}${pad(cells[0], 34)}${cells[1]}`);
}

console.log('\n  reading: ok = the command got the asset (what system mode must block);');
console.log('           denied = the path is out of reach.');
console.log('           `env-token` ok means a TOKEN-shaped variable reached the child.');
console.log('           system mode is not wired yet (Phase 0 = detection only).\n');

// The probe asserts nothing about the results on purpose: allowing reads is the
// documented behaviour of off/light, so a green table is not a pass. What the
// script guarantees is that it ran and produced a table — plus that it never
// touched what it did not have to.
if (results.off['write-tmp']?.status !== 'ok') {
  console.log('  NOTE: even unsandboxed, the temp-file probe did not succeed — check the environment.');
}
process.exit(0);
