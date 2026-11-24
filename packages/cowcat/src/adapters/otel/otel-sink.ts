// The SpanSink binding onto a real OTel TracerProvider (ADR-132/134). Everything
// OTel-specific lives in this file and provider.ts; translate.ts stays SDK-free.

import {
  context,
  trace,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Span,
  type TracerProvider,
} from '@opentelemetry/api';
import { millisToHrTime } from '@opentelemetry/core';
import type { SpanAttributeValue, SpanSink, SpanStatus, StartedSpan } from './translate.js';

function toOtAttributes(attributes: Readonly<Record<string, SpanAttributeValue>>): Attributes {
  return attributes;
}

class OtelStartedSpan implements StartedSpan {
  constructor(
    /** Package-private: read by createOtelSink for explicit parenting only. */
    readonly otelSpan: Span,
  ) {}

  end(
    endMs: number,
    status: SpanStatus,
    attributes?: Readonly<Record<string, SpanAttributeValue>>,
    errorType?: string,
  ): void {
    if (attributes !== undefined) this.otelSpan.setAttributes(toOtAttributes(attributes));
    if (status === 'ok') this.otelSpan.setStatus({ code: SpanStatusCode.OK });
    if (status === 'error') {
      this.otelSpan.setStatus({ code: SpanStatusCode.ERROR });
      if (errorType !== undefined) this.otelSpan.setAttribute('error.type', errorType);
    }
    this.otelSpan.end(millisToHrTime(endMs));
  }

  addEvent(name: string, ms: number, attributes?: Readonly<Record<string, SpanAttributeValue>>): void {
    this.otelSpan.addEvent(name, attributes === undefined ? undefined : toOtAttributes(attributes), millisToHrTime(ms));
  }

  setAttributes(attributes: Readonly<Record<string, SpanAttributeValue>>): void {
    this.otelSpan.setAttributes(toOtAttributes(attributes));
  }
}

export function createOtelSink(provider: TracerProvider, tracerName: string, version?: string): SpanSink {
  const tracer = provider.getTracer(tracerName, version);
  return {
    start(input) {
      // Parenting is explicit (trace.setSpan on context.active()) rather than
      // ambient: a CLI process runs without a registered context manager, so
      // relying on ambient context would silently flatten the tree.
      const parent = input.parent;
      if (parent !== undefined && !(parent instanceof OtelStartedSpan)) {
        throw new Error('the parent span was not created by this sink');
      }
      const parentContext =
        parent === undefined ? undefined : trace.setSpan(context.active(), parent.otelSpan);
      const span = tracer.startSpan(
        input.name,
        {
          kind: input.kind === 'client' ? SpanKind.CLIENT : SpanKind.INTERNAL,
          attributes: toOtAttributes(input.attributes),
          startTime: millisToHrTime(input.startMs),
        },
        parentContext,
      );
      return new OtelStartedSpan(span);
    },
  };
}
