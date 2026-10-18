import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlEventStore, SCHEMA_VERSION, makeAttachment, replay, type KernelEvent } from '../src/index.js';

/**
 * ADR-057's two promises, tested against the real store rather than a fake one:
 *
 *   1. "this answer came with an image" is a **durable fact** — it survives the log and
 *      replays into the message the model sees next;
 *   2. the **bytes never enter the log** — the log holds a path and a size, so a session
 *      file, a snapshot and an export stay small and free of base64.
 */
const MARKER = 'BYTES-MARKER-7f31c2';

interface Fixture {
  readonly dir: string;
  readonly file: string;
  readonly bytes: Buffer;
  cleanup(): void;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'cowcat-attach-'));
  const file = join(dir, 'image.png');
  // Distinctive and long enough that finding it in the log would be unambiguous.
  const bytes = Buffer.from(`${MARKER}${MARKER}${MARKER}`);
  writeFileSync(file, bytes);
  return {
    dir,
    file,
    bytes,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function events(dir: string, file: string, bytes: number): readonly KernelEvent[] {
  return [
    {
      seq: 1,
      ts: 1,
      sessionId: 'sess',
      turnId: null,
      type: 'session.opened',
      schemaVersion: SCHEMA_VERSION,
      cowcatVersion: '0.0.0-test',
      shell: { kind: 'posix', executable: '/bin/sh' },
    },
    {
      seq: 2,
      ts: 2,
      sessionId: 'sess',
      turnId: 'turn_1',
      type: 'tool.finished',
      callId: 'c1',
      name: 'Read',
      ok: true,
      output: 'read image.png (binary)',
      facts: null,
      truncation: null,
      path: file,
      attachments: [makeAttachment({ type: 'image', mediaType: 'image/png', path: file, bytes, width: 4, height: 3 })],
    },
    // The same tool reporting nothing: `null` is that statement, and `[]` is the
    // different one ("it reported no attachments"). Both must survive the round trip.
    {
      seq: 3,
      ts: 3,
      sessionId: 'sess',
      turnId: 'turn_1',
      type: 'tool.finished',
      callId: 'c2',
      name: 'Read',
      ok: true,
      output: 'plain text',
      facts: null,
      truncation: null,
      path: null,
      attachments: null,
    },
  ];
}

test('an attachment round-trips through the log as a reference', async () => {
  const fx = fixture();
  try {
    const store = new JsonlEventStore(fx.dir);
    const written = events(fx.dir, fx.file, fx.bytes.byteLength);
    for (const event of written) await store.append(event);

    const read = await store.readAll('sess');
    assert.deepEqual(read, written, 'the log gives back exactly what was appended');
    const finished = read[1];
    assert.ok(finished !== undefined);
    assert.equal(finished.type, 'tool.finished');
    const attachment = finished.attachments?.[0];
    assert.ok(attachment !== undefined, 'the attachment came back');
    assert.equal(attachment.path, fx.file);
    assert.equal(attachment.bytes, fx.bytes.byteLength);
    assert.equal(attachment.width, 4);
    assert.equal(attachment.pages, null, 'metadata nobody reported is null, not absent');
  } finally {
    fx.cleanup();
  }
});

test('the log holds the reference and never the bytes', async () => {
  const fx = fixture();
  try {
    const store = new JsonlEventStore(fx.dir);
    for (const event of events(fx.dir, fx.file, fx.bytes.byteLength)) await store.append(event);

    const raw = readFileSync(join(fx.dir, 'sess.jsonl'), 'utf8');
    // The path as the log spells it: JSON escapes a Windows separator, so comparing
    // against the raw spelling would fail for a reason that has nothing to do with this
    // test's claim.
    const encodedPath = JSON.stringify(fx.file).slice(1, -1);
    assert.ok(raw.includes(encodedPath), 'the path is what makes the attachment re-readable');
    assert.ok(raw.includes(String(fx.bytes.byteLength)), 'the size is recorded');
    assert.ok(!raw.includes(MARKER), 'the file content must not be in the log in any form');
    assert.ok(
      !raw.includes(fx.bytes.toString('base64')),
      'and not base64 either — that is the one encoding being reused later, on demand',
    );
  } finally {
    fx.cleanup();
  }
});

test('replay carries the logged attachments into the tool message', async () => {
  const fx = fixture();
  try {
    const state = replay('sess', events(fx.dir, fx.file, fx.bytes.byteLength));
    const tools = state.messages.filter((message) => message.role === 'tool');

    assert.equal(tools.length, 2);
    const first = tools[0];
    assert.ok(first !== undefined);
    const carried = first.attachments[0];
    assert.ok(carried !== undefined);
    assert.equal(carried.path, fx.file);
    assert.equal(carried.height, 3);
    // "reported nothing" (null in the log) and "reported none" ([]) are one statement in
    // a message: what it carries. The distinction lives in the log, not here.
    assert.deepEqual(tools[1]?.attachments, []);
  } finally {
    fx.cleanup();
  }
});

test('a log written before the field existed still decodes, as "nothing reported"', async () => {
  const fx = fixture();
  try {
    const store = new JsonlEventStore(fx.dir);
    const header = events(fx.dir, fx.file, 0)[0];
    assert.ok(header !== undefined);
    await store.append(header);
    // Hand-written on purpose: this is the shape dev logs written before ADR-057 have.
    writeFileSync(
      join(fx.dir, 'sess.jsonl'),
      `${JSON.stringify({
        seq: 2,
        ts: 2,
        sessionId: 'sess',
        turnId: 'turn_1',
        type: 'tool.finished',
        callId: 'c1',
        name: 'Read',
        ok: true,
        output: 'old log',
        facts: null,
        truncation: null,
        path: null,
      })}\n`,
      { flag: 'a' },
    );

    const read = await store.readAll('sess');
    const finished = read[1];
    assert.ok(finished !== undefined);
    assert.equal(finished.type, 'tool.finished');
    assert.equal(finished.attachments, null);
  } finally {
    fx.cleanup();
  }
});
