// Telemetry lifecycle: provider/exporter construction from config + env, and the
// shutdown contract (ADR-134). Returns null when telemetry is not configured OR
// when it cannot be constructed — the host then runs exactly as it always has, and
// a typo'd endpoint is a telemetry-off condition, never a host that refuses to start
// (ADR-132 ④: telemetry failures, configuration included, do not surface).

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { createOtelSink } from './otel-sink.js';
import type { SpanSink } from './translate.js';

export interface TelemetryHandle {
  readonly sink: SpanSink;
  /** Best-effort flush + shutdown, never hangs past 1s (ADR-132 ④). */
  finish(): Promise<void>;
}

export interface TelemetryInput {
  /** Process env to read; defaults to process.env. Injectable for tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** From user config `otel.endpoint`; wins over the env variable. */
  readonly endpoint?: string | undefined;
  /** From user config `otel.headersEnv`: name of an env var holding `k=v,k=v`. */
  readonly headersEnv?: string | undefined;
  /** Recorded as `gen_ai.agent.version` / service.version (the host's build version). */
  readonly serviceVersion?: string;
}

const SHUTDOWN_BUDGET_MS = 1_000;
// Shorter than the SDK default (10s): a DROP black hole would otherwise hold the
// event loop past the shutdown budget and stall CLI exit.
const EXPORT_TIMEOUT_MS = 5_000;

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const headers: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    if (key === '') continue;
    headers[key] = pair.slice(index + 1).trim();
  }
  return Object.keys(headers).length === 0 ? undefined : headers;
}

/**
 * Resolve the OTLP endpoint with the upstream SDK's own precedence: the explicit
 * config wins over the standard env var; absent both, telemetry is off (null).
 * Construction failures (a malformed endpoint, a bad headers var) also resolve to
 * null: telemetry that cannot start must not stop the host.
 */
export function initTelemetry(input: TelemetryInput): TelemetryHandle | null {
  const env = input.env ?? process.env;
  const endpoint = input.endpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint === undefined || endpoint === '') return null;
  try {
    // Validate before constructing: the OTLP exporter accepts some scheme-less
    // URLs at build time and only fails in the background export loop — which is
    // exactly the silent-off outcome this check exists to make explicit. WHATWG
    // URL parses 'localhost:4318' as scheme 'localhost', so the protocol has to
    // be allow-listed, not merely parseable.
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Secrets travel only through env (ADR-134 ①): config names the variable, it
    // never holds the value. An explicitly empty standard var falls through to the
    // config-named one — empty is "not set", not "set to nothing".
    const standard = env.OTEL_EXPORTER_OTLP_HEADERS;
    const named = input.headersEnv === undefined ? undefined : env[input.headersEnv];
    const headers = parseHeaders(standard === undefined || standard === '' ? named : standard);

    // Plain semconv keys, not the SemanticResourceAttributes constants: the constants
    // live in a second package for keys that are frozen forever, and 'service.name'
    // is exactly that.
    const resource = new Resource({
      'service.name': env.OTEL_SERVICE_NAME ?? 'cowcat',
      ...(input.serviceVersion === undefined ? {} : { 'service.version': input.serviceVersion }),
    });
    // spanProcessors via the constructor config: addSpanProcessor() is deprecated on
    // the 1.x SDK line, and a constructor argument ages better than a lint override.
    const provider = new BasicTracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: endpoint, timeoutMillis: EXPORT_TIMEOUT_MS, ...(headers === undefined ? {} : { headers }) }),
        ),
      ],
    });

    return {
      sink: createOtelSink(provider, 'cowcat', input.serviceVersion),
      async finish() {
        // BatchSpanProcessor.shutdown() flushes first; a black-holed endpoint rejects
        // that flush (ECONNREFUSED), and the ADR's contract is that telemetry must
        // never surface its failures to the host — swallow, don't stall. The budget
        // timer is unref'd and cleared on every path so neither a quick shutdown nor
        // a slow one is what keeps the process alive.
        let hitBudget!: () => void;
        const budget = new Promise<void>((resolve) => {
          hitBudget = resolve;
        });
        const watchdog = setTimeout(hitBudget, SHUTDOWN_BUDGET_MS);
        watchdog.unref();
        try {
          await Promise.race([provider.shutdown().catch(() => undefined), budget]);
        } finally {
          clearTimeout(watchdog);
        }
      },
    };
  } catch {
    return null;
  }
}
