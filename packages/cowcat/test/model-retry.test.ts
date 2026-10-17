import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicModel } from '../src/adapters/model-anthropic.js';
import { openAIModel } from '../src/adapters/model-openai.js';
import {
  NO_RETRY,
  retryAfterMs,
  retryableStatus,
  sleepAbortably,
  withRetry,
  type RetryDecision,
} from '../src/adapters/model-retry.js';
import type { ModelChunk, ModelPort, ModelRequest } from '../src/index.js';
import { failingBodyTransport, replayTransport, sequenceTransport } from './support.js';

// ADR-039, in two halves. The arithmetic of a wait is tested on `withRetry` directly, with
// the sleep injected so the numbers are the assertion rather than a wall-clock guess; what
// the protocol considers retryable is tested through the adapters, because that is where
// the protocol knowledge lives.

const request: ModelRequest = { messages: [{ role: 'user', text: 'hi' }], tools: [], model: 'fixture-model', maxTokens: 64 };

const SSE_TEXT =
  'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n';

const ANTHROPIC_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

async function drain(model: ModelPort, signal = new AbortController().signal): Promise<ModelChunk[]> {
  const parts: ModelChunk[] = [];
  for await (const part of model.stream(request, signal)) parts.push(part);
  return parts;
}

const textOf = (parts: readonly ModelChunk[]) => parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');

// ---- the wait itself --------------------------------------------------------------

test('retryableStatus covers the statuses both protocols agree on', () => {
  for (const status of [408, 409, 429, 500, 502, 503, 529]) assert.equal(retryableStatus(status), true, String(status));
  for (const status of [400, 401, 403, 404, 422]) assert.equal(retryableStatus(status), false, String(status));
});

test('Retry-After is read in seconds, and anything unparseable is ignored rather than guessed', () => {
  const headers = (value: string | null) => ({ get: () => value });
  assert.equal(retryAfterMs(headers('2')), 2000);
  assert.equal(retryAfterMs(headers(' 1.5 ')), 1500);
  // The HTTP-date form is deliberately not honoured: a client clock and a server clock
  // are not necessarily in the same state of agreement, and getting it wrong means either
  // a wait of years or none at all.
  assert.equal(retryAfterMs(headers('Wed, 21 Oct 2026 07:28:00 GMT')), null);
  assert.equal(retryAfterMs(headers(null)), null);
  assert.equal(retryAfterMs(undefined), null);
});

test('a wait that ends normally takes its listener with it', async () => {
  // ADR-039 decision ②: the listener is removed on both paths, not left to `{ once: true }`
  // — `once` unregisters on the path that needs it least, and a long-lived session signal
  // accumulates one per retry otherwise.
  let added = 0;
  let removed = 0;
  const fake = {
    aborted: false,
    addEventListener: () => {
      added += 1;
    },
    removeEventListener: () => {
      removed += 1;
    },
  } as unknown as AbortSignal;

  await sleepAbortably(1, fake);
  assert.equal(added, 1);
  assert.equal(removed, 1, 'the normal path must unregister too');
});

test('a wait that is aborted rejects at once, and unregisters the listener it added', async () => {
  let added = 0;
  let removed = 0;
  let fire: (() => void) | undefined;
  const fake = {
    aborted: false,
    addEventListener: (_type: string, listener: () => void) => {
      added += 1;
      fire = listener;
    },
    removeEventListener: () => {
      removed += 1;
    },
  } as unknown as AbortSignal;

  const waiting = sleepAbortably(60_000, fake);
  fire?.();
  await assert.rejects(() => waiting, /abort/i);
  assert.equal(added, 1);
  assert.equal(removed, 1, 'the abort path removes it too, rather than relying on { once: true }');
});

test('a signal that is already aborted never registers anything in the first place', async () => {
  let added = 0;
  const fake = {
    aborted: true,
    addEventListener: () => {
      added += 1;
    },
    removeEventListener: () => undefined,
  } as unknown as AbortSignal;

  await assert.rejects(() => sleepAbortably(60_000, fake), /abort/i);
  assert.equal(added, 0, 'there was never a wait to interrupt');
});

test('the retry budget is two by default, and the wait doubles', async () => {
  const waits: number[] = [];
  const seen: number[] = [];
  await assert.rejects(
    () =>
      withRetry({
        signal: new AbortController().signal,
        attempt: () => {
          seen.push(1);
          return Promise.reject(new Error('always fails'));
        },
        classify: (): RetryDecision => ({ retry: true, afterMs: null }),
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      }),
    /always fails/,
  );

  assert.equal(seen.length, 3, 'the first attempt plus two retries');
  assert.deepEqual(waits, [500, 1000], 'base, then double');
});

test('a Retry-After from the server wins over the computed backoff', async () => {
  const waits: number[] = [];
  await withRetry({
    signal: new AbortController().signal,
    attempt: (() => {
      let first = true;
      return () => {
        if (first) {
          first = false;
          return Promise.reject(new Error('rate limited'));
        }
        return Promise.resolve('done');
      };
    })(),
    classify: (): RetryDecision => ({ retry: true, afterMs: 7000 }),
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });

  assert.deepEqual(waits, [7000]);
});

test('a hostile Retry-After cannot park the session past the ceiling', async () => {
  const waits: number[] = [];
  await withRetry({
    signal: new AbortController().signal,
    attempt: (() => {
      let first = true;
      return () => {
        if (first) {
          first = false;
          return Promise.reject(new Error('rate limited'));
        }
        return Promise.resolve('done');
      };
    })(),
    classify: (): RetryDecision => ({ retry: true, afterMs: 86_400_000 }),
    policy: { maxDelayMs: 5000 },
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });

  assert.deepEqual(waits, [5000]);
});

