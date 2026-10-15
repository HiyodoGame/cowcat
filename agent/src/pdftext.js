// Best-effort PDF text extraction for OpenAI-compatible providers, which have no
// native way to accept a PDF (Anthropic providers get the file as a document
// block instead — see src/tools/read.js).
//
// Zero dependencies: inflate content streams with node's zlib, then walk the
// text operators (Tj / TJ / ' / ") and turn positioning operators into line
// breaks. This does NOT implement ToUnicode CMaps, so PDFs that store glyph ids
// instead of characters (common with embedded CJK fonts) come out garbled — the
// quality gate below turns that case into a clear error rather than feeding
// mojibake to the model.
import { inflateSync, inflateRawSync } from 'node:zlib';

export const MIN_CHARS = 40;
export const MAX_CHARS = 200000;
const MIN_PRINTABLE_RATIO = 0.7;
const PRINTABLE_RE = /[\p{L}\p{N}\p{P}\p{Zs}\n\t]/u;

// PDF strings are byte strings; most are Latin-1, some carry a UTF-16BE BOM.
function decodeBytes(str) {
  if (str.charCodeAt(0) === 0xfe && str.charCodeAt(1) === 0xff) {
    const bytes = Buffer.from(str, 'latin1');
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
    return out;
  }
  return str;
}

function hexToText(hex) {
  if (!hex) return '';
  const clean = hex.length % 2 ? `${hex}0` : hex;
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) {
    const b = parseInt(clean.slice(i, i + 2), 16);
    if (Number.isNaN(b)) return '';
    bytes.push(b);
  }
  return decodeBytes(Buffer.from(bytes).toString('latin1'));
}

// Literal string: '(' ... ')' with the escapes the spec defines, balancing
// nested (unescaped) parentheses that real-world writers emit.
export function readLiteralString(s, start) {
  let depth = 1;
  let i = start + 1;
  let out = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const n = s[i + 1];
      if (n === undefined) { i++; break; }
      if (n === 'n') { out += '\n'; i += 2; continue; }
      if (n === 'r') { out += '\r'; i += 2; continue; }
      if (n === 't') { out += '\t'; i += 2; continue; }
      if (n === 'b') { out += '\b'; i += 2; continue; }
      if (n === 'f') { out += '\f'; i += 2; continue; }
      if (n >= '0' && n <= '7') {
        const m = /^[0-7]{1,3}/.exec(s.slice(i + 1));
        out += String.fromCharCode(parseInt(m[0], 8));
        i += 1 + m[0].length;
        continue;
      }
      if (n === '\r') { i += s[i + 2] === '\n' ? 3 : 2; continue; } // line continuation
      if (n === '\n') { i += 2; continue; }
      out += n; i += 2; continue;
    }
    if (ch === '(') { depth++; out += ch; i++; continue; }
    if (ch === ')') { depth--; i++; if (depth === 0) break; out += ch; continue; }
    out += ch; i++;
  }
  return { text: decodeBytes(out), next: i };
}

// Walk one decoded content stream, emitting text and line breaks.
export function scanContentStream(s) {
  const pieces = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '(') {
      const r = readLiteralString(s, i);
      pieces.push(r.text);
      i = r.next;
      continue;
    }
    if (ch === '<') {
      if (s[i + 1] === '<') { i += 2; continue; } // dictionary
      const end = s.indexOf('>', i);
      if (end === -1) { i++; continue; }
      pieces.push(hexToText(s.slice(i + 1, end).replace(/\s+/g, '')));
      i = end + 1;
      continue;
    }
    if (ch === '[') {
      // TJ array: strings interleaved with kerning numbers; a large negative
      // adjustment is how a word space is encoded.
      i++;
      while (i < s.length && s[i] !== ']') {
        if (s[i] === '(') {
          const r = readLiteralString(s, i);
          pieces.push(r.text);
          i = r.next;
          continue;
        }
        if (s[i] === '<' && s[i + 1] !== '<') {
          const end = s.indexOf('>', i);
          if (end === -1) break;
          pieces.push(hexToText(s.slice(i + 1, end).replace(/\s+/g, '')));
          i = end + 1;
          continue;
        }
        const num = /^[-+]?\d*\.?\d+/.exec(s.slice(i));
        if (num) {
          if (Number(num[0]) <= -180) pieces.push(' ');
          i += num[0].length;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    const op = /^[A-Za-z*'"]+/.exec(s.slice(i));
    if (op) {
      const name = op[0];
      if (name === 'Td' || name === 'TD' || name === 'T*' || name === 'ET' || name === 'BT' || name === "'" || name === '"') {
        pieces.push('\n');
      }
      i += name.length;
      continue;
    }
    i++;
  }
  return pieces.join('');
}

// Every `stream ... endstream` body, inflated when the enclosing dictionary says
// FlateDecode (the overwhelmingly common case).
export function extractStreams(buf) {
  const raw = buf.toString('latin1');
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end === -1) break;
    let body = raw.slice(start, end);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    else if (body.endsWith('\n') || body.endsWith('\r')) body = body.slice(0, -1);
    const dictStart = Math.max(0, m.index - 600);
    const dict = raw.slice(dictStart, m.index);
    if (/\/FlateDecode/.test(dict)) {
      const bytes = Buffer.from(body, 'latin1');
      try { out.push(inflateSync(bytes).toString('latin1')); continue; } catch { /* try raw deflate */ }
      try { out.push(inflateRawSync(bytes).toString('latin1')); continue; } catch { /* not inflatable */ }
    }
    out.push(body);
  }
  return out;
}

function tidy(text) {
  return text
    .replace(/\r/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .trim();
}

function printableRatio(text) {
  if (!text) return 0;
  let ok = 0;
  for (const ch of text) if (PRINTABLE_RE.test(ch)) ok++;
  return ok / [...text].length;
}

// -> { ok:true, text, chars, truncated } | { ok:false, reason }
export function extractPdfText(buf, { minChars = MIN_CHARS, maxChars = MAX_CHARS } = {}) {
  let text = '';
  try {
    for (const stream of extractStreams(buf)) text += `${scanContentStream(stream)}\n`;
  } catch (e) {
    return { ok: false, reason: `stream decoding failed: ${e.message}` };
  }
  const cleaned = tidy(text);
  if (cleaned.length < minChars) {
    return { ok: false, reason: `only ${cleaned.length} characters of text could be extracted (likely a scanned or image-only PDF)` };
  }
  const ratio = printableRatio(cleaned);
  if (ratio < MIN_PRINTABLE_RATIO) {
    return { ok: false, reason: `extracted text is ${Math.round((1 - ratio) * 100)}% non-printable (glyph-encoded fonts without a ToUnicode map)` };
  }
  const truncated = cleaned.length > maxChars;
  return { ok: true, text: truncated ? cleaned.slice(0, maxChars) : cleaned, chars: cleaned.length, truncated };
}
