import { BoxRenderable, TextRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';

export interface SmokeFrame {
  /** Captured character frame. Line endings are `\n`, including one after the last row. */
  frame: string;
  width: number;
  height: number;
}

/**
 * T1's premise check, expressed as something that can be run again: the native core
 * loads and produces a frame.
 *
 * It goes through the packaged `testing` entry rather than `createCliRenderer` for
 * one reason: the former needs no TTY, and "can CI run a minimal interface" is
 * exactly the T1 question. How this looks in a real terminal is T10's question and
 * is not answered here.
 *
 * T7 replaced the interface with the protocol client plus `ui/`; what is left here is the
 * premise itself, and it lives in `test/` because of the rule T10 added: **`src/ui/screen.ts`
 * is the only file in `src/` allowed to import the renderer** (ADR-066 ③). Having this
 * check in `src/` was the one thing that made that sentence untrue — caught by CI's tui leg,
 * not by the lint probe, which is the lesson: a probe per file is not a package lint.
 */
export async function renderSmokeFrame(text: string, width = 40, height = 6): Promise<SmokeFrame> {
  const { renderer, renderOnce, captureCharFrame, dispose } = await createTestRenderer({ width, height });
  try {
    const box = new BoxRenderable(renderer, { id: 'smoke-box', border: true, width: width - 4, height });
    box.add(new TextRenderable(renderer, { id: 'smoke-text', content: text }));
    renderer.root.add(box);
    await renderOnce();
    return { frame: captureCharFrame(), width, height };
  } finally {
    await dispose();
  }
}