test('a cancellation during the wait ends it there, and no further attempt is made', async () => {
  // ADR-039 decision ①: the wait itself has to respond to the signal. The legacy
  // implementation's sleep was a bare setTimeout, so a cancelled session kept sleeping.
  const controller = new AbortController();
  const attempts: number[] = [];
  let interrupted = false;

  await assert.rejects(() =>
    withRetry({
      signal: controller.signal,
      attempt: () => {
        attempts.push(1);
        return Promise.reject(new Error('transient'));
      },
      classify: (): RetryDecision => ({ retry: true, afterMs: null }),
      sleep: () => {
        // A real sleep would take 500ms; a person cancelling during it must not.
        controller.abort();
        return sleepAbortably(60_000, controller.signal);
      },
    }),
  );

  interrupted = true;
  assert.equal(interrupted, true);
  assert.equal(attempts.length, 1, 'the retry never started');
});

test('an already-cancelled signal never reaches the attempt at all', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;

  await assert.rejects(() =>
    withRetry({
      signal: controller.signal,
      attempt: () => {
        called = true;
        return Promise.resolve('nope');
      },
      classify: (): RetryDecision => NO_RETRY,
    }),
  );

  assert.equal(called, false);
});

// ---- what the protocols consider retryable ----------------------------------------

test('openai: a 429 is retried and the retry can succeed', async () => {
  const transport = sequenceTransport([
    { status: 429, headers: { 'retry-after': '0' }, body: '{"error":"slow down"}' },
    { status: 200, body: SSE_TEXT, headers: { 'content-type': 'text/event-stream' } },
  ]);
  const parts = await drain(
    openAIModel({ apiKey: 'k', fetch: transport.fetch, retry: { baseDelayMs: 1 } }),
  );

  assert.equal(transport.requests.length, 2);
  assert.equal(textOf(parts), 'ok');
});

test('openai: a 401 is a configuration problem, not a transient one — no retry', async () => {
  const transport = sequenceTransport([
    { status: 401, body: '{"error":"bad key"}' },
    { status: 200, body: SSE_TEXT, headers: { 'content-type': 'text/event-stream' } },
  ]);

  await assert.rejects(() => drain(openAIModel({ apiKey: 'k', fetch: transport.fetch, retry: { baseDelayMs: 1 } })));
  assert.equal(transport.requests.length, 1, 'a rejected credential must not be hammered');
});

test('openai: a persistent 5xx gives up after the retry budget', async () => {
  const transport = sequenceTransport([{ status: 503, body: '{"error":"overloaded"}' }]);

  await assert.rejects(() => drain(openAIModel({ apiKey: 'k', fetch: transport.fetch, retry: { baseDelayMs: 1 } })));
  assert.equal(transport.requests.length, 3, 'the first attempt plus two retries');
});

test('a stream that has already produced output is never retried', async () => {
  // The one the SDKs get wrong on their own, and the reason the retry wraps only the call
  // that obtains the response: the iteration happens outside it.
  const transport = failingBodyTransport(
    'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"half"},"finish_reason":null}]}\n\n',
  );
  const parts: ModelChunk[] = [];

  await assert.rejects(async () => {
    for await (const part of openAIModel({
      apiKey: 'k',
      fetch: transport.fetch,
      retry: { baseDelayMs: 1 },
    }).stream(request, new AbortController().signal)) {
      parts.push(part);
    }
  }, /mid-stream/);

  assert.equal(transport.requests.length, 1, 'retrying would make the model say it twice');
  // Whether the last chunk survives is the SDK's buffering, not our contract: it can read
  // a fragment and the failure in the same batch and drop both. What this test is here for
  // is the request count above.
});

test('anthropic: an overloaded endpoint (529) is retried', async () => {
  const transport = sequenceTransport([
    { status: 529, body: '{"type":"error","error":{"type":"overloaded_error","message":"busy"}}' },
    { status: 200, body: ANTHROPIC_SSE, headers: { 'content-type': 'text/event-stream' } },
  ]);
  const parts = await drain(
    anthropicModel({ apiKey: 'k', fetch: transport.fetch, retry: { baseDelayMs: 1 } }),
  );

  assert.equal(transport.requests.length, 2);
  assert.equal(parts.some((p) => p.type === 'usage'), true);
});

test('anthropic: a 400 request error is not retried', async () => {
  const transport = sequenceTransport([
    { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"nope"}}' },
    { status: 200, body: ANTHROPIC_SSE, headers: { 'content-type': 'text/event-stream' } },
  ]);

  await assert.rejects(() =>
    drain(anthropicModel({ apiKey: 'k', fetch: transport.fetch, retry: { baseDelayMs: 1 } })),
  );
  assert.equal(transport.requests.length, 1);
});

test('a cancellation is never turned into a retry', async () => {
  const controller = new AbortController();
  const transport = sequenceTransport([{ status: 503, body: '{}' }]);
  controller.abort();

  await assert.rejects(() =>
    drain(
      openAIModel({ apiKey: 'k', fetch: transport.fetch, retry: { baseDelayMs: 1 } }),
      controller.signal,
    ),
  );
  assert.equal(transport.requests.length, 0, 'an aborted call does not even go out');
});

test('a replay transport still succeeds when no retry is needed at all', async () => {
  const transport = replayTransport(SSE_TEXT);
  const parts = await drain(openAIModel({ apiKey: 'k', fetch: transport.fetch }));
  assert.equal(textOf(parts), 'ok');
  assert.equal(transport.requests.length, 1);
});
