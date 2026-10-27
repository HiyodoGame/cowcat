import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import type { ProtocolClient } from '@corescense/cowcat-protocol';
import { runTui } from '../src/run.js';

function fakeClient(): ProtocolClient {
  const listeners = new Map<string, (payload: never) => void>();
  return {
    on(event: string, listener: (payload: never) => void) {
      listeners.set(event, listener);
      return () => { listeners.delete(event); };
    },
    closed: new Promise<void>(() => undefined),
    initialize: async () => ({}),
    trustStatus: async () => ({ trusted: true, withheld: { rules: 0, instructions: 0, skills: 0, mcpServers: 0, hooks: 0 } }),
    createSession: async () => ({ sessionId: 'sess_activity', lastSeq: 1 }),
    openSession: async () => ({ lastSeq: 1 }),
    readAttachment: async () => { throw new Error('no attachments'); },
    close: () => undefined,
    emitDelta(payload: { type: 'reasoning.delta'; turnId: string; text: string }) {
      listeners.get('delta')?.(payload as never);
    },
  } as unknown as ProtocolClient;
}

async function reasoningAt(width: number, animations: string): Promise<string> {
  const { renderer, renderOnce, captureCharFrame, dispose, mockInput, flush } = await createTestRenderer({ width, height: 24 });
  const previous = process.env.COWCAT_ANIMATIONS;
  process.env.COWCAT_ANIMATIONS = animations;
  try {
    const client = fakeClient();
    const running = runTui({ client, sessionId: null, version: 'test', createRenderer: async () => renderer });
    await new Promise((resolve) => setTimeout(resolve, 100));
    (client as unknown as { emitDelta(payload: { type: 'reasoning.delta'; turnId: string; text: string }): void }).emitDelta({ type: 'reasoning.delta', turnId: 'turn_1', text: '思考全文' });
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
