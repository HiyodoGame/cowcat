// Directory trust (aligned with the reference CLI's trust dialog): an
// interactive session asks before working in an untrusted cwd; declining (or
// non-interactive runs in untrusted dirs) lock the session to read-only plan
// mode. Trusted dirs are persisted in ~/.cowcat/config.json (merged, so
// installId and other fields survive).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cowcatHome } from './config.js';

export function trustedProjects(cfg) {
  return Array.isArray(cfg.trustedProjects) ? cfg.trustedProjects : [];
}

export function isTrustedProject(cfg, cwd) {
  return trustedProjects(cfg).includes(cwd);
}

// Persist cwd into trustedProjects, preserving every other config field.
export function trustProject(cfg, cwd) {
  const file = join(cowcatHome(), 'config.json');
  let existing = {};
  if (existsSync(file)) {
    try { existing = JSON.parse(readFileSync(file, 'utf8')); } catch { existing = {}; }
  }
  const list = Array.from(new Set([...(Array.isArray(existing.trustedProjects) ? existing.trustedProjects : []), cwd]));
  const merged = { ...existing, trustedProjects: list };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(merged, null, 2));
  cfg.trustedProjects = list; // keep the in-memory config in sync
  return merged;
}
