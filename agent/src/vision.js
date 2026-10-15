// Vision capability gating. The model catalog (assets/providers.json, distilled
// from models.dev) carries an `attachment` flag per model — the same signal the
// reference CLI uses to decide whether binary input is acceptable. We consult it
// instead of guessing, with COWCAT_VISION as the manual override.
//
// Three outcomes, deliberately distinct:
//   'yes'     -> send the bytes
//   'no'      -> refuse locally, with an actionable message (catalog says false)
//   'unknown' -> try it; if the upstream rejects the payload, errfmt's
//                visionUnsupported hint explains what happened
// Refusing on 'unknown' would block every model newer than the catalog snapshot.
import { listProviders, resolveModelRef } from './llm/presets.js';

const TRUTHY = new Set(['force', 'on', 'yes', 'true', '1']);
const FALSY = new Set(['off', 'none', 'false', 'no', '0']);

export function visionOverride(env = process.env) {
  const v = String(env.COWCAT_VISION || '').trim().toLowerCase();
  if (TRUTHY.has(v)) return 'yes';
  if (FALSY.has(v)) return 'no';
  return null;
}

// Look up a configured model in the catalog. Accepts 'provider/model' and bare
// model ids; a bare id is searched across providers with the configured provider
// taking precedence over an accidental match elsewhere.
export function lookupModel(model, providerId = null) {
  const ref = String(model || '');
  if (!ref) return null;
  if (ref.includes('/')) {
    const hit = resolveModelRef(ref);
    if (hit) return { providerId: hit.provider.id, model: hit.model, via: 'ref' };
  }
  const wanted = ref.toLowerCase();
  let fallback = null;
  for (const provider of listProviders()) {
    for (const m of provider.models || []) {
      if (m.id !== ref && String(m.id).toLowerCase() !== wanted) continue;
      const hit = { providerId: provider.id, model: m, via: 'scan' };
      if (providerId && provider.id === providerId) return hit;
      if (!fallback) fallback = hit;
    }
  }
  return fallback;
}

// -> { support:'yes'|'no'|'unknown', source:'env'|'catalog'|'default', entry?, modelId? }
export function visionCapability(config = {}, env = process.env) {
  const override = visionOverride(env);
  if (override) return { support: override, source: 'env' };
  const model = String(config.model || '');
  if (!model) return { support: 'unknown', source: 'default' };
  const hit = lookupModel(model, config.provider);
  if (!hit) return { support: 'unknown', source: 'default', modelId: model };
  return {
    support: hit.model.attachment === true ? 'yes' : 'no',
    source: 'catalog',
    entry: hit.model,
    modelId: hit.model.id,
  };
}

// Tool-layer refusal text for the 'no' branch. English, like every other tool
// error, so the model reads a consistent contract.
export function visionRefusalMessage(config = {}, { mediaKind = 'image' } = {}) {
  const cap = visionCapability(config);
  const model = cap.modelId || config.model || '(unset)';
  return `Cannot read this ${mediaKind}: model "${model}" is not marked as accepting image/PDF input `
    + '(attachment: false in the model catalog). Switch to a vision-capable model with /model, '
    + 'or set COWCAT_VISION=force to try anyway.';
}

// Does an upstream error look like "this model cannot take images"? Used by
// errfmt to attach an actionable hint instead of echoing a raw API message.
// Deliberately narrow: a bare "content block" or "vision" mention is not enough,
// the message has to tie the failure to image input.
const VISION_ERROR_RE = new RegExp([
  'image_url',
  'image input',
  'input_image',
  '(vision|multimodal)[^.]{0,30}(not|unsupported|disabled|unavailable)',
  "(not|unsupported|cannot|can't|does not|doesn't)[^.]{0,30}(image|vision|multimodal)",
  'content[\\s_-]?block[^.]{0,30}(unsupported|not supported|invalid)',
  '(invalid|unsupported)[^.]{0,30}(content[\\s_-]?block|media_type|image)',
].join('|'), 'i');

export function looksLikeVisionUnsupported(text) {
  return VISION_ERROR_RE.test(String(text || ''));
}
