// Child-process output decoding. Windows shells (cmd.exe / GBK codepage)
// emit bytes that are not valid UTF-8; Node's default decoding replaces them
// with U+FFFD. Decode as UTF-8 first, and when replacement characters appear,
// fall back to GBK (TextDecoder ships with full ICU in Node 20) — but only
// when GBK actually repairs the stream, so genuine UTF-8 is never re-decoded.
export function decodeOutput(buf) {
  if (buf == null) return '';
  if (typeof buf === 'string') return buf; // caller already decoded (legacy path)
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const gbk = new TextDecoder('gbk').decode(bytes);
    return gbk.includes('\uFFFD') ? utf8 : gbk;
  } catch {
    return utf8;
  }
}
