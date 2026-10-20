import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextCeiling,
  contextUsage,
  estimateMessage,
  estimateMessages,
  estimateText,
  initialState,
  makeAttachment,
  reduce,
  RECENT_KEEP_TOKENS,
  type KernelEvent,
  type Message,
  type SessionState,
} from '../src/index.js';

/**
 * ADR-070/071: how full the context is, and what a compaction does to the fold.
 *
 * The estimator is deliberately crude (`chars / 4`), so these tests assert the *shape*
 * of the arithmetic rather than tokenizer accuracy: what is counted, what is not, and
 * which reading wins.
 */

function header(seq = 1): KernelEvent {
  return {
    type: 'session.opened',
    seq,
    ts: seq,
    sessionId: 'sess_ctx',
    turnId: null,
    schemaVersion: 1,
    cowcatVersion: '0.0.0-test',
    shell: { kind: 'posix', executable: '/bin/sh' },
  };
}

function turnOpened(seq: number, input: string): KernelEvent {
  return { type: 'turn.opened', seq, ts: seq, sessionId: 'sess_ctx', turnId: `turn_${String(seq)}`, input };
}

function modelMessage(seq: number, text: string): KernelEvent {
  return {
    type: 'model.message',
    seq,
    ts: seq,
    sessionId: 'sess_ctx',
    turnId: 'turn_x',
    text,
    toolCalls: [],
    reasoning: [],
    stopReason: null,
  };
}

function toolFinished(seq: number, output: string): KernelEvent {
  return {
    type: 'tool.finished',
    seq,
    ts: seq,
    sessionId: 'sess_ctx',
    turnId: 'turn_x',
    callId: `call_${String(seq)}`,
    name: 'Read',
    ok: true,
    output,
    facts: null,
    truncation: null,
    path: null,
    attachments: null,
  };
}

function usage(seq: number, input: number, output = 0, cacheRead = 0, cacheCreation = 0): KernelEvent {
  return { type: 'model.usage', seq, ts: seq, sessionId: 'sess_ctx', turnId: 'turn_x', usage: { input, output, cacheRead, cacheCreation } };
}

function compacted(seq: number, throughSeq: number, shadowed: number[], summary: string): KernelEvent {
  return {
    type: 'context.compacted',
    seq,
    ts: seq,
    sessionId: 'sess_ctx',
    turnId: null,
    trigger: 'auto',
    summary,
    throughSeq,
    shadowed,
    dropped: shadowed.length,
    model: 'test-model',
    usage: null,
  };
}

function replayOf(events: readonly KernelEvent[]): SessionState {
  return events.reduce(reduce, initialState('sess_ctx'));
}

test('text is priced at four characters per token, rounded up', () => {
  assert.equal(estimateText(''), 0);
  assert.equal(estimateText('abcd'), 1);
  assert.equal(estimateText('abcde'), 2);
  assert.equal(estimateText('你好世界'), 1, 'four characters is one token whatever they are');
});

test('a tool result pays for its text and for its media, not for the bytes', () => {
  const plain: Message = { role: 'tool', callId: 'c1', ok: true, output: 'abcd', attachments: [] };
  const image: Message = {
    ...plain,
    attachments: [makeAttachment({ type: 'image', mediaType: 'image/png', path: '/tmp/a.png', bytes: 10 })],
  };
  const document: Message = {
    ...plain,
    attachments: [makeAttachment({ type: 'document', mediaType: 'application/pdf', path: '/tmp/a.pdf', bytes: 10 })],
  };
  const overhead = estimateMessage(plain) - estimateText('abcd');
  assert.equal(estimateMessage(image) - estimateMessage(plain), 1500);
  assert.equal(estimateMessage(document) - estimateMessage(plain), 2000);
  assert.equal(overhead > 0, true, 'role framing is not free');
});

test('assistant tool calls and reasoning are counted, because they are sent back', () => {
  const bare: Message = { role: 'assistant', text: '', toolCalls: [], reasoning: [] };
  const withCall: Message = {
    role: 'assistant',
    text: '',
    toolCalls: [{ callId: 'c1', name: 'Read', input: { file_path: '/tmp/a.ts' } }],
    reasoning: [{ type: 'thinking', text: 'thinking hard', signature: 'sig' }],
  };
  assert.ok(estimateMessage(withCall) > estimateMessage(bare));
});

test('the ceiling keeps a reply-sized reserve, and never invents one for an unknown window', () => {
  assert.equal(contextCeiling(undefined), null);
  assert.equal(contextCeiling(0), null);
  // 1M is the preset class we ship: 15% is larger than the 16k floor.
  assert.equal(contextCeiling(1_000_000), 850_000);
  // 100k: 15% is 15k, the floor wins.
  assert.equal(contextCeiling(100_000), 84_000);
  // A window smaller than twice the floor keeps the share only, so it is not emptied.
  assert.equal(contextCeiling(20_000), 17_000);
});

