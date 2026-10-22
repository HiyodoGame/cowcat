import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_CLEARING_KEEP_LAST,
  clearedToolPlaceholder,
  clearedToolView,
  clearingSummary,
  runTurn,
  Session,
  type Attachment,
  type Message,
  type ModelChunk,
} from '../src/index.js';
import { MemoryEventStore, ScriptedModel, sessionDeps, tool, turnDeps } from './support.js';

/**
 * ADR-118: old tool results travel as deterministic placeholders; the newest
 * {@link TOOL_CLEARING_KEEP_LAST} results stay whole. The log itself is never touched —
 * these tests pin the view only.
 */

const user = (text: string): Message => ({ role: 'user', text });
const assistant = (callId: string): Message => ({
  role: 'assistant',
  text: '',
  toolCalls: [{ callId, name: 'Bash', input: { command: 'x' } }],
  reasoning: [],
});
const toolMessage = (callId: string, output: string): Message => ({
  role: 'tool',
  callId,
  ok: true,
  output,
  attachments: [],
});

test('with at most the kept window of tool results, the view is the input itself', () => {
  const messages: Message[] = [user('go'), assistant('c1'), toolMessage('c1', 'one')];
  assert.equal(clearedToolView(messages), messages, 'no clearing, no copy');
  const two: Message[] = [user('go'), assistant('c1'), toolMessage('c1', 'one'), assistant('c2'), toolMessage('c2', 'two')];
  assert.equal(clearedToolView(two), two);
});

test('older tool results become placeholders, the window stays whole', () => {
  const messages: Message[] = [
    user('go'),
    assistant('c1'),
    toolMessage('c1', 'first'),
    assistant('c2'),
    toolMessage('c2', 'second'),
    assistant('c3'),
    toolMessage('c3', 'third'),
  ];
  const view = clearedToolView(messages);
  assert.equal(view.length, messages.length);
  // The assistant messages are never modified: wire pairing needs the calls (ADR-118 ②).
  assert.deepEqual(view[1], messages[1]);
  assert.deepEqual(view[3], messages[3]);
  assert.deepEqual(view[5], messages[5]);
  // The two newest results survive; the oldest is replaced by a placeholder.
  assert.deepEqual(view[2], { role: 'tool', callId: 'c1', ok: true, output: clearedToolPlaceholder('first'), attachments: [] });
  assert.equal(view[4], messages[4]);
  assert.equal(view[6], messages[6]);
  // And the log is untouched.
  assert.equal(messages[2]?.role === 'tool' && messages[2].output, 'first');
});

test('the placeholder counts UTF-8 bytes, not characters', () => {
  const chinese = '技能'.repeat(10); // 60 bytes, 20 characters
  assert.equal(clearedToolPlaceholder(chinese), '[已清除 60 字节]');
  assert.equal(clearedToolPlaceholder(''), '[已清除 0 字节]');
});

test('the view is deterministic across runs', () => {
  const messages: Message[] = [
    user('go'),
    assistant('c1'),
    toolMessage('c1', 'x'.repeat(10_000)),
    assistant('c2'),
    toolMessage('c2', 'y'.repeat(20_000)),
    assistant('c3'),
    toolMessage('c3', 'z'.repeat(30_000)),
  ];
  assert.deepEqual(clearedToolView(messages), clearedToolView(messages));
});

test('a compaction-shaped history folds cleanly: the summary is a user message, never cleared', () => {
  const summary: Message = { role: 'user', text: '<summary>earlier work</summary>' };
  const messages: Message[] = [
    summary,
    assistant('c9'),
    toolMessage('c9', 'a'.repeat(100)),
    assistant('c10'),
    toolMessage('c10', 'b'.repeat(100)),
    assistant('c11'),
    toolMessage('c11', 'c'.repeat(100)),
  ];
  const view = clearedToolView(messages);
  assert.equal(view[0], summary);
  assert.equal(view[2]?.role === 'tool' && view[2].output, clearedToolPlaceholder('a'.repeat(100)));
  assert.equal(view[4]?.role === 'tool' && view[4].output, 'b'.repeat(100));
});

