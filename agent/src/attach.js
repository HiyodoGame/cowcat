// Attachments: the vehicle for binary content (images, PDFs) that a tool result
// hands to the model. An attachment is a REFERENCE, never the bytes:
//
//   { type:'image'|'document', mediaType, path, bytes, tokens, width?, height?, pages? }
//
// The base64 payload is produced on demand by materializeAttachment() at the
// moment the request is serialized. That single invariant is what keeps session
// JSONL, /export, compact summaries and /context small and free of base64 — see
// docs/read-multimodal-plan.md §3.3. Every producer MUST set an absolute path;
// content with no file behind it (e.g. images embedded in a notebook output)
// is deliberately not attached.
import { readFileSync, statSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { formatBytes } from './imageinfo.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Anchored to real data: a 11.7MB national-standard PDF on a dev machine
// extracted cleanly, while Anthropic's own request ceiling is 32MB (base64
// inflates by 4/3, so 16MB raw stays comfortably inside it).
export const MAX_PDF_BYTES = 16 * 1024 * 1024;

export function maxBytesFor(type) {
  return type === 'document' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
}

export function makeAttachment({ type, mediaType, path, bytes, tokens = 0, width, height, pages } = {}) {
  const a = { type, mediaType, path, bytes: Number(bytes) || 0, tokens: Number(tokens) || 0 };
  if (width > 0 && height > 0) { a.width = width; a.height = height; }
  if (pages > 0) a.pages = pages;
  return a;
}

export function validateAttachment(a) {
  if (!a || typeof a !== 'object') return { ok: false, error: 'attachment is not an object' };
  if (a.type !== 'image' && a.type !== 'document') return { ok: false, error: `unknown attachment type: ${a.type}` };
  if (typeof a.mediaType !== 'string' || !a.mediaType) return { ok: false, error: 'attachment is missing mediaType' };
  if (typeof a.path !== 'string' || !a.path) return { ok: false, error: 'attachment is missing path (attachments must reference a file)' };
  return { ok: true };
}

export function attachmentName(a) {
  return a && a.path ? basename(a.path) : (a && a.type) || 'attachment';
}

// '[attached: a.png (image/png, 12.3 KB)]' — the one-line presence marker used
// in text-only surfaces (OpenAI tool messages, compact transcripts, /export).
export function attachmentLabel(a) {
  const dims = a.width > 0 && a.height > 0 ? `${a.width}x${a.height}, ` : (a.pages > 0 ? `${a.pages} pages, ` : '');
  return `[attached: ${attachmentName(a)} (${a.mediaType}, ${dims}${formatBytes(a.bytes)})]`;
}

function unavailableNote(a, reason) {
  return `[${a.type || 'attachment'} unavailable: ${attachmentName(a)} (${reason})]`;
}

// Read the bytes behind an attachment and return a provider-neutral block:
//   { type:'image'|'document', mediaType, data:<base64> }
// Never throws: a missing or oversized file degrades to { ok:false, error } and
// the caller substitutes a text note, so one stale reference cannot fail a
// whole request.
export function materializeAttachment(a) {
  const valid = validateAttachment(a);
  if (!valid.ok) return { ok: false, error: valid.error };
  if (!existsSync(a.path)) return { ok: false, error: 'file no longer exists' };
  let stat;
  try {
    stat = statSync(a.path);
  } catch (e) {
    return { ok: false, error: `stat failed: ${e.message}` };
  }
  if (!stat.isFile()) return { ok: false, error: 'not a regular file' };
  const limit = maxBytesFor(a.type);
  if (stat.size > limit) {
    return { ok: false, error: `file grew to ${formatBytes(stat.size)} (limit ${formatBytes(limit)})` };
  }
  let data;
  try {
    data = readFileSync(a.path).toString('base64');
  } catch (e) {
    return { ok: false, error: `read failed: ${e.message}` };
  }
  return { ok: true, block: { type: a.type, mediaType: a.mediaType, data } };
}

// Materialize a list, splitting into usable blocks and their failure notes.
export function materializeAll(attachments) {
  const blocks = [];
  const notes = [];
  for (const a of attachments || []) {
    const r = materializeAttachment(a);
    if (r.ok) blocks.push(r.block);
    else notes.push(unavailableNote(a, r.error));
  }
  return { blocks, notes };
}

// Total estimated tokens for the attachments carried by a message list. Used by
// the context estimator so images are visible in /context and the compact
// budget instead of looking free.
export function attachmentTokens(messages) {
  let total = 0;
  for (const m of messages || []) {
    for (const b of m.content || []) {
      if (b && Array.isArray(b.attachments)) {
        for (const a of b.attachments) total += Number(a.tokens) || 0;
      }
    }
  }
  return total;
}

export function collectAttachments(m) {
  const out = [];
  for (const b of (m && m.content) || []) {
    if (b && Array.isArray(b.attachments)) out.push(...b.attachments);
  }
  return out;
}
