import type { AttachmentView, Entry, ToolCallView, TuiView } from '../app/view.js';
import { graphemes, stringWidth } from '../text/width.js';
import type { TranscriptLines } from './transcript.js';

export type EntryRenderer = (entry: Entry, view: TuiView, width: number) => TranscriptLines;

interface CachedEntry {
  readonly width: number;
  readonly thinkingExpanded: boolean;
  readonly expanded: boolean;
  readonly call: ToolCallView | undefined;
  readonly attachments: readonly (AttachmentView | undefined)[];
  readonly part: TranscriptLines;
}

export function createEntryCache(render: EntryRenderer): EntryRenderer {
  const cache = new WeakMap<Entry, CachedEntry>();

  return (entry, view, width) => {
    const thinkingExpanded = entry.kind === 'assistant' && view.thinkingExpanded;
    const expanded = entry.kind === 'tool' && view.expanded.includes(entry.callId);
    const call = entry.kind === 'tool' ? view.calls[entry.callId] : undefined;
    const attachments = entry.kind === 'tool' ? entry.attachments.map((path) => view.attachments[path]) : [];
    const cached = cache.get(entry);
    if (
      cached !== undefined &&
      cached.width === width &&
      cached.thinkingExpanded === thinkingExpanded &&
      cached.expanded === expanded &&
      cached.call === call &&
      sameAttachments(cached.attachments, attachments)
    ) {
      return cached.part;
    }

    const part = render(entry, view, width);
    cache.set(entry, { width, thinkingExpanded, expanded, call, attachments, part });
    return part;
  };
}

function sameAttachments(
  left: readonly (AttachmentView | undefined)[],
  right: readonly (AttachmentView | undefined)[],
): boolean {
  return left.length === right.length && left.every((attachment, index) => attachment === right[index]);
}

export function tailForRows(text: string, width: number, rows: number): string {
  const budget = Math.max(256, width * rows * 2);
  const clusters = graphemes(text);
  if (clusters.length <= budget) return text;
  const suffix = clusters.slice(-budget).join('');
  // A cut changes where greedy wrapping sees spaces and line boundaries. It is safe only
  // when it also starts on an original display-width boundary; otherwise keep the full wrap.
  if (/\s/.test(suffix)) return text;
  return stringWidth(text) % width === stringWidth(suffix) % width ? suffix : text;
}
