/**
 * Attachments: the vehicle for binary content a tool hands to the model (ADR-057).
 *
 * An attachment is a **reference, never the bytes**: `path` plus the size, plus whatever
 * the producer happened to know about the pixels. The base64 payload is produced on
 * demand by the adapter at the moment a request is serialized — that single invariant is
 * what keeps the session log, a snapshot and an export small and free of base64.
 *
 * Two consequences worth stating out loud:
 *
 *  - every producer must set an **absolute** path, because the adapter that materializes
 *    the bytes later has no idea what the current directory was;
 *  - content with no file behind it (an image embedded in a notebook output, say) is
 *    deliberately **not** attached — there is nothing to re-read after a restart, and an
 *    attachment that cannot be materialized is a fact the log would be lying about.
 *
 * The legacy shape (`agent/src/attach.js`) also carried `tokens`, an estimate. v2 does
 * not take it: real usage is recorded by `model.usage` (ADR-041), and an estimate with no
 * consumer is a number that drifts away from the truth.
 */

export type AttachmentType = 'image' | 'document';

export interface Attachment {
  readonly type: AttachmentType;
  readonly mediaType: string;
  /** Absolute path to the file the bytes live in. */
  readonly path: string;
  /** Size on disk when it was attached. The bytes themselves never enter the log. */
  readonly bytes: number;
  /**
   * Not-reported metadata is `null`, not an absent field — the same convention `facts`,
   * `truncation` and `path` follow, and for the same reason: the log schema cannot use
   * `.optional()` without inferring `undefined`, which `exactOptionalPropertyTypes`
   * makes a different type from the kernel's (see `adapters/schema.ts`).
   */
  readonly width: number | null;
  readonly height: number | null;
  readonly pages: number | null;
}

/**
 * The size口径 is P5's (ADR-057): 5MB soft, 20MB hard.
 *
 * They are separate constants from `Read`'s own limits on purpose — one governs how much
 * *text* a read may return, the other how many *bytes* may ride a model request, and
 * merging them would make "change one, change the other" an implicit behaviour.
 */
export const ATTACHMENT_SOFT_LIMIT_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_HARD_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * The ergonomic constructor for a shape whose metadata fields are required-and-nullable.
 * Producers that know nothing about the image still write `makeAttachment({...})` rather
 * than three explicit `null`s, and the type stays honest at every call site.
 */
export function makeAttachment(
  input: Pick<Attachment, 'type' | 'mediaType' | 'path' | 'bytes'> & Partial<Pick<Attachment, 'width' | 'height' | 'pages'>>,
): Attachment {
  return {
    type: input.type,
    mediaType: input.mediaType,
    path: input.path,
    bytes: input.bytes,
    width: input.width ?? null,
    height: input.height ?? null,
    pages: input.pages ?? null,
  };
}
