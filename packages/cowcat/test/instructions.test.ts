// P3 T3c — the project's instruction file (ADR-029) and the gate on injecting it
// (ADR-030).
//
// Two halves, tested separately because they fail differently:
//   * the DECISION (policy) — untrusted means the file is not used, and the user is
//     told. A file that silently stops applying is the thing to avoid.
//   * the WALK (adapter) — nearest wins, and the standard's filename beats the
//     compatibility fallback. This half runs against a real temporary tree.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileInstructionSource,
  INSTRUCTION_FILENAMES,
  decideInstruction,
  describeInstructionSkip,
  nodeFs,
  type InstructionFile,
} from '../src/index.js';

const fs = nodeFs();
const file = (name: string, content: string, path = `/repo/${name}`): InstructionFile => ({ name, content, path });

const TRUSTED = { trusted: true };
const UNTRUSTED = { trusted: false };

// ---------------------------------------------------------------------------
// The decision (ADR-030)
// ---------------------------------------------------------------------------

test('the candidate order is the standard name first, with no proprietary name', () => {
  assert.deepEqual([...INSTRUCTION_FILENAMES], ['AGENTS.md', 'CLAUDE.md']);
  assert.ok(!INSTRUCTION_FILENAMES.includes('COWCAT.md' as never), 'the legacy proprietary name is gone (ADR-029)');
});

test('a trusted folder injects the file', () => {
  const decision = decideInstruction(file('AGENTS.md', 'do the thing'), TRUSTED);
  assert.equal(decision.kind, 'injected');
  assert.equal(describeInstructionSkip(decision), null, 'nothing to report when it was used');
});

test('no file at all is silent', () => {
  const decision = decideInstruction(null, UNTRUSTED);
  assert.equal(decision.kind, 'none');
  assert.equal(describeInstructionSkip(decision), null);
});

test('an untrusted folder does NOT inject, and says so', () => {
  const decision = decideInstruction(file('AGENTS.md', 'do the thing'), UNTRUSTED);
  assert.equal(decision.kind, 'skipped-untrusted');
  const notice = describeInstructionSkip(decision);
  assert.ok(notice !== null, 'a file that stops applying must not be silent');
  assert.match(notice, /not trusted/);
  assert.match(notice, /AGENTS\.md/);
});

test('the notice reports how many lines were withheld', () => {
  // Without the size the notice is not actionable: "we skipped your file" does not
  // tell the user whether they are missing one line or a hundred.
  const notice = describeInstructionSkip(decideInstruction(file('AGENTS.md', 'a\nb\nc'), UNTRUSTED));
  assert.match(notice ?? '', /3 lines/);
});

test('trusting the folder afterwards is just the same decision again', () => {
  // There is no cached state to invalidate: the decision is a pure function of the
  // file and the trust, which is what makes `/act` a reload rather than a migration.
  const found = file('AGENTS.md', 'do the thing');
  assert.equal(decideInstruction(found, UNTRUSTED).kind, 'skipped-untrusted');
  assert.equal(decideInstruction(found, TRUSTED).kind, 'injected');
});

// ---------------------------------------------------------------------------
// The walk (ADR-029)
// ---------------------------------------------------------------------------

