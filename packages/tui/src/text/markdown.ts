import type { LineRun } from '../ui/line.js';
import type { TokenName } from '../theme/tokens.js';
import { runLine } from '../ui/line.js';
import type { Line } from '../ui/line.js';
import { charWidth, graphemes, padTo, stringWidth } from './width.js';

/**
 * Markdown, rendered into the interface's own `Line` pipeline (ADR-162).
 *
 * The model answers in Markdown — headings, lists, code fences, tables — and printing it
 * raw (the old `wrap(entry.text)`) is the single biggest reason a transcript read as a
 * text wall. This module parses the block structure and the inline spans, then lays the
 * result out with the same width table everything else uses: a renderer that disagrees
 * about how wide `把` is would break the table rules and the code-block indents.
 *
 * Deliberately not here (ADR-162 ④): per-language syntax highlighting, nested-list
 * merging across lines, and any HTML. Tool output stays plain — that output IS terminal
 * text, and rendering it would be inventing structure the tool never meant.
 */

/** Inline bold/italic/code/link spans over the plain text of one logical line. */
export function inlineRuns(text: string, base: TokenName = 'text'): readonly LineRun[] {
  const runs: LineRun[] = [];
  let plain = '';
  let i = 0;
  const flush = (): void => {
    if (plain !== '') {
      runs.push({ text: plain, token: base });
      plain = '';
    }
  };
  while (i < text.length) {
    const rest = text.slice(i);
    // Inline code first: nothing inside backticks is markup.
    const code = /^`([^`]+)`/.exec(rest);
    if (code !== null) {
      flush();
      runs.push({ text: code[1] ?? '', token: 'code' });
      i += code[0].length;
      continue;
    }
    const bold = /^\*\*([^*]+)\*\*/.exec(rest);
    if (bold !== null) {
      flush();
      runs.push({ text: bold[1] ?? '', token: base, bold: true });
      i += bold[0].length;
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)/.exec(rest);
    if (link !== null) {
      flush();
      runs.push({ text: link[1] ?? '', token: base, bold: true });
      i += link[0].length;
      continue;
    }
    const italic = /^\*([^*]+)\*/.exec(rest);
    if (italic !== null) {
      flush();
      runs.push({ text: italic[1] ?? '', token: base, bold: true });
      i += italic[0].length;
      continue;
    }
    plain += text[i] ?? '';
    i += 1;
  }
  flush();
  return runs.length === 0 ? [{ text: '', token: base }] : runs;
}

/**
 * Wrap styled spans at `width`, one grapheme scan — the same single pass `wrap()` got for
 * the same reason (the naive version re-measured the tail per row). Rows are built by
 * slicing the plain string at cluster boundaries, and each row's spans are the runs that
 * intersect it, so inline styles survive wrapping exactly.
 */
export function wrapRuns(runs: readonly LineRun[], width: number): readonly Line[] {
  const plain = runs.map((span) => span.text).join('');
  if (plain.trim() === '') return [];
  const spans: { readonly start: number; readonly end: number; readonly token: TokenName; readonly bold?: boolean }[] = [];
  let offset = 0;
  for (const span of runs) {
    spans.push({ start: offset, end: offset + span.text.length, token: span.token, ...(span.bold === undefined ? {} : { bold: span.bold }) });
    offset += span.text.length;
  }
  const clusters = graphemes(plain);
  const starts: number[] = [0];
  let walked = 0;
  for (const cluster of clusters) {
    walked += cluster.length;
    starts.push(walked);
  }

  const out: Line[] = [];
  let k = 0;
  while (k < clusters.length) {
    let used = 0;
    let end = k;
    let lastSpace = -1;
    while (end < clusters.length) {
      const cluster = clusters[end];
      if (cluster === undefined) break;
      const w = charWidth(cluster);
      if (used + w > width) break;
      if (cluster === ' ' && used > Math.floor(width / 3)) lastSpace = end;
      used += w;
      end += 1;
    }
    if (end === k) {
      end = k + 1; // one too-wide cluster gets its own row
    } else if (end < clusters.length && lastSpace > k) {
      end = lastSpace + 1; // break after the last space past a third of the line
    }
    const rowStart = starts[k] ?? 0;
    const rowEnd = starts[end] ?? plain.length;
    const rowRuns: LineRun[] = [];
    for (const span of spans) {
      const from = Math.max(span.start, rowStart);
      const to = Math.min(span.end, rowEnd);
      if (to > from) {
        rowRuns.push({ text: plain.slice(from, to), token: span.token, ...(span.bold === undefined ? {} : { bold: span.bold }) });
      }
    }
    const text = plain.slice(rowStart, rowEnd);
    out.push(runLine('', rowRuns.length > 0 ? rowRuns : [{ text, token: 'text' }], ''));
    k = end;
  }
  return out;
}

function lineOf(text: string, token: TokenName): Line {
  return { text, token, bold: false };
}

/** Prefix every row of a wrapped block (hanging indent for list items, quote bars, code). */
function prefixed(rows: readonly Line[], prefix: string, continuation: string): readonly Line[] {
  return rows.map((row, index) => runLine(index === 0 ? prefix : continuation, row.runs ?? [{ text: row.text, token: row.token }], ''));
}

function tableRows(lines: readonly string[]): readonly Line[] {
  const rows = lines
    .filter((row) => /^\s*\|.*\|\s*$/.test(row))
    .map((row) =>
      row
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    );
  const body = rows.filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
  if (body.length === 0) return [];
  const columns = Math.max(...body.map((cells) => cells.length));
  const widths: number[] = [];
  for (let c = 0; c < columns; c += 1) {
    widths[c] = Math.min(40, Math.max(...body.map((cells) => stringWidth(cells[c] ?? ''))));
  }
  const rule = `+${widths.map((w) => '─'.repeat(w + 2)).join('+')}+`;
  const out: Line[] = [lineOf(rule, 'border')];
  body.forEach((cells, index) => {
    const spans: LineRun[] = [];
    for (let c = 0; c < columns; c += 1) {
      if (c > 0) spans.push({ text: ' │ ', token: 'border' });
      spans.push({ text: ` ${padTo(cells[c] ?? '', widths[c] ?? 0)} `, token: 'text', ...(index === 0 ? { bold: true } : {}) });
    }
    out.push(runLine('', spans, ' '));
    out.push(lineOf(rule, 'border'));
  });
  return out;
}

/**
 * Vertical rhythm (ADR-164): one blank line between blocks, never two, none at the top.
 * A transcript without breathing room reads as a wall regardless of how correct the
 * inline styles are — whitespace is the hierarchy, colour only backs it up.
 */
function gap(out: Line[]): void {
  const last = out.at(-1);
  if (last !== undefined && last.text !== '') out.push(lineOf('', 'text'));
}

/** The whole renderer: assistant text in, transcript lines out. `base` is the unstyled voice. */
export function renderMarkdown(source: string, width: number, base: TokenName = 'text'): readonly Line[] {
  const out: Line[] = [];
  const lines = source.split('\n');
  let i = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(' ');
    paragraph = [];
    out.push(...wrapRuns(inlineRuns(text, base), width));
  };

  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const line = raw.trimEnd();

    const fence = /^```(\w*)/.exec(line.trim());
    if (fence !== null) {
      flushParagraph();
      gap(out);
      const lang = fence[1] ?? '';
      if (lang !== '') out.push(lineOf(`▸ ${lang}`, 'textDim'));
      i += 1;
      const body: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim() !== '```') {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // the closing fence (or end of text — an unterminated block still renders)
      for (const row of body) {
        out.push(...prefixed([{ text: row, token: 'code', bold: false }], '  ', '  '));
      }
      gap(out);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      gap(out);
      const level = heading[1]?.length ?? 1;
      const text = heading[2] ?? '';
      if (level <= 2) {
        // The accent bar anchors the heading; its text stays the base voice, bold — a
        // whole green headline is emphasis shouting down the whole answer (ADR-164).
        out.push(runLine('', [{ text: '▌ ', token: 'brand' }, { text, token: base, bold: true }], ''));
      } else {
        out.push(...wrapRuns(inlineRuns(text, base).map((span) => ({ ...span, bold: true })), width));
      }
      gap(out);
      i += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph();
      out.push(lineOf('─'.repeat(Math.max(8, width)), 'border'));
      i += 1;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      gap(out);
      const table: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? '')) {
        table.push(lines[i] ?? '');
        i += 1;
      }
      out.push(...tableRows(table));
      gap(out);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote !== null) {
      flushParagraph();
      gap(out);
      out.push(...prefixed(wrapRuns(inlineRuns(quote[1] ?? '', 'textDim'), Math.max(8, width - 3)), '│ ', '│ '));
      gap(out);
      i += 1;
      continue;
    }

    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(raw);
    if (bullet !== null) {
      flushParagraph();
      const indent = bullet[1] ?? '';
      const marker = indent.length >= 2 ? '· ' : '• ';
      const text = bullet[3] ?? '';
      const rows = wrapRuns(inlineRuns(text), Math.max(8, width - marker.length - indent.length));
      out.push(...prefixed(rows, `${indent}${marker}`, `${indent}${' '.repeat(marker.length)}`));
      i += 1;
      continue;
    }

    const ordered = /^(\s*)(\d+[.)])\s+(.*)$/.exec(raw);
    if (ordered !== null) {
      flushParagraph();
      const indent = ordered[1] ?? '';
      const marker = `${ordered[2] ?? ''} `;
      const text = ordered[3] ?? '';
      const rows = wrapRuns(inlineRuns(text), Math.max(8, width - marker.length - indent.length));
      out.push(...prefixed(rows, `${indent}${marker}`, `${indent}${' '.repeat(marker.length)}`));
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      i += 1;
      continue;
    }
    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();
  return out;
}
