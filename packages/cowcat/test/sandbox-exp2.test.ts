// TEMPORARY experiment — delete before merge.
// The scratch test regressed from "host temp files are not visible" to visible=true once
// symlink traversal started working. That means the earlier pass was for the wrong reason:
// the lookup failed at /var, so the policy was never actually consulted.
// Two very different explanations, with very different consequences:
//   (a) the SYMLINK metadata rule over-permits, or
//   (b) file-read-metadata on a regular file is not gated by (deny default) at all.
// Measure which, and whether the CONTENTS still stay out of reach either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NodeFs, RUNTIME_ALLOWS, SEATBELT_READ_PATHS } from '../src/index.js';

test('exp2: is file-read-metadata gated on a regular file', { skip: process.platform !== 'darwin' }, (t) => {
  const fs = new NodeFs();
  const root = mkdtempSync(join(tmpdir(), 'cowcat-exp2-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const project = join(root, 'proj');
  const home = join(root, 'home');
  const outside = join(root, 'outside');
  for (const dir of [project, home, outside]) mkdirSync(dir);
  writeFileSync(join(project, 'r.txt'), 'PROJECT\n');
  writeFileSync(join(outside, 'secret.txt'), 'SECRET\n');
  // A sibling of the granted directories: not under proj, not under home, not denied.
  const marker = join(root, 'marker.txt');
  writeFileSync(marker, 'MARKER\n');

  const allow = [project, home].map((p) => `(allow file-read* (subpath ${JSON.stringify(fs.canonical(p))}))`);
  const toolchain = `(allow file-read* (subpath ${JSON.stringify(dirname(process.execPath))}))`;

  const base = [
    '(version 1)',
    '(deny default)',
    ...RUNTIME_ALLOWS,
    toolchain,
    ...allow,
    ...SEATBELT_READ_PATHS.map((p) => `(allow file-read* (subpath ${JSON.stringify(p)}))`),
    '(allow file-read* (literal "/"))',
    '(allow file-read-metadata (vnode-type DIRECTORY))',
  ];

  const probe = `const fs=require("fs");
    const a=(l,fn)=>{try{process.stdout.write(l+"=OK:"+fn())}catch(e){process.stdout.write(l+"="+e.code)}};
    a("exists-marker",()=>String(fs.existsSync(${JSON.stringify(marker)})));
    a("stat-marker-size",()=>String(fs.statSync(${JSON.stringify(marker)}).size));
    a("read-marker",()=>fs.readFileSync(${JSON.stringify(marker)},"utf8").trim());
    a("exists-secret",()=>String(fs.existsSync(${JSON.stringify(join(outside, 'secret.txt'))})));
    a("read-secret",()=>fs.readFileSync(${JSON.stringify(join(outside, 'secret.txt'))},"utf8").trim());
    a("read-proj",()=>fs.readFileSync(${JSON.stringify(join(project, 'r.txt'))},"utf8").trim());
    process.stdout.write("\\n");`;
  assert.ok(!probe.includes("'"), 'the probe must stay single-quote free');
  const command = `'${process.execPath}' -e '${probe}'`;

  const variants: Record<string, string[]> = {
    'P1 with-SYMLINK-rule': [...base, '(allow file-read-metadata (vnode-type SYMLINK))'],
    'P2 DIRECTORY-only': base,
    'P3 no-metadata-rules': base.filter((line) => !line.includes('vnode-type')),
  };

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
    console.log('EXP2 %s :: %s', name.padEnd(24), outcome);
  }
});