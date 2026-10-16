// Best-effort PDF text extraction for OpenAI-compatible providers, which have no
// native way to accept a PDF (Anthropic providers get the file as a document
// block instead — see src/tools/read.js).
//
// Zero dependencies. Three layers:
//   1. src/pdfobj.js  — objects (classic + inside /ObjStm), pages, font resources
//   2. src/pdfcmap.js — ToUnicode CMaps: glyph id -> character
//   3. this module    — walk the text operators (Tj / TJ / ' / ") and turn
//                       positioning operators into line breaks
//
// With layer 2 the extractor handles the common modern case (subset CID fonts
// with a ToUnicode map), which is what real-world documents use. PDFs without a
// usable map still fall back to reading the bytes as Latin-1, and the quality
// gate refuses what neither path can decode honestly.
import { inflateSync, inflateRawSync } from 'node:zlib';
import { parseDocument, collectPages, globalFontMap, buildDecoders } from './pdfobj.js';

export const MIN_CHARS = 40;
export const MAX_CHARS = 200000;
const MIN_PRINTABLE_RATIO = 0.7;
// Below this share of translated codes an extraction is not trustworthy even if
// the surviving characters look printable.
const MIN_MAPPED_RATIO = 0.5;
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

// Decode a string of raw bytes (one JS char per byte) with a font decoder.
// `stats` counts translated vs total codes so the caller can judge reliability.
function decodeWithFont(bytes, decoder, stats) {
  if (!decoder) return decodeBytes(bytes);
  const width = decoder.codeBytes === 2 ? 2 : 1;
  if (!decoder.map) {
    // CID font without a ToUnicode map: the codes are glyph ids. Falling back to
    // Latin-1 here is exactly what used to produce mojibake.
    if (stats) stats.seen += Math.max(1, Math.floor(bytes.length / width));
    return '';
  }
  let out = '';
  for (let i = 0; i + width - 1 < bytes.length; i += width) {
    const code = width === 2
      ? (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1)
      : bytes.charCodeAt(i);
    if (stats) stats.seen++;
    const mapped = decoder.map.get(code);
    if (mapped === undefined) continue;
    if (stats) stats.mapped++;
    out += mapped;
  }
  return out;
}

function hexToBytes(hex) {
  const clean = String(hex || '').replace(/[^0-9A-Fa-f]/g, '');
  const even = clean.length % 2 ? `${clean}0` : clean;
  const bytes = [];
  for (let i = 0; i < even.length; i += 2) {
    const b = parseInt(even.slice(i, i + 2), 16);
    if (Number.isNaN(b)) return null;
    bytes.push(b);
  }
  return Buffer.from(bytes).toString('latin1');
}

// Literal string: '(' ... ')' with the escapes the spec defines, balancing
// nested (unescaped) parentheses that real-world writers emit. Returns the raw
// byte string as well, so callers with a font decoder can use the bytes directly.
export function readLiteralString(s, start) {
  let depth = 1;
  let i = start + 1;
  let raw = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const n = s[i + 1];
      if (n === undefined) { i++; break; }
      if (n === 'n') { raw += '\n'; i += 2; continue; }
      if (n === 'r') { raw += '\r'; i += 2; continue; }
      if (n === 't') { raw += '\t'; i += 2; continue; }
      if (n === 'b') { raw += '\b'; i += 2; continue; }
      if (n === 'f') { raw += '\f'; i += 2; continue; }
      if (n >= '0' && n <= '7') {
        const m = /^[0-7]{1,3}/.exec(s.slice(i + 1));
        raw += String.fromCharCode(parseInt(m[0], 8));
        i += 1 + m[0].length;
        continue;
      }
      if (n === '\r') { i += s[i + 2] === '\n' ? 3 : 2; continue; } // line continuation
      if (n === '\n') { i += 2; continue; }
      raw += n; i += 2; continue;
    }
    if (ch === '(') { depth++; raw += ch; i++; continue; }
    if (ch === ')') { depth--; i++; if (depth === 0) break; raw += ch; continue; }
    raw += ch; i++;
  }
  return { text: decodeBytes(raw), raw, next: i };
}

const NAME_RE = /^\/([^\s/<>[\](){}]*)/;

