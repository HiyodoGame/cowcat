import { ERROR_CODES, ProtocolClientError, type ModelSummary, type ProtocolClient, type ProviderConfiguration, type ProviderSummary, type WireDelta } from '@corescense/cowcat-protocol';

const BUILTIN_ZAI: ProviderSummary = {
  name: 'zai', baseUrl: 'https://api.z.ai/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY', keySet: true,
  custom: false, protocol: 'openai', complete: true,
  models: [{ id: 'zai/glm-5.3-flash', protocol: 'openai', model: 'glm-5.3-flash', limits: { context: 1000000, output: 131072 }, toolCalls: true, contextWindow: 1000000, outputLimit: 131072 }],
};

export interface ProviderWrite {
  readonly name: string;
  readonly fields: { readonly baseUrl?: string; readonly apiKeyEnv?: string };
}

export function createRuntimeClient(
  initialProviders: readonly ProviderSummary[] = [BUILTIN_ZAI],
  models: readonly ModelSummary[] = [{ id: 'alpha/one', efforts: [] }, { id: 'beta/two', efforts: [] }],
  modelListConfigured = true,
  turnSendDelayMs = 0,
) {
  const listeners = new Map<string, (payload: never) => void>();
  const providers = [...initialProviders];
  const writes: ProviderWrite[] = [];
  const configured: ProviderConfiguration[] = [];
  const sent: string[] = [];
  const modelWrites: { readonly id: string; readonly effort: string | null }[] = [];
  let current = { id: models[0]?.id ?? 'alpha/one', effort: null as string | null };
  let ready = false;
  let markSessionOpened!: () => void;
  const sessionReady = new Promise<void>((resolve) => { markSessionOpened = resolve; });
  const client = {
    on(event: string, listener: (payload: never) => void) {
      listeners.set(event, listener);
      return () => { listeners.delete(event); };
    },
    closed: new Promise<void>(() => undefined),
    initialize: async () => ({}),
    trustStatus: async () => ({ trusted: true, withheld: { rules: 0, instructions: 0, skills: 0, mcpServers: 0, hooks: 0 } }),
    createSession: async () => ({ sessionId: 'sess_runtime', lastSeq: 1 }),
    openSession: async () => {
      // Let runTui finish attaching before releasing the test at the event-loop boundary.
      setImmediate(markSessionOpened);
      return { lastSeq: 1 };
    },
    listProviders: async () => ({ providers }),
    setProvider: async (name: string, fields: ProviderWrite['fields']) => {
      writes.push({ name, fields });
      const existing = providers.find((provider) => provider.name === name);
      if (existing === undefined) providers.push({ name, baseUrl: fields.baseUrl ?? null, apiKeyEnv: fields.apiKeyEnv ?? null, keySet: false, custom: true, protocol: null, complete: false, models: [] });
      else Object.assign(existing, fields);
      return {};
    },
    configureProvider: async (_sessionId: string, configuration: ProviderConfiguration) => {
      configured.push(configuration);
      ready = true;
      current = { id: configuration.preset, effort: null };
      const summary: ProviderSummary = {
        name: configuration.name, baseUrl: configuration.baseUrl, apiKeyEnv: configuration.apiKeyEnv,
        keySet: true, custom: configuration.definition !== undefined, protocol: configuration.protocol, complete: true,
        models: configuration.definition === undefined ? (providers.find((row) => row.name === configuration.name)?.models ?? []) : [{
          id: configuration.preset, ...configuration.definition,
          contextWindow: configuration.definition.limits.context ?? null,
          outputLimit: configuration.definition.limits.output ?? null,
        }],
      };
      const index = providers.findIndex((row) => row.name === configuration.name);
      if (index < 0) providers.push(summary);
      else providers[index] = summary;
      return { saved: true, current, keySet: true, requiresRestart: false };
    },
    listModels: async () => {
      if (!modelListConfigured && !ready) throw new ProtocolClientError('no model is configured', ERROR_CODES.hostRefused, { problem: 'not-configured' });
      return { models, current };
    },
    setModel: async (_sessionId: string, id: string, effort: string | null) => {
      modelWrites.push({ id, effort });
      current = { id, effort };
      return current;
    },
    request: async (method: string, params: { input?: string }) => {
      if (method === 'turn.send') {
        if (turnSendDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, turnSendDelayMs));
        if (!ready) throw new ProtocolClientError('no model is configured', ERROR_CODES.hostRefused, { problem: 'not-configured' });
        sent.push(params.input ?? '');
        return { turnId: 'turn_runtime' };
      }
      throw new Error(`unexpected request: ${method}`);
    },
    readAttachment: async () => { throw new Error('no attachments'); },
    close: () => undefined,
  } as unknown as ProtocolClient;
  return {
    client,
    sessionReady,
    writes,
    configured,
    sent,
    modelWrites,
    emitDelta(payload: WireDelta) {
      listeners.get('delta')?.(payload as never);
    },
  };
}
