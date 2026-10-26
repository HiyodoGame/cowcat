import type { ProviderSummary } from '@corescense/cowcat-protocol';
import { line, type Line } from '../ui/line.js';
import { truncate } from '../text/width.js';

/**
 * The `/providers` panel (ADR-165 ③): the user layer's provider entries, browsed and
 * editable from inside the TUI. What it deliberately does NOT do is take a key: the
 * panel edits `baseUrl` and the environment variable NAME; the secret stays in the
 * user's shell (ADR-063 — the same rule `setup` and the migration have always had).
 */

/** The list phase: one row per provider, plus the add-new row at the end. */
export function providerPanelLines(
  providers: readonly ProviderSummary[],
  index: number,
  width: number,
): readonly Line[] {
  const header = line(
    truncate(
      `服务商（${String(providers.length)}） · ↑↓ 选择 · 回车编辑 · Esc 关闭`,
      width,
    ),
    'textDim',
    true,
  );
  const rows = providers.map((provider, row) => {
    const selected = row === index;
    const marker = selected ? '▸ ' : '  ';
    const key = provider.apiKeyEnv === null
      ? '未设 apiKeyEnv'
      : provider.keySet
        ? `${provider.apiKeyEnv} ✓`
        : `${provider.apiKeyEnv} ✗ 未设`;
    const endpoint = provider.baseUrl ?? '（内置端点）';
    return line(
      truncate(`${marker}${provider.name} — ${endpoint} · ${key}`, Math.max(8, width)),
      selected ? 'act' : 'textDim',
      selected,
    );
  });
  const addSelected = index === providers.length;
  rows.push(line(
    truncate(`${addSelected ? '▸' : ' '} + 新增服务商…`, Math.max(8, width)),
    addSelected ? 'act' : 'textDim',
    addSelected,
  ));
  return [header, ...rows];
}

/** The field phase, for one entry (an existing name, or '' for a brand-new one). */
export function providerFieldLines(entry: string, current: ProviderSummary | undefined, index: number, width: number): readonly Line[] {
  const title = entry === '' ? '新增服务商' : `编辑 ${entry}`;
  const header = line(truncate(`${title} · ↑↓ 选字段 · 回车输入新值 · Esc 返回`, width), 'textDim', true);
  const fields: readonly (readonly [string, string])[] = [
    ['baseUrl', current?.baseUrl ?? '（内置端点）'],
    ['apiKeyEnv', current?.apiKeyEnv ?? '（未设——密钥走环境变量，面板不收 key）'],
  ];
  const rows = fields.map(([name, value], row) => {
    const selected = row === index;
    return line(
      truncate(`${selected ? '▸ ' : '  '}${name}: ${value}`, Math.max(8, width)),
      selected ? 'act' : 'textDim',
      selected,
    );
  });
  return [header, ...rows];
}
