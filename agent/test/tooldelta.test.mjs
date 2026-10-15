// P2 tool-call process streaming: providers fire onToolDelta while streaming
// (per-chunk + completion) with an unchanged buffered aggregate, and the TUI
// renders a live pending card that is superseded by toolCall on execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { aggregateOpenAIStream } from '../src/llm/openai.js';
import { aggregateAnthropicStream } from '../src/llm/anthropic.js';
import { TuiUI } from '../src/tui/ui.js';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// --- openai aggregate ------------------------------------------------------------

const OPENAI_EVENTS = [
  {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0, id: 'call_1', function: { name: 'Bash', arguments: '{"command": "npm' },
        }],
      },
    }],
  },
  {
    choices: [{
      delta: {
        tool_calls: [{ index: 0, function: { arguments: ' run build"}' } }],
      },
    }],
  },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { input_tokens: 3, output_tokens: 7 } },
];

test('tooldelta: openai aggregate fires onToolDelta per chunk plus one completion, message unchanged', () => {
  const deltas = [];
  const out = aggregateOpenAIStream(OPENAI_EVENTS, null, null, (d) => deltas.push(d));
  // one incremental fire per chunk carrying tool_calls deltas
  assert.deepEqual(deltas.slice(0, 2), [
    { index: 0, id: 'call_1', name: 'Bash', argsDelta: '{"command": "npm' },
    { index: 0, id: undefined, name: undefined, argsDelta: ' run build"}' },
  ]);
  // exactly one completion signal per tool, after the event loop
  const dones = deltas.filter((d) => d.done);
  assert.equal(deltas.length, 3);
  assert.deepEqual(dones, [
    { index: 0, id: 'call_1', name: 'Bash', argsComplete: '{"command": "npm run build"}', done: true },
  ]);
  // buffered aggregate identical with and without the callback
  const baseline = aggregateOpenAIStream(OPENAI_EVENTS);
  assert.deepEqual(out, baseline);
  assert.deepEqual(out.content, [
    { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'npm run build' } },
  ]);
  assert.equal(out.stopReason, 'tool_calls');
});

// --- anthropic aggregate ----------------------------------------------------------

const ANTHROPIC_EVENTS = [
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'Bash' } },
  {
    type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"command": "ls' },
  },
  {
    type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json: ' -la"}' },
  },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
];

test('tooldelta: anthropic aggregate fires onToolDelta on block start, per json delta, and completion', () => {
  const deltas = [];
  const out = aggregateAnthropicStream(ANTHROPIC_EVENTS, null, (d) => deltas.push(d));
  assert.deepEqual(deltas, [
    { index: 0, id: 'tu_1', name: 'Bash', argsDelta: '' },
    { index: 0, id: 'tu_1', name: 'Bash', argsDelta: '{"command": "ls' },
    { index: 0, id: 'tu_1', name: 'Bash', argsDelta: ' -la"}' },
    { index: 0, id: 'tu_1', name: 'Bash', argsComplete: '{"command": "ls -la"}', done: true },
  ]);
  const baseline = aggregateAnthropicStream(ANTHROPIC_EVENTS);
  assert.deepEqual(out, baseline);
  assert.deepEqual(out.content, [
    { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls -la' } },
  ]);
});

// --- TUI pending card --------------------------------------------------------------

function headlessTui() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  const tui = new TuiUI({
    input, output, colors: true, version: '0.16.0', cwd: '/x',
    getModel: () => 'm', getMode: () => 'default', getCost: () => '',
    getConfig: () => ({ maxContextTokens: 100000 }), getMessages: () => [],
    capabilities: { colors: '256', altScreen: true, osc8: false },
  });
  tui.screen.enter = () => { tui.screen.active = true; };
  tui.screen.draw = () => {};
  tui.start();
  return tui;
}

test('tooldelta: TUI pending card grows with streamed args and is superseded in place by toolCall', () => {
  const tui = headlessTui();
  tui.toolCallDelta({ index: 0, id: 'call_1', name: 'Bash', argsDelta: '{"command": "npm' });
  const entry = tui.entries[tui.entries.length - 1];
  assert.equal(entry.kind, 'card');
  assert.equal(entry.card.status, 'running', 'forming card spins like an executing one');
  let flat = tui._flat().map(strip);
  assert.ok(flat.some((l) => l.includes('Ran a command') && l.includes('$ npm')), 'partial command visible');
  tui.toolCallDelta({ index: 0, argsDelta: ' run build"}' });
  flat = tui._flat().map(strip);
  assert.ok(flat.some((l) => l.includes('$ npm run build')), 'title grows with the args stream');
  assert.equal(tui.entries.length, 1, 'still a single card, updated in place');
  // formation completes; the loop then executes the call: toolCall supersedes
  // the pending card, reusing its region slot
  tui.toolCallDelta({ index: 0, id: 'call_1', name: 'Bash', argsComplete: '{"command": "npm run build"}', done: true });
  tui.toolCall('Bash', 'npm run build');
  assert.equal(tui.entries.length, 1, 'no second card');
  assert.equal(tui.entries[0], entry, 'same region entry, hands over seamlessly');
  assert.equal(tui._activeCard.status, 'running');
  tui.toolSuccess();
  assert.equal(entry.card.status, 'done');
  flat = tui._flat().map(strip);
  assert.ok(flat.some((l) => /✓ Ran a command/.test(l)), 'executed card resolved to done');
  tui.close();
});

test('tooldelta: done card carries a dim elapsed tag from the card start clock', () => {
  const tui = headlessTui();
  tui.toolCall('Bash', 'node -v');
  const entry = tui.entries[tui.entries.length - 1];
  entry.card.startedAt = Date.now() - 1500;
  tui.toolSuccess();
  const line = tui._flat().find((l) => strip(l).includes('1.5s'));
  assert.ok(line, 'elapsed seconds in the summary');
  assert.ok(line.includes(tui.theme.inactive), 'elapsed tag is dim');
  tui.close();
});

test('tooldelta: unfinished formation is dropped at endStream; leftovers swept on the next user message', () => {
  const tui = headlessTui();
  // cut off mid-args (max_tokens): never executes, quietly closed at endStream
  tui.toolCallDelta({ index: 0, name: 'Bash', argsDelta: '{"command": "interrupted' });
  assert.equal(tui.entries.filter((e) => e.kind === 'card').length, 1);
  tui.endStream();
  assert.equal(tui.entries.filter((e) => e.kind === 'card').length, 0, 'truncated formation removed');
  // a completed formation whose tool the loop never ran (denied / unknown):
  // survives its own turn, swept when the next turn starts
  tui.toolCallDelta({ index: 0, name: 'Read', argsDelta: '{"file_path": "/x"}' });
  tui.toolCallDelta({ index: 0, name: 'Read', argsComplete: '{"file_path": "/x"}', done: true });
  assert.equal(tui.entries.filter((e) => e.kind === 'card').length, 1);
  tui.userMessage('next turn');
  assert.equal(tui.entries.filter((e) => e.kind === 'card').length, 0, 'stale pending card swept');
  tui.close();
});
