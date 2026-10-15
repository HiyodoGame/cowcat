// Interactive setup wizard, shared by the `cowcat setup` subcommand and the
// REPL's /setup slash command. Preset-catalog driven: pick a provider from the
// distillation catalog (filter + number select, configured providers marked),
// then one of its models, then the API key. "custom" falls back to the legacy
// four-question flow for non-catalog endpoints. Non-interactive stdin (EOF)
// falls back to the current env/defaults without asking. Writes the new
// schema (model: "provider/model" + providers patch) via saveSetupConfig.
import { saveSetupConfig } from './doctor.js';
import { configuredProviders, loadConfig } from './config.js';

const MAX_ROWS = 15;

function filterProviders(providers, query) {
  const q = String(query || '').trim().toLowerCase();
  const sorted = [...providers].sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
  if (!q) return sorted;
  return sorted.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
}

function modelRows(models) {
  return Object.entries(models || {})
    .filter(([, m]) => m && !m.disabled)
    .map(([id, m]) => ({
      id,
      title: m.name || id,
      description: `${id}${m.limit && typeof m.limit.context === 'number' ? ` · ctx ${Math.round(m.limit.context / 1000)}k` : ''}`,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export async function runSetupWizard(ui) {
  const zh = ui.lang === 'zh';
  const t = (z, e) => (zh ? z : e);
  ui.print(t('CowCat setup —— 从预置目录选择 provider（输入过滤，编号选择，custom 为自定义端点）。', 'CowCat setup — pick a provider from the preset catalog (type to filter, number to select, "custom" for a custom endpoint).'));

  const ask = async (q, def) => {
    ui.output.write(def !== undefined && def !== null && def !== '' ? `${q} [${def}]: ` : `${q}: `);
    const raw = await ui.readLine();
    if (raw === null) return null; // stdin closed — non-interactive
    const a = raw.trim();
    return a || def;
  };

  // Non-interactive stdin (EOF on the first prompt): fall back to env/defaults.
  ui.output.write(t('回车列出 provider，或输入过滤词: ', 'Enter to list providers, or type a filter: '));
  const raw0 = await ui.readLine();
  if (raw0 === null) return writeFallback(ui);

  // (a) provider pick — the first line doubles as filter/custom/number input.
  let provider = null;
  let query = '';
  let pending = raw0.trim();
  while (!provider) {
    const matches = filterProviders(configuredProviders(), query).slice(0, MAX_ROWS);
    if (!matches.length) {
      ui.print(t(`  （没有匹配 "${query}" 的 provider，换个过滤词；${matches.length + 1} = 自定义端点）`, `  (no provider matches "${query}" — try another filter; ${matches.length + 1} = custom endpoint)`));
    } else {
      matches.forEach((p, i) => {
        const mark = p.configured ? ' ✓' : '';
        ui.print(`  ${i + 1}. ${p.name} (${p.id})${mark}${p.protocol ? ` — ${p.protocol}` : ''}`);
      });
    }
    ui.print(`  ${matches.length + 1}. ${t('自定义端点（custom）', 'Custom endpoint (custom)')}`);
    const ans = pending !== null ? pending : await ask(t('编号或过滤词', 'Number or filter'));
    pending = null;
    if (ans === null) return writeFallback(ui);
    const a0 = String(ans).trim();
    if (!a0) continue; // bare enter: keep the current list, ask again
    const n = Number(a0);
    if (Number.isInteger(n) && n >= 1 && n <= matches.length) { provider = matches[n - 1]; break; }
    if (n === matches.length + 1) break; // custom
    if (/^custom$/i.test(a0)) break; // custom
    query = a0; // treat as a new filter
  }

  // custom endpoint: legacy four-question flow (flat schema)
  if (!provider) {
    const protocol = await ask('protocol (anthropic|openai)', 'openai');
    if (protocol === null) return writeFallback(ui);
    const baseURL = await ask('base URL', 'https://api.kimi.com/coding');
    if (baseURL === null) return writeFallback(ui);
    ui.output.write(t('API key (输入不回显): ', 'API key (not echoed): '));
    const rawKey = await ui.readSecret();
    if (rawKey === null) return writeFallback(ui);
    const apiKey = rawKey.trim();
    const model = await ask(t('模型名（该端点上的 id）', 'Model id on that endpoint'), 'kimi-for-coding');
    if (model === null) return writeFallback(ui);
    const { file, config } = saveSetupConfig({ provider: protocol, baseURL, apiKey, model });
    ui.print(`${t('✓ 已写入', '✓ saved to')} ${file}`);
    return config;
  }

  // (b) model pick
  const rows = modelRows(provider.models);
  let modelId = null;
  if (!rows.length) {
    modelId = await ask(t(`模型 id（${provider.name} 目录为空，手动填写）`, `Model id (${provider.name} catalog is empty, enter manually)`), '');
  } else {
    ui.print(t(`# ${provider.name} — ${t('选择默认模型', 'pick the default model')}`));
    rows.slice(0, MAX_ROWS).forEach((r, i) => ui.print(`  ${i + 1}. ${r.title} — ${r.description}`));
    while (!modelId) {
      const ans = await ask(t('编号，或直接输入模型 id', 'Number, or type a model id'));
      if (ans === null) return writeFallback(ui);
      const a0 = String(ans).trim();
      const n = Number(a0);
      if (Number.isInteger(n) && n >= 1 && n <= Math.min(rows.length, MAX_ROWS)) { modelId = rows[n - 1].id; break; }
      if (a0) { modelId = a0; break; } // free-form model id
    }
  }

  // (c) API key
  const envHint = provider.env.length ? ` (${provider.env.join(' / ')})` : '';
  ui.output.write(t(`API key${envHint}（留空则用环境变量，不回显）: `, `API key${envHint} (empty = use the env var, not echoed): `));
  const rawKey = await ui.readSecret();
  if (rawKey === null) return writeFallback(ui);
  const apiKey = rawKey.trim();

  // (d) confirm + write
  const ref = `${provider.id}/${modelId}`;
  ui.print(t('--- 确认 ---', '--- summary ---'));
  ui.print(`  provider: ${provider.name} (${provider.id})`);
  ui.print(`  model:    ${ref}`);
  ui.print(`  key:      ${apiKey ? (apiKey.slice(0, 4) + '…') : t('（用环境变量）', '(from env)')}`);
  const ok = await ask(t('写入？回车确认', 'Write? Enter to confirm'), 'y');
  if (ok === null) return writeFallback(ui);
  if (ok && !/^(y|yes|)$/i.test(ok)) {
    ui.print(t('已取消。', 'Cancelled.'));
    return null;
  }
  let envKey = null;
  try { envKey = loadConfig().apiKey; } catch { /* unresolved config: no key to carry */ }
  const answers = { schema: 'providers', model: ref, apiKey: apiKey || envKey || undefined, providerId: provider.id };
  const { file, config } = saveSetupConfig(answers);
  ui.print(`${t('✓ 已写入', '✓ saved to')} ${file}`);
  return config;
}

// Non-interactive fallback: persist whatever the layered resolution currently
// sees (env vars / existing config / defaults) in the new schema.
function writeFallback(ui) {
  const { file, config } = saveSetupConfig(fallbackAnswers());
  ui.print(`${ui.lang === 'zh' ? '✓ 非交互环境，已按当前环境变量写入' : '✓ non-interactive: written from current environment'} ${file}`);
  return config;
}

function fallbackAnswers() {  try {
    const cfg = loadConfig();
    return {
      schema: 'providers',
      model: cfg.modelRef || `${cfg.provider}/${cfg.model}`,
      apiKey: cfg.apiKey || undefined,
      providerId: cfg.provider,
    };
  } catch {
    return { schema: 'providers', model: 'anthropic/claude-sonnet-5-5', providerId: 'anthropic' };
  }
}

// Dialog variant of the wizard for picker-capable UIs (TuiUI.pickOne/askSecret).
// Same write shape as the line-mode wizard, but zero transcript spam: provider
// and model pick via DialogSelect, key via askSecret, confirm via composer ask.
export async function runSetupDialog(ui) {
  const zh = ui.lang === 'zh';
  const t = (z, e) => (zh ? z : e);
  const notify = (title, msg) => {
    if (typeof ui.toast === 'function') ui.toast('success', title, msg);
    else ui.print(`${title}: ${msg}`);
  };

  const providers = configuredProviders();
  const items = providers
    .map((p) => ({
      id: p.id,
      title: p.name,
      description: `${p.id} · ${p.protocol || 'custom'}${p.configured ? ' ✓' : ''}`,
      group: p.protocol || 'custom',
      provider: p,
    }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title));
  items.push({
    id: 'custom',
    title: t('自定义端点', 'Custom endpoint'),
    description: t('protocol 二选一 + 自由 baseURL', 'protocol + free-form baseURL'),
    group: 'custom',
    provider: null,
  });

  const picked = await ui.pickOne({ title: t('选择 provider', 'Select provider'), items });
  if (!picked) return null;
  const provider = picked.provider;

  // custom endpoint: legacy flat answers (ask/askSecret render in the composer)
  if (!provider) {
    const protocol = await ui.ask('protocol (anthropic|openai) [openai]: ');
    if (protocol === null) return writeFallback(ui);
    const baseURL = await ui.ask('base URL [https://api.kimi.com/coding]: ');
    if (baseURL === null) return writeFallback(ui);
    const apiKey = await ui.askSecret(zh ? 'API key（不回显）: ' : 'API key (not echoed): ');
    if (apiKey === null) return writeFallback(ui);
    const model = await ui.ask(zh ? '模型 id: ' : 'Model id: ');
    if (model === null) return writeFallback(ui);
    const { file, config } = saveSetupConfig({
      provider: (protocol || 'openai').trim(),
      baseURL: (baseURL || '').trim(),
      apiKey: apiKey.trim(),
      model: (model || '').trim(),
    });
    notify('setup', file);
    return config;
  }

  // model pick
  const rows = modelRows(provider.models);
  let modelId = null;
  if (!rows.length) {
    const ans = await ui.ask(t(`模型 id（${provider.name} 目录为空）: `, `Model id (${provider.name} catalog is empty): `));
    if (ans === null) return writeFallback(ui);
    modelId = (ans || '').trim();
  } else {
    const pickedModel = await ui.pickOne({
      title: t(`${provider.name} — 选择默认模型`, `${provider.name} — pick the default model`),
      items: rows.map((r) => ({ id: r.id, title: r.title, description: r.description })),
    });
    if (!pickedModel) return null;
    modelId = pickedModel.id;
  }
  if (!modelId) { ui.print(t('已取消。', 'Cancelled.')); return null; }

  // API key (empty = env fallback, same as the line wizard)
  const envHint = provider.env.length ? ` (${provider.env.join(' / ')})` : '';
  const apiKey = await ui.askSecret(t(`API key${envHint}（留空用环境变量）: `, `API key${envHint} (empty = env var): `));
  if (apiKey === null) return writeFallback(ui);

  const ok = await ui.ask(t(`写入 ${provider.id}/${modelId}？[Y/n]: `, `Write ${provider.id}/${modelId}? [Y/n]: `));
  if (ok === null) return writeFallback(ui);
  if (ok && !/^(y|yes)$/i.test(ok.trim())) { ui.print(t('已取消。', 'Cancelled.')); return null; }

  let envKey = null;
  try { envKey = loadConfig().apiKey; } catch { /* unresolved config */ }
  const answers = { schema: 'providers', model: `${provider.id}/${modelId}`, apiKey: apiKey.trim() || envKey || undefined, providerId: provider.id };
  const { file, config } = saveSetupConfig(answers);
  notify('setup', file);
  return config;
}
