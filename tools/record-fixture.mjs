#!/usr/bin/env node
// Record one model call into a fixture pair (ADR-042).
//
//   node tools/record-fixture.mjs \
//     --protocol openai --provider deepseek --scenario tool-call \
//     --base-url https://api.deepseek.com --api-key-env DEEPSEEK_API_KEY \
//     --model deepseek-flash --prompt "read a.txt"
//
// What it writes, under packages/cowcat/test/fixtures/<protocol>/<provider>/:
//
//   <scenario>.sse   the raw bytes, exactly as they came off the wire
//   <scenario>.json  the request side, plus a `logical` block set to null
//
// THE `logical` BLOCK IS NOT FILLED IN, ON PURPOSE. A recording fixes the bytes; what
// those bytes *mean* is a claim a person makes, and deriving it from our own parser
// would make the fixture agree with the parser by construction — the exact circularity
// that "record the bytes, not the parsed objects" exists to avoid. The loader refuses a
// fixture whose `logical` is null, so an unfinished recording cannot be mistaken for a
// finished one.
//
// Credentials: the key is read from the environment and never written. Nothing in the
// output is derived from request headers, and `scrubHeaders` exists so that stays true if
// someone later decides to snapshot them.
//
// This script is development tooling: it is not linted, not published
// (tools/check-tarball.mjs is the guard) and not run by CI.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'packages', 'cowcat', 'test', 'fixtures');

const HEADERS_NEVER_RECORDED = ['authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie', 'proxy-authorization'];

// Kept as a function rather than an omission so that the rule has one home: if a future
// change starts snapshotting headers, it has to come through here.
function scrubHeaders(headers) {
  const kept = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!HEADERS_NEVER_RECORDED.includes(name.toLowerCase())) kept[name] = value;
  }
  return kept;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

function requireArg(args, name) {
  const value = args[name];
  if (value === undefined || value === '') throw new Error(`--${name} is required`);
  return value;
}

// The smallest request that yields a full answer with one tool call available, so a
// recording exercises text, tool calls and usage.
function buildRequest(protocol, model, prompt) {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    },
  ];

  if (protocol === 'openai') {
    return {
      path: '/chat/completions',
      body: {
        model,
        messages: [{ role: 'user', content: prompt }],
        tools,
        stream: true,
        stream_options: { include_usage: true },
      },
    };
  }
  if (protocol === 'anthropic') {
    return {
      path: '/v1/messages',
      body: {
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        tools: tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters,
        })),
        stream: true,
      },
    };
  }
  throw new Error(`--protocol must be openai or anthropic, got ${protocol}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const protocol = requireArg(args, 'protocol');
  const provider = requireArg(args, 'provider');
  const scenario = requireArg(args, 'scenario');
  const baseURL = requireArg(args, 'base-url');
  const model = requireArg(args, 'model');
  const prompt = requireArg(args, 'prompt');
  const keyEnv = requireArg(args, 'api-key-env');
  const outDir = args['out-dir'] === undefined ? FIXTURES : resolve(args['out-dir']);

  const apiKey = process.env[keyEnv];
  if (apiKey === undefined || apiKey === '') {
    console.error(`${keyEnv} is not set; refusing to record without a key (nothing is written)`);
    process.exit(2);
  }

  const { path, body } = buildRequest(protocol, model, prompt);
  const headers =
    protocol === 'openai'
      ? { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
      : { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };

  const response = await fetch(`${baseURL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!response.ok) {
    console.error(`HTTP ${String(response.status)}: ${(await response.text()).slice(0, 400)}`);
    process.exit(1);
  }
  if (response.body === null) throw new Error('the response has no body to record');
  const raw = await response.text();

  // A recording that does not look like a stream is almost always an error page, and a
  // fixture of an error page is worse than no fixture.
  if (!/^(event: |data: |:)/m.test(raw)) {
    console.error(`the response does not look like an event stream; first 200 bytes:\n${raw.slice(0, 200)}`);
    process.exit(1);
  }

  const target = join(outDir, protocol, provider);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, `${scenario}.sse`), raw, 'utf8');
  writeFileSync(
    join(target, `${scenario}.json`),
    `${JSON.stringify(
      {
        description: `recorded from ${provider} (${protocol}) on ${new Date().toISOString().slice(0, 10)}`,
        urlPath: path,
        body,
        // Requests headers are deliberately absent; see HEADERS_NEVER_RECORDED.
        logical: null,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(`recorded ${raw.length} bytes -> ${join(target, `${scenario}.sse`)}`);
  console.log(`  request side      -> ${join(target, `${scenario}.json`)}`);
  console.log('  NEXT: fill in `logical` by hand (text, toolCalls, usage, stopKind).');
  console.log('  The loader refuses a fixture while `logical` is null, so this cannot ship half-done.');
  if (Object.keys(scrubHeaders(headers)).length === 0) console.log('  (scrubbed every header — nothing else to carry)');
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exit(1);
});
