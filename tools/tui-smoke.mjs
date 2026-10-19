#!/usr/bin/env node
/**
 * One REAL `cowcat tui` process: does it start, draw a frame, and leave cleanly?
 *
 * The in-process tests in `packages/tui` prove the pieces (project(), the lines, the frame
 * snapshot), and the cli's spawn tests prove the server. None of them proves the two are
 * wired: that `cowcat` with a real terminal library builds a host, renders a screen, and
 * exits 0 on Ctrl-C without leaving a session lock behind.
 *
 * It needs Node >= 26.4 (opentui's floor) and a built CLI:
 *   $env:PATH = "<node26>;$env:PATH"; node --prefix packages/cowcat run build  # etc.
 *   node tools/tui-smoke.mjs
 *
 * What it deliberately does NOT prove: how any of this LOOKS in a real terminal (refresh
 * rate, flicker, images). That needs a human and a real TTY — T10's acceptance, not a script's.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'packages', 'cli', 'dist', 'src', 'cli', 'main.js');

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (!(major > 26 || (major === 26 && minor >= 4))) {
  console.error(`cowcat tui needs Node >= 26.4 (opentui's floor); this is v${process.versions.node}`);
  process.exit(2);
}
if (!existsSync(ENTRY)) {
  console.error(`no build to run: ${ENTRY}\nbuild packages/protocol, packages/cowcat and packages/cli first.`);
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), 'cowcat-tui-smoke-'));
const failures = [];
function check(label, condition, detail) {
  if (condition) console.log(`  ok    ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  else {
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
    failures.push(label);
  }
}

// Terminal escapes, or the frame is unreadable. The naive version of this (OSC terminated
// only by BEL) ate the whole frame: opentui terminates its APC/OSC queries with ST
// (`ESC \\`), so an unterminated `..[^\u0007]*` ran across the screen looking for a BEL
// that never came.
const CSI = String.raw`\u001b\[[0-9;?<=>]*[ -/]*[@-~]`;
const OSC = String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)`;
const STRING = String.raw`\u001b[PX^_][^\u001b]*(?:\u001b\\)`;
const CHARSET = String.raw`\u001b[()][A-Za-z0-9]`;
const SIMPLE = String.raw`\u001b[@-Z\\-_]`;
const ESCAPES = new RegExp([OSC, STRING, CSI, CHARSET, SIMPLE].join('|'), 'g');
const child = spawn(process.execPath, [ENTRY, 'tui'], {
  cwd: ROOT,
  env: { ...process.env, COWCAT_HOME: home },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const exited = new Promise((resolve) => {
  child.on('exit', (code) => {
    resolve(code);
  });
});

console.log(`spawned ${ENTRY} tui  (COWCAT_HOME=${home})`);
await new Promise((resolve) => {
  setTimeout(resolve, 2_000);
});

check('it is still running after 2s (a TUI that exits immediately is not a TUI)', child.exitCode === null);

// Ctrl-C: the renderer is created with `exitOnCtrlC: false`, so this exercises our own
// handler and the teardown path (screen removed, renderer destroyed, host closed).
child.stdin.write('\u0003');
const code = await Promise.race([
  exited,
  new Promise((resolve) => {
    setTimeout(() => {
      resolve('timeout');
    }, 10_000);
  }),
]);

check('exits 0 on Ctrl-C', code === 0, `exit=${String(code)}`);
const text = stdout.replace(ESCAPES, '');
check('the banner is on screen', text.includes('CowCat'), JSON.stringify(text.split('\n').find((row) => row.includes('CowCat')) ?? ''));
check('the empty session says so', text.includes('还没有会话') || text.includes('说正事吧'), '');
check('the protocol handshake happened (no stderr complaints)', !/Error|not initialized|invalidParams/.test(stderr), stderr.trim().slice(0, 200));

console.log('\nfull stderr');
console.log(stderr.trim() === '' ? '  (empty)' : stderr.trim().split('\n').map((row) => `  ${row}`).join('\n'));
console.log('\nraw stdout (escapes visible, first 400 bytes)');
console.log(`  ${JSON.stringify(stdout.slice(0, 400))}`);

// The lock must be gone: a TUI that leaves one makes the next run report "writer pid … is
// gone but left its lock file behind" (ADR-010).
const sessions = existsSync(join(home, 'sessions')) ? readdirSync(join(home, 'sessions')) : [];
check('no session lock left behind', sessions.every((name) => !name.endsWith('.lock')), sessions.join(', ') || '(no sessions dir)');
check('a session was created on disk', sessions.some((name) => name.endsWith('.jsonl')), sessions.join(', ') || '(none)');

console.log('\nlast frame lines (escapes stripped)');
const lines = text.split('\n').filter((row) => row.trim() !== '');
for (const row of lines.slice(-12)) console.log(`  ${row}`);

child.kill();
rmSync(home, { recursive: true, force: true });
console.log(`\n${failures.length === 0 ? 'cowcat tui starts, draws and exits cleanly' : `${String(failures.length)} probe(s) failed`}`);
process.exit(failures.length === 0 ? 0 : 1);
