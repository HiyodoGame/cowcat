import { copyFor } from '../app/copy.js';
import type { AttachmentView, TranscriptToolEntry, TuiView } from '../app/view.js';
import { imageBox } from '../image/layout.js';
import { card, type CardBodyLine } from '../ui/card.js';
import type { Line } from '../ui/line.js';
import type { ImageSlot } from '../ui/screen.js';
import { unifiedDiff, foldItems, type UnifiedItem } from '../text/diff.js';
import { truncate } from '../text/width.js';
import { wrap } from '../text/wrap.js';

/**
 * The task card: what the agent did, whether it worked, and enough of the result to judge it.
 *
 * The brand guide's rules for it (§4.2) are all visible here: the output is FOLDED by default
 * with the last three lines and an exit status, the diff of an edit is what the card shows
 * when it has one, and everything is reachable again with one key rather than lost.
 *
 * The diff is possible at all because the REQUEST is in the log: `Edit`'s `old_string` and
 * `new_string` never appear in `tool.finished`, so the view keeps the model's tool calls by
 * id (`TuiView.calls`) and this card joins the two. That is the one place the frontend needs
 * more than the result, and it is the log's own data — not a re-derivation of it.
 *
 * An attachment becomes a hole in the text plus an `ImageSlot` (T9): the layout is decided
 * here, the pixels are the screen's business.
 */

/** Lines folded into a diff card before it stops being a card and becomes a file. */
const DIFF_FOLDED_LINES = 8;
const DIFF_EXPANDED_LINES = 40;
/** The brand guide: a terminal card shows the exit status and the last three lines. */
export const TOOL_OUTPUT_TAIL = 3;
const OUTPUT_EXPANDED_LINES = 60;
/** How tall an inline image may be before it stops being inline. */
const IMAGE_MAX_ROWS = 12;

export function toolCardLines(
  entry: TranscriptToolEntry,
  view: TuiView,
  width: number,
): { readonly lines: readonly Line[]; readonly images: readonly ImageSlot[] } {  const expanded = view.expanded.includes(entry.callId);
  const diff = editOf(view.calls[entry.callId]?.input);
  const status = entry.ok ? 'ok' : '失败';
  const where = entry.path === null ? '' : ` — ${entry.path}`;

  const suffix = diff === null ? (expanded ? '[收起]' : '[展开]') : `+${String(diff.added)} -${String(diff.removed)}`;
  const title = `⏺ ${entry.name} ${status}${where}`;
  const body: CardBodyLine[] = [];
  const images: ImageSlot[] = [];

  for (const path of entry.attachments) {
    const attachment = view.attachments[path];
    if (attachment === undefined) continue;
    const label = describeAttachment(attachment);
    if (attachment.status === 'ready' && attachment.bytes !== null) {
      const box = imageBox({
        cols: width - 4,
        maxRows: IMAGE_MAX_ROWS,
        width: attachment.width,
        height: attachment.height,
      });
      // The header names what it is even when the picture cannot be drawn: a terminal with no
      // image protocol must still say "there was a PNG here, 320×200".
      body.push({ text: `${copyFor('zh').image} ${label}`, token: 'textDim' });
      // `card()` draws one row of border above the body, so body row `b` is line `b + 1`.
      const row = body.length + 1;
      for (let index = 0; index < box.rows; index += 1) body.push({ text: '', token: 'text' });
      // Column 2: the card's `│ ` frame is two cells before its content.
      images.push({ row, left: 2, cols: box.cols, rows: box.rows, source: attachment.bytes, label });
    } else if (attachment.status === 'failed') {
      body.push({ text: `${copyFor('zh').image} ${label} — 取不到：${attachment.reason ?? '未知原因'}`, token: 'notice' });
    } else {
      body.push({ text: `${copyFor('zh').image} ${label} — 正在取字节…`, token: 'textDim' });
    }
  }
  if (entry.truncation !== null) body.push({ text: entry.truncation, token: 'textDim' });

  if (diff !== null) {
    body.push(...diffLines(diff.items, width - 4, expanded ? DIFF_EXPANDED_LINES : DIFF_FOLDED_LINES));
  } else if (entry.output !== '') {
    body.push(...outputLines(entry.output, width - 4, expanded));
  }

  return {
    lines: card({
      title: truncate(title, Math.max(8, width - 4 - suffix.length - 2)),
      titleToken: entry.ok ? 'tool' : 'alert',
      ...(suffix === '' ? {} : { suffix }),
      body,
      width,
    }),
    images,
  };
}

