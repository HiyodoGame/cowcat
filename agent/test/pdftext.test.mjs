// ToUnicode CMap decoding (the layer that makes real-world PDFs readable).
// The fixtures are the shape real documents have: a Type0/CID font whose strings
// carry glyph ids that only /ToUnicode can translate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import { parseToUnicodeCMap, utf16beToString } from '../src/pdfcmap.js';
import { parseDocument, dictValue, collectPages, fontMapOf, globalFontMap, buildDecoders } from '../src/pdfobj.js';
import { extractPdfText, scanContentStream, MIN_CHARS } from '../src/pdftext.js';
import { makeCidPdf, pdfFixture, assemblePdf, CID_EXPECTED, makePdf } from './fixtures/media.mjs';

// --- CMap parsing ------------------------------------------------------------

test('cmap: bfchar, bfrange array and incrementing bfrange', () => {
  const cmap = [
    '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    '2 beginbfchar <0001> <0048> <0002> <0069> endbfchar',
    '1 beginbfrange <0003> <0005> [<4E16> <754C> <0021>] endbfrange',
    '1 beginbfrange <0010> <0012> <0041> endbfrange',
    'endcmap',
  ].join('\n');
  const { map, codeBytes } = parseToUnicodeCMap(cmap);
  assert.equal(codeBytes, 2);
  assert.equal(map.get(0x0001), 'H');
  assert.equal(map.get(0x0002), 'i');
  assert.deepEqual([map.get(0x0003), map.get(0x0004), map.get(0x0005)], ['世', '界', '!']);
  assert.deepEqual([map.get(0x10), map.get(0x11), map.get(0x12)], ['A', 'B', 'C']);
});

test('cmap: destinations decode as UTF-16BE, single-byte writer forms tolerated', () => {
  assert.equal(utf16beToString('0048'), 'H');
  assert.equal(utf16beToString('4E16'), '世');
  assert.equal(utf16beToString('00480069'), 'Hi');
  assert.equal(utf16beToString('41'), 'A', 'some writers emit one byte for ASCII');
  assert.equal(utf16beToString(''), '');
  // a ligature-style multi-codepoint destination survives intact
  const { map } = parseToUnicodeCMap('1 beginbfchar <0007> <00660069> endbfchar');
  assert.equal(map.get(7), 'fi');
});

test('cmap: a codespace of one byte means one-byte codes', () => {
  const { codeBytes } = parseToUnicodeCMap('1 begincodespacerange <00> <ff> endcodespacerange');
  assert.equal(codeBytes, 1);
});

// --- object layer ------------------------------------------------------------

test('objects: classic objects, dictionaries and stream inflation', () => {
  const doc = parseDocument(makePdf(['hello there, this sentence is long enough to matter.']));
  const page = [...doc.objects.keys()].find((n) => /\/Type\s*\/Page(?![s])/.test(doc.objectText(n)));
  assert.ok(page, 'page object found');
  assert.equal(dictValue(doc.objectText(page), 'Type').text, 'Page');
  const contents = dictValue(doc.objectText(page), 'Contents');
  assert.equal(contents.type, 'ref');
  assert.match(doc.streamText(contents.num), /hello there/);
});

test('objects: dictionaries inside /ObjStm are readable', () => {
  const pdf = makeCidPdf({ viaObjStm: true });
  const doc = parseDocument(pdf);
  assert.ok([...doc.objects.values()].some((o) => /\/Type\s*\/ObjStm/.test(o.dict)), 'object stream present');
  const pages = collectPages(doc);
  assert.equal(pages.length, 1, 'the page dictionary was recovered from the object stream');
  assert.deepEqual([...pages[0].fonts.keys()], ['F1'], 'font resource map came from the packed page dict');
  const decoders = buildDecoders(doc, pages[0].fonts);
  assert.equal(decoders.get('F1').map.get(0x0003), '世', 'the packed font dict resolved its ToUnicode stream');
});

