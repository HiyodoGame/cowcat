import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OutputFlow, type OutputChunk, type OutputSchedule } from '../src/adapters/output-flow.js';

// The coalescing arithmetic (ADR-107), with a scheduler a test can fire by hand. Wall-clock
// timers here would make the suite sleep for the sake of one assertion.

function recordingSink(): { readonly chunks: OutputChunk[]; readonly sink: { onOutput: (stream: 'stdout' | 'stderr', text: string) => void } } {
  const chunks: OutputChunk[] = [];
  return {
    chunks,
    sink: {
      onOutput: (stream, text) => {
        chunks.push({ stream, text });
      },
    },
  };
}

function manualSchedule(): {
  readonly schedule: OutputSchedule;
  readonly fire: () => void;
  readonly armed: boolean;
} {
  let pending: (() => void) | null = null;
  return {
    schedule: (flush) => {
      pending = flush;
      return {
        cancel: () => {
          pending = null;
        },
      };
    },
    fire: () => {
      const flush = pending;
      pending = null;
      flush?.();
    },
    get armed() {
      return pending !== null;
    },
  };
}

test('chunks wait for the window and arrive as one callback per stream', () => {
  const { chunks, sink } = recordingSink();
  const clock = manualSchedule();
  const flow = new OutputFlow(sink, { schedule: clock.schedule });

  flow.push('stdout', 'hel');
  flow.push('stdout', 'lo');
  assert.deepEqual(chunks, [], 'nothing is handed over before the window closes');
  assert.equal(clock.armed, true);

  clock.fire();
  assert.deepEqual(chunks, [{ stream: 'stdout', text: 'hello' }]);
  assert.equal(clock.armed, false);
});

test('a burst flushes immediately instead of waiting for the window', () => {
  const { chunks, sink } = recordingSink();
  const clock = manualSchedule();
  const flow = new OutputFlow(sink, { maxChars: 5, schedule: clock.schedule });

  flow.push('stdout', 'abc');
  assert.equal(clock.armed, true);
  flow.push('stdout', 'de');
  assert.deepEqual(chunks, [{ stream: 'stdout', text: 'abcde' }], 'the size cap wins over the clock');
  assert.equal(clock.armed, false, 'the pending timer was cancelled by the flush');

  flow.push('stdout', 'f');
  assert.equal(clock.armed, true, 'a later chunk arms a fresh window');
});

test('streams keep their arrival order', () => {
  const { chunks, sink } = recordingSink();
  const clock = manualSchedule();
  const flow = new OutputFlow(sink, { schedule: clock.schedule });

  flow.push('stdout', 'a');
  flow.push('stderr', 'e');
  flow.push('stdout', 'b');
  clock.fire();

  assert.deepEqual(chunks, [
    { stream: 'stdout', text: 'a' },
    { stream: 'stderr', text: 'e' },
    { stream: 'stdout', text: 'b' },
  ]);
});

test('a sink that throws does not stop the next delivery', () => {
  const clock = manualSchedule();
  let calls = 0;
  const flow = new OutputFlow(
    {
      onOutput: () => {
        calls += 1;
        throw new Error('renderer bug');
      },
    },
    { schedule: clock.schedule },
  );

  flow.push('stdout', 'x');
  clock.fire();
  assert.equal(calls, 1);

  flow.push('stdout', 'y');
  clock.fire();
  assert.equal(calls, 2, 'a throwing sink is a broken frame, not a broken runner');
});

test('a sink that pushes while being flushed is drained by the same flush', () => {
  const clock = manualSchedule();
  const chunks: string[] = [];
  const flow: OutputFlow = new OutputFlow(
    {
      onOutput: (_stream, text) => {
        chunks.push(text);
        if (text === 'a') flow.push('stdout', 'b');
      },
    },
    { schedule: clock.schedule },
  );

  flow.push('stdout', 'a');
  clock.fire();
  assert.deepEqual(chunks, ['a', 'b'], 'the nested push is delivered, not lost or recursed');
  assert.equal(clock.armed, false, 'the window armed by the nested push was drained too');
});

test('an explicit flush hands over what is pending and is safe when nothing is', () => {
  const { chunks, sink } = recordingSink();
  const clock = manualSchedule();
  const flow = new OutputFlow(sink, { schedule: clock.schedule });

  flow.flush();
  assert.deepEqual(chunks, []);

  flow.push('stdout', 'z');
  flow.flush();
  assert.deepEqual(chunks, [{ stream: 'stdout', text: 'z' }]);
  assert.equal(clock.armed, false);
});

test('empty text never arms a timer', () => {
  const { chunks, sink } = recordingSink();
  const clock = manualSchedule();
  const flow = new OutputFlow(sink, { schedule: clock.schedule });

  flow.push('stdout', '');
  assert.equal(clock.armed, false);
  flow.flush();
  assert.deepEqual(chunks, []);
});
