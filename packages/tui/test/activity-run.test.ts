import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { runTui } from '../src/run.js';
import { createRuntimeClient } from './runtime-client.js';

async function reasoningAt(width: number, animations: string): Promise<string> {
  const { renderer, renderOnce, captureCharFrame, dispose, mockInput, flush } = await createTestRenderer({ width, height: 24 });
  const previous = process.env.COWCAT_ANIMATIONS;
  process.env.COWCAT_ANIMATIONS = animations;
  try {
    const runtime = createRuntimeClient();
    const running = runTui({ client: runtime.client, sessionId: null, version: 'test', createRenderer: async () => renderer });
    await new Promise((resolve) => setTimeout(resolve, 100));
    runtime.emitDelta({ type: 'reasoning.delta', turnId: 'turn_1', text: '思考全文' });
    await new Promise((resolve) => setTimeout(resolve, animations === 'off' ? 200 : 1_200));
    await renderOnce();
    const frame = captureCharFrame();
    mockInput.pressKey('d', { ctrl: true });
    await flush();
    await running;
    return frame;
  } finally {
    if (previous === undefined) delete process.env.COWCAT_ANIMATIONS;
    else process.env.COWCAT_ANIMATIONS = previous;
    await dispose();
  }
}

test('an 80-column TUI reveals live reasoning without an activity rail', async () => {
  assert.match(await reasoningAt(80, 'on'), /思考全文/);
});

test('reduced motion reveals the complete reasoning buffer on a narrow TUI', async () => {
  assert.match(await reasoningAt(120, 'off'), /思考全文/);
});
