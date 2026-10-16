// A deliberately small PDF object layer — just enough structure to find pages,
// their content streams and their font ToUnicode maps. Not a conforming parser:
// it works on the file as a latin1 string (byte-preserving), understands classic
// `N 0 obj ... endobj` objects plus objects packed inside /ObjStm streams (where
// modern generators put page and font dictionaries), and extracts values from
// dictionaries with balanced-brace scanning.
import { inflateSync, inflateRawSync } from 'node:zlib';
import { parseToUnicodeCMap } from './pdfcmap.js';

const MAX_OBJECT_BYTES = 8 * 1024 * 1024;

function matchBalanced(text, start, open, close) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '(') { // strings can contain << or [ and must not confuse the scan
      let d = 1;
      i++;
      while (i < text.length && d > 0) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '(') d++;
        else if (text[i] === ')') d--;
        i++;
      }
      continue;
    }
    if (text.startsWith(open, i)) { depth++; i += open.length; continue; }
    if (text.startsWith(close, i)) { depth--; i += close.length; if (depth === 0) return i; continue; }
    i++;
  }
  return -1;
}

function skipSpace(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

// Value following /key in a dictionary text.
// -> { type:'dict'|'array'|'ref'|'name'|'number', text?, num?, value? } | null
export function dictValue(text, key) {
  const re = new RegExp(`/${key}(?![A-Za-z0-9_])`);
  const m = re.exec(text);
  if (!m) return null;
  const i = skipSpace(text, m.index + m[0].length);
  if (text.startsWith('<<', i)) {
    const end = matchBalanced(text, i, '<<', '>>');
    return end === -1 ? null : { type: 'dict', text: text.slice(i + 2, end - 2) };
  }
  if (text[i] === '[') {
    const end = matchBalanced(text, i, '[', ']');
    return end === -1 ? null : { type: 'array', text: text.slice(i + 1, end - 1) };
  }
  if (text[i] === '/') {
    const name = /^\/[^\s/<>[\](){}]*/.exec(text.slice(i));
    return name ? { type: 'name', text: name[0].slice(1) } : null;
  }
  const ref = /^(\d+)\s+\d+\s+R\b/.exec(text.slice(i));
  if (ref) return { type: 'ref', num: Number(ref[1]) };
  const num = /^[-+]?\d*\.?\d+/.exec(text.slice(i));
  if (num) return { type: 'number', value: Number(num[0]) };
  return null;
}

function splitStream(body) {
  const sm = /stream\r?\n/.exec(body);
  if (!sm) return { dict: body, stream: null };
  const start = sm.index + sm[0].length;
  let end = body.indexOf('endstream', start);
  if (end === -1) end = body.length;
  let s = body.slice(start, end);
  if (s.endsWith('\r\n')) s = s.slice(0, -2);
  else if (s.endsWith('\n') || s.endsWith('\r')) s = s.slice(0, -1);
  return { dict: body.slice(0, sm.index), stream: s };
}

export function parseDocument(buf) {
  const raw = buf.toString('latin1');
  const objects = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (Number(m[2]) !== 0) continue; // generation 0 is the only one we meet in practice
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const endIdx = raw.indexOf('endobj', bodyStart);
    if (endIdx === -1) continue;
    objects.set(num, splitStream(raw.slice(bodyStart, Math.min(endIdx, bodyStart + MAX_OBJECT_BYTES))));
    re.lastIndex = endIdx; // do not match `obj` sequences inside stream payloads
  }

  const doc = {
    objects,
    streamText(num) {
      const o = objects.get(num);
      if (!o || o.stream == null) return null;
      if (o.decoded !== undefined) return o.decoded;
      let text = null;
      if (/\/FlateDecode/.test(o.dict)) {
        const bytes = Buffer.from(o.stream, 'latin1');
        try { text = inflateSync(bytes).toString('latin1'); }
        catch { try { text = inflateRawSync(bytes).toString('latin1'); } catch { text = null; } }
      } else {
        text = o.stream;
      }
      o.decoded = text;
      return text;
    },
    objectText(num) {
      const o = objects.get(num);
      return o ? o.dict : null;
    },
  };

  // Objects packed inside object streams: a header of `objNum offset` pairs, then
  // the object bodies concatenated after /First.
  for (const [num, obj] of [...objects]) {
    if (obj.stream == null || !/\/Type\s*\/ObjStm/.test(obj.dict)) continue;
    const text = doc.streamText(num);
    if (!text) continue;
    const declared = Number((/\/N\s+(\d+)/.exec(obj.dict) || [])[1] || 0);
    const first = Number((/\/First\s+(\d+)/.exec(obj.dict) || [])[1] || 0);
    if (!first || first > text.length) continue;
    const pairs = [...text.slice(0, first).matchAll(/(\d+)\s+(\d+)/g)].map((p) => ({ num: Number(p[1]), off: Number(p[2]) }));
    const count = declared ? Math.min(declared, pairs.length) : pairs.length;
    for (let i = 0; i < count; i++) {
      if (objects.has(pairs[i].num)) continue; // a classic object always wins
      const start = first + pairs[i].off;
      const end = i + 1 < count ? first + pairs[i + 1].off : text.length;
      objects.set(pairs[i].num, { dict: text.slice(start, end), stream: null });
    }
  }

  return doc;
}