/** `image/png 320×200`, or the part of it that is known. */
function describeAttachment(attachment: AttachmentView): string {
  const size =
    attachment.width === null || attachment.height === null
      ? ''
      : ` ${String(attachment.width)}×${String(attachment.height)}`;
  const pages = attachment.pages === null ? '' : ` · ${String(attachment.pages)} 页`;
  return `${attachment.mediaType}${size}${pages}`;
}

/** The `Edit`/`Write` input, if that is what this call was. */
function editOf(input: unknown): { readonly added: number; readonly removed: number; readonly items: readonly UnifiedItem[] } | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const before = typeof record['old_string'] === 'string' ? record['old_string'] : null;
  const after = typeof record['new_string'] === 'string' ? record['new_string'] : null;
  if (before === null || after === null) return null;
  const diff = unifiedDiff(before, after);
  return { added: diff.added, removed: diff.removed, items: diff.items };
}

function diffLines(items: readonly UnifiedItem[], inner: number, budget: number): readonly CardBodyLine[] {
  const folded = foldItems(items, budget);
  return folded.items.map((item) => {
    if (item.kind === 'hunk') return { text: item.header, token: 'textDim' as const };
    const gutter = item.sign === ' ' ? '  ' : `${item.sign} `;
    const number = item.newNo ?? item.oldNo ?? 0;
    const token = item.sign === '+' ? ('brand' as const) : item.sign === '-' ? ('alert' as const) : ('textDim' as const);
    return { text: `${String(number).padStart(3)} ${gutter}${item.text}`.slice(0, Math.max(0, inner)), token };
  });
}

function outputLines(output: string, inner: number, expanded: boolean): readonly CardBodyLine[] {
  const rows = output.split('\n').filter((row) => row !== '');
  const wrapped = rows.flatMap((row) => wrap(row, inner));
  const budget = expanded ? OUTPUT_EXPANDED_LINES : TOOL_OUTPUT_TAIL;
  const kept = wrapped.slice(-budget);
  const hidden = wrapped.length - kept.length;
  const lines: CardBodyLine[] = kept.map((row) => ({ text: `  ${row}`, token: 'tool' as const }));
  if (hidden > 0) lines.unshift({ text: `… 上面还有 ${String(hidden)} 行（Ctrl-O 展开）`, token: 'textDim' });
  return lines;
}

const RUNNING = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/**
 * The one line that identifies a call before its result exists.
 *
 * A Bash call can run for a minute; before this, nothing appeared until it finished, so a
 * long command looked like a hang. The frame is a function of `now`, which keeps snapshots
 * deterministic.
 */
export function callSummary(input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>;
    const command = record['command'];
    if (typeof command === 'string' && command !== '') return command;
    const path = record['file_path'] ?? record['path'] ?? record['pattern'];
    if (typeof path === 'string' && path !== '') return path;
  }
  const text = JSON.stringify(input ?? {});
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export function runningToolLines(name: string, summary: string, width: number, now: number): readonly Line[] {
  const frame = RUNNING[Math.floor(now / 100) % RUNNING.length] ?? '·';
  return card({
    title: `${frame} ${name}`,
    titleToken: 'plan',
    suffix: '[运行中]',
    body: [{ text: truncate(summary, Math.max(8, width - 6)), token: 'textDim' }],
    width,
  });
}