test('recent history is kept by tokens, not by messages (opencode default)', () => {
  assert.equal(RECENT_KEEP_TOKENS, 15_000);
});

test('before any usage report, the local estimate is the answer', () => {
  const state = replayOf([header(), turnOpened(2, 'hello')]);
  const usageNow = contextUsage(state);
  assert.equal(usageNow.measured, 0);
  assert.equal(usageNow.total, usageNow.estimated);
  assert.equal(usageNow.estimated, estimateMessages(state.messages));
});

test('a usage report anchors the count, and only later messages are estimated', () => {
  const state = replayOf([
    header(),
    turnOpened(2, 'hello'),
    modelMessage(3, 'hi'),
    // The provider saw the user message and produced the assistant message: 1000 input,
    // 200 output. `anchorSeq` is the assistant message (seq 3).
    usage(5, 1000, 200),
    toolFinished(6, 'x'.repeat(400)),
  ]);
  const now = contextUsage(state);
  assert.equal(now.measured, 1000 + 200 + estimateMessage({ role: 'tool', callId: 'call_6', ok: true, output: 'x'.repeat(400), attachments: [] }));
  assert.equal(now.estimated, estimateMessages(state.messages));
  assert.equal(now.total, Math.max(now.estimated, now.measured));
});

test('the larger reading wins, whichever side it comes from', () => {
  // A tiny report next to a huge history: the local estimate must win.
  const state = replayOf([
    header(),
    turnOpened(2, 'a'.repeat(4000)),
    modelMessage(3, 'ok'),
    usage(4, 1),
  ]);
  assert.equal(contextUsage(state).total, contextUsage(state).estimated);

  // A huge report next to a small history: the anchor must win.
  const reported = replayOf([header(), turnOpened(2, 'a'), modelMessage(3, 'ok'), usage(4, 900_000)]);
  assert.equal(contextUsage(reported).total, 900_000);
});

test('a compaction replaces the head and keeps the tail verbatim', () => {
  const state = replayOf([
    header(),
    turnOpened(2, 'first'),
    modelMessage(3, 'answer one'),
    toolFinished(4, 'tool output'),
    compacted(5, 3, [2, 3], 'summary of the first exchange'),
  ]);
  assert.deepEqual(state.messages[0], { role: 'user', text: 'summary of the first exchange' });
  assert.equal(state.messages.length, 2, 'the summary plus the message after the watermark');
  assert.deepEqual(state.messages[1], {
    role: 'tool',
    callId: 'call_4',
    ok: true,
    output: 'tool output',
    attachments: [],
  });
  assert.deepEqual(state.messageSeqs, [5, 4], 'the summary carries the compaction event seq; the tail keeps its own');
});

test('a later turn appends to the compacted history, and replay is deterministic', () => {
  const events: KernelEvent[] = [
    header(),
    turnOpened(2, 'first'),
    modelMessage(3, 'answer one'),
    compacted(4, 3, [2, 3], 'summary'),
    turnOpened(5, 'second'),
  ];
  const once = replayOf(events);
  const twice = replayOf(events);
  assert.deepEqual(once, twice);
  assert.deepEqual(
    once.messages.map((message) => message.role),
    ['user', 'user'],
    'summary then the new user message',
  );
  assert.equal(once.messageSeqs.length, once.messages.length);
  assert.deepEqual(once.messageSeqs, [4, 5]);
});

test('a second compaction can shadow the first summary', () => {
  const state = replayOf([
    header(),
    turnOpened(2, 'first'),
    modelMessage(3, 'answer one'),
    compacted(4, 3, [2, 3], 'summary one'),
    turnOpened(5, 'second'),
    modelMessage(6, 'answer two'),
    compacted(7, 6, [4, 5, 6], 'summary two'),
  ]);
  assert.deepEqual(state.messages, [{ role: 'user', text: 'summary two' }]);
  assert.deepEqual(state.messageSeqs, [7]);
});

test('a compaction clears the usage anchor, because the messages it counted are gone', () => {
  const state = replayOf([
    header(),
    turnOpened(2, 'hello'),
    modelMessage(3, 'hi'),
    usage(4, 5000),
    compacted(5, 3, [2, 3], 'summary'),
  ]);
  assert.equal(state.lastUsage, null);
  assert.equal(contextUsage(state).measured, 0);
});

test('the anchor points at the assistant message the report belongs to', () => {
  const state = replayOf([header(), turnOpened(2, 'hello'), modelMessage(3, 'hi'), usage(4, 100)]);
  assert.deepEqual(state.lastUsage, { tokens: 100, anchorSeq: 3 });
});