// A walk test gets a real temporary tree, because the behaviour under test IS the
// filesystem walk. `build` runs before the body so the tree is arranged in one place.
function treeTest(name: string, build: (root: string) => void, body: (root: string, t: TestContext) => Promise<void>): void {
  test(name, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'cowcat-instr-'));
    try {
      build(root);
      await body(root, t);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

const nearest = async (dir: string): Promise<InstructionFile | null> =>
  new FileInstructionSource({ fs }).nearest(dir);

treeTest(
  'nearest wins: a deeper file beats one in an ancestor',
  (root) => {
    writeFileSync(join(root, 'AGENTS.md'), 'root rules\n');
    mkdirSync(join(root, 'pkg'));
    writeFileSync(join(root, 'pkg', 'AGENTS.md'), 'pkg rules\n');
  },
  async (root) => {
    assert.equal((await nearest(join(root, 'pkg')))?.content, 'pkg rules');
  },
);

treeTest(
  'AGENTS.md beats CLAUDE.md in the same directory',
  (root) => {
    writeFileSync(join(root, 'CLAUDE.md'), 'claude rules\n');
    writeFileSync(join(root, 'AGENTS.md'), 'agents rules\n');
  },
  async (root) => {
    assert.equal((await nearest(root))?.name, 'AGENTS.md');
  },
);

treeTest(
  'CLAUDE.md is still read when it is the only one there',
  (root) => {
    writeFileSync(join(root, 'CLAUDE.md'), 'claude rules\n');
  },
  async (root) => {
    assert.equal((await nearest(root))?.name, 'CLAUDE.md');
  },
);

treeTest(
  'COWCAT.md is NOT read, even when it is the only one there',
  (root) => {
    writeFileSync(join(root, 'COWCAT.md'), 'legacy rules\n');
  },
  async (root) => {
    assert.equal(await nearest(root), null, 'the proprietary name no longer shadows the standard');
  },
);

treeTest(
  'an empty AGENTS.md does not shadow a populated CLAUDE.md',
  (root) => {
    writeFileSync(join(root, 'AGENTS.md'), '\n  \n');
    writeFileSync(join(root, 'CLAUDE.md'), 'claude rules\n');
  },
  async (root) => {
    assert.equal((await nearest(root))?.name, 'CLAUDE.md', 'an accidentally created empty file must not win');
  },
);

treeTest(
  'the walk goes up past directories with nothing in them',
  (root) => {
    writeFileSync(join(root, 'AGENTS.md'), 'root rules\n');
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });
  },
  async (root) => {
    assert.equal((await nearest(join(root, 'a', 'b', 'c')))?.content, 'root rules');
  },
);

treeTest(
  'the content is trimmed, so a trailing newline is not part of the instructions',
  (root) => {
    writeFileSync(join(root, 'AGENTS.md'), '\n\n  rules here  \n\n');
  },
  async (root) => {
    assert.equal((await nearest(root))?.content, 'rules here');
  },
);

treeTest(
  'a directory named AGENTS.md is not an instruction file',
  (root) => {
    mkdirSync(join(root, 'AGENTS.md'));
    writeFileSync(join(root, 'CLAUDE.md'), 'claude rules\n');
  },
  async (root) => {
    assert.equal((await nearest(root))?.name, 'CLAUDE.md', 'reading a directory fails and the walk moves on');
  },
);

treeTest(
  'the walk starts at the canonical directory, so two spellings agree',
  (root) => {
    writeFileSync(join(root, 'AGENTS.md'), 'root rules\n');
    mkdirSync(join(root, 'sub'));
  },
  async (root) => {
    assert.equal((await nearest(join(root, 'sub', '..')))?.content, 'root rules', 'a `..` hop is not a different location');
  },
);

treeTest(
  'no instruction file anywhere is null, not an error',
  (root) => {
    mkdirSync(join(root, 'sub'));
  },
  async (root) => {
    assert.equal(await nearest(join(root, 'sub')), null);
  },
);

treeTest(
  'a symlinked instruction file is followed to its target',
  () => {},
  async (root, t) => {
    // The standard's own migration advice is `ln -s AGENTS.md AGENT.md`, so a symlink
    // in this position is expected rather than exotic. Creating one needs a privilege
    // on Windows, so an unavailable platform skips rather than fails.
    const target = join(root, 'real-rules.md');
    writeFileSync(target, 'via symlink\n');
    try {
      symlinkSync(target, join(root, 'AGENTS.md'));
    } catch {
      t.skip('this platform will not create a symlink here');
      return;
    }
    assert.equal((await nearest(root))?.content, 'via symlink');
  },
);
