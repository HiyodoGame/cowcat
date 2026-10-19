#!/usr/bin/env node
// Probe: which of the members the TUI wants to MUTATE actually have setters, and what a
// captured frame looks like span by span?
//
// Why this exists: opentui's types describe `get content(): StyledText` and a pile of
// layout fields that are setter-only (`Renderable.d.ts:332-343`), so "can I update a line
// in place, or must I rebuild the renderable?" is a question the .d.ts does not answer
// plainly. Reading it wrong costs a redraw per streamed token, or a screen that silently
// stops updating.
//
// Usage: node tools/tui-api-probe.mjs        (needs Node >= 26.4 and packages/tui installed)
// Exits non-zero if an expectation fails.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TUI = join(here, '..', 'packages', 'tui');
const CORE_DIR = join(TUI, 'node_modules', '@opentui', 'core');

// Not `require.resolve`: the package's `exports` map has no `require` condition for either
// entry (`"./testing"` is `{ bun, import, types }` only), so CJS resolution refuses a
// subpath that an ESM `import` from inside `packages/tui` resolves fine. These are the two
// files those imports land on.
const ENTRIES = { core: join(CORE_DIR, 'index.node.js'), testing: join(CORE_DIR, 'testing.js') };
for (const [name, file] of Object.entries(ENTRIES)) {
  if (!existsSync(file)) {
    console.error(`cannot find @opentui/core's ${name} entry at ${file}`);
    console.error('run "npm ci" in packages/tui, and use Node >= 26.4');
    process.exit(2);
  }
}

const core = await import(pathToFileURL(ENTRIES.core).href);
const testing = await import(pathToFileURL(ENTRIES.testing).href);

const failures = [];
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok    ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  } else {
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
    failures.push(label);
  }
}

function hasSetter(target, name) {
  let prototype = Object.getPrototypeOf(target);
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor !== undefined) return typeof descriptor.set === 'function';
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}

const { renderer, renderOnce, captureCharFrame, captureSpans, dispose } = await testing.createTestRenderer({ width: 24, height: 4 });

try {
  console.log('renderables');
  const { BoxRenderable, InputRenderable, RGBA, ScrollBoxRenderable, TextRenderable, createTextAttributes } = core;

  const box = new BoxRenderable(renderer, { id: 'box', flexGrow: 1 });
  renderer.root.add(box);
  const text = new TextRenderable(renderer, { id: 'text', content: 'first' });
  box.add(text);

  console.log('mutability (the question the .d.ts does not answer)');
  check('TextRenderable.content has a setter', hasSetter(text, 'content'));
  check('TextRenderable.fg has a setter', hasSetter(text, 'fg'));
  check('TextRenderable.attributes has a setter', hasSetter(text, 'attributes'));
  check('TextRenderable.wrapMode has a setter', hasSetter(text, 'wrapMode'));
  check('BoxRenderable.remove exists', typeof box.remove === 'function', `arity ${String(box.remove?.length)}`);
  check('renderer.root.remove exists', typeof renderer.root.remove === 'function');
  check('BoxRenderable.flexDirection has a setter', hasSetter(box, 'flexDirection'));
  check('ScrollBoxRenderable.scrollTop has a setter', hasSetter(new ScrollBoxRenderable(renderer, { id: 's' }), 'scrollTop'));

  const input = new InputRenderable(renderer, { id: 'input', width: '100%', placeholder: 'say it' });
  check('InputRenderable.value has a setter', hasSetter(input, 'value'));
  check('InputRenderable.placeholder has a setter', hasSetter(input, 'placeholder'));
  check('InputRenderable.focus exists', typeof input.focus === 'function');
  // `on('enter')` is how a submitted value arrives, so the matching `off` has to exist or
  // teardown throws.
  check('InputRenderable.off exists (unsubscribe)', typeof input.off === 'function');
  check('renderer.keyInput.on/off exist', typeof renderer.keyInput.on === 'function' && typeof renderer.keyInput.off === 'function');

  // The two facts from the .d.ts that would otherwise bite silently.
  console.log('colour parsing');
  const magenta = RGBA.fromHex('#FF00FF');
  check('RGBA.defaultForeground() is not the magenta fallback', RGBA.defaultForeground().toInts().join(',') !== magenta.toInts().join(','), `default=${RGBA.defaultForeground().toInts().join(',')}`);
  check('createTextAttributes({ bold: true }) is a number', typeof createTextAttributes({ bold: true }) === 'number', String(createTextAttributes({ bold: true })));

  // Update in place, then read the frame back.
  text.content = 'second';
  input.value = 'typed';
  await renderOnce();
  const frame = captureCharFrame();
  check('an in-place content update reaches the frame', frame.includes('second'), JSON.stringify(frame.split('\n')[0]));

  const spans = captureSpans();
  check('captureSpans() reports the grid', typeof spans.cols === 'number' && typeof spans.rows === 'number', `${String(spans.cols)}x${String(spans.rows)}`);
  check('captureSpans() gives per-line spans with colours', Array.isArray(spans.lines) && spans.lines[0]?.spans[0]?.fg !== undefined, JSON.stringify(spans.lines[0]?.spans[0] ?? null));
} finally {
  await dispose();
}

console.log(`\n${failures.length === 0 ? 'all probes behave as expected' : `${String(failures.length)} probe(s) failed`}`);
process.exit(failures.length === 0 ? 0 : 1);
