import { unifiedDiff } from '../text/diff.js';
import type { TuiView } from './view.js';

export interface ChangedFile {
  readonly path: string;
  readonly operations: readonly ('Edit' | 'Write')[];
  readonly added: number;
  readonly removed: number;
  readonly written: number;
}

export function changedFiles(view: TuiView): readonly ChangedFile[] {
  const files = new Map<string, { path: string; operations: ('Edit' | 'Write')[]; added: number; removed: number; written: number }>();
  for (const entry of view.entries) {
    if (entry.kind !== 'tool' || !entry.ok || entry.path === null || (entry.name !== 'Edit' && entry.name !== 'Write')) continue;
    const name = entry.name;
    const input = view.calls[entry.callId]?.input;
    const current = files.get(entry.path) ?? { path: entry.path, operations: [], added: 0, removed: 0, written: 0 };
    if (!current.operations.includes(name)) current.operations.push(name);
    if (name === 'Edit') {
      const before = recordString(input, 'old_string');
      const after = recordString(input, 'new_string');
      if (before !== null && after !== null) {
        const diff = unifiedDiff(before, after);
        current.added += diff.added;
        current.removed += diff.removed;
      }
    } else {
      const content = recordString(input, 'content');
      if (content !== null) current.written += lineCount(content);
    }
    files.set(entry.path, current);
  }
  return [...files.values()];
}

export function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function recordString(input: unknown, key: string): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}
