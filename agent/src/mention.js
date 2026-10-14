// @-mention file completion (P2-6): typing @<prefix> then Tab completes project
// file paths (fuzzy substring, case-insensitive, capped at 20).
import { walkFiles } from './tools/glob.js';
import { relative, sep } from 'node:path';

const MAX_CANDIDATES = 20;

export function completeFiles(cwd, prefix) {
  const needle = String(prefix || '').toLowerCase().replace(/^@/, '');
  const all = walkFiles(cwd);
  const hits = all
    .map((f) => relative(cwd, f).split(sep).join('/'))
    .filter((rel) => !needle || rel.toLowerCase().includes(needle))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, MAX_CANDIDATES);
  return hits.map((h) => `@${h}`);
}
