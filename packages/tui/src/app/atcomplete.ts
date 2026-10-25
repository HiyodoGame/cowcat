import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export function atQuery(input: string): string | null {
  const match = /(?:^|\s)@([A-Za-z0-9_./\\:~-]*)$/.exec(input);
  return match?.[1] ?? null;
}

export function atCandidates(cwd: string): readonly string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    if (files.length >= 5_000) return;
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (files.length >= 5_000) return;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!['.git', '.cowcat', '.worktrees', 'node_modules', 'dist'].includes(entry.name)) walk(path);
        } else if (entry.isFile()) {
          files.push(relative(cwd, path).split(sep).join('/'));
        }
      }
    } catch {
      return;
    }
  };
  walk(cwd);
  return files;
}

export function rankAtCandidates(query: string, candidates: readonly string[]): readonly string[] {
  const needle = query.toLowerCase();
  if (needle === '') return candidates;
  return candidates
    .map((path, index) => ({ path, index, score: fuzzyScore(needle, path.toLowerCase()) }))
    .filter((item) => item.score !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.index - b.index)
    .map((item) => item.path);
}

function fuzzyScore(query: string, candidate: string): number | null {
  let index = 0;
  let first = -1;
  let last = -1;
  for (let position = 0; position < candidate.length && index < query.length; position += 1) {
    if (candidate[position] !== query[index]) continue;
    if (first === -1) first = position;
    last = position;
    index += 1;
  }
  if (index !== query.length) return null;
  const basename = candidate.slice(candidate.lastIndexOf('/') + 1);
  let basenameIndex = 0;
  for (const char of basename) {
    if (char === query[basenameIndex]) basenameIndex += 1;
  }
  const fuzzyBasename = basenameIndex === query.length;
  const exactBasename = fuzzyBasename ? 100 : basename.startsWith(query) ? 60 : basename.includes(query) ? 20 : 0;
  return exactBasename > 0 ? exactBasename : 10 - (last - first) * 0.1;
}
