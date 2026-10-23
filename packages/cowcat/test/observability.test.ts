// D9 observability (ADR-132~134): the event-log → span translator, the OTel sink
// binding, the provider lifecycle gating, and the config layer rules.
//
// The translator tests use a recording sink (no SDK, no timers). Exactly one test
// goes through the real OTel SDK with an InMemorySpanExporter, because that is the
// only place the SpanSink→OTel attribute mapping could drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor, BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import {
  createOtelSink,
  createSpanTranslator,
  initTelemetry,
  loadConfig,
  type ConfigSource,
  type KernelEvent,
  type SpanAttributeValue,
  type SpanKindName,
  type SpanSink,
  type SpanStatus,
  type StartedSpan,
} from '../src/index.js';

// A span as recorded by the fake sink: everything the translator promised, and the
// parent link the sink was asked to honour.
interface RecordedSpan {
  readonly name: string;
  readonly kind: SpanKindName;
  readonly startMs: number;
  endMs: number | null;
  status: SpanStatus;
  errorType: string | undefined;
  readonly attributes: Record<string, SpanAttributeValue>;
  readonly events: { readonly name: string; readonly ms: number; readonly attributes: Record<string, SpanAttributeValue> | undefined }[];
  readonly parent: RecordedSpan | null;
  readonly children: RecordedSpan[];
}

interface Recording {
  readonly sink: SpanSink;
  readonly spans: RecordedSpan[];
}

function recordingSink(): Recording {
  const spans: RecordedSpan[] = [];
  // The translator hands back its opaque StartedSpan as `parent`; the recording sink
  // must resolve it to the RecordedSpan it wraps. Guessing the shape (the original
  // bug here) throws INSIDE sink.start, which the translator's never-throw correctly
  // swallows — and the test then fails downstream, far from the cause.
  const spanOf = new Map<object, RecordedSpan>();
  const wrap = (parent: RecordedSpan | null, input: { name: string; kind: SpanKindName; startMs: number; attributes: Record<string, SpanAttributeValue> }): StartedSpan => {
    const span: RecordedSpan = {
      name: input.name,
      kind: input.kind,
      startMs: input.startMs,
      endMs: null,
      status: 'unset',
      errorType: undefined,
      attributes: { ...input.attributes },
      events: [],
      parent,
      children: [],
    };
    spans.push(span);
    parent?.children.push(span);
    const started: StartedSpan = {
      end: (endMs, status, attributes, errorType) => {
        span.endMs = endMs;
        span.status = status;
        if (attributes !== undefined) Object.assign(span.attributes, attributes);
        span.errorType = errorType;
      },
      addEvent: (name, ms, attributes) => {
        span.events.push({ name, ms, attributes: attributes === undefined ? undefined : { ...attributes } });
      },
      setAttributes: (attributes) => {
        Object.assign(span.attributes, attributes);
      },
    };
    spanOf.set(started, span);
    return started;
  };
  return {
    spans,
    sink: {
      start: (input) => wrap(input.parent === undefined ? null : (spanOf.get(input.parent) ?? null), input),
    },
  };
}

let seq = 0;
/** Minimal KernelEvent for the translator: the fields a span decision reads. */
const ev = (sessionId: string, type: string, ts: number, extra: Record<string, unknown> = {}): KernelEvent =>
  ({ seq: ++seq, ts, sessionId, type, ...extra }) as unknown as KernelEvent;

const T0 = 1_800_000_000_000;
const SESSION = 'sess_obs';
const PRESET = 'zai-coding-plan/glm-5.3-flash';

