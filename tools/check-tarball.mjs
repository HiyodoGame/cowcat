// Guard for what `npm publish` would upload. Run from anywhere:
//
//   node tools/check-tarball.mjs [packageDir=agent]
//
// It packs the package, then fails when the tarball contains anything outside
// the intended whitelist (`bin/`, `src/`, `assets/` + README/LICENSE/package.json)
// or is missing a file the package needs at runtime. This is the mechanical part
// of the release checklist in docs/PUBLISH.md — the part a human forgets to
// re-check after adding a directory.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const pkgDir = resolve(process.argv[2] || 'agent');
const packDir = mkdtempSync(join(tmpdir(), 'cowcat-pack-check-'));

const ALLOWED_TOP_LEVEL = new Set(['LICENSE', 'README.md', 'package.json', 'assets', 'bin', 'src']);
const REQUIRED = ['package.json', 'bin/cowcat.mjs', 'src/config.js', 'assets/providers.json'];
// Directories that must never ship (tests, docs, reverse-engineering material)
// and files that are development-only.
const FORBIDDEN_PREFIX = /^(test|docs|analysis|tools|logs|sandbox|node_modules)\//;
const FORBIDDEN_FILE = /(^|\/)(eslint\.config\.mjs|package-lock\.json|\.npmrc)$|\.env$|\.tgz$|tmp-frame|cli\.patched/;

let failed = false;
try {
  // shell:true — npm is a .cmd shim on Windows and cannot be exec'd directly.
  const out = execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], {
    cwd: pkgDir, encoding: 'utf8', shell: true,
  });
  const info = JSON.parse(out)[0];
  const files = info.files.map((f) => f.path);

  const byTop = new Map();
  for (const f of files) {
    const top = f.includes('/') ? f.split('/')[0] : '(root)';
    byTop.set(top, (byTop.get(top) || 0) + 1);
  }
  console.log(`${info.name}@${info.version} — ${info.entryCount} files, ${info.size} bytes`);
  console.log([...byTop.entries()].map(([k, v]) => `${k}=${v}`).join('  '));

  const problems = [];
  for (const f of files) {
    if (FORBIDDEN_PREFIX.test(f) || FORBIDDEN_FILE.test(f)) problems.push(`must not ship: ${f}`);
    const top = f.includes('/') ? f.split('/')[0] : f;
    if (!ALLOWED_TOP_LEVEL.has(top)) problems.push(`unexpected top-level entry: ${f}`);
  }
  for (const r of REQUIRED) if (!files.includes(r)) problems.push(`missing required file: ${r}`);

  if (problems.length) {
    failed = true;
    console.error(`\ntarball check FAILED (${problems.length} problem(s)):`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nFix agent/package.json "files" or move the offending file out of the package.');
  } else {
    console.log('\ntarball check passed');
  }
} catch (e) {
  failed = true;
  console.error(`tarball check could not run: ${e.message}`);
} finally {
  rmSync(packDir, { recursive: true, force: true });
}

// process.exit would cut the rmSync short on some platforms; the flag is enough.
if (failed) process.exitCode = 1;
