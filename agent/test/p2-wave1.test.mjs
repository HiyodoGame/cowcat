// P2 wave 1: /context visualization, thinking cards, @-mention, doctor forms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeContext, renderContextReport } from '../src/contextviz.js';
import { thinkingBlocksOf, summarizeThinking, renderThinkingCard } from '../src/thinking.js';
import { completeFiles } from '../src/mention.js';
import { runFix, runInspect, renderInspect, doctorJson } from '../src/doctor.js';
import { LineEditor } from '../src/lineeditor.js';

// --- P2-1 /context --------------------------------------------------------------

test('P2-1: context analysis aggregates sections, roles, largest, warnings', () => {
  const messages = [
    { role: 'user', content: 'u'.repeat(400) },        // ~100+ tokens
    { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(800) }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(4000) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ];
  const a = analyzeContext(messages, 1000, { systemBlocks: ['s'.repeat(400)] });
  assert.ok(a.total > 1000, 'total exceeds the small cap');
  assert.equal(a.warning, 'critical');
  assert.equal(a.pct, Math.round((a.total / 1000) * 100));
  assert.equal(a.sections.length, 4, 'contiguous roles merged into 4 sections');
  assert.ok(a.byRole.user > 0 && a.byRole.assistant > 0);
  assert.equal(a.largest[0].role, 'user', 'the big tool_result wins');
  assert.ok(a.systemTokens > 0);

  const a2 = analyzeContext(messages, 100000);
  assert.equal(a2.warning, null);

  const text = renderContextReport(a, { colors: false }).join('\n');
  assert.match(text, /context: ~[\d,]+ \/ 1,000 est\. tokens \(\d+%\)/);
  assert.match(text, /⚠ 接近上限/);
  assert.match(text, /sections \(oldest → newest\)/);
  assert.match(text, /largest messages:/);
});

// --- P2-5 thinking -----------------------------------------------------------------

test('P2-5: thinking blocks collected, summarized, collapsed and expanded cards', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'thinking', thinking: '先读文件\n再决定改哪里' }, { type: 'text', text: 'ok' }] },
    { role: 'user', content: 'next' },
  ];
  const blocks = thinkingBlocksOf(messages);
  assert.equal(blocks.length, 1);
  assert.equal(summarizeThinking('先读文件 再决定改哪里', 10).length <= 10, true);
  const collapsed = renderThinkingCard(blocks[0], { expanded: false, colors: false });
  assert.match(collapsed, /⏷ thinking · [\d,]+ chars — 先读文件/);
  const expanded = renderThinkingCard(blocks[0], { expanded: true, colors: false });
  assert.match(expanded, /│ 先读文件\n/);
  assert.match(expanded, /│ 再决定改哪里/);
});

// --- P2-6 @-mention ------------------------------------------------------------------

test('P2-6: completeFiles fuzzy-matches project files with @ prefix', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cowcat-mention-'));
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'index.js'), '');
  writeFileSync(join(cwd, 'src', 'index.test.js'), '');
  writeFileSync(join(cwd, 'README.md'), '');
  const all = completeFiles(cwd, '');
  assert.ok(all.includes('@src/index.js'));
  assert.ok(all.includes('@README.md'));
  const hits = completeFiles(cwd, 'index');
  assert.deepEqual(hits.sort(), ['@src/index.js', '@src/index.test.js']);
  assert.deepEqual(completeFiles(cwd, 'zzz'), []);

  // editor integration: @prefix + Tab cycles candidates
  const ed = new LineEditor({ fileCompletions: (p) => completeFiles(cwd, p) });
  ed.handle('看看 @index');
  ed.handle('\t');
  assert.equal(ed.text, '看看 @src/index.js');
  ed.handle('\t');
  assert.equal(ed.text, '看看 @src/index.test.js');
  ed.handle('\t');
  assert.equal(ed.text, '看看 @index', 'cycles back to the raw prefix');
});

// --- P2-7 doctor three forms ------------------------------------------------------------

test('P2-7: runFix repairs config shape and reports each fix', () => {
  const cfg = {
    provider: 'anthropic', baseURL: 'https://x', apiKey: 'k', model: 'm',
    permissions: { allow: ['Read', 'Bad(', 'Bash(npm run test:*)'], deny: 'not-an-array' },
    trustedProjects: undefined,
    hooks: 'broken',
  };
  const { fixes, config } = runFix(cfg, { hasConfigFile: false, knownTools: ['Read', 'Bash'] });
  assert.ok(fixes.some((f) => f.includes('创建 config.json')));
  assert.ok(fixes.some((f) => f.includes('trustedProjects')));
  assert.ok(fixes.some((f) => f.includes('坏规则')));
  assert.ok(fixes.some((f) => f.includes('hooks')));
  assert.deepEqual(config.trustedProjects, []);
  assert.deepEqual(config.permissions.allow, ['Read', 'Bash(npm run test:*)'], 'bad rule dropped, good kept');
  assert.equal(config.hooks['deny'] ?? typeof config.permissions.deny, 'object');
  assert.deepEqual(config.permissions.deny, [], 'non-array deny reset');
});

test('P2-7: inspect sections render and --json shape is machine readable', () => {
  const sections = runInspect(
    { provider: 'anthropic', baseURL: 'https://x', apiKey: 'sk-abcdefghijklmnop', model: 'm', maxTokens: 32000, maxContextTokens: 100000, permissions: { allow: ['Read'] }, hooks: { Stop: [{}] } },
    { knownTools: ['Read'], sessionCount: 3, toolCount: 13 },
  );
  const text = renderInspect(sections);
  assert.match(text, /\[config\][\s\S]*sk-a…mnop/);
  assert.match(text, /\[permission rules\][\s\S]*allow: 1/);
  assert.match(text, /\[hooks\][\s\S]*Stop: 1/);
  assert.match(text, /\[state\][\s\S]*sessions: 3/);

  const json = JSON.parse(doctorJson({
    items: [{ name: 'provider', ok: true, detail: 'anthropic' }, { name: 'API key', ok: false, detail: 'missing' }],
    fixes: ['补全 trustedProjects: []'],
  }));
  assert.equal(json.ok, false);
  assert.equal(json.items.length, 2);
  assert.deepEqual(json.fixes, ['补全 trustedProjects: []']);
});
