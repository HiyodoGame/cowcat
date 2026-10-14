#!/usr/bin/env node
// Self-test for the capture proxy: exercises the upstream-error path (401) and the SSE tee path, then cleans up.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const SERVER = path.join(ROOT, 'tools/proxy/server.mjs');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const waitReady = async (port, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    try { await fetch(`http://127.0.0.1:${port}/__ping`); return; }
    catch { if (Date.now() - t0 > ms) throw new Error(`proxy on :${port} did not start`); await new Promise(r => setTimeout(r, 150)); }
  }
};

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-selftest-'));

function startProxy(port, upstream, logDir) {
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--upstream', upstream, '--log-dir', logDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write(`[proxy:${port}] ${d}`));
  return child;
}

const cleanup = (dirs, children) => {
  for (const c of children) { try { c.kill(); } catch {} }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
};

const main = async () => {
  const tmp1 = mkTmp(); // real-upstream leg (expect 401)
  const tmp2 = mkTmp(); // SSE echo leg
  const children = [];
  const sse = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-test': 'sse-echo' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"delta":"hi"}\n\n');
    setTimeout(() => { res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n'); res.end(); }, 100);
  });

  try {
    children.push(startProxy(8791, 'https://api.anthropic.com', tmp1));
    await waitReady(8791);

    // Case 1: POST /v1/messages without key -> upstream 401 must be forwarded and captured.
    const r1 = await fetch('http://127.0.0.1:8791/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test-selftest-1234567890', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'test', messages: [], max_tokens: 1 }),
    });
    const r1body = await r1.text();
    check('manifest written', fs.existsSync(path.join(tmp1, 'manifest.jsonl')));
    const manifest = fs.readFileSync(path.join(tmp1, 'manifest.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const entry = manifest.find(m => m.path === '/v1/messages');
    check('manifest entry for /v1/messages', Boolean(entry));
    if (entry) {
      const rec = JSON.parse(fs.readFileSync(path.join(tmp1, entry.respFile), 'utf8'));
      check('response file records error/status', rec.status === 401, `status=${rec.status}`);
      const req = JSON.parse(fs.readFileSync(path.join(tmp1, entry.reqFile), 'utf8'));
      check('request file masks api key', req.headers['x-api-key'] === 'sk-test-…34567890', String(req.headers['x-api-key']));
      check('request body captured verbatim', req.body.includes('"max_tokens":1'));
    }

    // Case 2: SSE via local echo upstream.
    await new Promise(r => sse.listen(8792, '127.0.0.1', r));
    children.push(startProxy(8793, 'http://127.0.0.1:8792', tmp2));
    await waitReady(8793);
    const r2 = await fetch('http://127.0.0.1:8793/v1/messages?stream=true', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
      body: JSON.stringify({ model: 'test', messages: [], max_tokens: 1, stream: true }),
    });
    const ct2 = r2.headers.get('content-type') || '';
    const r2body = await r2.text();
    check('SSE content-type forwarded', ct2.includes('text/event-stream'), ct2);
    check('SSE body reaches client intact', r2body.includes('message_start') && r2body.includes('content_block_delta'));
    check('SSE custom header forwarded', r2.headers.get('x-test') === 'sse-echo');
    await new Promise(r => setTimeout(r, 400));
    const files2 = fs.readdirSync(tmp2);
    const respJl = files2.find(f => f.endsWith('-response.jsonl'));
    check('SSE jsonl response file written', Boolean(respJl));
    if (respJl) {
      const lines = fs.readFileSync(path.join(tmp2, respJl), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      check('SSE events parsed', lines.some(l => l.event === 'message_start' && l.data.includes('message_start')));
      const stats = lines[lines.length - 1];
      check('SSE [done-stats] tail record', stats.event === '[done-stats]' && stats.status === 200, JSON.stringify(stats));
    }
  } finally {
    sse.close();
    cleanup([tmp1, tmp2], children);
  }

  const failed = results.filter(r => !r.ok).length;
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
};

main().catch(e => { console.error('SELFTEST ERROR:', e); process.exit(1); });
