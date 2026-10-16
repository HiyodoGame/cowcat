// Binary fixtures for the multimodal tests, built byte by byte rather than
// checked in. The PNG is fully valid (real CRCs, deflated IDAT); the JPEG/GIF/
// WEBP/PDF fixtures carry correct magic bytes, dimensions and segment structure —
// everything the sniffer and the PDF extractor look at — without a pixel payload.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

// A valid 8-bit RGB PNG of the requested size, painted by `pixelFn(x, y)` ->
// [r, g, b]. Default is all black.
export function makePngRgb(width, height, pixelFn = () => [0, 0, 0]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  const raw = Buffer.alloc(height * (1 + width * 3)); // filter byte 0 + RGB triples
  for (let y = 0; y < height; y++) {
    let o = y * (1 + width * 3) + 1;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function makePng(width, height) {
  return makePngRgb(width, height);
}

export function makeJpeg(width, height) {
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0]),
  ]);
  const sof = Buffer.alloc(13);
  sof[0] = 0xff;
  sof[1] = 0xc0;            // SOF0
  sof.writeUInt16BE(sof.length - 2, 2);
  sof[4] = 8;               // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;               // components
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

export function makeGif(width, height) {
  const head = Buffer.alloc(6);
  head.write('GIF89a', 0, 'latin1');
  const dims = Buffer.alloc(4);
  dims.writeUInt16LE(width, 0);
  dims.writeUInt16LE(height, 2);
  return Buffer.concat([head, dims, Buffer.from([0x80, 0x00, 0x00]), Buffer.alloc(6)]);
}

function writeUInt24LE(buf, offset, value) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
}