test('attachments of a cleared result stop traveling, said out loud in the placeholder', () => {
  const attachment: Attachment = { type: 'image', mediaType: 'image/png', path: '/tmp/a.png', bytes: 100, width: null, height: null, pages: null };
  const messages: Message[] = [
    user('go'),
    assistant('c1'),
    { role: 'tool', callId: 'c1', ok: true, output: 'img', attachments: [attachment] },
    assistant('c2'),
    toolMessage('c2', 'keep'),
    assistant('c3'),
    toolMessage('c3', 'keep too'),
  ];
  const view = clearedToolView(messages);
  const cleared = view[2];
  assert.ok(cleared?.role === 'tool');
  assert.equal(cleared.output, '[已清除 3 字节]（另有 1 个附件不再随请求发送）');
  assert.deepEqual(cleared.attachments, []);
  // The log still carries everything.
  const logged = messages[2];
  assert.ok(logged?.role === 'tool');
  assert.equal(logged.attachments.length, 1);
});

test('clearingSummary reports how many results the view dropped', () => {
  assert.deepEqual(clearingSummary([]), { cleared: 0 });
  assert.deepEqual(clearingSummary([assistant('c1'), toolMessage('c1', 'x')]), { cleared: 0 });
  assert.deepEqual(
    clearingSummary([assistant('c1'), toolMessage('c1', 'x'), assistant('c2'), toolMessage('c2', 'y'), assistant('c3'), toolMessage('c3', 'z')]),
    { cleared: 1 },
  );
});

test('the kept window is the ADR value', () => {
  assert.equal(TOOL_CLEARING_KEEP_LAST, 2);
});

test('on the wire, old results travel as placeholders while the log keeps them whole (ADR-118 ①)', async () => {
  const probe = tool({ name: 'Probe', description: 'probe', risk: 'read' }, () => ({
    ok: true,
    output: 'x'.repeat(1_000),
  }));
  const script: (readonly ModelChunk[])[] = [1, 2, 3, 4].map((n) => [
    { type: 'tool_call' as const, call: { callId: `c${String(n)}`, name: 'Probe', input: { n } } },
  ]);
  script.push([{ type: 'text' as const, text: 'done' }]);

  const store = new MemoryEventStore();
  const session = await Session.create(sessionDeps(store), 'sess_clearing_wire');
  const model = new ScriptedModel(script);
  const deps = turnDeps(session, model, { tools: new Map([[probe.spec.name, probe]]) });
  const outcome = await runTurn(deps, 'go', new AbortController().signal);
  assert.equal(outcome.state, 'completed');

  // The log (and so the state) is untouched: every result is whole.
  const logged = session.state.messages.filter((message) => message.role === 'tool');
  assert.equal(logged.length, 4);
  for (const message of logged) {
    assert.equal(toolOutputOf(message), 'x'.repeat(1_000));
  }

  // The last request sent placeholders for all but the newest two results.
  const request = model.requests.at(-1);
  assert.ok(request !== undefined);
  const sent = request.messages.filter((message) => message.role === 'tool');
  assert.equal(sent.length, 4);
  assert.equal(toolOutputOf(sent[0]), clearedToolPlaceholder('x'.repeat(1_000)));
  assert.equal(toolOutputOf(sent[1]), clearedToolPlaceholder('x'.repeat(1_000)));
  assert.equal(toolOutputOf(sent[2]), 'x'.repeat(1_000));
  assert.equal(toolOutputOf(sent[3]), 'x'.repeat(1_000));
});

function toolOutputOf(message: Message | undefined): string | undefined {
  return message !== undefined && message.role === 'tool' ? message.output : undefined;
}
