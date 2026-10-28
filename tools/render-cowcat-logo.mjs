import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { mascotFrame } from '../packages/tui/dist/src/components/cowcat-art.js';

const width = 28 * 20;
const height = 20 * 20;
const palette = {
  fur: [247, 245, 240, 255], patch: [20, 20, 25, 255], nose: [232, 160, 160, 255], eye: [168, 195, 74, 255],
};
const pixels = mascotFrame('idle', 0);
const raw = Buffer.alloc((width * 4 + 1) * height);
for (let y = 0; y < height; y += 1) {
  const row = Math.floor(y / 20);
  const offset = y * (width * 4 + 1);
  raw[offset] = 0;
  for (let x = 0; x < width; x += 1) {
    const color = palette[pixels[row]?.[Math.floor(x / 20)] ?? null] ?? [0, 0, 0, 0];
    raw.set(color, offset + 1 + x * 4);
  }
}
writeFileSync('docs/brand/cowcat-avatar.png', png(width, height, raw));

function png(w, h, data) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(data, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 'ascii');
  data.copy(result, 8);
  result.writeInt32BE(crc32(result.subarray(4, data.length + 8)), data.length + 8);
  return result;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) | 0;
}
