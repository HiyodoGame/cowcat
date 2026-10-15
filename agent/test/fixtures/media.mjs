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

// A valid 8-bit RGB PNG of the requested size (all pixels black).
export function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  const raw = Buffer.alloc(height * (1 + width * 3)); // filter byte 0 + RGB triples
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
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
export function makePdf(lines) {
  const body = `BT /F1 12 Tf 72 720 Td ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`;
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
