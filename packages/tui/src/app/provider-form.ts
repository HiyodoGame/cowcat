import type { ProviderConfiguration, ProviderModelSummary, ProviderSummary } from '@corescense/cowcat-protocol';
import type { TuiView } from './view.js';
import { providerMatches } from './view.js';

export type ProviderFormStep = 'template' | 'model' | 'name' | 'baseUrl' | 'apiKeyEnv' | 'modelId' | 'context' | 'output' | 'toolCalls' | 'review' | 'saving';

export interface ProviderForm {
  readonly step: ProviderFormStep;
  readonly onboarding: boolean;
  readonly custom: boolean;
  readonly protocol: 'openai' | 'anthropic';
  readonly index: number;
  readonly templates: readonly ProviderSummary[];
  readonly models: readonly ProviderModelSummary[];
  readonly name: string;
  readonly baseUrl: string | null;
  readonly apiKeyEnv: string;
  readonly preset: string;
  readonly model: string;
  readonly context: string;
  readonly output: string;
  readonly toolCalls: boolean;
  readonly value: string;
  readonly error: string | null;
}

export function beginProviderForm(view: TuiView, onboarding = false): TuiView {
  const selected = view.providerPanel?.entry === null ? providerMatches(view)[view.providerPanel.index] : undefined;
  const templates = [...view.providerList, customTemplate('openai'), customTemplate('anthropic')];
  const index = selected === undefined ? 0 : templates.findIndex((template) => template.name === selected.name);
  return {
    ...view,
    providerForm: {
      step: 'template', onboarding, custom: selected?.custom ?? false, protocol: selected?.protocol ?? 'openai',
      index: Math.max(0, index), templates, models: selected?.models ?? [],
      name: selected?.name ?? '', baseUrl: selected?.baseUrl ?? null, apiKeyEnv: selected?.apiKeyEnv ?? '',
      preset: selected?.models[0]?.id ?? '', model: selected?.models[0]?.model ?? '',
      context: selected?.models[0]?.contextWindow?.toString() ?? '', output: selected?.models[0]?.outputLimit?.toString() ?? '',
      toolCalls: selected?.models[0]?.toolCalls ?? true, value: '', error: null,
    },
  };
}

function customTemplate(protocol: 'openai' | 'anthropic'): ProviderSummary {
  return {
    name: `custom-${protocol}`, baseUrl: null, apiKeyEnv: protocol === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY',
    keySet: false, custom: true, protocol, complete: true, models: [],
  };
}

export function moveProviderForm(view: TuiView, delta: number): TuiView {
  const form = view.providerForm;
  if (form === null) return view;
  const count = form.step === 'template' ? form.templates.length : form.step === 'model' ? form.models.length : form.step === 'toolCalls' ? 2 : 0;
  if (count === 0) return view;
  return { ...view, providerForm: { ...form, index: (form.index + delta + count) % count } };
}

export function setProviderFormValue(view: TuiView, value: string): TuiView {
  if (view.providerForm === null) return view;
  return { ...view, providerForm: { ...view.providerForm, value, error: null } };
}

