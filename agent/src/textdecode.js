// Child-process output decoding. Windows shells (cmd.exe / GBK codepage)
// emit bytes that are not valid UTF-8; Node's default decoding replaces them
// with U+FFFD. Decode as UTF-8 first, and when replacement characters appear,
// fall back to GBK (TextDecoder ships with full ICU in Node 20) — but only
// when GBK actually repairs the stream, so genuine UTF-8 is never re-decoded.
//
// GBK lives in the ICU data, and Node builds with small ICU (some CI images,
// minimal containers, `--with-intl=small-icu` builds) cannot decode it at all:
// `new TextDecoder('gbk')` throws or yields replacements. That is a runtime
// capability, not something we can fix — so the fallback is skipped there and the
// UTF-8 attempt stands. hasGbkSupport() reports which world we are in (tests and
// doctor use it instead of assuming).
let gbkSupport = null;

export function hasGbkSupport() {
  if (gbkSupport === null) {
    try {
      // '你' in GBK — a decoder that cannot do GBK yields U+FFFD here.
      gbkSupport = !new TextDecoder('gbk').decode(Buffer.from([0xc4, 0xe3])).includes('\uFFFD');
    } catch {
      gbkSupport = false;
    }
  }
  return gbkSupport;
}

export function decodeOutput(buf) {
  if (buf == null) return '';
  if (typeof buf === 'string') return buf; // caller already decoded (legacy path)
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  if (!hasGbkSupport()) return utf8; // small-ICU runtime: nothing better available
  try {
    const gbk = new TextDecoder('gbk').decode(bytes);
    return gbk.includes('\uFFFD') ? utf8 : gbk;
  } catch {
    return utf8;
  }
}
