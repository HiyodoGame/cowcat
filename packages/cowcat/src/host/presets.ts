import type { ModelPreset, ModelProtocol } from '../kernel/preset.js';

/**
 * The built-in model table (ADR-063 D1).
 *
 * Deliberately small, and every number is sourced rather than typed from memory: the
 * entries come from v1's distilled catalog (removed with `agent/` in P8; the values are
 * kept here), because a wrong output ceiling is not a cosmetic error — it
 * is a request the vendor refuses (ADR-044), and a wrong endpoint sends a key to the
 * wrong host.
 *
 * What is deliberately NOT here:
 *
 *  - **`efforts`** (the wire parameters behind each reasoning level, ADR-046 ④). The
 *    catalog carries `reasoning_options` *kinds* (`toggle`, `effort`) but not the
 *    parameters each kind maps to, and inventing them is exactly the guessing ADR-046
 *    forbids (`reasoning_effort: 'none'` is a 400 on some endpoints). Passing `effort`
 *    to a preset without them is not silently ignored: the turn reports
 *    `effort-not-declared` (ADR-046 decision ④). Distilling them is its own task.
 *  - **`attachment`** (whether the model can see images), which the catalog *does*
 *    carry. Wiring it into `ModelPreset` changes turn behaviour (a request must not
 *    carry an image the model cannot read), so it belongs with that change rather than
 *    with the composition root (HANDOFF §6.1).
 */
export interface BuiltinProvider {
  readonly protocol: ModelProtocol;
  /** The environment variable that normally holds the key. A name, never the key. */
  readonly apiKeyEnv: string;
  /** `null` means the SDK's own default endpoint. Set only where the catalog states one. */
  readonly baseUrl: string | null;
}

/**
 * Only providers the catalog gives an endpoint for, plus the two whose endpoint is the
 * SDK's default. A provider whose endpoint nobody recorded is worse than absent: with a
 * `null` base URL an OpenAI-protocol request would go to `api.openai.com` carrying
 * somebody else's key. Those are reachable through a custom preset instead, where the
 * endpoint is stated explicitly.
 */
export const BUILTIN_PROVIDERS: Readonly<Record<string, BuiltinProvider>> = {
  anthropic: { protocol: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrl: null },
  openai: { protocol: 'openai', apiKeyEnv: 'OPENAI_API_KEY', baseUrl: null },
  deepseek: { protocol: 'openai', apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com' },
  moonshotai: { protocol: 'openai', apiKeyEnv: 'MOONSHOT_API_KEY', baseUrl: 'https://api.moonshot.ai/v1' },
  zai: { protocol: 'openai', apiKeyEnv: 'ZHIPU_API_KEY', baseUrl: 'https://api.z.ai/api/paas/v4' },
  /**
   * The same model family as `zai`, reached a different way: BigModel's **Coding Plan**
   * serves it over the **Anthropic** protocol (`/v1/messages`), which is the endpoint a
   * Coding Plan key belongs to. Source: the value shown in the BigModel console for that
   * plan — not the catalog, which only records the OpenAI-compatible route. Two entries
   * for one family is the honest shape: an endpoint and a protocol are one decision, and
   * a key is issued for one of them.
   */
  bigmodel: { protocol: 'anthropic', apiKeyEnv: 'ZHIPU_API_KEY', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
  /**
   * Coding-plan routes. They serve the same GLM family as `zai`, but at a different
   * endpoint and (for the same model id) often with a different quota. A separate
   * provider id is what lets a v1 config keep meaning what it meant (ADR-089).
   */
  'zai-coding-plan': { protocol: 'openai', apiKeyEnv: 'ZHIPU_API_KEY', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
  'volcengine-coding-plan': {
    protocol: 'openai',
    apiKeyEnv: 'ARK_CODING_PLAN_API_KEY',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
  },
};

/**
 * `provider/model-id` → the preset the kernel calls. The key is what a config's
 * `model.preset` names, so it is also the id a user sees in an error message.
 */
export const BUILTIN_PRESETS: Readonly<Record<string, ModelPreset>> = {
  'anthropic/claude-sonnet-5-5': {
    protocol: 'anthropic',
    model: 'claude-sonnet-5-5',
    limits: { output: 128000, context: 1000000 },
    toolCalls: true,
  },
  'anthropic/claude-opus-5-5': {
    protocol: 'anthropic',
    model: 'claude-opus-5-5',
    limits: { output: 128000, context: 1000000 },
    toolCalls: true,
  },
  'openai/gpt-6.1-sol': {
    protocol: 'openai',
    model: 'gpt-6.1-sol',
    limits: { output: 128000, context: 1050000 },
    toolCalls: true,
  },
  'deepseek/deepseek-flash': {
    protocol: 'openai',
    model: 'deepseek-flash',
    limits: { output: 393216, context: 1000000 },
    toolCalls: true,
  },
  'moonshotai/kimi-k3': {
    protocol: 'openai',
    model: 'kimi-k3',
    limits: { output: 1048576, context: 1048576 },
    toolCalls: true,
  },
  'zai/glm-5.3': {
    protocol: 'openai',
    model: 'glm-5.3',
    limits: { output: 131072, context: 1000000 },
    toolCalls: true,
  },
  // The vision bridge for text models (ADR-138): GLM's free vision tier on the same zai
  // provider — a user with ZHIPU_API_KEY gets View working with zero extra setup. It
  // answers image questions; it never joins a conversation's tool loop.
  'zai/glm-4v-flash': {
    protocol: 'openai',
    model: 'glm-4v-flash',
    limits: { output: 4096, context: 8192 },
    toolCalls: false,
    vision: true,
  },
  // The Flash tier: same limits, cheaper. Included because "the small one" is what most
  // smoke tests and first runs actually want (catalog: cost 0.15/0.5 per Mtok).
  'zai/glm-5.3-flash': {
    protocol: 'openai',
    model: 'glm-5.3-flash',
    limits: { output: 131072, context: 1000000 },
    toolCalls: true,
  },
  /**
   * The Coding Plan route (see `bigmodel` above): same models, Anthropic protocol. The
   * limits are the catalog's for this family; the protocol differs because the endpoint
   * does.
   */
  'bigmodel/glm-5.3-flash': {
    protocol: 'anthropic',
    model: 'glm-5.3-flash',
    limits: { output: 131072, context: 1000000 },
    toolCalls: true,
  },
  'bigmodel/glm-5.3': {
    protocol: 'anthropic',
    model: 'glm-5.3',
    limits: { output: 131072, context: 1000000 },
    toolCalls: true,
  },
  'zai-coding-plan/glm-5.3-flash': {
    protocol: 'openai',
    model: 'glm-5.3-flash',
    limits: { output: 131072, context: 1000000 },
    toolCalls: true,
  },
  'zai-coding-plan/glm-5.3': {
    protocol: 'openai',
    model: 'glm-5.3',
    limits: { output: 131072, context: 1000000 },
    toolCalls: true,
  },
  'volcengine-coding-plan/glm-5.3-flash': {
    protocol: 'openai',
    model: 'glm-5.3-flash',
    limits: { output: 131072, context: 1000000 },
    toolCalls: true,
  },
  'volcengine-coding-plan/glm-5.3': {
    protocol: 'openai',
    model: 'glm-5.3',
    limits: { output: 131072, context: 1000000 },
    toolCalls: true,
  },
};
