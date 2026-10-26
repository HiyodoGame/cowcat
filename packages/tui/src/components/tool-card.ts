import { copyFor } from '../app/copy.js';
import { lineCount } from '../app/changes.js';
import type { AttachmentView, ToolTail, TranscriptToolEntry, TuiView } from '../app/view.js';
import { imageBox } from '../image/layout.js';
import type { Line, LineRun } from '../ui/line.js';
import { runLine } from '../ui/line.js';
import type { ImageSlot } from '../ui/screen.js';
import { unifiedDiff, foldItems, type UnifiedItem } from '../text/diff.js';
import { truncate } from '../text/width.js';
import { wrap } from '../text/wrap.js';

/**
 * The task card: what the agent did, whether it worked, and enough of the result to judge it.
 *
 * The brand guide's rules (§4.2) are all visible here: the output is FOLDED by default with
 * the last three lines and an exit status, the diff of an edit is what the card shows when it
 * has one, and everything is reachable again with one key rather than lost.
 *
 * The card's language is the BAR (ADR-164): one coloured gutter row — brand when ok, alert
 * when not — with the action, the status and the count on it, and the body indented under it.
 * Full `┄` frames around every action made the transcript read as boxes, not as work.
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

/** Indent the body of a bar-card: content sits under the action, two cells in. */
function indented(rows: readonly Line[]): readonly Line[] {
  return rows.map((row) => runLine('  ', row.runs ?? [{ text: row.text, token: row.token, ...(row.bold ? { bold: true } : {}) }], ''));
}

function asLine(text: string, token: LineRun['token'], bold = false): Line {
  return { text, token, bold };
}

export function toolCardLines(
  entry: TranscriptToolEntry,
  view: TuiView,
  width: number,
): { readonly lines: readonly Line[]; readonly images: readonly ImageSlot[] } {
  const expanded = view.expanded.includes(entry.callId);
  const diff = editOf(view.calls[entry.callId]?.input);
  const write = diff === null ? writeOf(view.calls[entry.callId]?.input) : null;
  const status = entry.ok ? 'ok' : '失败';
  const where = entry.path === null ? '' : ` — ${entry.path}`;

  const tail = diff !== null
    ? `+${String(diff.added)} -${String(diff.removed)}`
    : write !== null
      ? `写入 ${String(lineCount(write))} 行`
      : expanded
        ? '收起'
        : '展开';

  const body: Line[] = [];
  const images: ImageSlot[] = [];

  body.push(runLine('', [
    { text: '▌', token: entry.ok ? 'brand' : 'alert' },
    { text: ` ${entry.name} `, token: 'text', bold: true },
    { text: status, token: entry.ok ? 'textDim' : 'alert' },
    ...(where === '' ? [] : [{ text: where, token: 'textDim' } satisfies LineRun]),
    ...(tail === '' ? [] : [{ text: `  ${tail}`, token: 'textDim' } satisfies LineRun]),
  ], ''));

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
      body.push(asLine(`  ${copyFor('zh').image} ${label}`, 'textDim'));
      const row = body.length;
      for (let index = 0; index < box.rows; index += 1) body.push(asLine('', 'text'));
      images.push({ row, left: 2, cols: box.cols, rows: box.rows, source: attachment.bytes, label });
    } else if (attachment.status === 'failed') {
      // No card() to truncate for us any more: an untrusted reason is the one string here
      // that can be arbitrarily long, and the bar-card invariant (no row over the page)
      // is what keeps it from blowing out the layout.
      body.push(asLine(`  ${truncate(`${copyFor('zh').image} ${label} — 取不到：${attachment.reason ?? '未知原因'}`, Math.max(8, width - 2))}`, 'notice'));
    } else {
      body.push(asLine(`  ${copyFor('zh').image} ${label} — 正在取字节…`, 'textDim'));
    }
  }
  if (entry.truncation !== null) body.push(asLine(`  ${truncate(entry.truncation, Math.max(8, width - 2))}`, 'textDim'));

  if (diff !== null) {
    body.push(...indented(diffLines(diff.items, width - 4, expanded ? DIFF_EXPANDED_LINES : DIFF_FOLDED_LINES)));
  } else if (write !== null) {
    body.push(asLine('  写入内容预览（仅新内容，不是覆写前 diff）', 'textDim'));
    body.push(...indented(writePreviewLines(write, width - 4, expanded)));
  } else if (entry.output !== '') {
    body.push(...indented(outputLines(entry.output, width - 4, expanded)));
  }

  return { lines: body, images };
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

function writeOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  return typeof record['file_path'] === 'string' && typeof record['content'] === 'string' ? record['content'] : null;
}

function writePreviewLines(content: string, inner: number, expanded: boolean): readonly Line[] {
  const rows = content.split('\n');
  if (content.endsWith('\n')) rows.pop();
  const wrapped = rows.flatMap((row) => wrap(row, Math.max(1, inner - 2)));
  const budget = expanded ? DIFF_EXPANDED_LINES : DIFF_FOLDED_LINES;
  const kept = wrapped.slice(0, budget);
  const lines: Line[] = kept.map((row) => asLine(`+ ${row}`, 'brand'));
  const hidden = wrapped.length - kept.length;
  if (hidden > 0) lines.push(asLine(`… 下面还有 ${String(hidden)} 行（Ctrl-O 展开）`, 'textDim'));
  return lines;
}

function diffLines(items: readonly UnifiedItem[], inner: number, budget: number): readonly Line[] {
  const folded = foldItems(items, budget);
  return folded.items.map((item) => {
    if (item.kind === 'hunk') return asLine(item.header, 'textDim');
    const gutter = item.sign === ' ' ? '  ' : `${item.sign} `;
    const number = item.newNo ?? item.oldNo ?? 0;
    const token: LineRun['token'] = item.sign === '+' ? 'brand' : item.sign === '-' ? 'alert' : 'textDim';
    return asLine(`${String(number).padStart(3)} ${gutter}${item.text}`.slice(0, Math.max(0, inner)), token);
  });
}

function outputLines(output: string, inner: number, expanded: boolean): readonly Line[] {
  const rows = output.split('\n').filter((row) => row !== '');
  // The two-space prefix is part of the row: wrapping at `inner` first made every full row
  // two cells too wide, and `padTo` ate them (plus an ellipsis) instead of the card growing.
  const wrapped = rows.flatMap((row) => wrap(row, Math.max(1, inner - 2)));
  const budget = expanded ? OUTPUT_EXPANDED_LINES : TOOL_OUTPUT_TAIL;
  const kept = wrapped.slice(-budget);
  const hidden = wrapped.length - kept.length;
  // Terminal output is terminal text: the default voice; dim is for the fold hint only.
  const lines: Line[] = kept.map((row) => asLine(`  ${row}`, 'text'));
  if (hidden > 0) lines.unshift(asLine(`… 上面还有 ${String(hidden)} 行（Ctrl-O 展开）`, 'textDim'));
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

export function runningToolLines(
  name: string,
  summary: string,
  width: number,
  now: number,
  tail?: ToolTail,
): readonly Line[] {
  const frame = RUNNING[Math.floor(now / 100) % RUNNING.length] ?? '·';
  const inner = Math.max(8, width - 4);
  const rows: Line[] = [
    runLine('', [
      { text: '▌', token: 'plan' },
      { text: ` ${frame} ${name} `, token: 'text', bold: true },
      { text: '运行中', token: 'textDim' },
    ], ''),
    asLine(`  ${truncate(summary, inner)}`, 'textDim'),
  ];
  if (tail !== undefined && tail.text !== '') {
    rows.push(...indented(liveTailLines(tail, inner)));
  }
  return rows;
}

/** Rows a running card spends on live output. One `Line` per row, per ADR-100. */
const LIVE_TAIL_ROWS = 20;

/**
 * The tail of what a running command has printed (ADR-109).
 *
 * Wrapped here rather than by the renderer: a card row is one `Line` and must stay one row,
 * or the transcript's scroll arithmetic starts lying (ADR-100). The budget is display only —
 * the durable output keeps its own cap in the kernel.
 */
function liveTailLines(tail: ToolTail, inner: number): readonly Line[] {
  const rows = tail.text.split('\n').filter((row) => row !== '');
  const wrapped = rows.flatMap((row) => wrap(row, inner));
  const kept = wrapped.slice(-LIVE_TAIL_ROWS);
  const hidden = wrapped.length - kept.length;
  const lines: Line[] = kept.map((row) => asLine(row, 'text'));
  // A count is only honest when the cap did not already drop output the count cannot see.
  const hint = tail.truncated ? '… 只显示末尾输出' : hidden > 0 ? `… 上面还有 ${String(hidden)} 行` : null;
  if (hint !== null) lines.unshift(asLine(hint, 'textDim'));
  return lines;
}
