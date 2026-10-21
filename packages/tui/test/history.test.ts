import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialView, rememberInput, withHistory, type TuiView } from '../src/app/view.js';

// The history is a pure part of the view (ADR-106), so these are the rules the arrow keys
// obey. Which key is *offered* to it — and whether the cursor is at an edge — is `run.ts`'
// business, because only the renderer knows where the cursor is.

function histories(...entries: string[]): TuiView {
  return entries.reduce(rememberInput, initialView());
}

test('sending records the prompt, and the next ↑ starts from the newest entry', () => {
  const view = histories('first', 'second');
  assert.deepEqual(view.history, ['first', 'second']);
  assert.equal(view.historyIndex, null);

  const older = withHistory({ ...view, input: 'draft' }, 'older');
  assert.equal(older.input, 'second');
  assert.equal(older.historyIndex, 1);
});

test('a consecutive duplicate is one entry, and empty input is none', () => {
  assert.deepEqual(histories('same', 'same').history, ['same']);
  assert.deepEqual(rememberInput(histories('one'), '').history, ['one']);
});

test('↑ walks older and clamps at the oldest entry', () => {
  let view = histories('one', 'two', 'three');
  view = withHistory(view, 'older');
  assert.equal(view.input, 'three');
  view = withHistory(view, 'older');
  assert.equal(view.input, 'two');
  view = withHistory(view, 'older');
  assert.equal(view.input, 'one');
  // At the oldest entry there is nothing to recall, which the caller reads as "the arrow
  // still belongs to the cursor".
  assert.equal(withHistory(view, 'older'), view);
});

test('↓ walks back and restores the draft past the newest entry', () => {
  let view: TuiView = { ...histories('one', 'two'), input: 'half-written' };
  view = withHistory(view, 'older');
  assert.equal(view.input, 'two');
  view = withHistory(view, 'older');
  assert.equal(view.input, 'one');
  view = withHistory(view, 'newer');
  assert.equal(view.input, 'two');
  view = withHistory(view, 'newer');
  assert.equal(view.input, 'half-written');
  assert.equal(view.historyIndex, null);
  assert.equal(withHistory(view, 'newer'), view);
});

test('sending ends browsing, so the next ↑ does not resume the old position', () => {
  const browsing = withHistory({ ...histories('one'), input: 'draft' }, 'older');
  const after = rememberInput(browsing, 'two');
  assert.equal(after.historyIndex, null);
  assert.equal(after.historyDraft, '');
  assert.deepEqual(after.history, ['one', 'two']);
});

test('the history is bounded and keeps the newest entries', () => {
  const view = Array.from({ length: 120 }, (_, index) => `p${String(index)}`).reduce(
    rememberInput,
    initialView(),
  );
  assert.equal(view.history.length, 100);
  assert.equal(view.history.at(0), 'p20');
  assert.equal(view.history.at(-1), 'p119');
});

test('with no history the arrows stay with the cursor', () => {
  const view = initialView();
  assert.equal(withHistory(view, 'older'), view);
  assert.equal(withHistory(view, 'newer'), view);
});

test('an empty draft survives the round trip', () => {
  let view: TuiView = histories('only');
  view = withHistory(view, 'older');
  assert.equal(view.input, 'only');
  view = withHistory(view, 'newer');
  assert.equal(view.input, '');
  assert.equal(view.historyIndex, null);
});

test('editing a recalled entry does not rewrite the draft (bash behaviour)', () => {
  let view: TuiView = { ...histories('one'), input: 'draft' };
  view = withHistory(view, 'older');
  // The person starts editing the recalled line instead of sending it.
  view = { ...view, input: 'one, edited' };
  view = withHistory(view, 'newer');
  // ↓ past the newest entry restores the draft that was saved on the way in, not the edit:
  // the edit belonged to a recalled entry and was never sent, so it is not history.
  assert.equal(view.input, 'draft');
  assert.equal(view.historyIndex, null);
});
