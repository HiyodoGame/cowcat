import { copyFor } from '../app/copy.js';
import { lineCount } from '../app/changes.js';
import type { AttachmentView, ToolTail, TranscriptToolEntry, TuiView } from '../app/view.js';
import { imageBox } from '../image/layout.js';
import type { Line, LineRun } from '../ui/line.js';
import { runLine } from '../ui/line.js';
import { unifiedDiff, foldItems, type UnifiedItem } from '../text/diff.js';
import { truncate } from '../text/width.js';
import { wrap } from '../text/wrap.js';
import { accentBlock, imageBlock, textBlock, type SceneNode } from '../ui/scene.js';

const DIFF_FOLDED_LINES = 8;
const DIFF_EXPANDED_LINES = 40;
export const TOOL_OUTPUT_TAIL = 3;
const OUTPUT_EXPANDED_LINES = 60;
const IMAGE_MAX_ROWS = 12;

function indented(rows: readonly Line[]): readonly Line[] {
  return rows.map((row) => runLine('  ', row.runs ?? [{ text: row.text, token: row.token, ...(row.bold ? { bold: true } : {}) }], ''));
}

function asLine(text: string, token: LineRun['token'], bold = false): Line {
  return { text, token, bold };
}

export function toolCard(entry: TranscriptToolEntry, view: TuiView, width: number): SceneNode {
  const expanded = view.expanded.includes(entry.callId);
  const diff = editOf(view.calls[entry.callId]?.input);
  const write = diff === null ? writeOf(view.calls[entry.callId]?.input) : null;
  const status = entry.ok ? '完成' : '失败';
  const where = entry.path === null ? '' : `  ${entry.path}`;
  const tail = diff !== null
    ? `+${String(diff.added)} -${String(diff.removed)}`
    : write !== null ? `写入 ${String(lineCount(write))} 行` : expanded ? '收起' : '展开';
  const children: SceneNode[] = [textBlock('summary', [runLine('', [
    { text: `${entry.name}  `, token: 'text', bold: true },
    { text: status, token: entry.ok ? 'textDim' : 'alert' },
    ...(where === '' ? [] : [{ text: where, token: 'textDim' } satisfies LineRun]),
    { text: `  ${tail}`, token: 'textDim' },
  ], '')])];
  const rows: Line[] = [];
  for (const path of entry.attachments) {
    const attachment = view.attachments[path];
    if (attachment === undefined) continue;
    const label = describeAttachment(attachment);
    if (attachment.status === 'ready' && attachment.bytes !== null) {
      const box = imageBox({ cols: width - 4, maxRows: IMAGE_MAX_ROWS, width: attachment.width, height: attachment.height });
      children.push(textBlock(`attachment-label-${path}`, [asLine(`  ${copyFor('zh').image} ${label}`, 'textDim')]));
      children.push(imageBlock(`attachment-${path}`, { ...box, source: attachment.bytes, label }));
    } else if (attachment.status === 'failed') {
      rows.push(asLine(`  ${truncate(`${copyFor('zh').image} ${label} - 取不到：${attachment.reason ?? '未知原因'}`, Math.max(8, width - 4))}`, 'notice'));
    } else {
      rows.push(asLine(`  ${copyFor('zh').image} ${label} - 正在取字节…`, 'textDim'));
    }
  }
  if (entry.truncation !== null) rows.push(asLine(`  ${truncate(entry.truncation, Math.max(8, width - 4))}`, 'textDim'));
  if (diff !== null) rows.push(...indented(diffLines(diff.items, width - 4, expanded ? DIFF_EXPANDED_LINES : DIFF_FOLDED_LINES)));
  else if (write !== null) {
    rows.push(asLine('  写入内容预览（仅新内容，不是覆写前 diff）', 'textDim'));
    rows.push(...indented(writePreviewLines(write, width - 4, expanded)));
  } else if (entry.output !== '') rows.push(...indented(outputLines(entry.output, width - 4, expanded)));
  children.push(textBlock('output', rows));
  return accentBlock(`tool-${entry.callId}`, entry.ok ? 'brand' : 'alert', children, `tool:${entry.callId}`);
}

function describeAttachment(attachment: AttachmentView): string {
  const size = attachment.width === null || attachment.height === null ? '' : ` ${String(attachment.width)}×${String(attachment.height)}`;
  const pages = attachment.pages === null ? '' : ` · ${String(attachment.pages)} 页`;
  return `${attachment.mediaType}${size}${pages}`;
}

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
  return foldItems(items, budget).items.map((item) => {
    if (item.kind === 'hunk') return asLine(item.header, 'textDim');
    const gutter = item.sign === ' ' ? '  ' : `${item.sign} `;
    const number = item.newNo ?? item.oldNo ?? 0;
    const token: LineRun['token'] = item.sign === '+' ? 'brand' : item.sign === '-' ? 'alert' : 'textDim';
    return asLine(`${String(number).padStart(3)} ${gutter}${item.text}`.slice(0, Math.max(0, inner)), token);
  });
}

function outputLines(output: string, inner: number, expanded: boolean): readonly Line[] {
  const rows = output.split('\n').filter((row) => row !== '');
  const wrapped = rows.flatMap((row) => wrap(row, Math.max(1, inner - 2)));
  const budget = expanded ? OUTPUT_EXPANDED_LINES : TOOL_OUTPUT_TAIL;
  const kept = wrapped.slice(-budget);
  const hidden = wrapped.length - kept.length;
  const lines: Line[] = kept.map((row) => asLine(`  ${row}`, 'text'));
  if (hidden > 0) lines.unshift(asLine(`… 上面还有 ${String(hidden)} 行（Ctrl-O 展开）`, 'textDim'));
  return lines;
}

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

export function runningToolCard(callId: string, name: string, summary: string, width: number, tail?: ToolTail): SceneNode {
  const inner = Math.max(8, width - 4);
  const rows: Line[] = [asLine(`  ${truncate(summary, inner)}`, 'textDim')];
  if (tail !== undefined && tail.text !== '') rows.push(...indented(liveTailLines(tail, inner)));
  return accentBlock(`running-${callId}`, 'plan', [
    textBlock('summary', [runLine('', [{ text: `${name}  `, token: 'text', bold: true }, { text: '运行中', token: 'plan' }], '')]),
    textBlock('output', rows),
  ], `tool:${callId}`);
}

const LIVE_TAIL_ROWS = 20;

function liveTailLines(tail: ToolTail, inner: number): readonly Line[] {
  const rows = tail.text.split('\n').filter((row) => row !== '');
  const wrapped = rows.flatMap((row) => wrap(row, inner));
  const kept = wrapped.slice(-LIVE_TAIL_ROWS);
  const hidden = wrapped.length - kept.length;
  const lines: Line[] = kept.map((row) => asLine(row, 'text'));
  const hint = tail.truncated ? '… 只显示末尾输出' : hidden > 0 ? `… 上面还有 ${String(hidden)} 行` : null;
  if (hint !== null) lines.unshift(asLine(hint, 'textDim'));
  return lines;
}
