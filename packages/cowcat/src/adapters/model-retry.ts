// Retry, backoff and the two ways a wait must end (ADR-039).
//
// Retryability is protocol and vendor knowledge, so the *classification* stays with each
// adapter: an `overloaded_error`, a vendor's own code (MiniMax's `2013`) and a
// `Retry-After` header are things only the protocol layer knows. What is shared here is
// the part that is easy to get subtly wrong — the attempt budget, the growth of the wait,
// and the fact that a cancellation has to interrupt the wait itself.
//
// The SDKs are both constructed with `maxRetries: 0`: their retry would run behind this
// one, and neither implements "never retry a stream that has already produced output".

/** The shape a vendor's error header accessor has to have, without naming `Headers`. */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * The SDKs type their errors' `headers` as `any`, so it arrives here as `unknown` and has
 * to be narrowed rather than asserted: a vendor SDK that changes the field's shape must
 * fail a check, not a lint rule.
 */
export function asHeaderReader(value: unknown): HeaderReader | null {
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return value as HeaderReader;
  }
  return null;
}

export type RetryDecision = { readonly retry: false } | { readonly retry: true; readonly afterMs: number | null };

export const NO_RETRY: RetryDecision = { retry: false };

export interface RetryPolicy {
  /** Attempts *after* the first. ADR-039: two, which is also what both SDKs default to. */
  readonly retries?: number;
  /** Base of the exponential backoff; the first wait is this long. */
  readonly baseDelayMs?: number;
  /** Ceiling for one wait, so a hostile `Retry-After` cannot park a session. */
  readonly maxDelayMs?: number;
  /** Per-attempt deadline covering the handshake, not the whole stream (ADR-039). */
  readonly attemptTimeoutMs?: number;
}

export const DEFAULT_RETRIES = 2;
export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 20_000;
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 300_000;

/** Statuses both protocols agree are worth another attempt (ADR-039). */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * `Retry-After` as milliseconds, or null when it is absent or not a form we understand.
 * Both the delta-seconds form and the HTTP-date form are in the wild; only the first is
 * honoured, because a session's clock and the server's are not necessarily the same kind
 * of agreement and a wrong date would mean a wait of years.
 */
export function retryAfterMs(headers: HeaderReader | null | undefined): number | null {
  const raw = headers?.get('retry-after');
  if (raw === null || raw === undefined) return null;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

export function abortError(): Error {
  return new DOMException('the request was aborted', 'AbortError');
}

/**
 * A wait that a cancellation can cut short — the whole point of ADR-039 decision ①. The
 * legacy implementation's `sleep` was a bare `setTimeout`, so a cancelled session kept
 * sleeping and only stopped when the wait ran out.
 *
 * The listener is removed on both paths rather than relying on `{ once: true }`: `once`
 * unregisters when the event fires, which is the path that needs it least.
 */
export function sleepAbortably(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort);
  });
}

export interface RetryInput<T> {
  /**
   * One attempt. It deliberately covers only *obtaining* the response: the caller
   * iterates the stream outside this function, which is what makes "a stream that has
   * already produced output is never retried" a property of the structure rather than a
   * check somebody has to remember.
   */
  readonly attempt: (signal: AbortSignal) => Promise<T>;
  /**
   * The second argument is the attempt's own signal, so a classifier can tell "the
   * attempt ran out of time" (worth another try) from "a person cancelled" (never is) —
   * both arrive here as an abort-shaped error.
   */
  readonly classify: (error: unknown, attemptSignal: AbortSignal) => RetryDecision;
  readonly signal: AbortSignal;
  readonly policy?: RetryPolicy;
  /** Injected so tests do not actually wait. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export async function withRetry<T>(input: RetryInput<T>): Promise<T> {
  const retries = input.policy?.retries ?? DEFAULT_RETRIES;
  const base = input.policy?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const ceiling = input.policy?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const attemptTimeoutMs = input.policy?.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const sleep = input.sleep ?? sleepAbortably;

  for (let attempt = 0; ; attempt += 1) {
    if (input.signal.aborted) throw abortError();
    // Per attempt, so the deadline is the handshake's and not the stream's, and so a
    // timeout cannot outlive the attempt it belongs to (ADR-039 decision ⑤). Native
    // composition rather than hand-written listeners: no cleanup to forget.
    const attemptSignal = AbortSignal.any([input.signal, AbortSignal.timeout(attemptTimeoutMs)]);
    try {
      return await input.attempt(attemptSignal);
    } catch (error) {
      const decision = input.classify(error, attemptSignal);
      if (!decision.retry || attempt >= retries) throw error;
      const wait = Math.min(ceiling, decision.afterMs ?? base * 2 ** attempt);
      await sleep(wait, input.signal);
    }
  }
}
