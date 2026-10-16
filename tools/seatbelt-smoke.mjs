// Seatbelt smoke test: does `sandbox-exec` accept OUR profile, and does the
// command inside it actually run?
//
// Split on purpose. The test suite (agent/test/sandbox-macos.test.mjs) asserts
// outcomes, so when it fails you learn "the sandbox produced nothing" and not
// WHY. `--bisect` narrows it further by replaying the profile one section at a
// time, which is the only practical way to find the rule that is killing dyld:
// a Seatbelt violation that the kernel considers fatal kills the process with
// SIGKILL, so there is no error message — just a signal and silence.
//
// Run it anywhere macOS, from the repo root:
//   node tools/seatbelt-smoke.mjs            # the real profile
//   node tools/seatbelt-smoke.mjs --bisect   # which section breaks it
//   node tools/seatbelt-smoke.mjs --print    # also dump the profile text
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const agentRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent');
const imp = (rel) => import(`file://${join(agentRoot, ...rel.split('/')).replace(/\\/g, '/')}`);
const { buildSeatbeltCommand } = await imp('src/sandbox/backends/seatbelt.js');
const { canonicalPath } = await imp('src/canonical.js');

const HOME = process.env.HOME;
const proj = canonicalPath(mkdtempSync(join(tmpdir(), 'cowcat-seatbelt-smoke-')));
const tmpDir = canonicalPath(mkdtempSync(join(tmpdir(), 'cowcat-sbx-')));

const policy = {
  mode: 'system',
  envDeny: [],
  network: 'off',
  failOpen: true,
  backend: 'seatbelt',
  read: {
    profile: 'workspace',
    deny: [`${HOME}/.ssh`, `${HOME}/.aws`],
    allow: [proj, `${HOME}/.gitconfig`],
  },
  write: { allow: [proj], deny: [`${proj}/.env`] },
  unsupported: [],
};