function fullTurnEvents(sessionId = SESSION): KernelEvent[] {
  return [
    ev(sessionId, 'session.opened', T0, { schemaVersion: 3, cowcatVersion: '1.0.0', shell: 'interactive', model: PRESET }),
    ev(sessionId, 'turn.opened', T0 + 10, { input: 'hi', model: 'glm-5.3-flash' }),
    ev(sessionId, 'turn.transitioned', T0 + 20, { from: 'idle', to: 'requesting', reason: null }),
    ev(sessionId, 'model.usage', T0 + 30, { usage: { input: 100, output: 20, cacheRead: 40, cacheCreation: 0 } }),
    ev(sessionId, 'model.message', T0 + 40, { text: '', toolCalls: [{ callId: 'c1', name: 'Bash', input: { command: 'ls' } }], reasoning: [], stopReason: { kind: 'toolCalls', raw: 'tool_calls' } }),
    ev(sessionId, 'turn.transitioned', T0 + 50, { from: 'streaming', to: 'awaiting_tools', reason: null }),
    ev(sessionId, 'tool.finished', T0 + 80, { callId: 'c1', name: 'Bash', ok: true, output: 'ok', facts: null, truncation: null }),
    ev(sessionId, 'turn.transitioned', T0 + 90, { from: 'awaiting_tools', to: 'requesting', reason: null }),
    ev(sessionId, 'model.usage', T0 + 100, { usage: { input: 200, output: 10, cacheRead: 0, cacheCreation: 5 } }),
    ev(sessionId, 'model.message', T0 + 110, { text: 'done', toolCalls: [], reasoning: [], stopReason: { kind: 'end', raw: 'stop' } }),
    ev(sessionId, 'turn.transitioned', T0 + 120, { from: 'streaming', to: 'finishing', reason: null }),
    ev(sessionId, 'turn.transitioned', T0 + 130, { from: 'finishing', to: 'completed', reason: null }),
  ];
}

test('a full turn becomes the ADR-133 span tree', () => {
  const { sink, spans } = recordingSink();
  const tap = createSpanTranslator(sink, { agentVersion: '1.0.0-test' });
  for (const event of fullTurnEvents()) tap.observe(event);

  assert.equal(spans.length, 4, 'one turn span, one chat span per round, one span per tool call');
  const turn = spans[0];
  assert.ok(turn);
  assert.equal(turn.name, 'invoke_agent cowcat');
  assert.equal(turn.kind, 'internal');
  assert.equal(turn.parent, null);
  assert.equal(turn.startMs, T0 + 10);
  assert.equal(turn.endMs, T0 + 130);
  assert.equal(turn.status, 'unset');
  assert.equal(turn.attributes['gen_ai.operation.name'], 'invoke_agent');
  assert.equal(turn.attributes['gen_ai.provider.name'], 'zai-coding-plan');
  assert.equal(turn.attributes['gen_ai.agent.name'], 'cowcat');
  assert.equal(turn.attributes['gen_ai.agent.version'], '1.0.0-test');
  assert.equal(turn.attributes['gen_ai.conversation.id'], SESSION);

  // One chat span per round, CLIENT kind, under the turn span.
  assert.equal(turn.children.length, 3);
  const [chat1, tool, chat2] = turn.children;
  assert.ok(chat1);
  assert.ok(tool);
  assert.ok(chat2);
  assert.equal(chat1.name, 'chat glm-5.3-flash');
  assert.equal(chat1.kind, 'client');
  assert.equal(chat1.startMs, T0 + 20);
  assert.equal(chat1.endMs, T0 + 50, 'the round ends when the turn leaves streaming');
  assert.equal(chat1.attributes['gen_ai.request.model'], 'glm-5.3-flash');
  assert.equal(chat1.attributes['gen_ai.request.stream'], true);
  assert.equal(chat1.attributes['gen_ai.usage.input_tokens'], 100);
  assert.equal(chat1.attributes['gen_ai.usage.output_tokens'], 20);
  assert.equal(chat1.attributes['gen_ai.usage.cache_read.input_tokens'], 40);
  assert.equal(chat1.attributes['gen_ai.usage.cache_write.input_tokens'], undefined, 'zero cache writes are omitted, not reported as 0');
  assert.deepEqual(chat1.attributes['gen_ai.response.finish_reasons'], ['tool_calls']);

  // The tool span starts at the awaiting_tools entry (ADR-133 ③ approximation),
  // never before the tool actually began.
  assert.equal(tool.name, 'execute_tool Bash');
  assert.equal(tool.kind, 'internal');
  assert.equal(tool.startMs, T0 + 50);
  assert.equal(tool.endMs, T0 + 80);
  assert.equal(tool.attributes['gen_ai.tool.name'], 'Bash');
  assert.equal(tool.attributes['gen_ai.tool.call.id'], 'c1');
  assert.equal(tool.attributes['gen_ai.conversation.id'], SESSION);

  assert.equal(chat2.name, 'chat glm-5.3-flash');
  assert.equal(chat2.attributes['gen_ai.usage.cache_write.input_tokens'], 5);
  assert.deepEqual(chat2.attributes['gen_ai.response.finish_reasons'], ['stop']);
});

