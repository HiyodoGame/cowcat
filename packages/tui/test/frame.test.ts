import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestRenderer } from '@opentui/core/testing';
import type { WireEvent } from '@corescense/cowcat-protocol';
import { addNotice, project, streamText } from '../src/app/project.js';
import { initialView, type TuiView } from '../src/app/view.js';
import { frameOf, titleOf } from '../src/components/session-frame.js';
import { THEME } from '../src/theme/tokens.js';
import { createScreen } from '../src/ui/screen.js';
import { FRAMES } from './frames.js';

/**
 * ADR-059 ② in the form it was written in: feed the screen a written-down log, render one
 * frame, and compare it byte for byte.
 *
 * Why a snapshot and not a property assertion: what is being tested is that the same log
 * produces the same screen, and only a whole frame says that. Why a test renderer: it needs
 * no TTY, which is what makes this run in CI (ADR-056's premise, reused here as the pump).
 *
 * The expected frames live in `test/frames.ts` as a compiled module rather than in `.txt`
 * files next to the source, for one practical reason: this file runs from `dist/`, and a
 * fixture directory under `dist/` is deleted by the next build and can never be committed.
 *
 * `UPDATE_SNAPSHOTS=1 npm test` rewrites that module. **Look at the diff before committing
 * it** — a snapshot nobody read is a photograph, and a regenerated frame that "passes" is
 * exactly how a rendering regression gets blessed.
 */
const WIDTH = 64;
const HEIGHT = 16;
const RENDERER_VERSION = '0.0.0-test';
/**
 * A FIXED clock for every snapshot.
 *
 * `now` reaches a component (the "you still there" nudge), so a snapshot taken against the
 * real clock would change ten seconds after the approval scene was written — a fixture that
 * fails on its own is a fixture nobody trusts. The nudge scene passes a later value.
 */
const CLOCK = 1_000;

/** `dist/test/` → `test/`: the source tree, which is what the module belongs to. */
const SOURCE_TEST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test');

interface Rendered {
  readonly frame: string;
  readonly rowWidths: readonly number[];
}

async function renderSnapshot(view: TuiView, now: number = CLOCK): Promise<Rendered> {
  const { renderer, renderOnce, captureCharFrame, captureSpans, dispose } = await createTestRenderer({ width: WIDTH, height: HEIGHT });
  try {
    const screen = createScreen(renderer, THEME, { title: titleOf(RENDERER_VERSION) });
    // The same width the loop uses: the terminal's, minus the screen's own chrome. A card
    // measured against the terminal would be two cells too wide and wrap out of its box.
    screen.update(frameOf(view, { width: screen.contentWidth(), now }));
    await renderOnce();
    // `captureSpans()` reports each span's own width — the renderer's answer about cells,
    // which is what the layout is made of. Counting characters would be wrong the moment a
    // CJK glyph appears: it is two cells and one grapheme.
    const rowWidths = captureSpans().lines.map((line) => line.spans.reduce((sum, span) => sum + span.width, 0));
    return { frame: captureCharFrame(), rowWidths };
  } finally {
    await dispose();
  }
}

const rendered = new Map<string, Rendered>();
const updated: Record<string, string> = {};

async function expectFrame(name: string, view: TuiView, now: number = CLOCK): Promise<Rendered> {
  const snapshot = await renderSnapshot(view, now);
  rendered.set(name, snapshot);
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    updated[name] = snapshot.frame;
    return snapshot;
  }
  const expected = FRAMES[name];
  if (expected === undefined) {
    assert.fail(`no expected frame for "${name}" — run with UPDATE_SNAPSHOTS=1 and review it`);
  }
  if (expected !== snapshot.frame) {
    assert.fail(`frame "${name}" differs from test/frames.ts\n${firstDifference(expected, snapshot.frame)}`);
  }
  return snapshot;
}

/** The first differing row, with both sides quoted — a whole-frame dump helps nobody. */
function firstDifference(expected: string, actual: string): string {
  const left = expected.split('\n');
  const right = actual.split('\n');
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) {
      return `row ${String(index + 1)}\n  expected: ${JSON.stringify(left[index] ?? null)}\n  actual:   ${JSON.stringify(right[index] ?? null)}`;
    }
  }
  return '(the rows are equal but the total length differs)';
}

/** Writes `test/frames.ts`. `JSON.stringify` is the escaping, so CJK survives verbatim. */
function writeFrames(): void {
  const body = Object.entries(updated)
    .map(([name, frame]) => `  ${name}: ${JSON.stringify(frame)},`)
    .join('\n');
  const module = `// Expected frames, produced by rendering the scenes in frame.test.ts and looked at by a
// human. Regenerate with UPDATE_SNAPSHOTS=1 and review the diff.
export const FRAMES: Readonly<Record<string, string>> = {
${body}
};
`;
  writeFileSync(join(SOURCE_TEST, 'frames.ts'), module, 'utf8');
  console.log(`  wrote ${join(SOURCE_TEST, 'frames.ts')}`);
}

