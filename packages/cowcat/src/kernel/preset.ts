// Model presets: the data behind one call (ADR-037, ADR-046).
//
// The kernel knows only this shape. Which vendor speaks which protocol, which endpoint
// it lives at and which environment variable holds its key are the composition root's
// business — it also picks the adapter by `protocol` — so no vendor name ever reaches
// this layer, and nothing here is written down for one vendor's benefit.

export type ModelProtocol = 'openai' | 'anthropic';

export interface ModelLimits {
  /**
   * The model's own ceiling for one response. This is where `maxTokens` comes from
   * (ADR-046 decision ②) — the kernel invents no number when it is absent, and a
   * protocol that requires the field refuses a request without it (ADR-044). `context`
   * is the window: compaction compares its estimate against it (ADR-070), and the TUI
   * shows how full it is from the copy `turn.opened` records (ADR-105).
   */
  readonly output?: number;
  readonly context?: number;
}

export interface ModelPreset {
  /** The protocol the model speaks; the composition root picks the adapter with it. */
  readonly protocol: ModelProtocol;
  readonly model: string;
  readonly limits: ModelLimits;
  /**
   * Whether the model can call tools at all — `tool_call: false` models exist in the
   * catalogue (`bailing/Ring-1T`). False means the request goes out without `tools`,
   * and the turn reports that fact instead of pretending (ADR-046 decision ③).
   */
  readonly toolCalls: boolean;
  /**
   * The wire parameters behind each reasoning level, declared as data (ADR-046
   * decision ④) — for instance `{ high: { reasoning_effort: 'high' },
   * min: { thinking: { type: 'enabled', budget_tokens: 4096 } } }`.
   *
   * The parameters are sent verbatim. Level names and parameter vocabularies are the
   * vendor's, mapped per protocol by this data rather than by a table in code — which
   * is what the catalogue's own level vocabularies (`reasoning_options`) trading off
   * against a hard-coded fold (`llm/openai.js:90`) taught v1. An undeclared level is
   * not sent, and the turn reports it.
   */
  readonly efforts?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}