test('finish_reason maps vendor-neutral StopReason kinds onto protocol words', () => {
  const { sink, spans } = recordingSink();
  const tap = createSpanTranslator(sink);
  tap.observe(ev(SESSION, 'session.opened', T0, { schemaVersion: 3, cowcatVersion: '1', shell: 'interactive' }));
  for (const [kind, expected] of [
    ['maxTokens', 'length'],
    ['other', 'other'],
  ] as const) {
    tap.observe(ev(SESSION, 'turn.opened', T0 + 1, { input: 'x' }));
    tap.observe(ev(SESSION, 'turn.transitioned', T0 + 2, { from: 'idle', to: 'requesting', reason: null }));
    tap.observe(ev(SESSION, 'model.message', T0 + 3, { text: '', toolCalls: [], reasoning: [], stopReason: { kind, raw: kind } }));
    tap.observe(ev(SESSION, 'turn.transitioned', T0 + 4, { from: 'streaming', to: 'finishing', reason: null }));
    tap.observe(ev(SESSION, 'turn.transitioned', T0 + 5, { from: 'finishing', to: 'completed', reason: null }));
    const chats = spans.filter((s) => s.name === 'chat');
    const chat = chats[chats.length - 1];
    assert.ok(chat);
    assert.deepEqual(chat.attributes['gen_ai.response.finish_reasons'], [expected]);
  }
});

test('approval events land on the turn span without content attributes', () => {
  const { sink, spans } = recordingSink();
  const tap = createSpanTranslator(sink);
  tap.observe(ev(SESSION, 'session.opened', T0, { schemaVersion: 3, cowcatVersion: '1', shell: 'interactive', model: PRESET }));
  tap.observe(ev(SESSION, 'turn.opened', T0 + 1, { input: 'x', model: 'glm-5.3-flash' }));
  tap.observe(ev(SESSION, 'approval.requested', T0 + 2, { turnId: 't1', callId: 'a1', name: 'Bash', rule: 'escalation', reason: 'need it', dimensions: ['deny-override'] }));
  tap.observe(ev(SESSION, 'approval.answered', T0 + 3, { turnId: 't1', callId: 'a1', key: 'k', verdict: 'once', by: 'user' }));
  tap.observe(ev(SESSION, 'turn.transitioned', T0 + 4, { from: 'idle', to: 'completed', reason: null }));

  const turn = spans[0];
  assert.ok(turn);
  assert.equal(turn.events.length, 2);
  const [requested, answered] = turn.events;
  assert.ok(requested);
  assert.ok(answered);
  assert.equal(requested.name, 'cowcat.approval.requested');
  assert.equal(requested.attributes?.['cowcat.approval.rule'], 'escalation');
  assert.deepEqual(requested.attributes['cowcat.approval.dimensions'], ['deny-override']);
  assert.equal(answered.name, 'cowcat.approval.answered');
  assert.equal(answered.attributes?.['cowcat.approval.verdict'], 'once');
});

