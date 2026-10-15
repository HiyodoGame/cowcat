// Manual design-inspection dump (kept in the repo on purpose): builds a TuiUI
// on a fake TTY with a completed tool card, the slash menu open at /s, and the
// chip status bar, then writes the exact frame _draw assembles (header +
// transcript + input + status, ANSI stripped) to tmp-frame.txt next to this
// script. Run: node tmp-frame-dump.mjs
import { PassThrough } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TuiUI } from './src/tui/ui.js';
import { buildScreen } from './src/tui/render.js';
import { slashCommandList, slashCommandDocs } from './src/slashlist.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const input = new PassThrough();
const output = new PassThrough();
output.columns = 100;
output.rows = 30;
const tui = new TuiUI({
  input, output, colors: true, lang: 'zh', version: '0.11.0', cwd: join(HERE, '..'),
  getModel: () => 'kimi-k2-0905-preview',
  getMode: () => 'default',
  getCost: () => '$0.42',
  getConfig: () => ({ maxContextTokens: 100000, thinking: 'high' }),
  getMessages: () => [],
  completions: () => slashCommandList(),
  commandDocs: slashCommandDocs(),
  capabilities: { colors: '256', altScreen: true, osc8: false },
});
tui.screen.enter = () => { tui.screen.active = true; };
tui.screen.draw = () => {};
tui.start();

// transcript: user turn + a finished TodoWrite card + a finished Bash card
// (5 output lines so the fold hint renders).
tui.userMessage('帮我把输入框改成极简风格');
tui.print('好的，先看一下相关文件。');
tui.toolCall('TodoWrite', '列计划');
tui.toolSuccess();
tui.toolCall('Bash', 'node --test test/*.test.mjs');
tui.toolSuccess();
const bashEntry = tui.entries[tui.entries.length - 1];
bashEntry.card.summaryLines = ['✔ W3 completion: slashCommandDocs covers every command (0.26ms)', '✔ buildInputBox: empty input shows placeholder behind a > prompt (5.40ms)', '✔ renderStatus: chips for permission/mode/model with separators (0.89ms)'];
bashEntry.card.fullLines = [
  '✔ W3 completion: slashCommandDocs covers every command (0.26ms)',
  '✔ buildInputBox: empty input shows placeholder behind a > prompt (5.40ms)',
  '✔ renderStatus: chips for permission/mode/model with separators (0.89ms)',
  '✔ TuiUI: rule-line input box, context-line hint, chip status bar (10.90ms)',
  'ℹ tests 340 / pass 340 / fail 0',
];
tui._invalidateEntry(bashEntry);

// input: slash menu open at "/s"
tui.editor.insert('/s');

// let the async git branch lookup settle, then assemble the frame exactly the
// way _draw does and dump it stripped of ANSI.
setTimeout(() => {
  const { width, height } = tui._size();
  const inputLines = tui._inputBox();
  const frame = buildScreen({
    header: tui._header(),
    transcript: tui._flat(),
    input: inputLines,
    status: tui._status(),
    width, height,
    scroll: tui.scroll,
  });
  const text = frame.map(stripAnsi).join('\n') + '\n';
  writeFileSync(join(HERE, 'tmp-frame.txt'), text);
  console.log(text);
  tui.close();
  input.end();
  output.end();
}, 300);
