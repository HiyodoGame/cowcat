/**
 * File-kind sniffing by magic bytes, plus the little metadata `Read` needs to describe
 * what it attached (ADR-057). Pure functions over a Buffer: no I/O, no vendor SDK.
 *
 * Why magic instead of the extension: `Read` must not hand a renamed binary to the model
 * as text, and it must not refuse a real PNG that happens to lack an extension. The
 * extension is only a cross-check, so a mismatch can be *said* rather than guessed at.
 *
 * Ported from v1's `agent/src/imageinfo.js`, minus its token estimation: v2 records real
 * usage (`model.usage`, ADR-041) and an estimate with no consumer is a number that drifts
 * away from the truth (the same reason `Attachment` dropped `tokens`).
 */

export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp';

export type Sniffed =
  | {
      readonly kind: ImageKind;
      readonly mediaType: string;
      /** `null` when the header could not be parsed — "not reported", never a guess. */
      readonly width: number | null;
      readonly height: number | null;
    }
  | { readonly kind: 'pdf'; readonly mediaType: 'application/pdf'; readonly pages: number }
  /**
   * A format we can identify but cannot send: both protocols accept png/jpeg/gif/webp
   * (and Anthropic a PDF). Naming the format is the difference between "unsupported" and
   * "unsupported, and here is what it is".
   */
  | { readonly kind: 'image-unsupported'; readonly format: string }
  | { readonly kind: 'text' }
  | { readonly kind: 'binary' };

export const IMAGE_MEDIA_TYPES: Readonly<Record<ImageKind, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Formats we can identify but not send upstream. */
const UNSUPPORTED_IMAGE_FORMATS: readonly { readonly name: string; readonly test: (b: Buffer) => boolean }[] = [
  { name: 'bmp', test: (b) => startsWith(b, [0x42, 0x4d]) },
  // TIFF says `II*\0` or `MM\0*`; the marker byte is what keeps this from matching any
  // file that merely starts with two identical ASCII bytes.
  { name: 'tiff', test: (b) => startsWith(b, [0x49, 0x49, 0x2a]) || startsWith(b, [0x4d, 0x4d, 0x2a]) },
  { name: 'ico', test: (b) => startsWith(b, [0x00, 0x00, 0x01, 0x00]) },
  {
    name: 'avif',
    test: (b) => b.toString('latin1', 4, 8) === 'ftyp' && b.toString('latin1', 8, 12) === 'avif',
  },
  {
    name: 'heic',
    test: (b) => b.toString('latin1', 4, 8) === 'ftyp' && /^hei[cf]$/.test(b.toString('latin1', 8, 12)),
  },
];

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  return buffer.length >= bytes.length && buffer.subarray(0, bytes.length).equals(Buffer.from(bytes));
}

interface Size {
  readonly width: number;
  readonly height: number;
}

/** PNG: 8-byte signature, then IHDR — width/height are the first two 4-byte BE fields. */
function pngSize(buffer: Buffer): Size | null {
  if (buffer.length < 24) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** JPEG: walk the segment chain to the first SOF marker (C0-CF except DHT/JPG/DAC). */
function jpegSize(buffer: Buffer): Size | null {
  let position = 2;
  while (position + 9 <= buffer.length) {
    if (buffer.readUInt8(position) !== 0xff) {
      position += 1;
      continue;
    }
    const marker = buffer.readUInt8(position + 1);
    if (marker === 0xff) {
      position += 1;
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      position += 2;
      continue;
    }
    if (position + 4 > buffer.length) return null;
    const length = buffer.readUInt16BE(position + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(position + 5), width: buffer.readUInt16BE(position + 7) };
    }
    position += 2 + length;
  }
  return null;
}

/** WEBP: a RIFF container with three possible dimension encodings. */
function webpSize(buffer: Buffer): Size | null {
  if (buffer.length < 30) return null;
  const fourcc = buffer.toString('latin1', 12, 16);
  if (fourcc === 'VP8X') {
    return {
      width: 1 + (buffer.readUInt8(24) | (buffer.readUInt8(25) << 8) | (buffer.readUInt8(26) << 16)),
      height: 1 + (buffer.readUInt8(27) | (buffer.readUInt8(28) << 8) | (buffer.readUInt8(29) << 16)),
    };
  }
  if (fourcc === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    const packed = buffer.readUInt32LE(21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function gifSize(buffer: Buffer): Size | null {
  if (buffer.length < 10) return null;
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

/**
 * Best-effort page count: `/Type /Page` (not `/Pages`) in the raw bytes. PDF 1.5+ object
 * streams compress this away, and then the count is 0 — which the attachment records as
 * "not reported" rather than as "no pages".
 */
export function countPdfPages(buffer: Buffer): number {
  const matches = buffer.toString('latin1').match(/\/Type\s*\/Page(?![s])/g);
  return matches === null ? 0 : matches.length;
}

export function sniffBuffer(buffer: Buffer): Sniffed {
  if (buffer.length === 0) return { kind: 'binary' };

  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const size = pngSize(buffer);
    return { kind: 'png', mediaType: IMAGE_MEDIA_TYPES.png, width: size?.width ?? null, height: size?.height ?? null };
  }
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    const size = jpegSize(buffer);
    return { kind: 'jpeg', mediaType: IMAGE_MEDIA_TYPES.jpeg, width: size?.width ?? null, height: size?.height ?? null };
  }
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) {
    const size = gifSize(buffer);
    return { kind: 'gif', mediaType: IMAGE_MEDIA_TYPES.gif, width: size?.width ?? null, height: size?.height ?? null };
  }
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && buffer.toString('latin1', 8, 12) === 'WEBP') {
    const size = webpSize(buffer);
    return { kind: 'webp', mediaType: IMAGE_MEDIA_TYPES.webp, width: size?.width ?? null, height: size?.height ?? null };
  }
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) {
    return { kind: 'pdf', mediaType: 'application/pdf', pages: countPdfPages(buffer) };
  }
  for (const format of UNSUPPORTED_IMAGE_FORMATS) {
    if (format.test(buffer)) return { kind: 'image-unsupported', format: format.name };
  }
  if (buffer.includes(0)) return { kind: 'binary' };
  return { kind: 'text' };
}

export function isImageKind(kind: string): kind is ImageKind {
  return kind === 'png' || kind === 'jpeg' || kind === 'gif' || kind === 'webp';
}

/**
 * Extension → kind, used only to cross-check what the bytes say. A name that promises an
 * image but whose content is not one is a case worth *saying*: the alternative is handing
 * the bytes to the model as text, which is how a transcript gets silently corrupted.
 */
export function kindFromExtension(filePath: string): ImageKind | 'pdf' | 'image-unsupported' | null {
  const extension = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'jpeg';
  if (extension === 'png' || extension === 'gif' || extension === 'webp' || extension === 'pdf') return extension;
  if (extension === 'bmp' || extension === 'tif' || extension === 'tiff' || extension === 'ico' || extension === 'avif' || extension === 'heic') {
    return 'image-unsupported';
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `WxH`, or an empty string when the header did not say. */
export function describeDimensions(width: number | null, height: number | null): string {
  if (width === null || height === null || width <= 0 || height <= 0) return '';
  return `${String(width)}x${String(height)}`;
}
