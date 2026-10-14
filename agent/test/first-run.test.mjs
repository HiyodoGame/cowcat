// First-run experience: no-key onboarding (probe skipped, hints printed,
// status bar shows "not configured") + startup banner line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const AGENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- spawn-level: no-key first run -----------------------------------------

function countingServer() {
  let hits = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/messages/count_tokens')) {
      hits++;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid key' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: 1 }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits: () => hits }));
  });
}

function runCli(args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(AGENT_ROOT, 'bin', 'cowcat.mjs'), ...args], {
      env: { ...process.env, ...env },
      cwd: mkdtempSync(join(tmpdir(), 'cowcat-first-')),
    });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('cli timed out')); }, 20000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    if (input) child.stdin.write(input);
    child.stdin.end();
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

const NO_KEY_ENV = (home) => ({
  COWCAT_HOME: home,
  COWCAT_PROVIDER: 'anthropic',
  // no COWCAT_BASE_URL -> default api.anthropic.com, no COWCAT_API_KEY
  COWCAT_ANIMATION: 'off',
});
delete process.env.COWCAT_API_KEY;

test('first run without API key: probe skipped, onboarding printed, status shows 未配置', async () => {
  const { server, port, hits } = await countingServer();
  try {
    const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
    const res = await runCli([], NO_KEY_ENV(home), '/exit\n');
    assert.equal(hits(), 0, `probe must be skipped when no key (got ${hits()} requests)`);
    assert.match(res.out, /No model service configured/, 'onboarding line');
    assert.match(res.out, /^CowCat v[\d.]+ — /m, 'plain-text startup banner, no emoji');
    assert.match(res.out, /cowcat setup/, 'points at setup');
    assert.match(res.out, /api\.kimi\.com\/coding/, 'kimi recommendation present for default anthropic endpoint');
    assert.match(res.out, /model: not configured/, 'status bar shows not configured');
    assert.ok(!/probe\] count_tokens failed/.test(res.out), 'no 403 noise');
  } finally {
    server.close();
  }
});

test('first run without API key in -p mode keeps the existing probe/error path', async () => {
  const { server, port, hits } = await countingServer();
  try {
    const home = mkdtempSync(join(tmpdir(), 'cowcat-home-'));
    const res = await runCli(['-p', 'hi'], { ...NO_KEY_ENV(home), COWCAT_BASE_URL: `http://127.0.0.1:${port}` });
    assert.ok(hits() >= 1, '-p must keep the probe path');
    assert.match(res.out, /\[probe\] count_tokens failed/, 'probe error is printed as before');
    assert.match(res.out, /HTTP 401/, 'main request still surfaces the credential error');
    assert.ok(!/No model service configured/.test(res.out), 'onboarding message is interactive-only');
  } finally {
    server.close();
  }
});
