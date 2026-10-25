import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCommand, type CommandEffect } from '../src/app/commands.js';
import { initialView } from '../src/app/view.js';
import { latestAssistantText, osc52, sessionMarkdown } from '../src/app/workflow.js';
import { rankAtCandidates } from '../src/app/atcomplete.js';

function effectOf(name: string, rest = ''): CommandEffect {
  const command = findCommand(name);
  assert.ok(command !== undefined);
  return command.run(initialView(), rest);
}

test('resume, clear, copy and export are first-class command effects', () => {
  assert.deepEqual(effectOf('resume', 'sess_123'), { kind: 'resume', sessionId: 'sess_123' });
  assert.deepEqual(effectOf('resume'), { kind: 'sessions' });
  assert.deepEqual(effectOf('clear'), { kind: 'clear' });
  assert.deepEqual(effectOf('copy'), { kind: 'copy' });
  assert.deepEqual(effectOf('export'), { kind: 'export', path: null });
  assert.deepEqual(effectOf('export', 'out.md'), { kind: 'export', path: 'out.md' });
  assert.deepEqual(effectOf('undo'), { kind: 'undo' });
  assert.deepEqual(effectOf('redo'), { kind: 'redo' });
});

test('session markdown and copy use actual assistant content', () => {
  const view = {
    ...initialView(),
    sessionId: 'sess_demo',
    entries: [
      { kind: 'user' as const, seq: 1, text: 'hello' },
      { kind: 'assistant' as const, seq: 2, text: 'answer', calls: 0, reasoning: [], redactedThinking: 0 },
    ],
  };
  assert.equal(latestAssistantText(view), 'answer');
  const markdown = sessionMarkdown(view);
  assert.match(markdown, /sess_demo/);
  assert.match(markdown, /## 你/);
  assert.match(markdown, /## CowCat/);
  assert.match(markdown, /answer/);
  assert.equal(osc52('answer'), `]52;c;${Buffer.from('answer').toString('base64')}`);
});

test('@ candidates use fuzzy subsequence ranking with path awareness', () => {
  const ranked = rankAtCandidates('runts', ['packages/tui/src/run.ts', 'README.md', 'other/run.ts']);
  assert.equal(ranked[0], 'packages/tui/src/run.ts');
  assert.ok(ranked.includes('other/run.ts'));
  assert.equal(ranked.includes('README.md'), false);
});