// Walk one decoded content stream, emitting text and line breaks.
// opts.fonts: Map<resourceName, decoder> from buildDecoders() (optional — without
// it the bytes are decoded as Latin-1, which is all a naive PDF needs).
// opts.stats: mutable { codes, mapped, unmapped } counter (optional).
export function scanContentStream(s, opts = {}) {
  const { fonts = null, stats = null } = opts;
  const pieces = [];
  let current = null;      // decoder of the font selected by the last Tf
  let pendingName = null;  // last /Name token seen (the Tf operand)
  const pushString = (bytes) => { if (bytes) pieces.push(decodeWithFont(bytes, current, stats)); };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '(') {
      const r = readLiteralString(s, i);
      pushString(r.raw);
      i = r.next;
      continue;
    }
    if (ch === '/') {
      const nm = NAME_RE.exec(s.slice(i));
      pendingName = nm ? nm[1] : null;
      i += nm ? nm[0].length : 1;
      continue;
    }
    if (ch === '<') {
      if (s[i + 1] === '<') { i += 2; continue; } // dictionary
      const end = s.indexOf('>', i);
      if (end === -1) { i++; continue; }
      const bytes = hexToBytes(s.slice(i + 1, end));
      if (bytes) pushString(bytes);
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
          pushString(r.raw);
          i = r.next;
          continue;
        }
        if (s[i] === '<' && s[i + 1] !== '<') {
          const end = s.indexOf('>', i);
          if (end === -1) break;
          const bytes = hexToBytes(s.slice(i + 1, end));
          if (bytes) pushString(bytes);
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
      if (name === 'BI') {
        // Inline image: `BI <dict> ID <binary> EI` embeds raw image bytes directly
        // in the content stream. Scanning them as text produced junk (the largest
        // source of the non-printable share measured on a real 1MB English spec).
        const id = /(?:^|[\s\]>])ID[\s]/.exec(s.slice(i, i + 4096));
        if (id) {
          const searchFrom = i + id.index + id[0].length;
          const ei = s.indexOf('EI', searchFrom);
          i = ei === -1 ? s.length : ei + 2;
          pieces.push('\n');
          continue;
        }
      } else if (name === 'Tf') {
        current = fonts && pendingName != null ? (fonts.get(pendingName) ?? null) : null;
      } else if (name === 'Td' || name === 'TD' || name === 'T*' || name === 'ET' || name === 'BT' || name === "'" || name === '"') {
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
// FlateDecode. Non-content streams are skipped. Used as the structural fallback
// when the page tree cannot be read (and by the tests).
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

// CID-keyed fonts address glyphs, not characters, so without a ToUnicode map the
// strings cannot be interpreted at all. Detected structurally so the failure can
// be explained precisely (used only to pick the message, never to skip decoding).
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

// Page-aware extraction: follow /Pages -> /Contents with each page's font
// ToUnicode maps. Returns null when the document has no usable page structure so
// the caller can fall back to scanning every content stream.
function extractByPages(buf) {
  let pages;
  let doc;
  try {
    doc = parseDocument(buf);
    pages = collectPages(doc);
  } catch {
    return null;
  }
  const withContents = pages.filter((p) => p.contentRefs.length);
  if (!withContents.length) return null;
  const globalFonts = globalFontMap(doc);
  const stats = { seen: 0, mapped: 0, pages: withContents.length, fonts: 0 };
  const chunks = [];
  for (const page of withContents) {
    const refs = page.fonts.size ? page.fonts : globalFonts;
    const decoders = buildDecoders(doc, refs);
    stats.fonts = Math.max(stats.fonts, decoders.size);
    for (const ref of page.contentRefs) {
      const stream = doc.streamText(ref);
      if (stream) chunks.push(scanContentStream(stream, { fonts: decoders, stats }));
    }
  }
  return { text: chunks.join('\n'), stats };
}

// -> { ok:true, text, chars, truncated, stats? } | { ok:false, reason }
export function extractPdfText(buf, { minChars = MIN_CHARS, maxChars = MAX_CHARS } = {}) {
  let text = '';
  let stats = null;
  let crash = null;
  let fontAware = false;
  try {
    const pages = extractByPages(buf);
    if (pages) {
      text = pages.text;
      stats = pages.stats;
      fontAware = true;
    } else {
      // No page structure: scan whatever content streams exist, font-unaware.
      for (const stream of extractStreams(buf)) text += `${scanContentStream(stream)}\n`;
    }
  } catch (e) {
    crash = `stream decoding failed: ${e.message}`;
  }

  const cleaned = tidy(text);
  const seen = stats?.seen ?? 0;
  const mappedRatio = seen ? stats.mapped / seen : 1;
  const ratio = printableRatio(cleaned);
  const cidUnmapped = usesCidFontsWithoutUnicode(buf);

  // Text read WITHOUT font maps from a document that keys its text by glyph ids
  // cannot be vouched for: those bytes may be glyph ids that merely look like
  // printable ASCII. Refuse instead of handing over a plausible guess.
  if (!crash && !fontAware && cidUnmapped) {
    return { ok: false, reason: 'this PDF stores glyph ids instead of characters (CID fonts without a ToUnicode map), which needs a real PDF parser to decode' };
  }

  if (!crash && cleaned.length >= minChars && ratio >= MIN_PRINTABLE_RATIO && mappedRatio >= MIN_MAPPED_RATIO) {
    const truncated = cleaned.length > maxChars;
    return {
      ok: true,
      text: truncated ? cleaned.slice(0, maxChars) : cleaned,
      chars: cleaned.length,
      truncated,
      stats: stats
        ? { ...stats, mappedRatio: Number(mappedRatio.toFixed(3)), printableRatio: Number(ratio.toFixed(3)) }
        : undefined,
    };
  }

  // Decoding was attempted first; explain the most precise cause available.
  if (crash) return { ok: false, reason: crash };
  if (cidUnmapped) {
    return { ok: false, reason: 'this PDF stores glyph ids instead of characters (CID fonts without a ToUnicode map), which needs a real PDF parser to decode' };
  }
  if (seen >= 8 && mappedRatio < MIN_MAPPED_RATIO) {
    return { ok: false, reason: `only ${Math.round(mappedRatio * 100)}% of the text codes could be translated to characters (the rest are glyph ids without a usable ToUnicode map)` };
  }
  if (cleaned.length < minChars) {
    return { ok: false, reason: `only ${cleaned.length} characters of text could be extracted (likely a scanned or image-only PDF)` };
  }
  if (ratio < MIN_PRINTABLE_RATIO) {
    return { ok: false, reason: `extracted text is ${Math.round((1 - ratio) * 100)}% non-printable — this PDF encodes its text in a way that needs a real PDF parser; convert it to text first` };
  }
  return { ok: false, reason: 'extracted text could not be interpreted' };
}
