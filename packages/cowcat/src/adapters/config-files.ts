import { readFile } from 'node:fs/promises';
import type { ConfigLayerName } from '../policy/config.js';
import type { ConfigError, ConfigSource } from './config.js';

// Reading config files, and the ONE distinction this file exists to make (ADR-025
// decision 5): a file that is not there means "this layer says nothing", while a file
// that is there and cannot be read is a refusal. Collapsing the two would start a
// session on the built-in defaults while the user believes their file is in effect.
//
// It lives in the adapter layer next to the decoder, for the reason ADR-009 gives:
// decoding and the code that reads the bytes are one boundary. `src/host/` may not
// import `node:fs` (the lint block that covers it), so the composition root decides
// WHICH paths are read and in what order, and hands the reading here.

export interface ConfigFileTarget {
  readonly kind: ConfigLayerName;
  /** Where this came from, for the error message. */
  readonly path: string;
}

export interface ConfigFileReadResult {
  readonly sources: readonly ConfigSource[];
  /** Files that exist but could not be read. A single one refuses the whole load. */
  readonly errors: readonly ConfigError[];
}

export type ConfigFileReader = (targets: readonly ConfigFileTarget[]) => Promise<ConfigFileReadResult>;

/**
 * `readFile` as a function, so a test can describe a missing or unreadable file
 * without creating one — the same injection the model adapters use for `fetch`.
 */
export type ReadTextFile = (path: string) => Promise<string>;

const readFromDisk: ReadTextFile = (path) => readFile(path, 'utf8');

export function createConfigFileReader(read: ReadTextFile = readFromDisk): ConfigFileReader {
  return async (targets) => {
    const sources: ConfigSource[] = [];
    const errors: ConfigError[] = [];
    for (const target of targets) {
      try {
        sources.push({ kind: target.kind, path: target.path, text: await read(target.path) });
      } catch (error) {
        // Absent is the normal case for at least two of the three layers on a first
        // run, so it must be silent — anything else here would make a fresh install
        // look broken.
        if (isMissing(error)) continue;
        errors.push({ source: target.path, problem: `cannot be read: ${message(error)}` });
      }
    }
    return { sources, errors };
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
