// P8 release packing: build the four publishable packages into a staging area,
// rewrite the `file:` workspace links to the released version, and check what
// `npm publish` would upload.
//
// Why a staging copy: local development MUST keep `file:` dependencies (ADR-062
// rejected npm workspaces), but a published tarball carrying `file:../cowcat`
// is unusable for everyone else. Rewriting happens here, never in the source
// manifests, so `npm test` keeps running against the linked packages.
//
// Usage:
//   node tools/pack-release.mjs            # check only, tarballs in a temp dir
//   node tools/pack-release.mjs --out DIR  # keep the tarballs in DIR
//   node tools/pack-release.mjs --install  # also install the tarballs in a temp
//                                          # project and run `cowcat --version`
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const VERSION = '1.0.0-beta.1';
const PACKAGES = [
  { dir: 'packages/protocol', name: '@corescense/cowcat-protocol', entry: 'dist/src/index.js' },
  { dir: 'packages/cowcat', name: '@corescense/cowcat-core', entry: 'dist/src/index.js' },
  { dir: 'packages/tui', name: '@corescense/cowcat-tui', entry: 'dist/src/index.js' },
  { dir: 'packages/cli', name: '@corescense/cowcat', entry: 'dist/src/cli/main.js' },
];
const INTERNAL = new Set(PACKAGES.map((entry) => entry.name));
const ALLOWED_TOP = new Set(['dist', 'package.json', 'README.md', 'LICENSE']);
const FORBIDDEN = /(^|\/)test(\/|$)|\.map$/u;

const args = process.argv.slice(2);
const install = args.includes('--install');
const outIndex = args.indexOf('--out');
const keepTarballs = outIndex >= 0 && args[outIndex + 1] !== undefined;
const outDir = keepTarballs ? resolve(args[outIndex + 1]) : mkdtempSync(join(tmpdir(), 'cowcat-release-'));
if (keepTarballs) mkdirSync(outDir, { recursive: true });
const staging = mkdtempSync(join(tmpdir(), 'cowcat-stage-'));

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fail(message) {
  throw new Error(message);
}

function stagePackage(entry) {
  const source = resolve(entry.dir);
  const manifest = readJson(join(source, 'package.json'));
  if (manifest.name !== entry.name) fail(`${entry.dir}: expected ${entry.name}, found ${String(manifest.name)}`);
  if (manifest.version !== VERSION) fail(`${entry.dir}: version ${String(manifest.version)} != ${VERSION}`);
  if (manifest.private === true) fail(`${entry.dir}: still private`);
  for (const file of ['README.md', 'LICENSE']) {
    if (!existsSync(join(source, file))) fail(`${entry.dir}: ${file} is missing`);
  }
  const dist = join(source, 'dist', 'src');
  if (!existsSync(dist) || !statSync(dist).isDirectory()) fail(`${entry.dir}: dist/src is missing — run npm run build first`);
  if (!existsSync(join(source, entry.entry))) fail(`${entry.dir}: ${entry.entry} is missing`);

  const target = join(staging, entry.dir.replace('/', '-'));
  cpSync(join(source, 'dist', 'src'), join(target, 'dist', 'src'), {
    recursive: true,
    filter: (file) => !file.endsWith('.map'),
  });
  for (const file of ['README.md', 'LICENSE']) cpSync(join(source, file), join(target, file));

  const released = structuredClone(manifest);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(released[field] ?? {})) {
      if (INTERNAL.has(name)) released[field][name] = VERSION;
      else if (typeof range === 'string' && range.startsWith('file:')) fail(`${entry.dir}: ${name} still uses ${range}`);
    }
  }
  writeFileSync(join(target, 'package.json'), `${JSON.stringify(released, null, 2)}\n`);
  return { entry, target };
}

function pack(staged) {
  const output = execFileSync('npm', ['pack', '--json', '--pack-destination', outDir], {
    cwd: staged.target,
    encoding: 'utf8',
    shell: true,
  });
  const info = JSON.parse(output)[0];
  const files = info.files.map((file) => file.path).sort();
  const problems = [];
  for (const file of files) {
    const top = file.includes('/') ? file.split('/')[0] : file;
    if (!ALLOWED_TOP.has(top)) problems.push(`unexpected top-level entry: ${file}`);
    if (FORBIDDEN.test(file)) problems.push(`must not ship: ${file}`);
  }
  if (!files.includes('package.json')) problems.push('missing package.json');
  if (!files.includes(staged.entry.entry)) problems.push(`missing ${staged.entry.entry}`);
  for (const file of ['README.md', 'LICENSE']) if (!files.includes(file)) problems.push(`missing ${file}`);

  const manifest = readJson(join(staged.target, 'package.json'));
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range === 'string' && range.startsWith('file:')) problems.push(`${name} still has ${range}`);
    }
  }

  console.log(`${info.name}@${info.version} — ${String(info.entryCount)} files, ${String(info.size)} bytes`);
  for (const file of files) console.log(`  ${file}`);
  if (problems.length > 0) fail(`${info.name}: ${problems.join('; ')}`);
  return { name: info.name, version: info.version, filename: info.filename };
}

async function main() {
  const built = PACKAGES.map((entry) => pack(stagePackage(entry)));
  console.log(`\npacked ${String(built.length)} packages into ${outDir}`);
  for (const pkg of built) console.log(`${pkg.name}@${pkg.version}: ${pkg.filename}`);

  if (install) {
    const project = mkdtempSync(join(tmpdir(), 'cowcat-install-'));
    try {
      writeFileSync(join(project, 'package.json'), `${JSON.stringify({ name: 'cowcat-install-check', private: true }, null, 2)}\n`);
      const tarballs = built.map((pkg) => join(outDir, pkg.filename));
      execFileSync('npm', ['install', '--no-audit', '--no-fund', ...tarballs], { cwd: project, stdio: 'inherit', shell: true });
      const cli = join(project, 'node_modules', '@corescense', 'cowcat', 'dist', 'src', 'cli', 'main.js');
      const version = execFileSync(process.execPath, [cli, '--version'], { cwd: project, encoding: 'utf8' }).trim();
      console.log(`installed check: ${version}`);
      if (!version.includes(VERSION)) fail(`installed CLI reported "${version}", expected ${VERSION}`);
      const help = execFileSync(process.execPath, [cli, '--help'], { cwd: project, encoding: 'utf8' });
      if (!help.includes('cowcat')) fail('installed CLI --help did not mention cowcat');
      console.log('installed check passed');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(`pack-release: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(staging, { recursive: true, force: true });
  if (!keepTarballs) rmSync(outDir, { recursive: true, force: true });
}