test('fork re-emission is metered as the new conversation (ADR-132 ③)', () => {
  const { sink, spans } = recordingSink();
  const tap = createSpanTranslator(sink);
  for (const event of fullTurnEvents()) tap.observe(event);
  const before = spans.length;
  // The fork copies history through forked.emit under the NEW session id: same
  // events, new conversation. Telemetry follows the billing reality (the fork's
  // next request re-sends the whole history to the provider).
  for (const event of fullTurnEvents('sess_fork')) tap.observe(event);
  const forked = spans.slice(before);
  assert.equal(forked.length, before);
  const forkTurn = forked[0];
  assert.ok(forkTurn);
  assert.equal(forkTurn.attributes['gen_ai.conversation.id'], 'sess_fork');
});

test('a late session.opened backfills the provider name', () => {
  const { sink, spans } = recordingSink();
  const tap = createSpanTranslator(sink);
  // The tap attached after session.opened went by (create-before-open flow).
  tap.observe(ev('sess_late', 'turn.opened', T0, { input: 'x', model: 'glm-5.3-flash' }));
  tap.observe(ev('sess_late', 'turn.transitioned', T0 + 1, { from: 'idle', to: 'requesting', reason: null }));
  tap.observe(ev('sess_late', 'session.opened', T0 + 2, { schemaVersion: 3, cowcatVersion: '1', shell: 'interactive', model: PRESET }));
  tap.observe(ev('sess_late', 'turn.transitioned', T0 + 3, { from: 'requesting', to: 'finishing', reason: null }));
  tap.observe(ev('sess_late', 'turn.transitioned', T0 + 4, { from: 'finishing', to: 'completed', reason: null }));

  const chat = spans.find((s) => s.name === 'chat glm-5.3-flash');
  assert.equal(chat?.attributes['gen_ai.provider.name'], 'zai-coding-plan');
});

test('a throwing sink never propagates through observe or finish', () => {
  const boom: SpanSink = {
    start: () => {
      throw new Error('sink exploded');
    },
  };
  const tap = createSpanTranslator(boom);
  assert.doesNotThrow(() => {
    for (const event of fullTurnEvents()) tap.observe(event);
  });
  assert.doesNotThrow(() => {
    tap.finish(T0 + 999);
  });
});

test('finish abandons open spans as host_shutdown errors', () => {
  const { sink, spans } = recordingSink();
  const tap = createSpanTranslator(sink);
  tap.observe(ev(SESSION, 'session.opened', T0, { schemaVersion: 3, cowcatVersion: '1', shell: 'interactive' }));
  tap.observe(ev(SESSION, 'turn.opened', T0 + 1, { input: 'x', model: 'm' }));
  tap.observe(ev(SESSION, 'turn.transitioned', T0 + 2, { from: 'idle', to: 'requesting', reason: null }));
  tap.finish(T0 + 10);

  const turn = spans.find((s) => s.name === 'invoke_agent cowcat');
  const chat = spans.find((s) => s.name === 'chat m');
  assert.ok(turn);
  assert.ok(chat);
  assert.equal(turn.status, 'error');
  assert.equal(turn.errorType, 'host_shutdown');
  assert.equal(turn.endMs, T0 + 10);
  assert.equal(chat.status, 'error');
  assert.equal(chat.errorType, 'host_shutdown');
});

test('a failed tool carries error.type on its span', () => {
  const { sink, spans } = recordingSink();
  const tap = createSpanTranslator(sink);
  tap.observe(ev(SESSION, 'session.opened', T0, { schemaVersion: 3, cowcatVersion: '1', shell: 'interactive' }));
  tap.observe(ev(SESSION, 'turn.opened', T0 + 1, { input: 'x', model: 'm' }));
  tap.observe(ev(SESSION, 'turn.transitioned', T0 + 2, { from: 'idle', to: 'awaiting_tools', reason: null }));
  tap.observe(ev(SESSION, 'tool.finished', T0 + 5, { callId: 'c9', name: 'Bash', ok: false, output: 'denied', facts: null, truncation: null }));
  const tool = spans.find((s) => s.name === 'execute_tool Bash');
  assert.ok(tool);
  assert.equal(tool.status, 'error');
  assert.equal(tool.errorType, 'tool_error');
});

