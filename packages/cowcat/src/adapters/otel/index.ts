// Public surface of the OTel adapter (ADR-132). The pure translator and the OTel
// binding are separate files; consumers import from here.

export { createSpanTranslator } from './translate.js';
export type { SpanSink, SpanKindName, SpanAttributeValue, SpanStatus, StartedSpan, TranslatorInput } from './translate.js';
export { createOtelSink } from './otel-sink.js';
export { initTelemetry } from './provider.js';
export type { TelemetryHandle, TelemetryInput } from './provider.js';