export function advanceProviderForm(view: TuiView): TuiView {
  const form = view.providerForm;
  if (form === null) return view;
  const update = (next: ProviderForm): TuiView => ({ ...view, providerForm: next });
  const invalid = (error: string): TuiView => ({ ...view, providerForm: { ...form, error } });
  switch (form.step) {
    case 'template': {
      const selected = form.templates[form.index];
      if (selected === undefined) return view;
      const custom = selected.custom;
      return update({
        ...form,
        custom,
        protocol: selected.protocol ?? 'openai',
        name: custom && selected.name.startsWith('custom-') ? '' : selected.name,
        baseUrl: selected.baseUrl,
        apiKeyEnv: selected.apiKeyEnv ?? (selected.protocol === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'),
        models: selected.models,
        context: selected.models[0]?.contextWindow?.toString() ?? '',
        output: selected.models[0]?.outputLimit?.toString() ?? '',
        step: custom ? 'name' : 'model',
        value: custom && !selected.name.startsWith('custom-') ? selected.name : '',
        error: null,
      });
    }
    case 'model': {
      const model = form.models[form.index];
      if (model === undefined) return view;
      return update({
        ...form,
        preset: model.id,
        model: model.model,
        context: model.contextWindow?.toString() ?? '',
        output: model.outputLimit?.toString() ?? '',
        toolCalls: model.toolCalls,
        step: 'baseUrl',
        value: form.baseUrl ?? '',
        error: null,
      });
    }
    case 'name':
      if (form.value.trim() === '') return invalid('请填写服务商 ID');
      return update({ ...form, name: form.value.trim(), step: 'baseUrl', value: form.baseUrl ?? '', error: null });
    case 'baseUrl':
      if (form.custom && form.value.trim() === '') return invalid('自定义服务商必须填写 Base URL');
      return update({ ...form, baseUrl: form.value.trim() === '' ? null : form.value.trim(), step: 'apiKeyEnv', value: form.apiKeyEnv, error: null });
    case 'apiKeyEnv':
      if (form.value.trim() === '') return invalid('请填写 API key 的环境变量名（不填写密钥本身）');
      return update({ ...form, apiKeyEnv: form.value.trim(), step: form.custom ? 'modelId' : 'review', value: form.custom ? form.model : '', error: null });
    case 'modelId':
      if (form.value.trim() === '') return invalid('请填写服务商实际提供的模型 ID');
      return update({ ...form, model: form.value.trim(), preset: `${form.name}/${form.value.trim()}`, step: 'context', value: form.context, error: null });
    case 'context':
      if (!validLimit(form.value)) return invalid('上下文限额必须是正整数，或留空表示未知');
      return update({ ...form, context: form.value.trim(), step: 'output', value: form.output, error: null });
    case 'output':
      if (!validLimit(form.value) || (form.protocol === 'anthropic' && form.value.trim() === '')) {
        return invalid(form.protocol === 'anthropic' ? 'Anthropic 必须填写正整数输出限额' : '输出限额必须是正整数，或留空表示未知');
      }
      return update({ ...form, output: form.value.trim(), step: 'toolCalls', index: form.toolCalls ? 0 : 1, error: null });
    case 'toolCalls':
      return update({ ...form, toolCalls: form.index === 0, step: 'review', error: null });
    case 'review':
      return update({ ...form, step: 'saving', error: null });
    case 'saving': return view;
  }
}

function validLimit(value: string): boolean {
  return value.trim() === '' || /^[1-9][0-9]*$/.test(value.trim());
}

export function backProviderForm(view: TuiView): TuiView {
  const form = view.providerForm;
  if (form === null) return view;
  if (form.step === 'template') return { ...view, providerForm: null };
  if (form.step === 'saving') return view;
  const previous: Partial<Record<ProviderFormStep, ProviderFormStep>> = {
    model: 'template', name: 'template', baseUrl: form.custom ? 'name' : 'model', apiKeyEnv: 'baseUrl',
    modelId: 'apiKeyEnv', context: 'modelId', output: 'context', toolCalls: 'output', review: form.custom ? 'toolCalls' : 'apiKeyEnv',
  };
  const step = previous[form.step] ?? 'template';
  const value = step === 'name' ? form.name : step === 'baseUrl' ? form.baseUrl ?? '' : step === 'apiKeyEnv' ? form.apiKeyEnv
    : step === 'modelId' ? form.model : step === 'context' ? form.context : step === 'output' ? form.output : '';
  return { ...view, providerForm: { ...form, step, value, error: null } };
}

export function failProviderForm(view: TuiView, error: string): TuiView {
  if (view.providerForm === null) return view;
  return { ...view, providerForm: { ...view.providerForm, step: 'review', error } };
}

export function providerFormConfiguration(form: ProviderForm): ProviderConfiguration {
  return {
    name: form.name,
    protocol: form.protocol,
    baseUrl: form.baseUrl,
    apiKeyEnv: form.apiKeyEnv,
    preset: form.preset,
    activate: true,
    ...(form.custom ? {
      definition: {
        protocol: form.protocol,
        model: form.model,
        limits: {
          ...(form.context === '' ? {} : { context: Number(form.context) }),
          ...(form.output === '' ? {} : { output: Number(form.output) }),
        },
        toolCalls: form.toolCalls,
      },
    } : {}),
  };
}
