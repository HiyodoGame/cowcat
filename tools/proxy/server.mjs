#!/usr/bin/env node
// Logging HTTP proxy: forwards Claude Code traffic to an upstream LLM API while recording full request/response bodies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const HELP = `Usage: node tools/proxy/server.mjs --port <port> --upstream <url> [options]

Options:
  --port <n>           Listen port on 127.0.0.1 (default: 8787)
  --upstream <url>     Upstream base URL, e.g. https://api.anthropic.com (required)
  --upstream-key <k>   Override Authorization / x-api-key when forwarding
  --log-dir <dir>      Capture directory (default: logs/capture)
  -h, --help           Show this help

Point Claude Code at it:  ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
`;

function parseArgs(argv) {
  const o = { port: 8787, upstream: '', upstreamKey: '', logDir: 'logs/capture' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--port') o.port = Number(next());
    else if (a.startsWith('--port=')) o.port = Number(a.slice(7));
    else if (a === '--upstream') o.upstream = next();
    else if (a.startsWith('--upstream=')) o.upstream = a.slice(11);
    else if (a === '--upstream-key') o.upstreamKey = next();
    else if (a.startsWith('--upstream-key=')) o.upstreamKey = a.slice(15);
    else if (a === '--log-dir') o.logDir = next();
    else if (a.startsWith('--log-dir=')) o.logDir = a.slice(10);
    else { console.error(`Unknown argument: ${a}`); process.exit(1); }
  }
  return o;
}

const mask = (v) => {
  v = String(v);
  return v.length <= 16 ? v : `${v.slice(0, 8)}…${v.slice(-8)}`;
};

function pickHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (lk === 'content-type' || lk === 'user-agent' || lk.startsWith('anthropic-') ||
        lk === 'authorization' || lk === 'x-api-key') {
      out[k] = (lk === 'authorization' || lk === 'x-api-key') ? mask(v) : v;
    }
  }
  return out;
}

function toHeaderValue(v) {
  return Array.isArray(v) ? v.join(', ') : v;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { console.log(HELP); return; }
  if (!opts.upstream) { console.error('Missing required --upstream.\n'); console.log(HELP); process.exit(1); }
  const upstream = new URL(opts.upstream);
  fs.mkdirSync(opts.logDir, { recursive: true });
  const manifestPath = path.join(opts.logDir, 'manifest.jsonl');
  let seq = 0;

  const appendManifest = (rec) => fs.appendFileSync(manifestPath, JSON.stringify(rec) + '\n');

  const server = http.createServer(async (req, res) => {
    const n = ++seq;
    const start = Date.now();
    const base = path.join(opts.logDir, `${stamp()}-${n}`);
    const reqFile = `${base}-request.json`;
    let respFile = `${base}-response.json`;
    const url = new URL(req.url, 'http://127.0.0.1');
    const basePath = upstream.pathname.replace(/\/$/, '');
    const target = upstream.origin + basePath + url.pathname + url.search;

    const fail = (status, err) => {
      const durationMs = Date.now() - start;
      respFile = `${base}-response.json`;
      fs.writeFileSync(respFile, JSON.stringify({ seq: n, timestamp: new Date().toISOString(), status, error: String(err && err.message || err) }, null, 2));
      appendManifest({ seq: n, time: new Date().toISOString(), path: url.pathname, status, reqFile: path.basename(reqFile), respFile: path.basename(respFile), durationMs });
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      try { res.end(JSON.stringify({ error: 'proxy_error', status, message: String(err && err.message || err) })); } catch {}
      console.log(`[${n}] ${req.method} ${url.pathname} -> ${status} ERROR (${durationMs}ms)`);
    };

    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);

      fs.writeFileSync(reqFile, JSON.stringify({
        seq: n,
        timestamp: new Date().toISOString(),
        method: req.method,
        path: url.pathname + url.search,
        headers: pickHeaders(req.headers),
        body: body.toString('utf8'),
      }, null, 2));

      const fwd = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(k)) continue;
        fwd[k] = toHeaderValue(v);
      }
      if (opts.upstreamKey) {
        fwd.authorization = `Bearer ${opts.upstreamKey}`;
        fwd['x-api-key'] = opts.upstreamKey;
      }

      const upstreamRes = await fetch(target, {
        method: req.method,
        headers: fwd,
        body: ['GET', 'HEAD'].includes(req.method || '') ? undefined : body,
        redirect: 'manual',
      });

      const respHeaders = {};
      upstreamRes.headers.forEach((v, k) => { respHeaders[k] = v; });
      const ct = upstreamRes.headers.get('content-type') || '';

      if (ct.includes('text/event-stream')) {
        // SSE: stream to client, tee into per-event jsonl.
        respFile = `${base}-response.jsonl`;
        const out = fs.createWriteStream(respFile, { flags: 'a' });
        res.writeHead(upstreamRes.status, respHeaders);
        const reader = upstreamRes.body.getReader();
        let lineBuf = '';
        let pending = null; // {event, dataLines}
        const emit = () => {
          if (pending && (pending.event || pending.dataLines.length)) {
            out.write(JSON.stringify({ event: pending.event, data: pending.dataLines.join('\n') }) + '\n');
          }
          pending = { event: '', dataLines: [] };
        };
        pending = { event: '', dataLines: [] };
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            try { res.write(chunk); } catch { break; } // client gone
            lineBuf += chunk.toString('utf8');
            let idx;
            while ((idx = lineBuf.indexOf('\n')) >= 0) {
              const line = lineBuf.slice(0, idx).replace(/\r$/, '');
              lineBuf = lineBuf.slice(idx + 1);
              if (line === '') { emit(); continue; }
              if (line.startsWith('event:')) pending.event = line.slice(6).trim();
              else if (line.startsWith('data:')) pending.dataLines.push(line.slice(5).replace(/^ /, ''));
            }
          }
          emit();
        } finally {
          out.write(JSON.stringify({ event: '[done-stats]', status: upstreamRes.status, durationMs: Date.now() - start }) + '\n');
          out.end();
          try { res.end(); } catch {}
        }
      } else {
        const buf = Buffer.from(await upstreamRes.arrayBuffer());
        res.writeHead(upstreamRes.status, respHeaders);
        res.end(buf);
        fs.writeFileSync(respFile, JSON.stringify({
          seq: n,
          timestamp: new Date().toISOString(),
          status: upstreamRes.status,
          headers: respHeaders,
          body: buf.toString('utf8'),
        }, null, 2));
      }

      const durationMs = Date.now() - start;
      appendManifest({ seq: n, time: new Date().toISOString(), path: url.pathname, status: upstreamRes.status, reqFile: path.basename(reqFile), respFile: path.basename(respFile), durationMs });
      console.log(`[${n}] ${req.method} ${url.pathname} -> ${upstreamRes.status} (${durationMs}ms)`);
    } catch (err) {
      fail(res.headersSent ? 502 : 502, err);
    }
  });

  server.on('clientError', (err, sock) => { try { sock.destroy(); } catch {} });
  server.listen(opts.port, '127.0.0.1', () => {
    console.log(`Proxy listening on 127.0.0.1:${opts.port} -> ${upstream.origin}, logging to ${path.resolve(opts.logDir)}`);
  });
}

main();
