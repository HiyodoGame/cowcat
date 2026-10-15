// .ipynb parsing, text rendering and cell editing. Pure functions over strings —
// no I/O — so both Read (render) and NotebookEdit (edit) share one definition of
// what a cell is, and tests can exercise them without touching disk.
//
// Rendering is text-only on purpose: outputs that are images are reported with
// their size but NOT attached, because attachments must reference a file (see
// docs/read-multimodal-plan.md §3.1/§3.3) and notebook images live inside the
// JSON. Line numbers restart per cell and are 1-based.
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { formatBytes } from './imageinfo.js';

export const DEFAULT_MAX_OUTPUT_CHARS = 20000;

export function parseNotebook(text) {
  let nb;
  try {
    nb = JSON.parse(String(text ?? ''));
  } catch (e) {
    return { ok: false, error: `not valid JSON (${e.message})` };
  }
  if (!nb || typeof nb !== 'object' || Array.isArray(nb)) return { ok: false, error: 'notebook root is not an object' };
  if (!Array.isArray(nb.cells)) return { ok: false, error: 'notebook has no "cells" array' };
  return { ok: true, nb };
}

// Jupyter stores source/output text as either a string or a list of lines that
// must be concatenated. Both forms appear in the wild.
export function sourceToString(src) {
  if (Array.isArray(src)) return src.join('');
  return src == null ? '' : String(src);
}

