// P2: metadata.user_id + anthropic-beta headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function withHome(fn) {
  const saved = process.env.COWCAT_HOME;
  process.env.COWCAT_HOME = mkdtempSync(join(tmpdir(), 'cowcat-p2-'));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.COWCAT_HOME;
      else process.env.COWCAT_HOME = saved;
    });
}

test('P2-1) install id: 32-hex, persisted to ~/.cowcat/state.json, stable across loads', () =>
  withHome(async () => {
    const { loadConfig, cowcatHome } = await import('../src/config.js');
    const cfg1 = loadConfig();
    assert.match(cfg1.installId, /^[0-9a-f]{32}$/);
    const stateFile = join(cowcatHome(), 'state.json');
    assert.ok(existsSync(stateFile), 'installId must be persisted');
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).installId, cfg1.installId);
    const cfg2 = loadConfig();
    assert.equal(cfg2.installId, cfg1.installId, 'same install must reuse the id');
  }));

test('P2-2) metadata.user_id follows user_<installId>_account__session_<id>', () =>
  withHome(async () => {
    const { loadConfig } = await import('../src/config.js');
    const { AnthropicProvider } = await import('../src/llm/anthropic.js');
    const cfg = loadConfig();
    const provider = new AnthropicProvider(cfg);
    provider.setSessionId('2026-10-13T12-00-00-000Z');
    assert.deepEqual(provider.requestMetadata(), {
      user_id: `user_${cfg.installId}_account__session_2026-10-13T12-00-00-000Z`,
    });
    const { buildAnthropicRequestBody } = await import('../src/llm/anthropic.js');
    const body = buildAnthropicRequestBody(cfg, {
      system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], stream: true,
      metadata: provider.requestMetadata(),
    });
    assert.equal(body.metadata.user_id, `user_${cfg.installId}_account__session_2026-10-13T12-00-00-000Z`);
  }));

test('P2-3) anthropic-beta header declares counting + interleaved thinking, no claude-cli impersonation', () =>
  withHome(async () => {
    const { loadConfig } = await import('../src/config.js');
    const { AnthropicProvider } = await import('../src/llm/anthropic.js');
    const provider = new AnthropicProvider(loadConfig());
    const h = provider.headers();
    assert.ok(h['anthropic-beta'].includes('token-counting-2024-11-01'));
    assert.ok(h['anthropic-beta'].includes('interleaved-thinking-2025-05-14'));
    assert.ok(!h['anthropic-beta'].includes('claude-code-20250219'));
    assert.ok(!h['anthropic-beta'].includes('prompt-caching-scope'));
    const pkg = require('../package.json');
    assert.equal(h['user-agent'], `cowcat/${pkg.version}`);
  }));
