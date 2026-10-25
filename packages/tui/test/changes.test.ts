import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WireEvent } from '@corescense/cowcat-protocol';
import { changedFiles } from '../src/app/changes.js';
import { findCommand } from '../src/app/commands.js';
import { project } from '../src/app/project.js';
import { initialView, type TuiView } from '../src/app/view.js';
import { frameOf } from '../src/components/session-frame.js';

let seq = 0;
function event(type: string, body: Record<string, unknown> = {}): WireEvent {
  seq += 1;
  return { seq, ts: 1_000, sessionId: 'sess_changes', turnId: 'turn_1', type, ...body };
}

function viewOf(events: readonly WireEvent[]): TuiView {
  return events.reduce((view, item) => project(view, item), initialView());
}

function call(callId: string, name: string, input: unknown): WireEvent {
  return event('model.message', { text: '', toolCalls: [{ callId, name, input }], reasoning: [], stopReason: null });
}

function finished(callId: string, name: string, path: string, ok = true): WireEvent {
  return event('tool.finished', { callId, name, ok, output: ok ? `updated ${path}` : 'failed', facts: null, truncation: null, attachments: null, path });
}

test('changed files are derived from successful Write/Edit entries and deduplicated', () => {
  seq = 0;
  const view = viewOf([
    call('c1', 'Edit', { file_path: '/work/a.ts', old_string: 'a\nb\n', new_string: 'a\nc\nd\n' }),
    finished('c1', 'Edit', '/work/a.ts'),
    call('c2', 'Write', { file_path: '/work/b.txt', content: 'one\ntwo\n' }),
    finished('c2', 'Write', '/work/b.txt'),
    call('c3', 'Write', { file_path: '/work/c.txt', content: 'not written' }),
    finished('c3', 'Write', '/work/c.txt', false),
    call('c4', 'Edit', { file_path: '/work/a.ts', old_string: 'x\n', new_string: 'y\n' }),
    finished('c4', 'Edit', '/work/a.ts'),
  ]);
  // Write carries `written` (new-content line count), never a fabricated
  // `added` count — there are no before bytes to diff against (ADR-149 ④).
  assert.deepEqual(changedFiles(view), [
    { path: '/work/a.ts', operations: ['Edit'], added: 3, removed: 2, written: 0 },
    { path: '/work/b.txt', operations: ['Write'], added: 0, removed: 0, written: 2 },
  ]);
});

test('/changes toggles a dock panel with paths and change statistics', () => {
  seq = 0;
  let view = viewOf([
    call('c1', 'Write', { file_path: '/work/b.txt', content: 'one\ntwo\n' }),
    finished('c1', 'Write', '/work/b.txt'),
  ]);
  const command = findCommand('changes');
  assert.ok(command !== undefined);
  const effect = command.run(view);
  assert.equal(effect.kind, 'view');
  view = effect.view;
  assert.equal(view.changesVisible, true);
  const dock = frameOf(view, { width: 64, now: 0 }).dock ?? [];
  const text = dock.map((row) => row.text).join('\n');
  assert.match(text, /变更文件/);
  assert.match(text, /\/work\/b\.txt/);
  assert.match(text, /写入 2 行/);
  // A Write has no before bytes, so the panel must not fabricate a diffstat (ADR-149 ④).
  assert.doesNotMatch(text, /\+2 -0/);
});

test('a Write card shows a new-content preview, not a fabricated before/after diff', () => {
  seq = 0;
  const view = viewOf([
    call('c1', 'Write', { file_path: '/work/new.ts', content: 'const a = 1;\nconst b = 2;\n' }),
    finished('c1', 'Write', '/work/new.ts'),
  ]);
  const frame = frameOf(view, { width: 72, now: 0 });
  const text = frame.body.map((row) => row.text).join('\n');
  assert.match(text, /Write ok — \/work\/new\.ts/);
  assert.match(text, /写入 2 行/);
  assert.match(text, /写入内容预览/);
  assert.match(text, /const a = 1;/);
  assert.match(text, /const b = 2;/);
  assert.doesNotMatch(text, /\+2 -0/);
});
