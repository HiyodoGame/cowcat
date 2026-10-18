import { readFileSync } from 'node:fs';

// From dist/src/cli/version.js, three levels up is the package root.
const PACKAGE_JSON = new URL('../../../package.json', import.meta.url);

/**
 * The package's own version, read rather than duplicated.
 *
 * It is read at runtime instead of being compiled in so that one number lives in one
 * place: a constant in the source would need its own guard against `package.json`, and
 * a guard that compares two copies is just a third copy.
 */
export function readVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { readonly version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0+unknown';
  } catch {
    // A `serve` running from a partially copied install is more useful with a
    // placeholder version than with a crash on `--version`.
    return '0.0.0+unknown';
  }
}
