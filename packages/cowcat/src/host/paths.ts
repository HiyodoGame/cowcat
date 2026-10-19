import { join } from 'node:path';

// Where the product keeps its files. One module so the layout is a single statement
// rather than four paths assembled at four call sites (ADR-064).
//
// `home` is the USER's home directory — `~` in a policy entry means the same thing here
// as it does to the user — while `dir` is our own directory under it. Keeping the two
// apart matters: `resolveSandboxProfile` expands `~/.npm` against the first, and the
// session log lives in the second.

export const CONFIG_DIR_NAME = '.cowcat';
export const PROJECT_CONFIG_FILENAME = 'cowcat.json';
export const SESSIONS_DIR_NAME = 'sessions';
export const TRUST_FILENAME = 'trust.json';

export interface CowcatPaths {
  /** `~/.cowcat` — our own directory. */
  readonly dir: string;
  readonly sessionsDir: string;
  readonly trustFile: string;
  /** The user layer: `~/.cowcat/config.json`. */
  readonly userConfig: string;
  /** The project layer: `<cwd>/cowcat.json`. */
  readonly projectConfig: string;
}

/**
 * The layout (ADR-064).
 *
 * Sessions are a flat `<sessionId>.jsonl` under `~/.cowcat/sessions/`, named the same way
 * `JsonlEventStore` names its files, so a session id can be handed to the store without
 * a second translation. The legacy v1 layout was per-project
 * (`~/.cowcat/projects/<slug>/…`); v2 does not inherit it, for the reason the store
 * takes a directory rather than a scheme: a session id is the identity, and looking one
 * up must not depend on which directory the user happens to be in.
 */
export function cowcatPaths(options: { readonly cwd: string; readonly home: string; readonly dir?: string }): CowcatPaths {
  // `dir` is how a caller relocates our state without touching the user's home — the CLI
  // passes `COWCAT_HOME` through here. It is a process fact, not a config layer: it moves
  // where the logs live and does not change a single policy value (ADR-025 decision 2
  // is about VALUES, and a directory is not one).
  const dir = options.dir ?? join(options.home, CONFIG_DIR_NAME);
  return {
    dir,
    sessionsDir: join(dir, SESSIONS_DIR_NAME),
    trustFile: join(dir, TRUST_FILENAME),
    userConfig: join(dir, 'config.json'),
    projectConfig: join(options.cwd, PROJECT_CONFIG_FILENAME),
  };
}
