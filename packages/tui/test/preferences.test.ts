import assert from 'node:assert/strict';
import { test } from 'node:test';
import { animationsEnabled, mouseEnabled, scrollStep } from '../src/app/preferences.js';

test('the mouse is on by default, and off only when asked', () => {
  assert.equal(mouseEnabled({}), true);
  assert.equal(mouseEnabled({ COWCAT_MOUSE: 'on' }), true);
  assert.equal(mouseEnabled({ COWCAT_MOUSE: 'off' }), false);
});

test('animations are on by default, and off only when asked', () => {
  assert.equal(animationsEnabled({}), true);
  assert.equal(animationsEnabled({ COWCAT_ANIMATIONS: 'off' }), false);
});

test('the wheel moves three lines by default and can be tuned', () => {
  assert.equal(scrollStep({}), 3);
  assert.equal(scrollStep({ COWCAT_SCROLL_SPEED: '5' }), 5);
  assert.equal(scrollStep({ COWCAT_SCROLL_SPEED: '0' }), 1);
  assert.equal(scrollStep({ COWCAT_SCROLL_SPEED: '999' }), 20);
  assert.equal(scrollStep({ COWCAT_SCROLL_SPEED: 'nope' }), 3);
});
