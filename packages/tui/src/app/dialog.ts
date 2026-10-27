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
  /** An input dialog (the Connect 式 Other step): the composer types ONE value. */
  readonly input?: { readonly placeholder: string; readonly value: string };
  readonly groups: readonly DialogGroup[];
  readonly footer: readonly { readonly key: string; readonly label: string }[];
}

/** Case-insensitive substring match over label + detail — the whole search behaviour. */
export function filterDialogRows(rows: readonly DialogRow[], query: string): readonly DialogRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return rows;
  return rows.filter(
    (row) => row.label.toLowerCase().includes(needle) || (row.detail ?? '').toLowerCase().includes(needle),
  );
}

/** Group models by their provider prefix, current selection first (the Select model shape). */
export function modelDialog(
  models: readonly ModelSummary[],
  current: ModelSelectionSummary | null,
  query: string,
): DialogSpec {
  const visible = filterDialogRows(
    models.map((model) => ({
      label: model.id,
      ...(model.efforts.length === 0 ? {} : { detail: `effort: ${model.efforts.join('/')}` }),
      selected: model.id === current?.id,
    })),
    query,
  );
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

/** One group: the current model's reasoning levels (the /effort shortcut). */
export function effortDialog(
  models: readonly ModelSummary[],
  current: ModelSelectionSummary,
  index: number,
): DialogSpec {
  const model = models.find((entry) => entry.id === current.id);
  const rows = (model?.efforts ?? []).map((effort, row) => ({
    label: effort,
    selected: row === index,
    ...(current.effort === effort ? { mark: '●' } : {}),
  }));
  return {
    title: `思考档位 · ${current.id}`,
    groups: rows.length === 0 ? [{ title: null, rows: [{ label: '该模型没有可调档位', selected: true }] }] : [{ title: null, rows }],
    footer: [{ key: 'enter', label: '确认' }, { key: 'esc', label: '关闭' }],
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
