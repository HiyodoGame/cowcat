import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ModelUsage, ReasoningBlock, StopReasonKind } from '../src/index.js';

// Fixture loading for the model adapters (ADR-042).
//
// Fixtures are DATA, not code: `tsconfig.json` includes only `src` and `test`, so the
// `.sse` and `.json` files are neither compiled nor copied into `dist/` — while the tests
// themselves run from `dist/test`. A path relative to `import.meta.dirname` would
// therefore point at a directory that does not exist. The root is found by walking up to
// the package marker instead, which is right from both `test/` and `dist/test/`.

/**
 * The request the recording was made with, and what that recording is *supposed* to
 * mean once normalised.
 *
 * `logical` is what makes a pair a pair: two encodings of one turn declare the same
 * text, the same tool calls and the same four usage numbers, and each adapter has to
 * produce exactly that (ADR-043). Tool-call ids are deliberately absent — they are
 * protocol-generated, which is the point of the projection rule.
 */
export interface FixtureExpectation {
  readonly description: string;
  /** The path the request was sent to, relative to the provider's base URL. */
  readonly urlPath: string;
  /** Key request fields worth pinning; not the whole body. */
  readonly body: Readonly<Record<string, unknown>>;
  readonly logical: {
    readonly text: string;
    readonly toolCalls: readonly { readonly name: string; readonly input: unknown }[];
    readonly usage: ModelUsage;
    readonly stopKind: StopReasonKind;
    /**
     * Present only where a scenario exercises reasoning (the paired fixtures predate it,
     * so absent means "none", not "unspecified"): the blocks a faithful normalisation
     * must produce, in order (ADR-045).
     */
    readonly reasoning?: readonly ReasoningBlock[];
  };
}

export interface Fixture {
  /** The raw bytes, exactly as they came off the wire. */
  readonly raw: string;
  readonly expectation: FixtureExpectation;
}

export type FixtureProtocol = 'openai' | 'anthropic';

function packageRoot(): string {
  let dir = import.meta.dirname;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`fixture root: no package.json above ${import.meta.dirname}`);
    }
    dir = parent;
  }
}

export function fixturesRoot(): string {
  return join(packageRoot(), 'test', 'fixtures');
}

/**
 * `protocol/provider/scenario` names a pair of files. `paired` is the provider directory
 * for the intentionally-authored cross-protocol pair; a real provider name is what the
 * recorder writes (tools/record-fixture.mjs).
 *
 * The recorder writes `logical: null` on purpose, so this refuses to load a half-finished
 * recording: the bytes are recorded, the meaning is authored, and a fixture that skipped
 * the second step would be asserting that our own parser is right.
 */
export function loadFixture(protocol: FixtureProtocol, provider: string, scenario: string): Fixture {
  const base = join(fixturesRoot(), protocol, provider, scenario);
  // Typed as `unknown` on purpose: a recording's sidecar really does carry `logical: null`,
  // and a `Partial<FixtureExpectation>` would let the compiler call that check unnecessary
  // while the runtime value sails straight through it.
  const parsed = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as Record<string, unknown>;
  if (parsed.logical === undefined || parsed.logical === null) {
    throw new Error(
      `${base}.json has no logical block — a recording's meaning is authored by hand, not derived (tools/record-fixture.mjs)`,
    );
  }
  return { raw: readFileSync(`${base}.sse`, 'utf8'), expectation: parsed as unknown as FixtureExpectation };
}
