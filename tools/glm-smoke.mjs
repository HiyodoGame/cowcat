#!/usr/bin/env node
/**
 * One REAL model request, through the composition root's own code path (T4a 2/3, HANDOFF §3 item 4).
 *
 * Everything else in the v2 tree stops before the network: there are no credentials in CI,
 * so "can a provider actually be reached" has been a zero-measurement question since P4.
 * This probe answers it by hand, on a machine where a key exists, and nothing in CI calls it.
 *
 * What it exercises end to end:
 *   config.preset id -> selectModel() (built-in table) -> createModelPort() (reads the key
 *   from the environment) -> ModelPort.stream() -> real bytes -> decoded chunks.
 *
 * Usage:
 *   node tools/glm-smoke.mjs                          # bigmodel/glm-5.3-flash, no tools
 *   node tools/glm-smoke.mjs zai/glm-5.3-flash        # the OpenAI-protocol route
 *   node tools/glm-smoke.mjs --tools                  # also send the tool schemas
 *
 * Exit codes: 0 the request was made and the reply was decoded; 1 it was refused or failed;
 * 2 nothing was attempted (no key in the environment, or no build to run against).
 *
 * It never prints the key, and never writes anything anywhere.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'packages', 'cowcat', 'dist', 'src', 'index.js');

if (!existsSync(dist)) {
  console.error(`no build to run against: ${dist}\nrun "npm --prefix packages/cowcat run build" first.`);
  process.exit(2);
}

// pathToFileURL, not the bare path: Windows drive letters are an ESM loader error
// (AGENTS.md, measured).
const core = await import(pathToFileURL(dist).href);

const argv = process.argv.slice(2);
const withTools = argv.includes('--tools');
const presetId = argv.find((arg) => !arg.startsWith('--')) ?? 'bigmodel/glm-5.3-flash';

const settings = { preset: presetId, effort: null, presets: {}, providers: {} };
let selection;
try {
  selection = core.selectModel(settings);
} catch (error) {
  console.error(`preset refused: ${error.message}${error.hint ? `\n  ${error.hint}` : ''}`);
  process.exit(2);
}

console.log(`preset   ${selection.id}`);
console.log(`protocol ${selection.preset.protocol}`);
console.log(`model    ${selection.preset.model}`);
console.log(`endpoint ${selection.baseUrl ?? '(the SDK default)'}`);
console.log(`key env  ${selection.apiKeyEnv}`);
for (const warning of selection.warnings) console.log(`warning  ${warning}`);

if (!process.env[selection.apiKeyEnv]) {
  console.error(`\n${selection.apiKeyEnv} is not set in this environment, so nothing was sent.`);
  console.error('This probe spends a real request on a real plan: set the variable in the shell you run it from.');
  process.exit(2);
}

let model;
try {
  model = core.createModelPort(selection, process.env);
} catch (error) {
  console.error(`the model could not be built: ${error.message}`);
  process.exit(2);
}

// Six schemas, not seven: `Bash` needs a ProcessPort, and what this flag is here to test is
// whether the endpoint accepts our wire JSON Schema at all (HANDOFF §6.5).
const tools = withTools
  ? [
      core.createReadTool({ cwd: process.cwd() }),
      core.createWriteTool({ cwd: process.cwd() }),
      core.createEditTool({ cwd: process.cwd() }),
      core.createGlobTool({ cwd: process.cwd() }),
      core.createGrepTool({ cwd: process.cwd() }),
      core.createTodoWriteTool(),
    ].map((tool) => tool.spec)
  : [];

const request = {
  messages: [{ role: 'user', text: 'Reply with exactly: cowcat smoke ok' }],
  tools,
  model: selection.preset.model,
  ...(selection.preset.limits.output === undefined ? {} : { maxTokens: selection.preset.limits.output }),
};

console.log(`\nsending${tools.length > 0 ? ` with ${tools.length} tool schemas` : ' (no tools)'}...`);

const started = Date.now();
const controller = new AbortController();
const timeout = setTimeout(() => {
  controller.abort(new Error('the probe timed out after 60s'));
}, 60_000);

let text = '';
const calls = [];
let stopReason = null;
let usage = null;
try {
  for await (const chunk of model.stream(request, controller.signal)) {
    switch (chunk.type) {
      case 'text':
        text += chunk.text;
        break;
      case 'tool_call':
        calls.push(chunk.call);
        break;
      case 'usage':
        usage = chunk.usage;
        break;
      case 'stop':
        stopReason = chunk.reason;
        break;
      case 'reasoning':
        console.log(`reasoning: ${chunk.block.type} (${String(JSON.stringify(chunk.block).length)} bytes)`);
        break;
      default:
        console.log(`unhandled chunk: ${JSON.stringify(chunk)}`);
    }
  }
} catch (error) {
  clearTimeout(timeout);
  console.error(`\nREFUSED after ${String(Date.now() - started)}ms: ${error instanceof Error ? error.message : String(error)}`);
  // The interesting failure is a 400 with a ceiling or a schema complaint in it: that is what
  // calibrates the preset numbers (HANDOFF §6.12), so print the whole thing rather than a line.
  if (error?.cause) console.error('cause:', error.cause);
  process.exit(1);
}
clearTimeout(timeout);

console.log(`\ntext       ${JSON.stringify(text)}`);
console.log(`tool calls ${String(calls.length)}${calls.length > 0 ? ` (${calls.map((call) => call.name).join(', ')})` : ''}`);
console.log(`stop       ${JSON.stringify(stopReason)}`);
console.log(`usage      ${JSON.stringify(usage)}`);
console.log(`elapsed    ${String(Date.now() - started)}ms`);
console.log(`\nreached the vendor and decoded a reply`);
