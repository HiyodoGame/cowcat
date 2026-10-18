/**
 * Jupyter notebooks: parse and render to text. Pure functions over strings, no I/O.
 *
 * Ported from v1's `agent/src/notebook.js`, **read half only**: the editing half
 * (`editNotebook`, `serializeNotebook`, cell-type normalisation) belongs to NotebookEdit,
 * which v2 has not built. Porting the renderer now is what makes `Read` complete; the
 * writer can follow the same shape when that tool lands.
 *
 * Rendering is text-only on purpose (ADR-057): an image output lives *inside* the JSON,
 * so there is no file behind it to reference — and an attachment must be a path the
 * adapter can re-read later. Such outputs are reported with their size and explicitly
 * said to be unattached, which is the one honest thing available.
 *
 * The values below come from JSON on disk, so every access goes through a narrowing
 * helper rather than a cast: a notebook is a user file, and a malformed one must degrade
 * into a readable rendering instead of a crash.
 */

import { formatBytes } from './imageinfo.js';

export const DEFAULT_MAX_OUTPUT_CHARS = 20000;

type Json = Record<string, unknown>;

export type NotebookParse = { readonly ok: true; readonly notebook: Json } | { readonly ok: false; readonly error: string };

export function parseNotebook(text: string): NotebookParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { ok: false, error: `not valid JSON (${cause instanceof Error ? cause.message : String(cause)})` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'notebook root is not an object' };
  }
  const notebook = parsed as Json;
  if (!Array.isArray(notebook['cells'])) return { ok: false, error: 'notebook has no "cells" array' };
  return { ok: true, notebook };
}

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Jupyter stores text as a string or as a list of lines; both appear in the wild. */
export function sourceToString(source: unknown): string {
  if (Array.isArray(source)) return source.map((part) => (typeof part === 'string' ? part : '')).join('');
  return typeof source === 'string' ? source : '';
}

function numbered(text: string): readonly string[] {
  if (text === '') return ['(empty cell)'];
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((line, index) => `${String(index + 1)}\t${line}`);
}

const IMAGE_KEYS: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function imageNotes(data: Json): readonly string[] {
  const notes: string[] = [];
  for (const key of IMAGE_KEYS) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    const bytes = Buffer.byteLength(sourceToString(value), 'base64');
    notes.push(`[image output: ${key}, ${formatBytes(bytes)} — not attached: it lives inside the notebook JSON, so there is no file to reference]`);
  }
  return notes;
}

function renderOutput(output: Json, maxChars: number): { readonly lines: readonly string[]; readonly truncated: boolean } {
  const lines: string[] = [];
  const type = typeof output['output_type'] === 'string' ? output['output_type'] : 'output';
  if (type === 'stream') {
    lines.push(...numbered(sourceToString(output['text']).replace(/\n$/, '')));
  } else if (type === 'error') {
    const head = [output['ename'], output['evalue']]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join(': ');
    if (head !== '') lines.push(...numbered(head));
    const traceback = Array.isArray(output['traceback'])
      ? output['traceback'].filter((part): part is string => typeof part === 'string').join('\n')
      : sourceToString(output['traceback']);
    // ANSI escapes are noise in a text rendering; the model cannot see colour anyway.
    if (traceback !== '') lines.push(...numbered(traceback.replace(/\u001B\[[0-9;]*m/g, '')));
  } else {
    const data = asRecord(output['data']);
    const text = sourceToString(data['text/plain']);
    if (text !== '') lines.push(...numbered(text.replace(/\n$/, '')));
    const notes = imageNotes(data);
    if (notes.length > 0) lines.push(...notes);
    if (text === '' && notes.length === 0) {
      const html = sourceToString(data['text/html']).trim();
      lines.push(...numbered(html === '' ? '(no renderable output)' : html));
    }
  }

  const joined = lines.join('\n');
  if (joined.length > maxChars) {
    return {
      lines: [joined.slice(0, maxChars), `[output truncated: ${formatBytes(joined.length - maxChars)} dropped]`],
      truncated: true,
    };
  }
  return { lines, truncated: false };
}

export interface RenderNotebookOptions {
  readonly path?: string;
  readonly maxOutputChars?: number;
}

/**
 * The rendering plus whether any output hit its cap. The cap is real (a stream output can
 * be megabytes), so the result says so rather than letting the caller assume nothing was
 * dropped — `Read` turns it into a `truncation` fact (ADR-048/053).
 */
export interface NotebookRender {
  readonly text: string;
  readonly truncated: boolean;
}

export function renderNotebook(notebook: Json, options: RenderNotebookOptions = {}): NotebookRender {
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const cells = asArray(notebook['cells']);
  let truncated = false;
  const counts = new Map<string, number>();
  for (const cell of cells) {
    const type = typeof asRecord(cell)['cell_type'] === 'string' ? String(asRecord(cell)['cell_type']) : 'unknown';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([kind, count]) => `${String(count)} ${kind}`).join(', ');
  const name = options.path === undefined || options.path === '' ? 'notebook' : basenameOf(options.path);
  const lines = [
    `[notebook] ${name} — ${String(cells.length)} cell${cells.length === 1 ? '' : 's'}${summary === '' ? '' : ` (${summary})`}`,
  ];

  cells.forEach((cell, index) => {
    const record = asRecord(cell);
    const type = typeof record['cell_type'] === 'string' ? record['cell_type'] : 'unknown';
    const executionCount = record['execution_count'];
    const execution =
      type === 'code' && (typeof executionCount === 'number' || typeof executionCount === 'string')
        ? ` exec:${String(executionCount)}`
        : '';
    lines.push(`--- cell [${String(index)}] ${type}${execution} ---`);
    lines.push(...numbered(sourceToString(record['source'])));
    asArray(record['outputs']).forEach((output, outputIndex) => {
      const outputRecord = asRecord(output);
      const outputType = typeof outputRecord['output_type'] === 'string' ? outputRecord['output_type'] : 'output';
      lines.push(`--- output [${String(index)}.${String(outputIndex)}] ${outputType} ---`);
      const rendered = renderOutput(outputRecord, maxOutputChars);
      lines.push(...rendered.lines);
      if (rendered.truncated) truncated = true;
    });
  });

  return { text: lines.join('\n'), truncated };
}

/** A local basename keeps this module free of `node:path` (it is a pure string module). */
function basenameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}
