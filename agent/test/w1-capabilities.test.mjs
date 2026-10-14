// W1 Task 2: terminal capability detection (pure, env-injected).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectCapabilities } from '../src/tui/capabilities.js';

const TTY = { stdinIsTTY: true, stdoutIsTTY: true };

test('capabilities: Windows Terminal env yields 24bit + altScreen + osc8', () => {
  const caps = detectCapabilities({ env: { WT_SESSION: 'x' }, ...TTY });
  assert.deepEqual(caps, { colors: '24bit', altScreen: true, osc8: true });
});

test('capabilities: TERM_PROGRAM also yields 24bit', () => {
  const caps = detectCapabilities({ env: { TERM_PROGRAM: 'iTerm.app' }, ...TTY });
  assert.equal(caps.colors, '24bit');
  assert.equal(caps.osc8, true);
});

test('capabilities: COLORTERM truecolor/24bit yields 24bit', () => {
  assert.equal(detectCapabilities({ env: { COLORTERM: 'truecolor' }, ...TTY }).colors, '24bit');
  assert.equal(detectCapabilities({ env: { COLORTERM: '24bit' }, ...TTY }).colors, '24bit');
});

test('capabilities: CI or NO_COLOR forces colors none', () => {
  assert.equal(detectCapabilities({ env: { CI: 'true', COLORTERM: 'truecolor' }, ...TTY }).colors, 'none');
  assert.equal(detectCapabilities({ env: { NO_COLOR: '1', WT_SESSION: 'x' }, ...TTY }).colors, 'none');
});

test('capabilities: non-TTY forces colors none even with truecolor env', () => {
  const caps = detectCapabilities({ env: { COLORTERM: 'truecolor' }, stdinIsTTY: false, stdoutIsTTY: true });
  assert.equal(caps.colors, 'none');
  const caps2 = detectCapabilities({ env: { WT_SESSION: 'x' }, stdinIsTTY: true, stdoutIsTTY: false });
  assert.equal(caps2.colors, 'none');
});

test('capabilities: TERM containing 256 yields 256', () => {
  const caps = detectCapabilities({ env: { TERM: 'xterm-256color' }, ...TTY });
  assert.equal(caps.colors, '256');
});

test('capabilities: bare env with dual TTY yields 16', () => {
  const caps = detectCapabilities({ env: {}, ...TTY });
  assert.deepEqual(caps, { colors: '16', altScreen: true, osc8: false });
});

test('capabilities: altScreen requires dual TTY and TERM !== dumb', () => {
  assert.equal(detectCapabilities({ env: {}, ...TTY }).altScreen, true);
  assert.equal(detectCapabilities({ env: { TERM: 'dumb' }, ...TTY }).altScreen, false);
  assert.equal(detectCapabilities({ env: {}, stdinIsTTY: true, stdoutIsTTY: false }).altScreen, false);
  assert.equal(detectCapabilities({ env: {}, stdinIsTTY: false, stdoutIsTTY: true }).altScreen, false);
});

test('capabilities: osc8 off on classic conhost (no WT_SESSION/TERM_PROGRAM, TERM unset or dumb)', () => {
  assert.equal(detectCapabilities({ env: {}, ...TTY }).osc8, false);
  assert.equal(detectCapabilities({ env: { TERM: 'dumb' }, ...TTY }).osc8, false);
  assert.equal(detectCapabilities({ env: { TERM: 'xterm-256color' }, ...TTY }).osc8, true);
  assert.equal(detectCapabilities({ env: { WT_SESSION: 'x' }, ...TTY }).osc8, true);
  assert.equal(detectCapabilities({ env: { TERM_PROGRAM: 'vscode' }, ...TTY }).osc8, true);
  // no altScreen → no osc8 regardless of env
  assert.equal(detectCapabilities({ env: { WT_SESSION: 'x' }, stdinIsTTY: false, stdoutIsTTY: true }).osc8, false);
});

test('capabilities: 24bit beats 256 when both signals present', () => {
  const caps = detectCapabilities({ env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' }, ...TTY });
  assert.equal(caps.colors, '24bit');
});
