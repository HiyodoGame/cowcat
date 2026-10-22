import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Spill — where an oversized tool result lives once it is too big for context (ADR-119).
 *
 * The full text is written under the session's own directory and the inline `output`
 * becomes a reference plus the first {@link SPILL_HEAD_BYTES} bytes, so the model keeps
 * enough head to decide whether to page back in (Read) or rerun narrowed (Bash). This
 * is the text counterpart of attachments (ADR-057): the log carries the reference, the
 * bytes live on disk.
 *
 * Deliberately adapter-layer: generation-time truncation lives here too (bash's tail
 * cap, read's line cap), and `FsPort` stays a read-only identity port (ADR-017) — spill
 * never asks the kernel to write files.
 */

/** Above this, a result spills. Borrowed from dsh's `maxInlineBytes` (research D5). */
export const SPILL_MAX_INLINE_BYTES = 50_000;
/** What stays inline ahead of the reference: enough to judge the result by. */
export const SPILL_HEAD_BYTES = 4_096;

export interface SpillConfig {
  /** The sessions directory; the session's own subdir is derived per call. */
  readonly rootDir: string;
}

export interface SpillOutcome {
  /** What the tool result should carry: reference + head, or the original when small. */
  readonly output: string;
  /** Where the full text went, or null when nothing spilled. */
  readonly spilledTo: string | null;
}

export function spillOutput(
  config: SpillConfig,
  sessionId: string,
  callId: string,
  output: string,
  maxInlineBytes: number = SPILL_MAX_INLINE_BYTES,
): SpillOutcome {
  if (byteLength(output) <= maxInlineBytes) return { output, spilledTo: null };
  const dir = join(config.rootDir, sanitize(sessionId), 'spill');
  // The call id comes from the provider: sanitized, because nothing about its shape is
  // ours to trust — `../` must not become a path traversal, and a Windows-hostile name
  // must not fail the write silently (the catch below would hide it).
  const file = join(dir, `${sanitize(callId)}.txt`);
  const temp = join(dir, `.${sanitize(callId)}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    // Temp file + rename (ADR-091 ④): a crash mid-write must not leave a truncated
    // file behind the log's "full output" claim.
    writeFileSync(temp, output, 'utf8');
    renameSync(temp, file);
  } catch {
    rmSync(temp, { force: true });
    // Spill is an optimization, never a failure mode: when the disk refuses, the tool
    // result travels whole, exactly as it did before spill existed.
    return { output, spilledTo: null };
  }
  const head = takeBytes(output, SPILL_HEAD_BYTES);
  return {
    output: [
      `[spilled: full output of ${String(byteLength(output))} bytes written to ${file}; first ${String(SPILL_HEAD_BYTES)} bytes below — read it back with Read, or rerun the command narrowed]`,
      head,
    ].join('\n'),
    spilledTo: file,
  };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Path-safe names for ids we did not mint: anything outside [A-Za-z0-9._-] becomes _. */
function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** A UTF-8-safe head: never splits a multi-byte sequence. */
function takeBytes(text: string, bytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= bytes) return text;
  let end = bytes;
  // A continuation byte (0b10xxxxxx) means we are inside a sequence: walk back to its
  // start. Decoding a torn sequence would replace bytes with U+FFFD, changing what the
  // model reads for no reason.
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}
