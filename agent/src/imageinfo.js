// File-kind sniffing by magic bytes, plus image dimension parsing and token
// estimation. Pure functions over a Buffer — no deps, no I/O, no side effects.
//
// Why magic bytes instead of the extension: `Read` must not hand a renamed
// binary to the model, and it must not refuse a real PNG that happens to lack
// an extension. The extension is only used as a cross-check (see readkind.js
// callers) so we can say "the name says .png but the content is not an image".
//
// Token estimates follow Anthropic's published formula for images
// (tokens ≈ width * height / 750) and are only used for /context and the
// compact budget — they are deliberately NOT claimed to be exact.
import { extname } from 'node:path';

const IMAGE_MEDIA_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// Formats we can identify but cannot send upstream (Anthropic accepts
// png/jpeg/gif/webp only).
const UNSUPPORTED_IMAGE_FORMATS = [
  { name: 'bmp', test: (b) => b.length > 2 && b[0] === 0x42 && b[1] === 0x4d },
  { name: 'tiff', test: (b) => b.length > 4 && ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d)) && b[2] === 0x2a },
  { name: 'ico', test: (b) => b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 },
  { name: 'avif', test: (b) => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' && b.toString('latin1', 8, 12) === 'avif' },
  { name: 'heic', test: (b) => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^hei[cf]$/.test(b.toString('latin1', 8, 12)) },
];

function hasPrefix(buf, bytes, offset = 0) {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[offset + i] !== bytes[i]) return false;
  return true;
}

// PNG: 8-byte signature, then IHDR (width/height are the first two 4-byte BE
// fields of the chunk data at offset 16/20).
function pngSize(buf) {
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// JPEG: walk the segment chain to the first SOF (start-of-frame) marker.
// SOF markers are C0-CF except C4 (DHT), C8 (JPG) and CC (DAC).
function jpegSize(buf) {
  let p = 2;
  while (p + 9 <= buf.length) {
    if (buf[p] !== 0xff) { p++; continue; }
    const marker = buf[p + 1];
    if (marker === 0xff) { p++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    if (p + 4 > buf.length) return null;
    const len = buf.readUInt16BE(p + 2);
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
    }
    p += 2 + len;
  }
  return null;
}

// WEBP: RIFF container, three possible dimension encodings.
function webpSize(buf) {
  if (buf.length < 30) return null;
  const fourcc = buf.toString('latin1', 12, 16);
  if (fourcc === 'VP8X') {
    return {
      width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
      height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
    };
  }
  if (fourcc === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    const packed = buf.readUInt32LE(21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function gifSize(buf) {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

// Best-effort page count for PDFs: counts `/Type /Page` (not `/Pages`) in the
// raw bytes. PDF 1.5+ object streams compress this away, in which case we fall
// back to a flat estimate — the number only feeds the context budget.
export function countPdfPages(buf) {
  const text = buf.toString('latin1');
  const m = text.match(/\/Type\s*\/Page(?![s])/g);
  return m ? m.length : 0;
}

// Identify what a buffer actually is.
// -> { kind: 'png'|'jpeg'|'gif'|'webp'|'pdf'|'image-unsupported'|'text'|'binary',
//      mediaType?: string, width?, height?, format? }
export function sniffBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return { kind: 'binary' };
  if (hasPrefix(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'png', mediaType: IMAGE_MEDIA_TYPES.png, ...pngSize(buf) };
  }
  if (hasPrefix(buf, [0xff, 0xd8, 0xff])) {
    return { kind: 'jpeg', mediaType: IMAGE_MEDIA_TYPES.jpeg, ...jpegSize(buf) };
  }
  if (hasPrefix(buf, [0x47, 0x49, 0x46, 0x38])) { // GIF8
    return { kind: 'gif', mediaType: IMAGE_MEDIA_TYPES.gif, ...gifSize(buf) };
  }
  if (hasPrefix(buf, [0x52, 0x49, 0x46, 0x46]) && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { kind: 'webp', mediaType: IMAGE_MEDIA_TYPES.webp, ...webpSize(buf) };
  }
  if (hasPrefix(buf, [0x25, 0x50, 0x44, 0x46])) { // %PDF
    return { kind: 'pdf', mediaType: 'application/pdf', pages: countPdfPages(buf) };
  }
  for (const f of UNSUPPORTED_IMAGE_FORMATS) {
    if (f.test(buf)) return { kind: 'image-unsupported', format: f.name };
  }
  if (buf.includes(0)) return { kind: 'binary' };
  return { kind: 'text' };
}

export function isImageKind(kind) {
  return typeof kind === 'string' && (kind in IMAGE_MEDIA_TYPES || kind === 'image-unsupported');
}

// Extension -> kind, used only to cross-check the sniffed content.
export function kindFromExtension(filePath) {
  const ext = extname(String(filePath || '')).toLowerCase().replace(/^\./, '');
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (ext === 'png' || ext === 'gif' || ext === 'webp' || ext === 'pdf') return ext;
  if (ext === 'bmp' || ext === 'tif' || ext === 'tiff' || ext === 'ico' || ext === 'avif' || ext === 'heic') return 'image-unsupported';
  return null;
}

// Anthropic resizes an image so its long edge is at most 1568px before charging
// tokens, so the estimate has to use the resized geometry — counting a 3840px
// wide screenshot at full size overstates its cost several times over.
export const MAX_IMAGE_EDGE = 1568;

// Anthropic's formula for image tokens; unknown dimensions fall back to a flat
// 1MP-class estimate rather than pretending to be exact.
export function estimateImageTokens({ kind, width, height, pages, bytes } = {}) {
  if (kind === 'pdf') {
    return pages > 0 ? Math.min(pages, 100) * 1500 : 2000;
  }
  if (width > 0 && height > 0) {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    return Math.max(1, Math.ceil((w * h) / 750));
  }
  if (bytes > 0) return 1600;
  return 0;
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

export function describeDimensions(info) {
  if (!info) return '';
  if (info.pages > 0) return `${info.pages} page${info.pages === 1 ? '' : 's'}`;
  if (info.width > 0 && info.height > 0) return `${info.width}x${info.height}`;
  return '';
}
