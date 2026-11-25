import type { ModelSelectionSummary, ModelSummary, ProviderSummary } from '@corescense/cowcat-protocol';

/**
 * The modal dialog's data (ADR-166): a pure description the frame can produce and the
 * screen can mount as real components — a centred floating window with a title bar, a
 * search field, grouped rows whose selection is a BACKGROUND, and a footer of shortcuts.
 *
 * Everything here is data on purpose: the same `DialogSpec` is what the frame snapshot
 * sees and what the overlay renders, so "the dialog says X" is testable without a
 * terminal, and the overlay never invents content the view did not state.
 */

export interface DialogRow {
  readonly label: string;
  /** Secondary text, right-aligned on the row. */
  readonly detail?: string;
  /** The row the cursor is on: rendered as a full-width highlight, not a marker glyph. */
  readonly selected?: boolean;
  /** Left-edge status mark: `✓` connected, `●` current. */
  readonly mark?: string;
}

export interface DialogGroup {
  readonly title: string | null;
  readonly rows: readonly DialogRow[];
}

export interface DialogSpec {
  readonly title: string;
  /** The search field's current text; present means the dialog filters as you type. */
  readonly query?: string;
  /** An input dialog (the Connect 式 Other step): the dialog itself types ONE value. */
  readonly input?: { readonly placeholder: string; readonly value: string };
  readonly groups: readonly DialogGroup[];
  readonly footer: readonly { readonly key: string; readonly label: string }[];
  /** Validation or save failure, kept inside the current form. */
  readonly error?: string;
}

/** Case-insensitive substring match over label + detail — the whole search behaviour. */
export function filterDialogRows<T extends DialogRow>(rows: readonly T[], query: string): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return rows;
  return rows.filter(
    (row) => row.label.toLowerCase().includes(needle) || (row.detail ?? '').toLowerCase().includes(needle),
  );
}

/** Group models by their provider prefix, current selection first (the Select model shape). */
/** Phase two of the model picker (ADR-161): the reasoning efforts of a locked preset. */
export function effortDialog(
  preset: string,
  efforts: readonly string[],
  index: number,
  current: ModelSelectionSummary | null,
): DialogSpec {
  return {
    title: `${preset} · 选择推理力度`,
    groups: [{
      title: '档位',
      rows: efforts.map((effort, offset) => ({
        label: effort,
        selected: offset === index,
        ...(current?.id === preset && current.effort === effort ? { mark: '当前' } : {}),
      })),
    }],
    footer: [{ key: 'enter', label: '切换' }, { key: 'esc', label: '返回' }],
  };
}

export function modelDialog(
  models: readonly ModelSummary[],
  current: ModelSelectionSummary | null,
  query: string,
  cursor: string | null = null,
): DialogSpec {
  // `models` arrives already ordered and filtered (modelMatches). The cursor — not the current
  // model — is the highlighted row, because the cursor is what Enter runs. The current model
  // keeps a '当前' mark.
  const visible = models.map((model) => ({
    label: model.id,
    ...(model.efforts.length === 0 ? {} : { detail: `effort: ${model.efforts.join('/')}` }),
    selected: model.id === cursor,
    ...(model.id === current?.id ? { mark: '当前' } : {}),
  }));
  if (visible.length === 0) {
    return {
      title: '选择模型',
      query,
      groups: [{ title: '还没有可用的模型', rows: [{ label: '先用 /providers 配置服务商并设置 API key' }] }],
      footer: [{ key: 'esc', label: '关闭' }],
    };
  }
  const groups = new Map<string, DialogRow[]>();
  for (const row of visible) {
    const provider = row.label.includes('/') ? row.label.slice(0, row.label.indexOf('/')) : row.label;
    const bucket = groups.get(provider) ?? [];
    bucket.push(row);
    groups.set(provider, bucket);
  }
  return {
    title: '选择模型',
    query,
    groups: [...groups.entries()].map(([title, rows]) => ({ title, rows })),
    footer: [{ key: 'enter', label: '切换' }, { key: 'esc', label: '关闭' }],
  };
}

/** The providers list (the Connect a provider shape): configured group + connected marks. */
export function providerDialog(providers: readonly ProviderSummary[], query: string): DialogSpec {
  const rows = filterDialogRows(
    providers.map((provider) => ({
      label: provider.name,
      detail: provider.baseUrl ?? '（内置端点）',
      ...(provider.keySet ? { mark: '✓' } : {}),
    })),
    query,
  );
  return {
    title: '服务',
    query,
    groups: [{ title: '已配置', rows }],
    footer: [{ key: 'enter', label: '编辑' }, { key: 'a', label: '新增' }, { key: 'esc', label: '关闭' }],
  };
}

/** The input dialog (the Connect 式 Other step): one typed value, enter submits. */
export function inputDialog(title: string, placeholder: string, value: string): DialogSpec {
  return {
    title,
    input: { placeholder, value },
    groups: [],
    footer: [{ key: 'enter', label: '提交' }, { key: 'esc', label: '取消' }],
  };
}
