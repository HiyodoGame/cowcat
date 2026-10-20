import { readFileSync } from 'node:fs';
import { ATTACHMENT_HARD_LIMIT_BYTES, type Attachment, type AttachmentType } from '../ports/index.js';

/**
 * An attachment, with its bytes in hand — what the wire builder actually needs.
 *
 * This is the only place the bytes exist outside the file: the log holds references
 * (ADR-057), so materialization happens exactly once per request, at serialization time.
 */
export interface MaterializedAttachment {
  readonly type: AttachmentType;
  readonly mediaType: string;
  readonly base64: string;
  /**
   * The size actually read, not the size the attachment declared.
   *
   * Carried because the bytes and their length are two answers to two questions: a wire
   * builder wants the payload, and `attachment.read` has to report a `byteLength` to a
   * frontend that will not decode base64 to count it.
   */
  readonly byteLength: number;
}

/**
 * The bytes are not there. Two callers want different things from that fact (ADR-069):
 *
 * - `attachment.read` refuses, because a frontend asked for bytes and there are none to
 *   give it — a silent empty answer would be a lie with a plausible shape.
 * - A wire builder **names the attachment in the request instead** (ADR-016 is satisfied
 *   by saying so, not by failing): refusing there costs the whole turn, and because the
 *   reference stays in the history, every later turn of that session fails the same way.
 *   That was observed for real: delete the file a `Read` produced, and the session wedges.
 */
export class AttachmentUnavailableError extends Error {
  readonly path: string;
  readonly reason: string;
  /**
   * How large the file really was, when that is knowable — `null` when it could not be
   * read at all.
   *
   * It is not derived from `reason` by a caller: "the bytes are over the limit" and "the
   * bytes are gone" want different error codes on the wire, and a frontend that has to
   * parse a sentence to tell them apart is a frontend that will get it wrong.
   */
  readonly byteLength: number | null;

  constructor(attachment: Attachment, reason: string, byteLength: number | null = null) {
    super(`attachment ${attachment.path} cannot be sent: ${reason}`);
    this.name = 'AttachmentUnavailableError';
    this.path = attachment.path;
    this.reason = reason;
    this.byteLength = byteLength;
  }
}

export interface MaterializeOptions {
  /** Tests use a small cap; the product uses `ATTACHMENT_HARD_LIMIT_BYTES`. */
  readonly hardLimitBytes?: number;
}

/** Either the bytes, or the reason they are not here — never an exception (ADR-069). */
export type MaterializeOutcome =
  | { readonly ok: true; readonly value: MaterializedAttachment }
  | { readonly ok: false; readonly error: AttachmentUnavailableError };

/**
 * Read the bytes and hand back base64. Synchronous on purpose: it runs once per request,
 * inside a path that is already building a wire body synchronously, and the payload is
 * bounded by the hard limit — threading `async` through the whole wire builder to avoid a
 * bounded synchronous read would buy nothing and complicate every branch of it.
 */
export function tryMaterializeAttachment(
  attachment: Attachment,
  options: MaterializeOptions = {},
): MaterializeOutcome {
  const hardLimit = options.hardLimitBytes ?? ATTACHMENT_HARD_LIMIT_BYTES;

  // The declared size is checked first so an oversized attachment is refused without
  // being read into memory at all.
  if (attachment.bytes > hardLimit) {
    return {
      ok: false,
      error: new AttachmentUnavailableError(
        attachment,
        `declared ${String(attachment.bytes)} bytes is over the ${String(hardLimit)} byte limit`,
        attachment.bytes,
      ),
    };
  }

  let data: Buffer;
  try {
    data = readFileSync(attachment.path);
  } catch {
    return { ok: false, error: new AttachmentUnavailableError(attachment, 'the file it points at is gone or unreadable') };
  }

  // The file may have grown since the tool attached it, so the measured size is checked
  // too — the declared number is a claim, this one is a fact.
  if (data.byteLength > hardLimit) {
    return {
      ok: false,
      error: new AttachmentUnavailableError(
        attachment,
        `is ${String(data.byteLength)} bytes, over the ${String(hardLimit)} byte limit`,
        data.byteLength,
      ),
    };
  }

  return {
    ok: true,
    value: { type: attachment.type, mediaType: attachment.mediaType, base64: data.toString('base64'), byteLength: data.byteLength },
  };
}

/**
 * The strict reading, for callers that must refuse: `attachment.read` promises bytes or an
 * error code, and a request body cannot promise anything of the sort (ADR-069).
 */
export function materializeAttachment(
  attachment: Attachment,
  options: MaterializeOptions = {},
): MaterializedAttachment {
  const outcome = tryMaterializeAttachment(attachment, options);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * What a wire builder puts where the bytes would have gone.
 *
 * A named absence, so the model knows the tool produced something it is not seeing — the
 * same move the OpenAI adapter already makes for documents, which this protocol cannot
 * inline at all (`model-openai.ts`, `attachmentMessage`).
 */
export function unavailableAttachmentNote(attachment: Attachment, reason: string): string {
  return `[attachment unavailable: ${attachment.mediaType} at ${attachment.path} — ${reason}]`;
}