let seq = 0;
function event(type: string, body: Record<string, unknown> = {}): WireEvent {
  seq += 1;
  return { seq, ts: 1, sessionId: 'sess_t7', turnId: 'turn_1', type, ...body };
}

function from(events: readonly WireEvent[]): TuiView {
  seq = 0;
  return events.reduce((view, item) => project(view, item), initialView());
}

const OPENED = event('session.opened', {
  schemaVersion: 1,
  cowcatVersion: '0.0.0',
  shell: { kind: 'posix', executable: '/bin/sh' },
});

test('an empty screen says where it is and how to leave', async () => {
  seq = 0;
  await expectFrame('empty', initialView());
});

test('a turn with a tool result and an answer', async () => {
  seq = 0;
  const opened = OPENED;
  await expectFrame(
    'turn',
    from([
      opened,
      event('turn.opened', { input: 'rename value to total' }),
      event('turn.transitioned', { from: 'opened', to: 'requesting', reason: null }),
      event('tool.finished', {
        callId: 'c1',
        name: 'Edit',
        ok: true,
        output: 'updated src/total.ts',
        facts: null,
        truncation: null,
        attachments: null,
        path: '/work/src/total.ts',
      }),
      event('model.message', { text: 'Renamed it. The diff is one line.', toolCalls: [], reasoning: [], stopReason: null }),
      event('turn.transitioned', { from: 'requesting', to: 'completed', reason: null }),
    ]),
  );
});

test('a live stream, which no event has replaced yet', async () => {
  seq = 0;
  const asked = from([
    OPENED,
    event('turn.opened', { input: 'explain the attach seam' }),
    event('turn.transitioned', { from: 'opened', to: 'streaming', reason: null }),
  ]);
  const streaming = streamText(
    streamText(asked, { type: 'model.delta', turnId: 'turn_1', text: 'the host subscribes ' }),
    { type: 'model.delta', turnId: 'turn_1', text: 'before reading the log' },
  );
  await expectFrame('streaming', streaming);
});

test('a pending approval takes over the input line', async () => {
  seq = 0;
  const asked = from([
    OPENED,
    event('turn.opened', { input: '清一下构建目录' }),
    event('turn.transitioned', { from: 'opened', to: 'awaiting_tools', reason: null }),
    event('approval.requested', { callId: 'c7', name: 'Bash', rule: 'exec-asks', reason: null }),
  ]);
  await expectFrame('approval', addNotice(asked, 'warn', 'the tool wants network access'));
});

test('an approval nobody answers nudges, which is the one redraw nothing triggers', async () => {
  seq = 0;
  const asked = from([
    OPENED,
    event('turn.opened', { input: '清一下构建目录' }),
    event('approval.requested', { callId: 'c7', name: 'Bash', rule: 'exec-asks', reason: null }),
  ]);
  // Eleven seconds in, with a clock that is injected rather than read.
  await expectFrame('nudge', asked, CLOCK + 11_000);
});

test('the todo panel, and the command palette over it', async () => {
  seq = 0;
  const withTodos = from([
    OPENED,
    event('turn.opened', { input: '把登录接口改成 JWT' }),
    event('todo.updated', {
      todos: [
        { content: '加 JWT 校验', status: 'in_progress', activeForm: '在加 JWT 校验' },
        { content: '跑一遍测试', status: 'pending', activeForm: '在跑测试' },
        { content: '读一遍现有实现', status: 'completed', activeForm: '在读实现' },
      ],
    }),
  ]);
  await expectFrame('todos', withTodos);
  await expectFrame('palette', { ...withTodos, palette: { index: 1 } });
});

// CJK is two cells wide and one grapheme, so the count that matters is the renderer's own
// span widths — not `Intl.Segmenter`'s clusters, which the T1 premise check could get away
// with only because its content was pure ASCII.
test('every row of a frame is exactly the requested width, CJK included', async () => {
  seq = 0;
  const view = from([
    OPENED,
    event('turn.opened', { input: '把 value 改名成 total' }),
    event('model.message', { text: '改好了，一行 diff。', toolCalls: [], reasoning: [], stopReason: null }),
  ]);
  const { frame, rowWidths } = await renderSnapshot(view);
  assert.equal(rowWidths.length, HEIGHT);
  for (const [index, width] of rowWidths.entries()) {
    // An unequal row shifts every column after it: this is the misalignment the brand guide
    // warns about, and the reason a wide character counted as one column is a real bug
    // rather than a cosmetic one.
    assert.equal(width, WIDTH, `row ${String(index + 1)} is ${String(width)} cells, expected ${String(WIDTH)}`);
  }
  // The Chinese answer really is on screen, and really is what made the row wide.
  assert.match(frame, /把 value 改名成 total/);
  assert.match(frame, /改好了，一行 diff。/);
});

// Runs last (node:test keeps declaration order), so every scene above is in hand.
test('the fixtures were written when asked', () => {
  if (process.env.UPDATE_SNAPSHOTS !== '1') {
    // Reading the module at all is the point when we are not updating: a missing or
    // hand-edited file would fail above.
    assert.ok(Object.keys(FRAMES).length >= 4, 'frames.ts must carry every scene');
    return;
  }
  writeFrames();
});
