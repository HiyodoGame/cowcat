import type { DialogSpec } from '../app/dialog.js';
import type { ProviderForm } from '../app/provider-form.js';

export function providerFormDialog(form: ProviderForm): DialogSpec {
  const error = form.error === null ? {} : { error: form.error };
  if (form.step === 'template') {
    return {
      title: form.onboarding ? '先完成服务商配置' : '选择服务商',
      groups: [{
        title: '内置模板与自定义连接',
        rows: form.templates.map((provider, index) => ({
          label: provider.name === 'custom-openai' ? '自定义 OpenAI 兼容' : provider.name === 'custom-anthropic' ? '自定义 Anthropic' : provider.name,
          detail: `${provider.complete ? '' : '待补全 · '}${provider.baseUrl ?? (provider.custom ? '填写自定义端点' : 'SDK 默认端点')}`,
          selected: index === form.index,
        })),
      }],
      footer: [{ key: 'enter', label: '选择' }, { key: 'esc', label: '取消' }],
      ...error,
    };
  }
  if (form.step === 'model') {
    return {
      title: `${form.name} · 选择模型`,
      groups: [{
        title: '可用模型',
        rows: form.models.map((model, index) => ({
          label: model.id,
          detail: `${model.protocol} · context ${model.contextWindow === null ? '未知' : String(model.contextWindow)} · output ${model.outputLimit === null ? '未知' : String(model.outputLimit)}`,
          selected: index === form.index,
        })),
      }],
      footer: [{ key: 'enter', label: '选择' }, { key: 'esc', label: '上一步' }],
      ...error,
    };
  }
  if (form.step === 'toolCalls') {
    return {
      title: '模型工具调用能力',
      groups: [{
        title: 'Coding Agent 需要工具调用；请按模型实际能力选择',
        rows: [{ label: '支持工具调用', selected: form.index === 0 }, { label: '不支持工具调用', selected: form.index === 1 }],
      }],
      footer: [{ key: 'enter', label: '确认' }, { key: 'esc', label: '上一步' }],
      ...error,
    };
  }
  if (form.step === 'review' || form.step === 'saving') {
    return {
      title: form.step === 'saving' ? '正在保存服务商配置' : '确认完整配置',
      groups: [{
        title: '保存后将应用为当前模型',
        rows: [
          { label: '服务商', detail: form.name },
          { label: '协议', detail: form.protocol },
          { label: 'Base URL', detail: form.baseUrl ?? 'SDK 默认端点' },
          { label: 'API key 环境变量', detail: form.apiKeyEnv },
          { label: '模型', detail: form.preset },
          { label: '上下文限额', detail: form.context === '' ? '未声明' : form.context },
          { label: '输出限额', detail: form.output === '' ? '未声明' : form.output },
          { label: '工具调用', detail: form.toolCalls ? '支持' : '不支持' },
          { label: '保存并应用', selected: true },
        ],
      }],
      footer: form.step === 'saving' ? [] : [{ key: 'enter', label: '保存并应用' }, { key: 'esc', label: '上一步' }],
      ...error,
    };
  }
  const labels = {
    name: ['服务商 ID', '例如 local'],
    baseUrl: ['Base URL', form.custom ? '例如 http://localhost:11434/v1' : '留空使用内置端点'],
    apiKeyEnv: ['API key 环境变量名', '例如 ZHIPU_API_KEY（密钥本身走环境变量）'],
    modelId: ['实际模型 ID', '例如 qwen3-coder'],
    context: ['上下文限额', '可选，例如 128000；留空表示未知'],
    output: ['输出限额', form.protocol === 'anthropic' ? '必填，例如 8192' : '可选，例如 8192'],
  } as const;
  const [label, placeholder] = labels[form.step];
  return {
    title: `${form.name === '' ? '自定义服务商' : form.name} · ${label}`,
    input: { placeholder, value: form.value },
    groups: [],
    footer: [{ key: 'enter', label: '下一步' }, { key: 'esc', label: '上一步' }],
    ...error,
  };
}
