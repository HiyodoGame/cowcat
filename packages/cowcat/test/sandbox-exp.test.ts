// TEMPORARY experiment — delete before merge.
// The friendly spelling is now granted and still refused, so "subpath matches the literal
// path" is not the mechanism. Candidate: /var is itself a symlink, and traversing it needs
// read access to a SYMLINK vnode — while the profile only grants metadata for DIRECTORY
// vnodes. One run, five variants, no argument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  const base = [
  '(version 1)',
  '(deny default)',
  ...RUNTIME_ALLOWS,
  ...reads,
  // Note 7: without this the root inode is uncovered and dyld aborts BEFORE exec, with an
  // empty stderr. That is what the first run of this experiment measured.
  '(allow file-read* (literal "/"))',
  '(allow file-read-metadata (vnode-type DIRECTORY))',
];

  const variants: Record<string, string[]> = {
    'A as-generated': base,
    'B +metadata-SYMLINK': [...base, '(allow file-read-metadata (vnode-type SYMLINK))'],
    'C +allow-literal-/var': [...base, '(allow file-read* (literal "/var"))'],
    'D +read*-SYMLINK': [...base, '(allow file-read* (vnode-type SYMLINK))'],
    'E +B and C': [
      ...base,
      '(allow file-read-metadata (vnode-type SYMLINK))',
      '(allow file-read* (literal "/var"))',
    ],
  };

  const probe = `const fs=require("fs");
    const attempt=(label,fn)=>{try{process.stdout.write(label+"=OK:"+fn())}catch(e){process.stdout.write(label+"="+e.code)}};
    attempt(" friendly",()=>fs.readFileSync(${JSON.stringify(friendly + '/n.txt')},"utf8").trim());
    attempt(" canonical",()=>fs.readFileSync(${JSON.stringify(canonical + '/n.txt')},"utf8").trim());
    attempt(" readlink",()=>fs.readlinkSync("/var"));
    process.stdout.write("\\n");`;

  for (const [name, rules] of Object.entries(variants)) {
    let outcome: string;
    try {
      outcome = execFileSync('/usr/bin/sandbox-exec', ['-p', rules.join('\n'), '/bin/bash', '-c', probe], {
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