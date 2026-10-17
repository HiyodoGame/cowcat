// TEMPORARY experiment 鈥?delete before merge.
// The friendly spelling is now granted and still refused, so "subpath matches the literal
// path" is not the mechanism. Candidate: /var is itself a symlink, and traversing it needs
// read access to a SYMLINK vnode 鈥?while the profile only grants metadata for DIRECTORY
// vnodes. One run, five variants, no argument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NodeFs, RUNTIME_ALLOWS, SEATBELT_READ_PATHS, spellings } from '../src/index.js';

const platform = process.platform;

test('exp: what does traversing a symlink actually require', { skip: platform !== 'darwin' }, (t) => {
  const fs = new NodeFs();
  const root = mkdtempSync(join(tmpdir(), 'cowcat-exp-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const home = join(root, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'n.txt'), 'HOME\n');

  const canonical = fs.canonical(home);
  const friendly = spellings(canonical)[1] ?? canonical;
  const reads = [canonical, ...SEATBELT_READ_PATHS].flatMap(spellings).map((path) => `(allow file-read* (subpath ${JSON.stringify(path)}))`);
  // The same list WITHOUT the friendly twins 鈥?the question is whether the symlink rule
  // alone makes a friendly-spelled path work, or whether the twin rules earn their keep.
  const readsCanonicalOnly = [canonical, ...SEATBELT_READ_PATHS].map((path) => `(allow file-read* (subpath ${JSON.stringify(path)}))`);

  // The node toolchain is granted in EVERY variant. Without it node itself cannot start in
// the canonical-only variants ("OpenSSL configuration error"), which is a confound in the
// experiment and nothing to do with what is being measured.
const toolchain = `(allow file-read* (subpath ${JSON.stringify(dirname(process.execPath))}))`;

const base = [
    '(version 1)',
    '(deny default)',
    ...RUNTIME_ALLOWS,
    toolchain,
    ...reads,
    // Note 7: without this the root inode is uncovered and dyld aborts BEFORE exec, with an
    // empty stderr. That is what the first run of this experiment measured.
    '(allow file-read* (literal "/"))',
    '(allow file-read-metadata (vnode-type DIRECTORY))',
  ];

  const baseCanonicalOnly = [
    '(version 1)',
    '(deny default)',
    ...RUNTIME_ALLOWS,
    toolchain,
    ...readsCanonicalOnly,
    '(allow file-read* (literal "/"))',
    '(allow file-read-metadata (vnode-type DIRECTORY))',
  ];

  const symlink = '(allow file-read-metadata (vnode-type SYMLINK))';
  const variants: Record<string, string[]> = {
    'A as-generated': base,
    'B +metadata-SYMLINK': [...base, symlink],
    'C +allow-literal-/var': [...base, '(allow file-read* (literal "/var"))'],
    'D +read*-SYMLINK': [...base, '(allow file-read* (vnode-type SYMLINK))'],
    'F canonical-only +SYMLINK': [...baseCanonicalOnly, symlink],
    'G canonical-only only': baseCanonicalOnly,
  };

  const probe = `const fs=require("fs");
    const attempt=(label,fn)=>{try{process.stdout.write(label+"=OK:"+fn())}catch(e){process.stdout.write(label+"="+e.code)}};
    attempt(" friendly",()=>fs.readFileSync(${JSON.stringify(friendly + '/n.txt')},"utf8").trim());
    attempt(" canonical",()=>fs.readFileSync(${JSON.stringify(canonical + '/n.txt')},"utf8").trim());
    attempt(" readlink",()=>fs.readlinkSync("/var"));
    process.stdout.write("\\n");`;

  // sandbox-exec hands its last arguments to a SHELL, so the command has to be shell 鈥?  // which is why the real builder shell-quotes the executable and its script separately.
  // The probe contains no single quotes, so one pair of them is the whole quoting job.
  assert.ok(!probe.includes("'"), 'the probe must stay single-quote free');
  const command = `'${process.execPath}' -e '${probe}'`;

  for (const [name, rules] of Object.entries(variants)) {
    let outcome: string;
    try {
      outcome = execFileSync('/usr/bin/sandbox-exec', ['-p', rules.join('\n'), '/bin/bash', '-c', command], {
        encoding: 'utf8',
        timeout: 30_000,
      }).trim();
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      outcome = `THREW status=${String(e.status)} stderr=${(e.stderr ?? '').slice(0, 160)}`;
    }
    console.log('EXP %s :: %s', name.padEnd(26), outcome);
  }

  assert.ok(true);
});
