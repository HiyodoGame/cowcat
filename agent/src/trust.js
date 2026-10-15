// Directory trust (aligned with the reference CLI's trust dialog): an
// interactive session asks before working in an untrusted cwd; declining (or
// non-interactive runs in untrusted dirs) lock the session to read-only plan
// mode. Trusted dirs are persisted in ~/.cowcat/state.json (merged, so
// installId and other state fields survive; legacy config.json copies are
// still honored on read).
import { readState, writeState } from './config.js';

export function trustedProjects(cfg) {
  return Array.isArray(cfg.trustedProjects) ? cfg.trustedProjects : [];
}

export function isTrustedProject(cfg, cwd) {
  return trustedProjects(cfg).includes(cwd);
}

// Persist cwd into trustedProjects, preserving every other state field.
export function trustProject(cfg, cwd) {
  const next = writeState((state) => {
    state.trustedProjects = Array.from(new Set([...(Array.isArray(state.trustedProjects) ? state.trustedProjects : []), cwd]));
    return state;
  });
  cfg.trustedProjects = next.trustedProjects; // keep the in-memory config in sync
  return next;
}
