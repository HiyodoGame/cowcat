import assert from 'node:assert/strict';
import { test } from 'node:test';
import { animationsEnabled, mouseEnabled } from '../src/app/preferences.js';

test('the mouse is on by default, and off only when asked', () => {
  assert.equal(mouseEnabled({}), true);
  assert.equal(mouseEnabled({ COWCAT_MOUSE: 'on' }), true);
  assert.equal(mouseEnabled({ COWCAT_MOUSE: 'off' }), false);
});

test('animations are on by default, and off only when asked', () => {
  assert.equal(animationsEnabled({}), true);
  assert.equal(animationsEnabled({ COWCAT_ANIMATIONS: 'off' }), false);
});
