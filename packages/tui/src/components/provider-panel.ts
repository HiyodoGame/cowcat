import type { ProviderSummary } from '@corescense/cowcat-protocol';
import { truncate } from '../text/width.js';
import { choiceBlock, panelBlock, type SceneNode } from '../ui/scene.js';

export function providerPanel(providers: readonly ProviderSummary[], index: number, width: number): SceneNode {
  return panelBlock({
    key: 'providers', title: `服务商 ${String(providers.length)} · 回车编辑 · Esc 关闭`, tone: 'brand',
    children: [
      ...providers.map((provider, row) => {
        // The source is shown so a stale environment variable that overrides a saved key is visible.
        const source = provider.keySource === 'env' ? '（来自环境变量）' : provider.keySource === 'file' ? '（来自保存的密钥）' : '';
        const key = provider.apiKeyEnv === null ? '未设 apiKeyEnv' : provider.keySet ? `${provider.apiKeyEnv} 已设置${source}` : `${provider.apiKeyEnv} 未设置`;
        return choiceBlock(provider.name, truncate(`${provider.name} · ${provider.baseUrl ?? '内置端点'} · ${key}`, Math.max(8, width - 6)), {
          selected: row === index, token: 'textDim',
        });
      }),
      choiceBlock('new-provider', '新增服务商', { selected: index === providers.length, token: 'textDim' }),
    ],
  });
}

export function providerFields(entry: string, current: ProviderSummary | undefined, index: number, width: number): SceneNode {
  const fields: readonly (readonly [string, string])[] = [
    ['baseUrl', current?.baseUrl ?? '（内置端点）'],
    ['apiKeyEnv', current?.apiKeyEnv ?? '（未设，密钥走环境变量，面板不收 key）'],
  ];
  return panelBlock({
    key: `provider-${entry}`, title: entry === '' ? '新增服务商' : `编辑 ${entry}`, tone: 'brand',
    children: fields.map(([name, value], row) => choiceBlock(name, truncate(`${name}: ${value}`, Math.max(8, width - 6)), {
      selected: row === index, token: 'textDim',
    })),
  });
}
