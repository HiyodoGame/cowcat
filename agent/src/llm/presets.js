// Preset provider/model catalog, distilled from the models.dev snapshot into
// assets/providers.json by tools/distill-providers.mjs. Pure synchronous reads,
// zero dependencies, no side effects. Resolved relative to this module so it
// works both when bin/cowcat.mjs runs src/ directly and from any CWD.
import { readFileSync } from 'node:fs';

let cache = null;

function loadCatalog() {
  if (cache === null) {
    const url = new URL('../../assets/providers.json', import.meta.url);
    cache = JSON.parse(readFileSync(url, 'utf8'));
  }
  return cache;
}

export function listProviders() {
  return Object.values(loadCatalog());
}

export function getProvider(id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  return loadCatalog()[id] || null;
}

export function listModels(providerId) {
  const provider = getProvider(providerId);
  if (!provider || !Array.isArray(provider.models)) return [];
  return provider.models;
}

export function resolveModelRef(ref) {
  if (typeof ref !== 'string') return null;
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return null;
  const provider = getProvider(ref.slice(0, slash));
  if (!provider || !Array.isArray(provider.models)) return null;
  const id = ref.slice(slash + 1);
  const model = provider.models.find((m) => m.id === id);
  if (!model) return null;
  return { provider, model };
}

export function providerEnvVars(id) {
  const provider = getProvider(id);
  return provider && Array.isArray(provider.env) ? provider.env.slice() : [];
}

export function providerBaseURL(id) {
  const provider = getProvider(id);
  return provider && typeof provider.api === 'string' && provider.api.length > 0 ? provider.api : null;
}
