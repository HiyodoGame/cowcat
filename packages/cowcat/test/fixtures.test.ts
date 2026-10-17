import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicModel } from '../src/adapters/model-anthropic.js';
import { openAIModel } from '../src/adapters/model-openai.js';
import type { ModelChunk, ModelPort, ModelRequest, ModelUsage, StopReasonKind } from '../src/index.js';
import { loadFixture, type Fixture, type FixtureProtocol } from './fixtures.js';
import { replayTransport, type ReplayTransport } from './support.js';

// The adapters, driven by fixture bytes instead of hand-written strings (ADR-042). Two
// things this file is here to prove:
//
// 1. A fixture is really a pair: two encodings of one logical turn, whose declared
//    meanings are identical and whose normalised output therefore has to be too. That is
//    the substance of the P4 exit criterion; exit-criteria.test.ts puts the same bytes
//    through `runTurn` and compares the kernel event sequence itself.
// 2. The four quirks we inherited from v1 and from the vendor docs stay pinned, so a
//    future refactor cannot quietly drop them.

const MAX_TOKENS = 1024;

const readTool = {
  name: 'read_file',
  description: 'read a file',
  risk: 'read' as const,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

interface Driven {
  readonly parts: ModelChunk[];
  readonly transport: ReplayTransport;
}

async function drive(protocol: FixtureProtocol, fixture: Fixture): Promise<Driven> {
  const transport = replayTransport(fixture.raw);
  const model: ModelPort =
    protocol === 'openai'
      ? openAIModel({ apiKey: 'k', fetch: transport.fetch })
      : anthropicModel({ apiKey: 'k', fetch: transport.fetch });
  const request: ModelRequest = {
    messages: [{ role: 'user', text: 'read a.txt' }],
    tools: [readTool],
    model: 'fixture-model',
    maxTokens: MAX_TOKENS,
  };

  const parts: ModelChunk[] = [];
  for await (const part of model.stream(request, new AbortController().signal)) parts.push(part);
  return { parts, transport };
}

const textOf = (parts: readonly ModelChunk[]) =>
  parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
const callsOf = (parts: readonly ModelChunk[]) =>
  parts.flatMap((p) => (p.type === 'tool_call' ? [{ name: p.call.name, input: p.call.input }] : []));
const usagesOf = (parts: readonly ModelChunk[]) => parts.flatMap((p) => (p.type === 'usage' ? [p.usage] : []));
const lastUsage = (parts: readonly ModelChunk[]): ModelUsage | undefined => usagesOf(parts).at(-1);
const stopKind = (parts: readonly ModelChunk[]): StopReasonKind | null => {
  const stop = parts.find((p) => p.type === 'stop');
  return stop?.type === 'stop' ? stop.reason.kind : null;
};

// Every key the fixture declares must be present and equal — a subset check, because the
// point is to pin the fields we care about rather than to freeze the SDK's whole body.
function assertBodyIncludes(actual: Record<string, unknown>, expected: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, `request body field ${key}`);
  }
}

const PAIRED: readonly FixtureProtocol[] = ['openai', 'anthropic'];

// The two model calls of one turn script (ADR-043): the turn the P4 exit criterion is
// about is not one response but the pair of them — the model calls a tool, and the answer
// it then gives once the result is back is what ends the turn.
const PAIRED_SCENARIOS = ['text-and-tool', 'final-text'] as const;

test('the paired fixtures declare one and the same logical turn', () => {
  // If this fails, the two files have drifted and every comparison between them is
  // meaningless — the pair has to be authored together (ADR-043).
  for (const scenario of PAIRED_SCENARIOS) {
    const openai = loadFixture('openai', 'paired', scenario).expectation.logical;
    const anthropic = loadFixture('anthropic', 'paired', scenario).expectation.logical;

    assert.deepEqual(openai, anthropic, scenario);
  }
});

for (const protocol of PAIRED) {
  for (const scenario of PAIRED_SCENARIOS) {
    test(`${protocol}/${scenario}: a fixture's bytes normalise to exactly what the fixture declares`, async () => {
      const fixture = loadFixture(protocol, 'paired', scenario);
      const { parts, transport } = await drive(protocol, fixture);
      const { logical } = fixture.expectation;

      assert.equal(textOf(parts), logical.text);
      assert.deepEqual(callsOf(parts), logical.toolCalls);
      assert.deepEqual(lastUsage(parts), logical.usage);
      assert.equal(stopKind(parts), logical.stopKind);
      // The request side is pinned too: a fixture records the call that produced it.
      assert.match(transport.requests[0]?.url ?? '', new RegExp(`${fixture.expectation.urlPath.replace('/', '\\/')}$`));
      assertBodyIncludes(transport.requests[0]?.body ?? {}, fixture.expectation.body);
    });
  }
}

for (const scenario of PAIRED_SCENARIOS) {
  test(`${scenario}: the pair produces the same normalised content out of two different encodings`, async () => {
    // This is the property the exit criterion is about, stated at the adapter level: the
    // same logical turn, two wire formats, one answer.
    const results = await Promise.all(
      PAIRED.map(async (protocol) => {
        const { parts } = await drive(protocol, loadFixture(protocol, 'paired', scenario));
        return { text: textOf(parts), calls: callsOf(parts), usage: lastUsage(parts), stop: stopKind(parts) };
      }),
    );

    const [openai, anthropic] = results;
    assert.deepEqual(anthropic, openai);
  });
}

test('tool-call ids are the one thing the two encodings do not share', async () => {
  // Worth pinning explicitly: the projection rule in ADR-043 exists because of this, and
  // a test that forgot to project ids would look like a protocol difference.
  const openai = await drive('openai', loadFixture('openai', 'paired', 'text-and-tool'));
  const anthropic = await drive('anthropic', loadFixture('anthropic', 'paired', 'text-and-tool'));

  const idOf = (parts: readonly ModelChunk[]) =>
    parts.flatMap((p) => (p.type === 'tool_call' ? [p.call.callId] : []))[0];

  assert.equal(idOf(openai.parts), 'call_fix_1');
  assert.equal(idOf(anthropic.parts), 'toolu_fix_1');
});

test('pinned: a tool delta arriving after finish_reason is still assembled', async () => {
  const fixture = loadFixture('openai', 'synthetic', 'tool-delta-after-finish');
  const { parts } = await drive('openai', fixture);

  assert.deepEqual(callsOf(parts), fixture.expectation.logical.toolCalls);
  assert.equal(stopKind(parts), 'toolCalls');
});

test('pinned: message_delta usage does not erase the input and cache counts', async () => {
  const fixture = loadFixture('anthropic', 'synthetic', 'usage-delta-omits-input');
  const { parts } = await drive('anthropic', fixture);

  assert.deepEqual(lastUsage(parts), fixture.expectation.logical.usage);
  // The intermediate report is the count `message_start` carried, so a consumer can see
  // both facts rather than only the merged one (ADR-040).
  assert.deepEqual(usagesOf(parts)[0], { input: 10, output: 1, cacheRead: 4, cacheCreation: 2 });
});

test('a fixture is loaded from the package root, not from dist', async () => {
  // Fixtures are data: tsconfig compiles `src` and `test`, so nothing copies `.sse` or
  // `.json` into `dist/`. The tests themselves run from `dist/test`, which is exactly why
  // this has to keep working (AGENTS.md records the same trap for stale builds).
  const fixture = loadFixture('openai', 'paired', 'text-and-tool');
  assert.match(fixture.raw, /^\s*data: /);
  assert.equal(typeof fixture.expectation.description, 'string');
});
