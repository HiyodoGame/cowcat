import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RGBA } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { runTui } from '../src/run.js';
import { createRuntimeClient } from './runtime-client.js';

test('a opens a complete provider wizard with an opaque backdrop and saves every model field', async () => {
  const { renderer, captureSpans, dispose, mockInput, flush, waitFor, waitForFrame } = await createTestRenderer({ width: 100, height: 32 });
  try {
    const { client, sessionReady, configured } = createRuntimeClient([{ name: 'existing', baseUrl: null, apiKeyEnv: null, keySet: false, custom: true, protocol: null, complete: false, models: [] }]);
    const running = runTui({ client, sessionId: null, version: 'test', createRenderer: async () => renderer });
    await sessionReady;
    mockInput.typeText('/providers');
    mockInput.pressEnter();
    await waitForFrame((frame) => frame.includes('existing'));
    mockInput.pressKey('a');
    await waitForFrame((frame) => frame.includes('选择服务商'));

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
    await waitForFrame((frame) => frame.includes('确认完整配置'));
    await next();
    await waitFor(() => configured.length === 1);
    await waitForFrame((frame) => frame.includes('existing 当前') && frame.includes('http://localhost:11434/v1'));
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
  const { renderer, dispose, mockInput, flush, waitForFrame } = await createTestRenderer({ width: 100, height: 28 });
  try {
    const { client, sessionReady } = createRuntimeClient([{ name: 'existing', baseUrl: null, apiKeyEnv: null, keySet: false, custom: true, protocol: null, complete: false, models: [] }]);
    const running = runTui({ client, sessionId: null, version: 'test', createRenderer: async () => renderer });
    await sessionReady;
    mockInput.typeText('/providers');
    mockInput.pressEnter();
    await waitForFrame((frame) => frame.includes('existing'));
    mockInput.pressKey('a', { shift: true });
    const form = await waitForFrame((frame) => /│ A\s+│/.test(frame));
    assert.doesNotMatch(form, /新增服务商/);
    mockInput.pressKey('d', { ctrl: true });
    await flush();
    await running;
  } finally {
    await dispose();
  }
});

test('Enter submits the model selected by the filtered dialog', async () => {
  const { renderer, dispose, mockInput, flush, waitFor, waitForFrame } = await createTestRenderer({ width: 100, height: 28 });
  try {
    const { client, sessionReady, modelWrites } = createRuntimeClient();
    const running = runTui({ client, sessionId: null, version: 'test', createRenderer: async () => renderer });
    await sessionReady;
    mockInput.typeText('/model');
    mockInput.pressEnter();
    await waitForFrame((frame) => frame.includes('alpha/one'));
    mockInput.typeText('two');
    mockInput.pressEnter();
    await waitFor(() => modelWrites.length === 1);
    assert.deepEqual(modelWrites, [{ id: 'beta/two', effort: null }]);
    mockInput.pressKey('d', { ctrl: true });
    await flush();
    await running;
  } finally {
    await dispose();
  }
});

test('a missing model opens setup and restores the draft after saving without auto-sending', async () => {
  const { renderer, dispose, mockInput, flush, waitFor, waitForFrame } = await createTestRenderer({ width: 100, height: 32 });
  try {
    const { client, sessionReady, configured, sent } = createRuntimeClient(undefined, undefined, true, 150);
    const running = runTui({ client, sessionId: null, version: 'test', createRenderer: async () => renderer });
    await sessionReady;
    mockInput.typeText('hello local model');
    mockInput.pressEnter();
    await waitForFrame((frame) => frame.includes('先完成服务商配置'));
    for (let step = 0; step < 4; step += 1) {
      mockInput.pressEnter();
      await flush();
    }
    await waitForFrame((frame) => frame.includes('确认完整配置'));
    mockInput.pressEnter();
    await waitFor(() => configured.length === 1);
    await waitForFrame((frame) => frame.includes('hello local model'));
    assert.equal(configured[0]?.preset, 'zai/glm-5.3-flash');
    assert.deepEqual(sent, [], 'configuration never spends a model call automatically');
    mockInput.pressEnter();
    await waitFor(() => sent.length === 1);
    assert.deepEqual(sent, ['hello local model']);
    mockInput.pressKey('d', { ctrl: true });
    await flush();
    await running;
  } finally {
    await dispose();
  }
});

test('cancelling onboarding restores the unsent draft', async () => {
  const { renderer, dispose, mockInput, flush, waitForFrame } = await createTestRenderer({ width: 100, height: 28 });
  try {
    const { client, sessionReady } = createRuntimeClient();
    const running = runTui({ client, sessionId: null, version: 'test', createRenderer: async () => renderer });
    await sessionReady;
    mockInput.typeText('keep me');
    mockInput.pressEnter();
    await waitForFrame((frame) => frame.includes('先完成服务商配置'));
    mockInput.pressEscape();
    await waitForFrame((frame) => frame.includes('keep me'));
    mockInput.pressKey('c', { ctrl: true });
    mockInput.pressKey('d', { ctrl: true });
    await flush();
    await running;
  } finally {
    await dispose();
  }
});

test('/model also opens provider setup when no model is configured', async () => {
  const { renderer, dispose, mockInput, flush, waitForFrame } = await createTestRenderer({ width: 100, height: 28 });
  try {
    const { client, sessionReady } = createRuntimeClient(undefined, undefined, false);
    const running = runTui({ client, sessionId: null, version: 'test', createRenderer: async () => renderer });
    await sessionReady;
    mockInput.typeText('/model');
    mockInput.pressEnter();
    await waitForFrame((frame) => frame.includes('先完成服务商配置'));
    mockInput.pressKey('d', { ctrl: true });
    await flush();
    await running;
  } finally {
    await dispose();
  }
});
