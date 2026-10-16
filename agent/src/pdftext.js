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

// Stream dictionaries that never hold page text: embedded font programs, ICC
// profiles, images, metadata, object streams. Inflating those produced binary
// junk that polluted the extracted text (found by running against real PDFs —
// an English 1MB spec had zero CID fonts yet 33% non-printable output).
// `/Form` is deliberately NOT skipped: page text legitimately lives in form
// XObjects.
const NON_CONTENT_STREAM_RE = new RegExp([
  '/Subtype\\s*/(Type1C|CIDFontType0C|CIDFontType2|OpenType|TrueType|Type0|Type3|XML|Image)',
  '/Type\\s*/(Metadata|ObjStm|XRef|EmbeddedFile)',
  '/FontFile[0-9]?',
  '/Subtype\\s*/Image',
].join('|'));

// Every `stream ... endstream` body, inflated when the enclosing dictionary says
// FlateDecode (the overwhelmingly common case). Non-content streams are skipped.
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
    // Only THIS object's dictionary decides: a fixed-size window backwards would
    // also capture the previous object (a font program's /Subtype /Type1C sitting
    // right before a page stream used to get the page stream skipped).
    const objStart = raw.lastIndexOf('obj', m.index);
    const dict = objStart === -1 ? '' : raw.slice(objStart, m.index);
    if (NON_CONTENT_STREAM_RE.test(dict)) continue;
    if (/\/FlateDecode/.test(dict)) {
      const bytes = Buffer.from(body, 'latin1');
      try { out.push(inflateSync(bytes).toString('latin1')); continue; } catch { /* try raw deflate */ }
      try { out.push(inflateRawSync(bytes).toString('latin1')); continue; } catch { /* not inflatable */ }
    }
    out.push(body);
  }
  return out;
}

// CID-keyed fonts (Type0) address glyphs, not characters, so a literal/hex string
// carries glyph ids that only a ToUnicode CMap could translate — and this
// extractor does not read CMaps. When that combination is detectable up front,
// refusing is more honest than guessing. (When it is not detectable, the
// printable-ratio gate below is the backstop.)
export function usesCidFontsWithoutUnicode(buf) {
  const raw = buf.toString('latin1');
  if (!/\/Type0\b/.test(raw)) return false;
  return !/\/ToUnicode\b/.test(raw);
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
  if (usesCidFontsWithoutUnicode(buf)) {
    return { ok: false, reason: 'this PDF stores glyph ids instead of characters (CID fonts without a ToUnicode map), which needs a real PDF parser to decode' };
  }
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
    return { ok: false, reason: `extracted text is ${Math.round((1 - ratio) * 100)}% non-printable — this PDF encodes its text in a way that needs a real PDF parser (embedded font encodings / CMaps); convert it to text first` };
  }
  const truncated = cleaned.length > maxChars;
  return { ok: true, text: truncated ? cleaned.slice(0, maxChars) : cleaned, chars: cleaned.length, truncated };
}
