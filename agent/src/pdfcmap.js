// ToUnicode CMap parsing. A ToUnicode CMap is the bridge from the codes stored in
// a PDF string to actual characters: with CID/Identity encodings the bytes in
// `(...)`/`<...>` are glyph ids, and without this map they decode to garbage
// (which is why real-world PDFs were refused before this existed).
//
// The mapping lives in a stream of the form:
//   /CIDInit /ProcSet findresource begin 12 dict begin begincmap
//   1 begincodespacerange <0000> <FFFF> endcodespacerange
//   2 beginbfchar <0001> <0048> <0002> <0069> endbfchar
//   1 beginbfrange <0003> <0005> [<4E16> <754C> <0021>] endbfrange
//   endcmap end end
//
// Destinations are UTF-16BE. bfrange loops increment the last code unit, which is
// correct for the BMP (the overwhelmingly common case); ranges that step across
// surrogate pairs are not representable this way and are simply not produced.

function hexToBytes(hex) {
  const clean = String(hex || '').replace(/[^0-9A-Fa-f]/g, '');
  const even = clean.length % 2 ? `${clean}0` : clean;
  const out = [];
  for (let i = 0; i < even.length; i += 2) out.push(parseInt(even.slice(i, i + 2), 16));
  return out;
}

// UTF-16BE (the spec) with a tolerant fallback: some writers emit a single byte
// for ASCII destinations, e.g. <20> instead of <0020>.
export function utf16beToString(hex) {
  const bytes = hexToBytes(hex);
  if (bytes.length === 0) return '';
  if (bytes.length === 1) return String.fromCharCode(bytes[0]);
  const buf = Buffer.from(bytes);
  let out = '';
  for (let i = 0; i + 1 < buf.length; i += 2) out += String.fromCharCode(buf.readUInt16BE(i));
  return out;
}

function utf16beCodes(hex) {
  const bytes = hexToBytes(hex);
  if (bytes.length <= 1) return [bytes.length ? bytes[0] : 0];
  const buf = Buffer.from(bytes);
  const codes = [];
  for (let i = 0; i + 1 < buf.length; i += 2) codes.push(buf.readUInt16BE(i));
  return codes;
}

function sections(text, begin, end) {
  const out = [];
  let i = 0;
  for (;;) {
    const b = text.indexOf(begin, i);
    if (b === -1) return out;
    const e = text.indexOf(end, b + begin.length);
    if (e === -1) return out;
    out.push(text.slice(b + begin.length, e));
    i = e + end.length;
  }
}

const HEX_PAIR_RE = /<([0-9A-Fa-f\s]*)>\s*<([0-9A-Fa-f\s]*)>/g;
const RANGE_RE = /<([0-9A-Fa-f\s]*)>\s*<([0-9A-Fa-f\s]*)>\s*(<[0-9A-Fa-f\s]*>|\[[^\]]*\])/g;

// -> { map: Map<code, string>, codeBytes: 1|2 }
// `cidHint` says the font is a CID font (2-byte codes) when the CMap itself does
// not declare a codespace — which happens in the wild.
export function parseToUnicodeCMap(text, { cidHint = false } = {}) {
  const src = String(text || '');
  const map = new Map();
  let codeBytes = 0;

  for (const block of sections(src, 'begincodespacerange', 'endcodespacerange')) {
    const m = /<([0-9A-Fa-f\s]*)>/.exec(block);
    if (m) {
      const bytes = hexToBytes(m[1]).length;
      if (bytes === 1 || bytes === 2) { codeBytes = bytes; break; }
    }
  }

  for (const block of sections(src, 'beginbfchar', 'endbfchar')) {
    for (const m of block.matchAll(HEX_PAIR_RE)) {
      const code = parseInt(m[1].replace(/\s+/g, ''), 16);
      if (!Number.isFinite(code)) continue;
      map.set(code, utf16beToString(m[2]));
    }
  }

  for (const block of sections(src, 'beginbfrange', 'endbfrange')) {
    for (const m of block.matchAll(RANGE_RE)) {
      const lo = parseInt(m[1].replace(/\s+/g, ''), 16);
      const hi = parseInt(m[2].replace(/\s+/g, ''), 16);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) continue;
      const dst = m[3];
      if (dst.startsWith('[')) {
        const items = [...dst.matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((x) => utf16beToString(x[1]));
        items.forEach((s, i) => { if (lo + i <= hi) map.set(lo + i, s); });
        continue;
      }
      const base = utf16beCodes(dst.slice(1, -1));
      if (!base.length) continue;
      for (let code = lo; code <= hi && code - lo < 65536; code++) {
        const codes = base.slice();
        codes[codes.length - 1] += (code - lo);
        map.set(code, String.fromCharCode(...codes));
      }
    }
  }

  return { map, codeBytes: codeBytes || (cidHint ? 2 : 1) };
}
