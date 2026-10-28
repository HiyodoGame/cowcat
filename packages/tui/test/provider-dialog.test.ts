import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RGBA } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { runTui } from '../src/run.js';
import { createRuntimeClient } from './runtime-client.js';

test('a opens a complete provider wizard with an opaque backdrop and saves every model field', async () => {
  const { renderer, renderOnce, captureCharFrame, captureSpans, dispose, mockInput, flush } = await createTestRenderer({ width: 100, height: 32 });
  try {
    const { client, configured } = createRuntimeClient([{ name: 'existing', baseUrl: null, apiKeyEnv: null, keySet: false, custom: true, protocol: null, complete: false, models: [] }]);
    const running = runTui({ client, sessionId: null, version: 'test', createRenderer: async () => renderer });
    await new Promise((resolve) => setTimeout(resolve, 100));
    mockInput.typeText('/providers');
    mockInput.pressEnter();
    await flush();
    mockInput.pressKey('a');
    await flush();
    await renderOnce();
    assert.match(captureCharFrame(), /选择服务商/);

    const spans = captureSpans().lines.flatMap((row) => row.spans);
    const ink = RGBA.fromHex('#141419').toInts().join(',');
    const surface = RGBA.fromHex('#2A2A33').toInts().join(',');
    assert.ok(spans.some((span) => span.bg.toInts().join(',') === ink), 'backdrop is opaque brand ink');
    assert.ok(spans.some((span) => span.bg.toInts().join(',') === surface), 'dialog has an independent surface');

    const next = async (): Promise<void> => {
      mockInput.pressEnter();
      await flush();
    };
    await next();
    await next();
    mockInput.typeText('http://localhost:11434/v1');
    await next();
    for (let index = 0; index < 14; index += 1) mockInput.pressBackspace();
    mockInput.typeText('DEMO_API_KEY');
    await next();
    mockInput.typeText('qwen3-coder');
    await next();
    mockInput.typeText('128000');
    await next();
    mockInput.typeText('8192');
    await next();
    await next();
    await renderOnce();
    assert.match(captureCharFrame(), /确认完整配置/);
    await next();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(configured, [{
      name: 'existing', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', apiKeyEnv: 'DEMO_API_KEY',
      preset: 'existing/qwen3-coder', activate: true,
      definition: { protocol: 'openai', model: 'qwen3-coder', limits: { context: 128000, output: 8192 }, toolCalls: true },
    }]);
    mockInput.pressKey('d', { ctrl: true });
    await flush();
    await running;
  } finally {
    await dispose();
  }
});



test('Shift+A searches uppercase instead of opening the new-provider form', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose, mockInput, flush } = await createTestRenderer({ width: 100, height: 28 });
  try {
    const { client } = createRuntimeClient([{ name: 'existing', baseUrl: null, apiKeyEnv: null, keySet: false, custom: true, protocol: null, complete: false, models: [] }]);
    const running = runTui({ client, sessionId: null, version: 'test', createRenderer: async () => renderer });
    await new Promise((resolve) => setTimeout(resolve, 100));
    mockInput.typeText('/providers');
    mockInput.pressEnter();
    await flush();
    mockInput.pressKey('a', { shift: true });
    await flush();
    await renderOnce();
    const form = captureCharFrame();
    assert.match(form, /│ A\s+│/);
    assert.doesNotMatch(form, /新增服务商/);
    mockInput.pressKey('d', { ctrl: true });
    await flush();
    await running;
  } finally {
    await dispose();
  }
});



test('Enter submits the model selected by the filtered dialog', async () => {
  const { renderer, dispose, mockInput, flush } = await createTestRenderer({ width: 100, height: 28 });
  try {
    const { client, modelWrites } = createRuntimeClient();
    const running = runTui({ client, sessionId: null, version: 'test', createRenderer: async () => renderer });
    await new Promise((resolve) => setTimeout(resolve, 100));
    mockInput.typeText('/model');
    mockInput.pressEnter();
    await flush();
    mockInput.typeText('two');
    mockInput.pressEnter();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(modelWrites, [{ id: 'beta/two', effort: null }]);
    mockInput.pressKey('d', { ctrl: true });
    await flush();
    await running;
  } finally {
    await dispose();
  }
});

test('a missing model opens setup and restores the draft after saving without auto-sending', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose, mockInput, flush } = await createTestRenderer({ width: 100, height: 32 });
  try {
    const { client, configured, sent } = createRuntimeClient();
    const running = runTui({ client, sessionId: null, version: 'test', createRenderer: async () => renderer });
    await new Promise((resolve) => setTimeout(resolve, 100));
    mockInput.typeText('hello local model');
    mockInput.pressEnter();
    await flush();
    await renderOnce();
    assert.match(captureCharFrame(), /先完成服务商配置/);
    for (let step = 0; step < 4; step += 1) {
      mockInput.pressEnter();
      await flush();
    }
    assert.match(captureCharFrame(), /确认完整配置/);
    mockInput.pressEnter();
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(configured[0]?.preset, 'zai/glm-5.3-flash');
    assert.deepEqual(sent, [], 'configuration never spends a model call automatically');
    await renderOnce();
    assert.match(captureCharFrame(), /hello local model/);
    mockInput.pressEnter();
    await flush();
    assert.deepEqual(sent, ['hello local model']);
    mockInput.pressKey('d', { ctrl: true });
    await flush();
    await running;
  } finally {
    await dispose();
  }
});

test('cancelling onboarding restores the unsent draft', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose, mockInput, flush } = await createTestRenderer({ width: 100, height: 28 });
  try {
    const { client } = createRuntimeClient();
    const running = runTui({ client, sessionId: null, version: 'test', createRenderer: async () => renderer });
    await new Promise((resolve) => setTimeout(resolve, 100));
    mockInput.typeText('keep me');
    mockInput.pressEnter();
    await flush();
    mockInput.pressEscape();
    await flush();
    await renderOnce();
    assert.match(captureCharFrame(), /keep me/);
    mockInput.pressKey('c', { ctrl: true });
    mockInput.pressKey('d', { ctrl: true });
    await flush();
    await running;
  } finally {
    await dispose();
  }
});

test('/model also opens provider setup when no model is configured', async () => {
  const { renderer, renderOnce, captureCharFrame, dispose, mockInput, flush } = await createTestRenderer({ width: 100, height: 28 });
  try {
    const { client } = createRuntimeClient(undefined, undefined, false);
    const running = runTui({ client, sessionId: null, version: 'test', createRenderer: async () => renderer });
    await new Promise((resolve) => setTimeout(resolve, 100));
    mockInput.typeText('/model');
    mockInput.pressEnter();
    await flush();
    await renderOnce();
    assert.match(captureCharFrame(), /先完成服务商配置/);
    mockInput.pressKey('d', { ctrl: true });
    await flush();
    await running;
  } finally {
    await dispose();
  }
});