// RIFF/WEBP with a VP8X (extended) header chunk — the bit that carries the
// canvas size.
export function makeWebp(width, height) {
  const payload = Buffer.alloc(10);
  writeUInt24LE(payload, 4, width - 1);
  writeUInt24LE(payload, 7, height - 1);
  const chunk = Buffer.concat([
    Buffer.from('VP8X', 'latin1'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(payload.length); return b; })(),
    payload,
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(chunk.length + 4, 4);
  return Buffer.concat([riff, Buffer.from('WEBP', 'latin1'), chunk]);
}

// A structurally valid single-page PDF whose content stream is Flate-compressed
// and draws the given lines with Tj operators.
export function makePdf(lines) {  const body = `BT /F1 12 Tf 72 720 Td ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`;
  const stream = deflateSync(Buffer.from(body, 'latin1'));
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  const addObject = (n, text) => {
    offsets[n] = pdf.length;
    pdf += `${n} 0 obj\n${text}\nendobj\n`;
  };
  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  addObject(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  offsets[4] = pdf.length;
  pdf += `4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`
    + `${stream.toString('latin1')}\nendstream\nendobj\n`;
  addObject(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const xrefStart = pdf.length;
  const count = offsets.length;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// A notebook JSON string with `code`/`markdown` cells, a text output and an
// image output (the image is never attached — see the plan §1).
export function makeNotebookBuffer({ indent = '  ', eol = '\n' } = {}) {
  const nb = {
    cells: [
      {
        cell_type: 'markdown',
        metadata: {},
        source: ['# Analysis', '\n', 'Some notes.'],
      },
      {
        cell_type: 'code',
        execution_count: 3,
        metadata: {},
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['hello from stdout\n'] },
          {
            output_type: 'display_data',
            data: { 'image/png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'text/plain': '<Figure size 640x480>' },
            metadata: {},
          },
          { output_type: 'error', ename: 'ValueError', evalue: 'boom', traceback: ['ValueError: boom'] },
        ],
        source: ['print("hello")'],
      },
    ],
    metadata: { kernelspec: { name: 'python3' } },
    nbformat: 4,
    nbformat_minor: 5,
  };
  const json = JSON.stringify(nb, null, indent);
  return eol === '\n' ? `${json}\n` : `${json.replace(/\n/g, eol)}${eol}`;
}

// --- PDF fixtures ------------------------------------------------------------

// Assemble objects into a PDF container. /Length is injected for streams so the
// fixtures stay readable; the extractor never reads xref, so none is emitted.
export function assemblePdf(entries) {
  let pdf = '%PDF-1.4\n';
  for (const e of entries) {
    const body = e.stream == null ? null : (Buffer.isBuffer(e.stream) ? e.stream.toString('latin1') : e.stream);
    const dict = body == null ? e.dict : e.dict.replace('<<', `<< /Length ${body.length}`);
    pdf += `${e.num} 0 obj\n${dict}\n`;
    if (body != null) pdf += `stream\n${body}\nendstream\n`;
    pdf += 'endobj\n';
  }
  const size = Math.max(...entries.map((e) => e.num)) + 1;
  pdf += `trailer\n<< /Size ${size} >>\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// Minimal PDF whose stream bodies are planted verbatim (used to test the
// non-content stream filter).
export function pdfFixture(objects) {
  let out = '%PDF-1.4\n';
  objects.forEach((o, i) => {
    out += `${i + 1} 0 obj\n<< /Length ${o.body.length}${o.extra || ''} >>\nstream\n${o.body.toString('latin1')}\nendstream\nendobj\n`;
  });
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// Pack object bodies into an /ObjStm stream, the way PDF 1.5+ generators do
// (page and font dictionaries commonly live there).
export function packObjStm(entries, num) {
  let header = '';
  let body = '';
  for (const e of entries) {
    header += `${e.num} ${body.length} `;
    body += `${e.dict}\n`;
  }
  const first = header.length;
  return {
    num,
    dict: `<< /Type /ObjStm /N ${entries.length} /First ${first} /Filter /FlateDecode >>`,
    stream: deflateSync(Buffer.from(header + body, 'latin1')),
  };
}

// What makeCidPdf's content stream is expected to decode to.
export const CID_EXPECTED = { hi: 'Hi', cjk: '世界!', incremental: 'ABC' };

// A PDF shaped like real-world documents: a Type0 (CID) font whose strings carry
// glyph ids, translatable only through the /ToUnicode CMap.
//   codes 0001-0002 -> Hi   0003-0005 -> 世界!   0010-0012 -> ABC
// The second Tj is the same "Hi" as an escaped literal string — note the codes
// must be written as full two-byte units (\000\001\000\002), because with
// Identity-H a literal string is read two bytes at a time; \001\002 would be the
// single (unmapped) code 0x0102. With `viaObjStm` the page and font dictionaries
// are packed into an object stream.
export function makeCidPdf({ withToUnicode = true, viaObjStm = false } = {}) {
  const content = [
    'BT /F1 24 Tf 72 700 Td <00010002> Tj ET',
    'BT /F1 24 Tf 72 660 Td (\\000\\001\\000\\002) Tj ET',
    'BT /F1 24 Tf 72 620 Td <000300040005> Tj ET',
    'BT /F1 24 Tf 72 580 Td <001000110012> Tj ET',
  ].join('\n');
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    '2 beginbfchar <0001> <0048> <0002> <0069> endbfchar',
    '1 beginbfrange <0003> <0005> [<4E16> <754C> <0021>] endbfrange',
    '1 beginbfrange <0010> <0012> <0041> endbfrange',
    'endcmap end end',
  ].join('\n');
  const page = { num: 3, dict: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>' };
  const font = { num: 5, dict: `<< /Type /Font /Subtype /Type0 /BaseFont /Sub /Encoding /Identity-H /DescendantFonts [6 0 R]${withToUnicode ? ' /ToUnicode 8 0 R' : ''} >>` };
  const entries = [
    { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 4, dict: '<< /Filter /FlateDecode >>', stream: deflateSync(Buffer.from(content, 'latin1')) },
    { num: 6, dict: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Sub /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>' },
    ...(withToUnicode ? [{ num: 8, dict: '<< /Filter /FlateDecode >>', stream: deflateSync(Buffer.from(cmap, 'latin1')) }] : []),
  ];
  if (viaObjStm) entries.push(packObjStm([page, font], 9));
  else entries.push(page, font);
  return assemblePdf(entries.sort((a, b) => a.num - b.num));
}
