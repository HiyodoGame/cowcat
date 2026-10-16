// The log format version this build writes. Bumping it means the on-disk shape of
// KernelEvent changed; SUPPORTED_SCHEMA_VERSIONS is what `open` will still accept.
// ADR-012: the header is written once by create, never rewritten, and an unknown
// version is reported rather than guessed at.
export const SCHEMA_VERSION = 1;

export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [SCHEMA_VERSION];

// Carries both versions as fields so a frontend can render guidance without
// parsing the message.
export class UnsupportedSchemaVersionError extends Error {
  readonly found: number;
  readonly supported: readonly number[];

  constructor(sessionId: string, found: number) {
    super(
      `session ${sessionId} was written with log schema version ${String(found)}; ` +
        `this build supports ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
    );
    this.name = 'UnsupportedSchemaVersionError';
    this.found = found;
    this.supported = SUPPORTED_SCHEMA_VERSIONS;
  }
}

export function isSupportedSchemaVersion(version: number): boolean {
  return SUPPORTED_SCHEMA_VERSIONS.includes(version);
}

export function assertSupportedSchemaVersion(version: number, sessionId: string): void {
  if (!isSupportedSchemaVersion(version)) throw new UnsupportedSchemaVersionError(sessionId, version);
}