// Inverse of sourceToString: split only at '\n', keeping each newline attached to
// the line it terminates. round-trip: sourceToString(splitSource(s)) === s
export function splitSource(str) {
  const s = String(str ?? '');
  if (s === '') return [];
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') { out.push(s.slice(start, i + 1)); start = i + 1; }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

function numbered(text) {
  if (text === '') return ['(empty cell)'];
  return text.replace(/\n$/, '').split('\n').map((l, i) => `${i + 1}\t${l}`);
}

const IMAGE_KEYS = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function imageNotes(data) {
  const notes = [];
  for (const key of IMAGE_KEYS) {
    const v = data[key];
    if (v == null) continue;
    const bytes = Buffer.byteLength(sourceToString(v), 'base64');
    notes.push(`[image output: ${key}, ${formatBytes(bytes)} — not attached; read the notebook file to view it]`);
  }
  return notes;
}

function renderOutput(out, maxChars) {
  const lines = [];
  const type = out.output_type || 'output';
  if (type === 'stream') {
    lines.push(...numbered(sourceToString(out.text).replace(/\n$/, '')));
  } else if (type === 'error') {
    const head = [out.ename, out.evalue].filter(Boolean).join(': ');
    if (head) lines.push(...numbered(head));
    const tb = Array.isArray(out.traceback) ? out.traceback.join('\n') : String(out.traceback ?? '');
    if (tb) lines.push(...numbered(tb.replace(/\x1b\[[0-9;]*m/g, '')));
  } else {
    const data = out.data || {};
    const text = sourceToString(data['text/plain']);
    if (text) lines.push(...numbered(text.replace(/\n$/, '')));
    const notes = imageNotes(data);
    if (notes.length) lines.push(...notes);
    if (!text && !notes.length) lines.push(...numbered(sourceToString(data['text/html']).trim() || '(no renderable output)'));
  }
  const joined = lines.join('\n');
  if (joined.length > maxChars) {
    return [joined.slice(0, maxChars), `[output truncated: ${formatBytes(joined.length - maxChars)} dropped]`];
  }
  return lines;
}

// 'text' | 'code' | 'markdown' | 'raw'
export function renderNotebook(nb, { path = '', maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS } = {}) {
  const cells = nb.cells || [];
  const counts = new Map();
  for (const c of cells) counts.set(c.cell_type || 'unknown', (counts.get(c.cell_type || 'unknown') || 0) + 1);
  const summary = [...counts.entries()].map(([k, v]) => `${v} ${k}`).join(', ');
  const out = [`[notebook] ${path ? basename(path) : 'notebook'} — ${cells.length} cell${cells.length === 1 ? '' : 's'}${summary ? ` (${summary})` : ''}`];
  cells.forEach((c, i) => {
    const type = c.cell_type || 'unknown';
    const exec = type === 'code' && c.execution_count != null ? ` exec:${c.execution_count}` : '';
    out.push(`--- cell [${i}] ${type}${exec} ---`);
    out.push(...numbered(sourceToString(c.source)));
    (c.outputs || []).forEach((o, n) => {
      out.push(`--- output [${i}.${n}] ${o.output_type || 'output'} ---`);
      out.push(...renderOutput(o, maxOutputChars));
    });
  });
  return out.join('\n');
}

const CELL_TYPES = new Map([
  ['code', 'code'],
  ['markdown', 'markdown'],
  ['md', 'markdown'],
  ['raw', 'raw'],
]);

export function normalizeCellType(t) {
  if (t == null) return null;
  return CELL_TYPES.get(String(t).toLowerCase()) || null;
}

// Preserve the file's own formatting so an edit produces a one-cell diff instead
// of reformatting the whole notebook.
export function detectStyle(text) {
  const eol = String(text || '').includes('\r\n') ? '\r\n' : '\n';
  const m = String(text || '').match(/\{\r?\n([ \t]{1,8})"/);
  return {
    eol,
    indent: m ? m[1] : '  ',
    trailingNewline: /\r?\n$/.test(String(text || '')),
  };
}

export function serializeNotebook(nb, style = {}) {
  const { eol = '\n', indent = '  ', trailingNewline = true } = style;
  const json = JSON.stringify(nb, null, indent);
  const normalized = eol === '\n' ? json : json.replace(/\n/g, eol);
  return trailingNewline ? `${normalized}${eol}` : normalized;
}

function newCell(cellType, source, nbformatMinor) {
  const cell = { cell_type: cellType, metadata: {}, source: splitSource(source) };
  if (nbformatMinor >= 5) cell.id = randomUUID().slice(0, 8);
  if (cellType === 'code') { cell.outputs = []; cell.execution_count = null; }
  return cell;
}

// edit_mode:
//   replace (default) — cell_index is replaced; source and/or cell_type change
//   insert            — a new cell is placed AT cell_index (existing cells shift
//                       right); cell_index === cells.length appends
//   delete            — cell_index is removed
// -> { ok:true, nb, text, summary } | { ok:false, error }
export function editNotebook(text, { cell_index: cellIndex, edit_mode: editMode = 'replace', new_source: newSource, cell_type: cellType } = {}) {
  const parsed = parseNotebook(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const nb = parsed.nb;
  const cells = nb.cells;
  const mode = String(editMode || 'replace').toLowerCase();
  if (!['replace', 'insert', 'delete'].includes(mode)) {
    return { ok: false, error: `edit_mode must be replace, insert or delete (got "${editMode}")` };
  }
  if (!Number.isInteger(cellIndex)) return { ok: false, error: 'cell_index must be an integer' };
  const normalizedType = normalizeCellType(cellType);
  if (cellType != null && !normalizedType) {
    return { ok: false, error: `cell_type must be code, markdown or raw (got "${cellType}")` };
  }

  let summary;
  if (mode === 'delete') {
    if (cellIndex < 0 || cellIndex >= cells.length) {
      return { ok: false, error: `cell_index ${cellIndex} is out of range (notebook has ${cells.length} cells)` };
    }
    const removed = cells.splice(cellIndex, 1)[0];
    summary = `deleted cell [${cellIndex}] (${removed?.cell_type || 'unknown'})`;
  } else if (mode === 'insert') {
    if (cellIndex < 0 || cellIndex > cells.length) {
      return { ok: false, error: `cell_index ${cellIndex} is out of range for insert (0..${cells.length})` };
    }
    if (newSource == null) return { ok: false, error: 'new_source is required for insert' };
    const type = normalizedType || 'code';
    cells.splice(cellIndex, 0, newCell(type, newSource, nb.nbformat_minor || 0));
    summary = `inserted ${type} cell at [${cellIndex}]`;
  } else {
    if (cellIndex < 0 || cellIndex >= cells.length) {
      return { ok: false, error: `cell_index ${cellIndex} is out of range (notebook has ${cells.length} cells)` };
    }
    if (newSource == null && normalizedType == null) {
      return { ok: false, error: 'replace needs new_source and/or cell_type' };
    }
    const cell = cells[cellIndex];
    const before = cell.cell_type;
    if (normalizedType) cell.cell_type = normalizedType;
    if (newSource != null) cell.source = splitSource(newSource);
    if (cell.cell_type === 'code') {
      if (!Array.isArray(cell.outputs)) cell.outputs = [];
      if (cell.execution_count === undefined) cell.execution_count = null;
    } else {
      delete cell.outputs;
      delete cell.execution_count;
    }
    summary = `replaced cell [${cellIndex}] (${before}${normalizedType && normalizedType !== before ? ` -> ${normalizedType}` : ''})`;
  }

  const style = detectStyle(text);
  const next = serializeNotebook(nb, style);
  // Cheap self-check: the edit must produce a re-readable notebook.
  const verify = parseNotebook(next);
  if (!verify.ok) return { ok: false, error: `internal error: edited notebook is invalid (${verify.error})` };
  return { ok: true, nb, text: next, summary };
}
