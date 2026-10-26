/**
 * The headless protocol (ADR-055) and its two halves.
 *
 * One module covers both sides on purpose: the wire format is a single artifact, and a
 * client and a server that were written from two different descriptions of it are the
 * classic way a protocol drifts. T3 wraps `createServer` in a stdio subprocess; T7
 * renders what `createClient` receives.
 *
 * Two rules hold for everything under `src/protocol/`:
 *
 *   1. no opentui. This is the part of the frontend that a headless consumer (an IDE
 *      plugin, a script, `cowcat serve` on a machine with no terminal) would need, so
 *      it must not need a renderer. Enforced by lint.
 *   2. no kernel. The frontend reaches the kernel only through this protocol
 *      (ADR-059 ③) — `host.ts` states the shape of that conversation instead.
 */
export {
  ERROR_CODES,
  JSONRPC_VERSION,
  parseIncoming,
  parseResponse,
  serializeError,
  serializeNotification,
  serializeRequest,
  serializeResult,
  settle,
  type ErrorCode,
  type Incoming,
  type JsonRpcError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RequestId,
  type Settled,
} from './jsonrpc.js';

export {
  METHODS,
  PARAMS,
  isMethodName,
  type ApprovalVerdict,
  type AttachmentBytes,
  type CronJobSummary,
  type GrantSummary,
  type MethodName,
  type ModelListResult,
  type ModelSelectionSummary,
  type ModelSummary,
  type Params,
  type ProviderSummary,
  type Result,
  type ResultTable,
  type SessionSummary,
  type TrustWithheld,
} from './methods.js';

export {
  NOTIFICATIONS,
  NOTIFICATION_SCHEMAS,
  deltaParamsSchema,
  eventParamsSchema,
  isNotificationName,
  isWireEvent,
  logParamsSchema,
  parseNotification,
  type NotificationName,
  type NotificationParams,
  type ParsedNotification,
  type WireDelta,
  type WireEvent,
  type WireLog,
} from './notifications.js';

export {
  AttachmentTooLargeError,
  NoSuchSessionError,
  ProtocolHostError,
  type AttachedSession,
  type ProtocolHost,
} from './host.js';

export { memoryTransport, type Defer, type MemoryTransportPair, type Transport } from './transport.js';

export { STDIO_MAX_LINE_BYTES, stdioTransport, type StdioTransportOptions } from './stdio.js';

export { createServer, type ProtocolServer, type ServerOptions } from './server.js';

export { ProtocolClientError, createClient, onNotification, type ClientOptions, type ProtocolClient } from './client.js';

export { NOT_WIRED, refusingHost } from './refusing-host.js';

export { SERVE_SIGNALS, serve, type ServeOptions, type SignalSource } from './serve.js';

export { PROTOCOL_VERSION } from './version.js';