// The signal, not the message: a Seatbelt violation the kernel treats as fatal
// kills the process, so execFileSync reports `signal` and no exit status.
function attempt(profile, command = 'echo SANDBOX_OK') {
  const args = ['-p', profile, '/bin/bash', '-c', command];
  try {
    const stdout = execFileSync('/usr/bin/sandbox-exec', args, {
      encoding: 'utf8', cwd: proj, timeout: 20000,
      env: { ...process.env, TMPDIR: tmpDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ran: true, status: 0, signal: null, stdout, stderr: '' };
  } catch (e) {
    return {
      ran: false,
      status: e?.status ?? null,
      signal: e?.signal ?? null,
      code: e?.code ?? null,
      stdout: e?.stdout?.toString() || '',
      stderr: e?.stderr?.toString() || '',
    };
  }
}

const report = (label, r) => {
  console.log(
    `${r.ran ? 'RAN  ' : 'DEAD '} ${label.padEnd(46)} status=${r.status} signal=${r.signal} code=${r.code ?? '-'}`
    + `${r.stderr ? ` stderr=${JSON.stringify(r.stderr.slice(0, 160))}` : ''}`
    + `${r.ran && !r.stdout.includes('SANDBOX_OK') ? ' stdout=' + JSON.stringify(r.stdout.slice(0, 80)) : ''}`,
  );
};

const argv = process.argv.slice(2);
if (argv.includes('--net')) {
  // Is egress broken, or only name resolution? And which Mach service does the
  // resolver need? Each variant is one attempt; the whole matrix is one CI step.
  const { RUNTIME_ALLOWS, SEATBELT_READ_PATHS } = await imp('src/sandbox/backends/seatbelt.js');
  const base = [
    '(version 1)', '(deny default)', ...RUNTIME_ALLOWS,
    `(allow file-read* ${[...SEATBELT_READ_PATHS, proj, `${HOME}/.gitconfig`].map((x) => `(subpath ${JSON.stringify(x)})`).join(' ')} (subpath ${JSON.stringify(tmpDir)}) (literal "/"))`,
    '(allow file-read-metadata (vnode-type DIRECTORY))',
    `(allow file-write* (subpath ${JSON.stringify(proj)}) (subpath ${JSON.stringify(tmpDir)}))`,
    '(allow network*)',
  ];
  const variants = {
    'egress only, numeric IP (no DNS)': [],
    'DNS as-is': [],
    '+ discoveryd': ['(allow mach-lookup (global-name "com.apple.discoveryd"))'],
    '+ discoveryd + dns proxy': [
      '(allow mach-lookup (global-name "com.apple.discoveryd"))',
      '(allow mach-lookup (global-name "com.apple.dnssd.service"))',
      '(allow mach-priv-host-port (target same-sandbox))',
    ],
    '+ discoveryd + mdnsd socket + host-port': [
      '(allow mach-lookup (global-name "com.apple.discoveryd"))',
      '(allow system-socket (socket-domain AF_UNIX))',
      '(allow network-outbound (remote unix-socket (subpath "/private/var/run/mdnsd")))',
      '(allow network-bind (local unix-socket (subpath "/private/var/run/mdnsd")))',
      '(allow mach-priv-host-port (target same-sandbox))',
      '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.membership"))',
    ],
    // Brackets: if ANY of these resolves the name, the resolver goes through that
    // channel and the fix is to narrow it down. If none do, macOS's resolver is
    // not reachable from inside a `(deny default)` profile without a
    // sandbox-EXTERNAL proxy — which is exactly why Claude Code / Codex / srt all
    // put one there.
    'all mach-lookup': ['(allow mach-lookup)'],
    'all unix sockets': ['(allow system-socket)', '(allow network-outbound (remote unix-socket (subpath "/")))'],
    'all mach + all unix': ['(allow mach-lookup)', '(allow system-socket)', '(allow network-outbound (remote unix-socket (subpath "/")))', '(allow mach-priv-host-port)'],
  };
  const netProbe = 'node -e "fetch(\'https://example.com\').then(r=>console.log(\'DNSOK\',r.status)).catch(e=>{console.error(\'dnsfail\',e.cause?.code||e.name);process.exit(3)})"';
  const probes = {
    'egress only, numeric IP (no DNS)': 'node -e "fetch(\'http://1.1.1.1\').then(r=>console.log(\'IPOK\',r.status)).catch(e=>{console.error(\'ipfail\',e.cause?.code||e.name);process.exit(3)})"',
    'DNS as-is': netProbe,
    '+ discoveryd': netProbe,
    '+ discoveryd + dns proxy': netProbe,
    '+ discoveryd + mdnsd socket + host-port': netProbe,
    'all mach-lookup': netProbe,
    'all unix sockets': netProbe,
    'all mach + all unix': netProbe,
  };
  for (const [label, extra] of Object.entries(variants)) {
    const profile = [...base, ...extra].join('\n');
    const r = attempt(profile, probes[label]);
    console.log(`${label.padEnd(38)} ${JSON.stringify(r.stdout.trim().slice(0, 40))} ${JSON.stringify(r.stderr.trim().slice(0, 60))}`);
  }
} else if (argv.includes('--sections')) {
  // Each section ALONE on top of the floor — not accumulated. Accumulation can
  // only say "still dead", and here it lied twice: an allow-list profile is dead
  // while "allow everything + deny every top-level directory" is alive, so the
  // read surface as a *set of paths* is not the cause and the rule structure is.
  const { RUNTIME_ALLOWS } = await imp('src/sandbox/backends/seatbelt.js');
  const floor = ['(version 1)', '(deny default)', ...RUNTIME_ALLOWS].join('\n');
  const built = buildSeatbeltCommand(policy, { command: 'echo SANDBOX_OK', cwd: proj, tmpDir });
  const sections = built.args[1].split('\n\n');
  console.log(`floor alone: ${sections[0].split('\n').length + RUNTIME_ALLOWS.length} lines\n`);
  for (let i = 1; i < sections.length; i += 1) {
    const label = (sections[i].split('\n')[0] || '(blank)').replace(/^;+\s*/, '').slice(0, 40);
    const r = attempt(`${floor}\n\n${sections[i]}`);
    report(`[${i}] ${label}`, r);
  }
  // And the killer pair: allow-list + credential denies, without the writes.
  console.log('\npaired:');
  const reads = sections.slice(1).filter((s) => /^; File read/.test(s));
  const writes = sections.slice(1).filter((s) => /^; File write/.test(s));
  for (const [label, group] of [['read only', reads], ['write only', writes], ['read+write', [...reads, ...writes]]]) {
    report(label, attempt([floor, ...group].join('\n\n')));
  }
  // Metadata rule on its own: a lone `(allow file-read-metadata …)` under
  // `(deny default)` is a known way to abort dyld.
  report('metadata rule alone', attempt(`${floor}\n(allow file-read-metadata (vnode-type DIRECTORY))`));
  report('allow file-read* + metadata', attempt(`${floor}\n(allow file-read*)\n(allow file-read-metadata (vnode-type DIRECTORY))`));
} else if (argv.includes('--bisect-min')) {
  // Find the SMALLEST set of top-level directories that, when unreadable, kills
  // the process. Its complement is exactly the read surface the sandbox has to
  // grant — no guessing, no one-path-per-CI-round-trip.
  //
  // Greedy: start from "deny everything", then give each directory back if the
  // process survives. O(n²) attempts at ~15ms each, so the whole thing is one CI
  // step (~18 directories → ~170 attempts → ~3s).
  const { RUNTIME_ALLOWS } = await imp('src/sandbox/backends/seatbelt.js');
  const METADATA = '(allow file-read-metadata (vnode-type DIRECTORY))';
  const floor = ['(version 1)', '(deny default)', ...RUNTIME_ALLOWS].join('\n');
  const entries = readdirSync('/', { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => `/${d.name}`)
    .sort();

  const survives = (denied) => {
    const rules = denied.map((p) => `(deny file-read* (subpath ${JSON.stringify(p)}))`);
    const profile = [floor, '(allow file-read*)', METADATA, ...rules].join('\n');
    const r = attempt(profile, 'echo SANDBOX_OK');
    return r.ran && r.stdout.includes('SANDBOX_OK');
  };

  console.log(`top-level directories: ${entries.length}`);
  let denied = entries.filter((p) => !['/.', '/'].includes(p));
  if (survives(denied)) {
    console.log('\nCONTROL FAILED: denying every top-level directory still runs.');
    console.log('The read surface is NOT the cause — look at the write/move sections.');
  } else {
    console.log('control ok: deny-all kills the process. Greedily giving directories back…');
    for (const p of [...denied]) {
      const without = denied.filter((x) => x !== p);
      if (!survives(without)) denied = without; // still dead without it → it is needed
    }
    console.log(`\nminimum set that must stay UNREADABLE (${denied.length}):\n  ${denied.join('\n  ')}`);
    console.log(`\n⇒ the read surface has to include (${entries.length - denied.length}):\n  ${entries.filter((p) => !denied.includes(p)).join('\n  ')}`);
  }
} else if (argv.includes('--bisect-top')) {
  // Deny-side search, which is the shape that actually answers the question.
  //
  // Adding candidate paths one at a time to the allow list only tells you "still
  // not enough" until the last one, and each guess costs a CI round trip. Start
  // from "everything readable" (which runs) and DENY one top-level directory at a
  // time: the ones that turn the process DEAD are the ones dyld cannot start
  // without. Each attempt costs ~15ms, so the whole filesystem is one CI step.
  const { RUNTIME_ALLOWS } = await imp('src/sandbox/backends/seatbelt.js');
  const METADATA = '(allow file-read-metadata (vnode-type DIRECTORY))';
  const floor = ['(version 1)', '(deny default)', ...RUNTIME_ALLOWS].join('\n');
  const entries = readdirSync('/', { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => `/${d.name}`)
    // /Volumes holds other disks and /System/Volumes is the sealed system volume;
    // both are covered by their parents.
    .filter((p) => !['/Volumes', '/dev'].includes(p))
    .sort();
  console.log(`top-level directories: ${entries.length}\n`);
  const required = [];
  for (const p of entries) {
    const profile = `${floor}\n(allow file-read*)\n${METADATA}\n(deny file-read* (subpath ${JSON.stringify(p)}))`;
    const r = attempt(profile, 'echo SANDBOX_OK');
    const ran = r.ran && r.stdout.includes('SANDBOX_OK');
    if (!ran) required.push(p);
    console.log(`  ${ran ? 'ok  ' : 'NEED'} deny ${p}`);
  }
  console.log(`\nrequired for the process to start: ${required.join(' ') || '(none — the deny is not the cause)'}`);
} else if (argv.includes('--why')) {
  // Ask Seatbelt itself. `(with log-stdout)` is a filter that prints every
  // matched (i.e. denied) path to STDOUT, so a catch-all read deny after the
  // allow list names exactly what dyld wanted and did not get — instead of us
  // guessing paths one CI round trip at a time.
  const { RUNTIME_ALLOWS, SEATBELT_READ_PATHS } = await imp('src/sandbox/backends/seatbelt.js');
  const profile = [
    '(version 1)',
    '(deny default)',
    ...RUNTIME_ALLOWS,
    `(allow file-read* ${SEATBELT_READ_PATHS.map((x) => `(subpath ${JSON.stringify(x)})`).join(' ')} ${policy.read.allow.map((x) => `(subpath ${JSON.stringify(x)})`).join(' ')})`,
    '(allow file-read-metadata (vnode-type DIRECTORY))',
    // The instrumentation: everything the process tried to read that the rules
    // above did not grant.
    '(deny file-read* (with log-stdout))',
  ].join('\n');
  const r = attempt(profile, 'echo SANDBOX_OK');
  console.log(`exit: status=${r.status} signal=${r.signal} stderr=${JSON.stringify(r.stderr)}`);
  console.log('--- paths the sandbox refused (log-stdout) ---');
  const seen = new Set();
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^Sandbox:\s*(.+?)\s*(deny|not allowed).*$/i) || line.match(/^Sandbox:\s*(.+)$/);
    const p = (m ? m[1] : line).trim();
    if (p && !seen.has(p)) seen.add(p);
  }
  console.log([...seen].slice(0, 60).join('\n') || '(nothing logged)');
  console.log('--- raw stdout (first 2000 chars) ---');
  console.log(r.stdout.slice(0, 2000));
} else if (argv.includes('--bisect-read')) {
  // The read surface, narrowed one path at a time from "everything".
  //
  // A missing read grant does NOT produce EPERM for a normal syscall — dyld
  // aborts (SIGABRT, no stderr) while it is still loading, so there is no error
  // to read. Narrowing from `(allow file-read*)` towards the intended list names
  // the path that mattered.
  //
  // `(allow file-read-metadata (vnode-type DIRECTORY))` belongs to the READ
  // section of the real profile, not to the runtime floor, so it has to be added
  // explicitly here. Leaving it out made an earlier run of this bisect report
  // that even the FULL path list aborts — which sent the fix after the wrong path
  // entirely (/var/db → /private/var/db). The experiment was invalid; the
  // comment is here so the next person does not repeat it.
  const { RUNTIME_ALLOWS, SEATBELT_READ_PATHS } = await imp('src/sandbox/backends/seatbelt.js');
  const METADATA = '(allow file-read-metadata (vnode-type DIRECTORY))';
  const base = ['(version 1)', '(deny default)', ...RUNTIME_ALLOWS, '(allow file-read*)', METADATA].join('\n');
  console.log('read surface, narrowing from (allow file-read*):');
  report('everything readable', attempt(base));
  const kept = [];
  for (const p of SEATBELT_READ_PATHS) {
    kept.push(p);
    const profile = ['(version 1)', '(deny default)', ...RUNTIME_ALLOWS, `(allow file-read* ${kept.map((x) => `(subpath ${JSON.stringify(x)})`).join(' ')})`, METADATA].join('\n');
    report(`+ ${p}`, attempt(profile));
  }
  // And the credential denies on top of the full list — last-match-wins check.
  const full = ['(version 1)', '(deny default)', ...RUNTIME_ALLOWS,
    `(allow file-read* ${SEATBELT_READ_PATHS.map((x) => `(subpath ${JSON.stringify(x)})`).join(' ')})`,
    `(deny file-read* ${[`${HOME}/.ssh`, `${HOME}/.aws`].map((x) => `(subpath ${JSON.stringify(x)})`).join(' ')})`,
    METADATA].join('\n');
  report('+ credential denies (last-match-wins)', attempt(full));
} else if (argv.includes('--bisect')) {
  console.log('baseline (control):');
  report('(allow default)', attempt('(version 1)\n(allow default)'));
  report('(deny default) only', attempt('(version 1)\n(deny default)'));
  console.log('\nreplay the real profile section by section:');
  const built = buildSeatbeltCommand(policy, { command: 'echo SANDBOX_OK', cwd: proj, tmpDir });
  const sections = built.args[1].split('\n\n');
  // Cumulative: each step adds one section, so the first DEAD step names the
  // section that killed it. slice(1), not slice(2) — section 0 is the
  // `(version 1)`+`(deny default)` pair we already seeded `acc` with, and
  // skipping one more would quietly leave the runtime floor out of the replay.
  let acc = ['(version 1)', '(deny default)'];
  for (const section of sections.slice(1)) {
    const label = (section.split('\n')[0] || '(blank)').replace(/^;+\s*/, '').slice(0, 44);
    acc = [...acc, section];
    report(label, attempt(acc.join('\n\n')));
  }
} else {
  const command = argv.includes('--cmd')
    ? argv[argv.indexOf('--cmd') + 1]
    : 'echo SANDBOX_OK; echo hi > inside.txt && cat inside.txt; echo "TMPDIR=$TMPDIR"; ls ~/.ssh';
  const built = buildSeatbeltCommand(policy, { command, cwd: proj, tmpDir });
  if (argv.includes('--print')) {
    console.log('--- profile -------------------------------------------------');
    console.log(built.args[1]);
    console.log('------------------------------------------------------------');
  }
  const started = Date.now();
  const r = attempt(built.args[1], command);
  console.log(`profile bytes : ${Buffer.byteLength(built.args[1])}`);
  console.log(`exit          : status=${r.status} signal=${r.signal} code=${r.code ?? '-'}`);
  console.log(`elapsed       : ${Date.now() - started}ms`);
  console.log(`stdout        : ${JSON.stringify(r.stdout)}`);
  console.log(`stderr        : ${JSON.stringify(r.stderr)}`);
  console.log(r.ran && r.stdout.includes('SANDBOX_OK')
    ? '\nVERDICT: the profile was applied and the command ran.'
    : '\nVERDICT: the command did NOT produce its marker. A non-zero exit with\n'
      + '         SANDBOX_OK in stdout means the command ran and something inside it\n'
      + '         was refused (that is the sandbox working). `signal=SIGABRT` with no\n'
      + '         stderr is the signature of a fatal violation — dyld never got to run.');
}

rmSync(proj, { recursive: true, force: true });
rmSync(tmpDir, { recursive: true, force: true });