test('ephemeral stream updates are not facts and produce no spans', () => {
  const { sink, spans } = recordingSink();
  const tap = createSpanTranslator(sink);
  tap.observe({ type: 'model.delta', turnId: 't1', seq: ++seq, ts: T0, sessionId: SESSION, text: 'fragment' } as unknown as KernelEvent);
  tap.observe({ type: 'tool.output.delta', turnId: 't1', callId: 'c1', seq: ++seq, ts: T0, sessionId: SESSION, chunk: 'x' } as unknown as KernelEvent);
  assert.equal(spans.length, 0);
});

test('the OTel sink maps spans, attributes, parenting, and events faithfully', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tap = createSpanTranslator(createOtelSink(provider, 'cowcat', '2.0.0'), { agentVersion: '2.0.0' });
  for (const event of fullTurnEvents()) tap.observe(event);

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 4, 'one turn span, one chat span per round, one span per tool call');
  const byName = (name: string) => spans.find((s) => s.name === name);

  const turn = byName('invoke_agent cowcat');
  assert.ok(turn);
  assert.equal(turn.spanContext().traceId, spans.find((s) => s.name === 'chat glm-5.3-flash')?.spanContext().traceId);
  const chat = byName('chat glm-5.3-flash');
  assert.ok(chat);
  assert.equal(chat.parentSpanId, turn.spanContext().spanId);
  assert.equal(chat.kind, 2, 'SpanKind.CLIENT');
  assert.equal(chat.attributes['gen_ai.operation.name'], 'chat');
  assert.equal(chat.attributes['gen_ai.usage.input_tokens'], 100);
  assert.equal(chat.attributes['gen_ai.request.stream'], true);
  const tool = byName('execute_tool Bash');
  assert.ok(tool);
  assert.equal(tool.parentSpanId, turn.spanContext().spanId);
  assert.equal(tool.attributes['gen_ai.tool.call.id'], 'c1');
  assert.equal(turn.attributes['gen_ai.conversation.id'], SESSION);
  assert.equal(turn.attributes['gen_ai.agent.version'], '2.0.0');
});

test('initTelemetry is gated: no endpoint, no telemetry', () => {
  assert.equal(initTelemetry({ env: {} }), null);
  assert.equal(initTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: '' } }), null);
});

test('initTelemetry honours the env endpoint and shuts down within the 1s budget even against a black hole', async () => {
  const handle = initTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9/v1/traces' } });
  assert.ok(handle);
  // The sink works without a live collector; a span end must not throw either.
  const tap = createSpanTranslator(handle.sink);
  assert.doesNotThrow(() => {
    for (const event of fullTurnEvents()) tap.observe(event);
  });
  const started = Date.now();
  await handle.finish();
  assert.ok(Date.now() - started < 2_000, 'finish must respect the 1s budget even when the endpoint black-holes');
});

const src = (kind: ConfigSource['kind'], body: unknown, path = `/${kind}/cowcat.json`): ConfigSource => ({
  kind,
  path,
  text: typeof body === 'string' ? body : JSON.stringify(body),
});

test('user config otel block resolves; other layers are warned and dropped (ADR-134)', () => {
  const ok = loadConfig([src('user', { otel: { endpoint: 'http://localhost:4318', headersEnv: 'MY_HEADERS' } })]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.config.otel, { endpoint: 'http://localhost:4318', headersEnv: 'MY_HEADERS' });

  const project = loadConfig([
    src('user', {}),
    src('project', { otel: { endpoint: 'http://evil.example' } }),
  ]);
  assert.ok(project.ok);
  assert.equal(project.config.otel, undefined, 'a project must not be able to turn telemetry on or pick an endpoint');
  assert.ok(project.warnings.some((w) => w.problem.includes('otel') && w.problem.includes('ADR-134')));

  const sessionLayer = loadConfig([src('user', {}), src('session', { otel: { endpoint: 'http://also-ignored' } }, '<session>')]);
  assert.ok(sessionLayer.ok);
  assert.equal(sessionLayer.config.otel, undefined);
  assert.ok(sessionLayer.warnings.some((w) => w.problem.includes('otel')));
});
