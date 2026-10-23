import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/**
 * `@` file references in a prompt (ADR-128), narrowed the way the false-positive
 * review of #173 demanded: a token only counts when it
 *
 *   1. starts at a word boundary (whitespace, start, or an opening bracket/quote) —
 *      so `user@example.com` and `npm install @scope/pkg` are not references;
 *  2. is made of path characters — so `看 @README.md。` captures `README.md` and
 *     leaves the full stop in the text; and
 *  3. resolves to a file that exists — so a nonexistent `@path` stays text, the
 *     send is never refused over a token that was never a file.
 *
 * Everything else stays in the text: the model sees it and can Read it the usual way.
 */
export function parseAtRefs(text: string, cwd: string): readonly string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(/(?:^|[\s（("'])@([A-Za-z0-9_./\\:~-]+)/g)) {
    const token = match[1] ?? '';
    const path = isAbsolute(token) ? token : resolve(cwd, token);
    if (existsSync(path)) refs.push(path);
  }
  return refs;
}