test('objects: font resources resolve through a /Resources reference too', () => {
  const pdf = assemblePdf([
    { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, dict: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources 7 0 R >>' },
    { num: 4, dict: '<< /Filter /FlateDecode >>', stream: deflateSync(Buffer.from('BT /F1 12 Tf 10 10 Td (Hello there, a fairly long sentence for the gate) Tj ET', 'latin1')) },
    { num: 7, dict: '<< /Font << /F1 5 0 R >> >>' },
    { num: 5, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
  ]);
  const doc = parseDocument(pdf);
  assert.deepEqual([...fontMapOf(doc, doc.objectText(3)).keys()], ['F1'], 'indirect /Resources is followed');
  const r = extractPdfText(pdf);
  assert.equal(r.ok, true);
  assert.match(r.text, /Hello there/);
});

test('objects: a page without its own /Resources falls back to the document map', () => {
  const pdf = assemblePdf([
    { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Resources << /Font << /F1 5 0 R >> >> >>' },
    { num: 3, dict: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>' },
    { num: 4, dict: '<< /Filter /FlateDecode >>', stream: deflateSync(Buffer.from('BT /F1 12 Tf 10 10 Td (Inherited resources are common in the wild) Tj ET', 'latin1')) },
    { num: 5, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
  ]);
  const doc = parseDocument(pdf);
  assert.equal(collectPages(doc)[0].fonts.size, 0, 'page itself declares no fonts');
  assert.equal(globalFontMap(doc).get('F1'), 5, 'document-wide map has it');
  assert.equal(extractPdfText(pdf).ok, true);
});

// --- end-to-end decoding -----------------------------------------------------

test('extract: a CID font with a ToUnicode map decodes to real characters', () => {
  const r = extractPdfText(makeCidPdf(), { minChars: 10 });
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.match(r.text, new RegExp(CID_EXPECTED.hi));
  assert.match(r.text, new RegExp(CID_EXPECTED.cjk));
  assert.match(r.text, new RegExp(CID_EXPECTED.incremental));
  assert.equal(r.stats.mappedRatio, 1, 'every code translated');
  assert.equal(r.stats.printableRatio, 1);
});

test('extract: the same decoding works when the dictionaries live in an object stream', () => {
  const r = extractPdfText(makeCidPdf({ viaObjStm: true }), { minChars: 10 });
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.match(r.text, new RegExp(CID_EXPECTED.cjk));
  assert.match(r.text, new RegExp(CID_EXPECTED.incremental));
});

test('extract: the literal-string path uses the font map too (not Latin-1)', () => {
  // The fixture's second Tj is (\001\002): 0x01/0x02 are control bytes, so any
  // Latin-1 fallback would produce unprintable junk instead of "Hi".
  const r = extractPdfText(makeCidPdf(), { minChars: 10 });
  const lines = r.text.split('\n');
  assert.equal(lines.filter((l) => l === CID_EXPECTED.hi).length, 2, 'hex and literal strings both decoded');
});

test('extract: a CID font without a ToUnicode map is refused, never Latin-1 guessed', () => {
  const r = extractPdfText(makeCidPdf({ withToUnicode: false }), { minChars: 10 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /glyph ids instead of characters/);
});

test('extract: partial coverage below the threshold is refused as unreliable', () => {
  // A map that translates only a couple of codes: the rest look "printable"
  // (0x41/0x42 are A/B) but are really glyph ids, so the result must not pass.
  const page = { num: 3, dict: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>' };
  const font = { num: 5, dict: '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 8 0 R >>' };
  const content = `BT /F1 12 Tf 10 10 Td <41004200430044004500460047004800> Tj ET`;
  const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n2 beginbfchar <4100> <0041> <4200> <0042> endbfchar';
  const pdf = assemblePdf([
    { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    page,
    { num: 4, dict: '<< /Filter /FlateDecode >>', stream: deflateSync(Buffer.from(content, 'latin1')) },
    font,
    { num: 8, dict: '<< /Filter /FlateDecode >>', stream: deflateSync(Buffer.from(cmap, 'latin1')) },
  ]);
  const r = extractPdfText(pdf);
  assert.equal(r.ok, false);
  assert.match(r.reason, /could be translated to characters/);
});

test('extract: a simple font with a ToUnicode map decodes one byte at a time', () => {
  // This is the shape the 1MB English spec had: no CID fonts at all, but every
  // font carries a ToUnicode map.
  const cmap = [
    '1 begincodespacerange <00> <ff> endcodespacerange',
    '3 beginbfchar <48> <0048> <65> <0065> <79> <0079> endbfchar',
  ].join('\n');
  const pdf = assemblePdf([
    { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, dict: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>' },
    { num: 4, dict: '<< /Filter /FlateDecode >>', stream: deflateSync(Buffer.from('BT /F1 12 Tf 10 10 Td (Hey) Tj ET', 'latin1')) },
    { num: 5, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 8 0 R >>' },
    { num: 8, dict: '<< /Filter /FlateDecode >>', stream: deflateSync(Buffer.from(cmap, 'latin1')) },
  ]);
  const r = extractPdfText(pdf, { minChars: 3 });
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.equal(r.text, 'Hey', 'each byte went through the 1-byte map');
});

test('extract: PDFs with no page structure still work via the stream fallback', () => {
  const r = extractPdfText(pdfFixture([
    { extra: ' /Filter /FlateDecode', body: deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${'a'.repeat(0)}A stream-only PDF with enough text to clear the minimum length gate.${''}) Tj ET`.slice(0, 400), 'latin1')) },
  ]));
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  assert.match(r.text, /A stream-only PDF/);
});

// --- scanner compatibility ---------------------------------------------------

test('scanContentStream: font-less calls keep the previous behaviour', () => {
  const s = 'BT /F1 12 Tf 10 10 Td (plain text) Tj -250 (spaced) Tj ET';
  assert.match(scanContentStream(s), /plain text/);
  const stats = { seen: 0, mapped: 0 };
  assert.match(scanContentStream(s, { fonts: null, stats }), /plain text/);
  assert.equal(stats.seen, 0, 'no font map means no code accounting');
});

test('extract: MIN_CHARS is still the floor for a text-only failure reason', () => {
  const r = extractPdfText(makePdf(['x']));
  assert.equal(r.ok, false);
  assert.ok(String(MIN_CHARS) === '40');
  assert.match(r.reason, /only 1 characters/);
});