// /Font << /F1 5 0 R >> -> Map<'F1', 5>
export function fontMapOf(doc, dictText) {
  let res = dictValue(dictText, 'Resources');
  if (res?.type === 'ref') {
    const o = doc.objectText(res.num);
    res = o == null ? null : { type: 'dict', text: o };
  }
  if (res?.type !== 'dict') return new Map();
  const font = dictValue(res.text, 'Font');
  if (font?.type !== 'dict') return new Map();
  const map = new Map();
  for (const m of font.text.matchAll(/\/([A-Za-z0-9+._-]+)\s+(\d+)\s+0\s+R/g)) map.set(m[1], Number(m[2]));
  return map;
}

// Pages in document order where possible, each with its content stream refs and
// font resource map. /Resources may be inherited from the page tree, so callers
// fall back to a document-wide font map when a page has none of its own.
export function collectPages(doc) {
  const pages = [];
  const nums = [...doc.objects.keys()].sort((a, b) => a - b);
  for (const num of nums) {
    const dict = doc.objectText(num);
    if (!dict || !/\/Type\s*\/Page(?![s])/.test(dict)) continue;
    const contents = dictValue(dict, 'Contents');
    const contentRefs = [];
    if (contents?.type === 'ref') contentRefs.push(contents.num);
    else if (contents?.type === 'array') {
      for (const m of contents.text.matchAll(/(\d+)\s+0\s+R/g)) contentRefs.push(Number(m[1]));
    }
    pages.push({ num, contentRefs, fonts: fontMapOf(doc, dict) });
  }
  return pages;
}

// Merge every /Font dictionary in the document — the fallback when a page
// inherits /Resources from its parent node.
export function globalFontMap(doc) {
  const merged = new Map();
  for (const num of doc.objects.keys()) {
    const dict = doc.objectText(num);
    if (!dict) continue;
    for (const [name, ref] of fontMapOf(doc, dict)) if (!merged.has(name)) merged.set(name, ref);
  }
  return merged;
}

// Per-resource-name string decoder, built from each font's /ToUnicode CMap.
//   { map, codeBytes }            -> codes translate to characters
//   { map: null, cid: true }      -> CID font without a usable map: its codes are
//                                    glyph ids, so decoding MUST NOT fall back to
//                                    latin1 (that is what produced mojibake)
//   null                          -> unknown/simple font: caller may try latin1
export function buildDecoders(doc, fontRefs) {
  const decoders = new Map();
  for (const [name, ref] of fontRefs) {
    const dict = doc.objectText(ref);
    if (!dict) continue;
    const cid = /\/Subtype\s*\/Type0/.test(dict);
    const toUnicode = dictValue(dict, 'ToUnicode');
    const cmapText = toUnicode?.type === 'ref' ? doc.streamText(toUnicode.num) : null;
    if (cmapText) {
      const parsed = parseToUnicodeCMap(cmapText, { cidHint: cid });
      decoders.set(name, { map: parsed.map, codeBytes: parsed.codeBytes, cid });
    } else if (cid) {
      decoders.set(name, { map: null, cid: true, codeBytes: 2 });
    } else {
      decoders.set(name, null);
    }
  }
  return decoders;
}
