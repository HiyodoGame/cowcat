// Streaming markdown block renderer: line-based block state machine plus an
// inline span tokenizer. push() returns rows closed in that call followed by a
// full re-render of the still-open tail block; the caller replaces the tail.

import { stringWidth, charWidth, graphemes } from './wcwidth.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const UNDERLINE = '\x1b[4m';

const FAST_LIMIT = 200;
const META_RE = /[#*_`>|+\-]/;

const stripAnsi = (s) => String(s)
  .replace(/\x1b\[[0-9;]*m/g, '')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^(\s*)([-*+])\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const FENCE_RE = /^```(\S*)\s*$/;
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_ROW_RE = /^\|.*\|$/;
const SEP_CELL_RE = /^:?-{3,}:?$/;
const INLINE_RE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]*\]\([^)\n]*\))/g;
const LINK_RE = /^\[([^\]]*)\]\(([^)]*)\)$/;

function parseCells(line) {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function inlineSpans(text, theme, osc8) {
  const spans = [];
  let last = 0;
  for (const m of String(text).matchAll(INLINE_RE)) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index), style: null });
    const tok = m[0];
    if (tok.startsWith('**')) spans.push({ text: tok.slice(2, -2), style: BOLD });
    else if (tok.startsWith('*')) spans.push({ text: tok.slice(1, -1), style: ITALIC });
    else if (tok.startsWith('`')) spans.push({ text: tok.slice(1, -1), style: theme.permission });
    else {
      const lm = LINK_RE.exec(tok);
      if (osc8) {
        spans.push({ text: `\x1b]8;;${lm[2]}\x1b\\${theme.permission}${lm[1]}${RESET}\x1b]8;;\x1b\\`, style: 'raw' });
      } else {
        spans.push({ text: `${DIM}${lm[1]} (${lm[2]})${RESET}`, style: 'raw' });
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), style: null });
  return spans;
}

function unitsFromSpans(spans, baseStyle = null) {
  const units = [];
  for (const sp of spans) {
    const style = sp.style === null ? baseStyle : sp.style;
    for (const g of graphemes(sp.text)) units.push({ g, style });
  }
  return units;
}

function widthOf(units) {
  let w = 0;
  for (const u of units) w += charWidth(u.g);
  return w;
}

function wrapUnits(units, width) {
  const lines = [];
  let cur = [];
  let w = 0;
  let i = 0;
  const flush = () => {
    while (cur.length && cur[0].g === ' ') cur.shift();
    while (cur.length && cur[cur.length - 1].g === ' ') cur.pop();
    lines.push(cur);
    cur = [];
    w = 0;
  };
  while (i < units.length) {
    const u = units[i];
    const uw = charWidth(u.g);
    if (w + uw <= width || w === 0) {
      cur.push(u);
      w += uw;
      i++;
      continue;
    }
    let sp = -1;
    for (let j = cur.length - 1; j >= 0; j--) {
      if (cur[j].g === ' ') { sp = j; break; }
    }
    if (sp > 0) {
      const carry = cur.slice(sp + 1);
      cur = cur.slice(0, sp);
      flush();
      cur = carry;
      w = widthOf(carry);
    } else {
      flush();
    }
  }
  if (cur.length) flush();
  return lines;
}

function renderUnitsLine(units) {
  let out = '';
  let i = 0;
  while (i < units.length) {
    const st = units[i].style;
    let j = i;
    let text = '';
    while (j < units.length && units[j].style === st) { text += units[j].g; j++; }
    out += st === null || st === 'raw' ? text : st + text + RESET;
    i = j;
  }
  return out;
}

export function createMarkdownRenderer({ theme, width, highlight, osc8 = false }) {
  let buf = '';
  let block = null;
  let closed = [];
  let closedSeen = 0;
  let fast = true;
  let fastText = '';
  let fastLinesSeen = 0;
  let fastEmitted = false;

  const lineObj = (text) => ({ text, width: stringWidth(stripAnsi(text)) });

  const wrapPlain = (text, wrapWidth = width) =>
    wrapUnits(unitsFromSpans([{ text, style: null }]), wrapWidth)
      .map((row) => lineObj(renderUnitsLine(row)));

  function classify(line) {
    let m;
    if ((m = HEADING_RE.exec(line))) return { type: 'heading', level: m[1].length, text: m[2] };
    if ((m = UL_RE.exec(line))) return { type: 'ul', level: Math.floor(m[1].length / 2) + 1, text: m[3] };
    if ((m = OL_RE.exec(line))) return { type: 'ol', level: Math.floor(m[1].length / 2) + 1, num: m[2], text: m[3] };
    if ((m = QUOTE_RE.exec(line))) return { type: 'quote', text: m[1] };
    if ((m = FENCE_RE.exec(line))) return { type: 'fence', lang: m[1] };
    if (HR_RE.test(line)) return { type: 'hr' };
    if (TABLE_ROW_RE.test(line)) return { type: 'table', cells: parseCells(line) };
    return { type: 'para', text: line };
  }

  function startBlock(c) {
    switch (c.type) {
      case 'heading':
        block = { type: 'heading', level: c.level, text: c.text };
        break;
      case 'para':
        block = { type: 'para', lines: [c.text] };
        break;
      case 'quote':
        block = { type: 'quote', lines: [c.text] };
        break;
      case 'ul':
      case 'ol':
        block = { type: c.type, items: [{ level: c.level, num: c.num, text: c.text }] };
        break;
      case 'table':
        block = { type: 'table', rows: [c.cells] };
        break;
      case 'fence':
        block = { type: 'fence', lang: c.lang, code: [] };
        break;
      case 'hr':
        closed.push(lineObj(theme.subtle + '─'.repeat(width) + RESET));
        block = null;
        break;
    }
  }

  function closeBlock() {
    if (!block) return;
    closed.push(...renderBlock(block));
    block = null;
  }

  function processLine(line) {
    if (block && block.type === 'fence') {
      if (FENCE_RE.test(line)) closeBlock();
      else block.code.push(line);
      return;
    }
    if (line.trim() === '') { closeBlock(); return; }
    const c = classify(line);
    const same = block && block.type === c.type
      && c.type !== 'heading' && c.type !== 'hr';
    if (!same) {
      closeBlock();
      startBlock(c);
    } else if (c.type === 'table') {
      block.rows.push(c.cells);
    } else if (c.type === 'ul' || c.type === 'ol') {
      block.items.push({ level: c.level, num: c.num, text: c.text });
    } else {
      block.lines.push(c.text);
    }
  }

  function renderParagraph(text, baseStyle) {
    const units = unitsFromSpans(inlineSpans(text, theme, osc8), baseStyle);
    return wrapUnits(units, width).map((row) => lineObj(renderUnitsLine(row)));
  }

  function renderList(b, items) {
    const out = [];
    let sub = 0;
    for (const it of items) {
      const indent = '  '.repeat(Math.max(0, it.level - 1));
      let marker;
      if (b.type === 'ul') {
        if (it.level <= 1) marker = '- ';
        else { marker = String.fromCharCode(97 + (sub % 26)) + '. '; sub++; }
      } else {
        marker = `${it.num ?? ''}. `;
      }
      const prefix = indent + marker;
      const cont = indent + ' '.repeat(stringWidth(marker));
      const units = unitsFromSpans(inlineSpans(it.text, theme, osc8));
      const rows = wrapUnits(units, Math.max(1, width - stringWidth(prefix)));
      rows.forEach((row, k) => {
        out.push(lineObj((k === 0 ? prefix : cont) + renderUnitsLine(row)));
      });
    }
    return out;
  }

  function renderTable(rows) {
    const cols = Math.max(...rows.map((r) => r.length));
    const widths = Array.from({ length: cols }, (_, k) => 3);
    for (const row of rows) {
      row.forEach((cell, k) => {
        const cellText = renderUnitsLine(unitsFromSpans(inlineSpans(cell, theme, osc8)));
        widths[k] = Math.max(widths[k], stringWidth(stripAnsi(cellText)));
      });
    }
    return rows.map((row) => {
      if (row.every((c) => SEP_CELL_RE.test(c))) {
        return lineObj('|' + widths.map((cw) => '-'.repeat(cw + 2)).join('|') + '|');
      }
      const cells = widths.map((cw, k) => {
        const cellText = renderUnitsLine(unitsFromSpans(inlineSpans(row[k] ?? '', theme, osc8)));
        return ' ' + cellText + ' '.repeat(cw - stringWidth(stripAnsi(cellText))) + ' ';
      });
      return lineObj('|' + cells.join('|') + '|');
    });
  }

  function renderBlock(b, extra) {
    switch (b.type) {
      case 'heading': {
        const text = extra ? b.text + extra : b.text;
        const style = theme.text + (b.level === 1 ? BOLD + ITALIC + UNDERLINE : BOLD);
        const rows = wrapUnits(unitsFromSpans([{ text, style: null }], style), width)
          .map((row) => lineObj(renderUnitsLine(row)));
        rows.push({ text: '', width: 0 });
        return rows;
      }
      case 'para': {
        const lines = extra ? b.lines.concat([extra]) : b.lines;
        return renderParagraph(lines.join(' '));
      }
      case 'quote': {
        const lines = extra ? b.lines.concat([extra]) : b.lines;
        return renderParagraph(lines.join(' '), theme.inactive + DIM + ITALIC);
      }
      case 'ul':
      case 'ol': {
        let items = b.items;
        if (extra) {
          const c = classify(extra);
          items = c.type === b.type
            ? items.concat([{ level: c.level, num: c.num, text: c.text }])
            : items.map((it, k) => k === items.length - 1 ? { ...it, text: `${it.text} ${extra}` } : it);
        }
        return renderList(b, items);
      }
      case 'fence': {
        const codeLines = extra ? b.code.concat([extra]) : b.code;
        const code = codeLines.join('\n');
        const out = highlight ? highlight(code, b.lang) : code;
        const lines = String(out).split('\n');
        if (lines.length && lines.at(-1) === '') lines.pop();
        return lines.map((text) => lineObj(text));
      }
      case 'table': {
        const rows = extra && TABLE_ROW_RE.test(extra) ? b.rows.concat([parseCells(extra)]) : b.rows;
        return renderTable(rows);
      }
      default:
        return [];
    }
  }

  function renderPlain() {
    let rest = fastText;
    let i;
    const lines = [];
    while ((i = rest.indexOf('\n')) !== -1) {
      lines.push(rest.slice(0, i));
      rest = rest.slice(i + 1);
    }
    const out = [];
    for (const line of lines.slice(fastLinesSeen)) {
      for (const row of wrapPlain(line)) out.push(row);
    }
    fastLinesSeen = lines.length;
    for (const row of wrapPlain(rest)) out.push(row);
    if (out.length) fastEmitted = true;
    return out;
  }

  function currentRows() {
    if (block) return renderBlock(block, buf || undefined);
    return buf ? renderParagraph(buf) : [];
  }

  function push(chunk) {
    if (fast) {
      fastText += chunk;
      if (!META_RE.test(fastText.slice(0, FAST_LIMIT))) return renderPlain();
      fast = false;
      let rest = fastText;
      let i;
      while ((i = rest.indexOf('\n')) !== -1) {
        processLine(rest.slice(0, i).replace(/\r$/, ''));
        rest = rest.slice(i + 1);
      }
      buf = rest;
      closedSeen = fastEmitted ? closed.length : 0;
      const replayed = closed.slice(closedSeen);
      closedSeen = closed.length;
      return replayed.concat(currentRows());
    }
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      processLine(line);
    }
    const out = closed.slice(closedSeen);
    closedSeen = closed.length;
    return out.concat(currentRows());
  }

  function reset(newWidth) {
    width = newWidth;
    buf = '';
    block = null;
    closed = [];
    closedSeen = 0;
    fast = true;
    fastText = '';
    fastLinesSeen = 0;
    fastEmitted = false;
  }

  return { push, reset };
}
