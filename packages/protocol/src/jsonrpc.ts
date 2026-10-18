import { z } from 'zod';

/**
 * ADR-055: JSON-RPC 2.0, one JSON object per line, no `Content-Length` framing.
 *
 * This file is the encoding boundary for everything that crosses the transport, and
 * the only place in the frontend that knows zod. Above it, code works on the decoded
 * types below and never sees a raw line.
 */
export const JSONRPC_VERSION = '2.0';

/**
 * The JSON-RPC reserved codes, plus the implementation-defined range
 * (-32000..-32099) for the failures this protocol has that the spec does not name.
 *
 * They are values rather than message strings because a client has to branch on them:
 * "the server speaks another protocol version" and "your params were malformed" want
 * different UI, and matching on prose is how that breaks silently.
 */
export const ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  versionMismatch: -32001,
  notInitialized: -32002,
  noSuchSession: -32003,
  hostRefused: -32004,
  attachmentTooLarge: -32005,
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type RequestId = string | number;

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcRequest {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: RequestId;
  readonly method: string;
  readonly params?: unknown;
}

/**
 * A request without an `id`, which owes no response. No client sends one today (the
 * protocol has no client-to-server notification), but the parser distinguishes the
 * two rather than treating a missing `id` as a malformed request — otherwise a
 * future client notification would get an error response it never asked for.
 */
export interface JsonRpcNotification {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly method: string;
  readonly params?: unknown;
}

export type JsonRpcResponse =
  | { readonly jsonrpc: typeof JSONRPC_VERSION; readonly id: RequestId | null; readonly result: unknown }
  | { readonly jsonrpc: typeof JSONRPC_VERSION; readonly id: RequestId | null; readonly error: JsonRpcError };

const idSchema = z.union([z.string(), z.number()]);
const errorSchema = z.strictObject({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
const requestSchema = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: idSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});
const notificationSchema = z.strictObject({
  jsonrpc: z.literal(JSONRPC_VERSION),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const responseSchema = z.union([
  z.strictObject({ jsonrpc: z.literal(JSONRPC_VERSION), id: idSchema.nullable(), result: z.unknown() }),
  z.strictObject({ jsonrpc: z.literal(JSONRPC_VERSION), id: idSchema.nullable(), error: errorSchema }),
]);

export type Incoming =
  | { readonly kind: 'request'; readonly request: JsonRpcRequest }
  | { readonly kind: 'notification'; readonly notification: JsonRpcNotification }
  | { readonly kind: 'invalid'; readonly id: RequestId | null; readonly error: JsonRpcError };

/**
 * Never throws: a transport delivers bytes, and bytes from the other side are not
 * ours to trust. Every failure becomes an `invalid` carrying the id when one could be
 * recovered, so the peer learns what was wrong instead of waiting forever.
 */
export function parseIncoming(line: string): Incoming {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'invalid', id: null, error: { code: ERROR_CODES.parseError, message: 'body is not JSON' } };
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'invalid', id: null, error: { code: ERROR_CODES.invalidRequest, message: 'expected a JSON object' } };
  }

  if ('id' in value) {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) {
      return {
        kind: 'invalid',
        id: recoverId(value),
        error: { code: ERROR_CODES.invalidRequest, message: 'malformed request', data: parsed.error.issues },
      };
    }
    return { kind: 'request', request: parsed.data };
  }

  const parsed = notificationSchema.safeParse(value);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      id: null,
      error: { code: ERROR_CODES.invalidRequest, message: 'malformed notification', data: parsed.error.issues },
    };
  }
  return { kind: 'notification', notification: parsed.data };
}

export function parseResponse(line: string): JsonRpcResponse | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = responseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function recoverId(value: object): RequestId | null {
  const id: unknown = Reflect.get(value, 'id');
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

// Key order is fixed so a frame is byte-comparable in tests and in a log.
export function serializeRequest(request: JsonRpcRequest): string {
  return JSON.stringify({
    jsonrpc: JSONRPC_VERSION,
    id: request.id,
    method: request.method,
    ...(request.params === undefined ? {} : { params: request.params }),
  });
}

export function serializeNotification(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params });
}

export function serializeResult(id: RequestId | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result });
}

export function serializeError(id: RequestId | null, error: JsonRpcError): string {
  return JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, error });
}

/** A response the client can act on, rather than the wire union with its optional fields. */
export type Settled =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: JsonRpcError };

export function settle(response: JsonRpcResponse): Settled {
  return 'error' in response ? { ok: false, error: response.error } : { ok: true, result: response.result };
}
