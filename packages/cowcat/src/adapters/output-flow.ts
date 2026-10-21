import type { OutputSink } from '../ports/process.js';

/**
 * Coalescing for the live-output sink (ADR-107).
 *
 * A child can write thousands of small chunks per second (`pnpm install`, a compiler
 * progress line), and handing each one to a renderer is how a 60fps interface spends its
 * whole frame budget on text nobody can read at that speed. This class merges adjacent
 * chunks of the same stream and flushes on whichever comes first: a window, or a size
 * that is already too big to sit on.
 *
 * It is deliberately separate from the child: the arithmetic is testable with a fake
 * scheduler, and the adapter stays a reader of pipes.
 *
 * Two boundaries worth stating: a single chunk larger than `maxChars` is delivered whole
 * (the merger never slices — ADR-107 keeps truncation out of this layer), and a sink that
 * pushes from inside `onOutput` cannot recurse: a flush in progress drains what arrived
 * before returning control.
 */

/** Flush at most this often. One frame is 16ms; 100ms is six frames. */
export const OUTPUT_WINDOW_MS = 100;
/** Flush early once this many characters are pending: a burst is worse than a late frame. */
export const OUTPUT_MAX_CHARS = 8_192;

export type OutputStream = 'stdout' | 'stderr';

export interface OutputChunk {
  readonly stream: OutputStream;
  readonly text: string;
}

/** Injected so tests do not have to wait on wall-clock timers. */
export type OutputSchedule = (flush: () => void, delayMs: number) => { readonly cancel: () => void };

export interface OutputFlowOptions {
  readonly windowMs?: number;
  readonly maxChars?: number;
  readonly schedule?: OutputSchedule;
}

interface Pending {
  readonly stream: OutputStream;
  text: string;
}

export class OutputFlow {
  readonly #sink: OutputSink;
  readonly #windowMs: number;
  readonly #maxChars: number;
  readonly #schedule: OutputSchedule;
  #pending: Pending[] = [];
  #chars = 0;
  #cancel: (() => void) | null = null;
  #flushing = false;

  constructor(sink: OutputSink, options: OutputFlowOptions = {}) {
    this.#sink = sink;
    this.#windowMs = options.windowMs ?? OUTPUT_WINDOW_MS;
    this.#maxChars = Math.max(1, options.maxChars ?? OUTPUT_MAX_CHARS);
    this.#schedule = options.schedule ?? timerSchedule;
  }

  push(stream: OutputStream, text: string): void {
    if (text === '') return;
    const last = this.#pending.at(-1);
    if (last?.stream === stream) {
      last.text += text;
    } else {
      this.#pending.push({ stream, text });
    }
    this.#chars += text.length;
    if (this.#chars >= this.#maxChars) {
      this.flush();
      return;
    }
    this.#cancel ??= this.#schedule(() => {
      this.#cancel = null;
      this.flush();
    }, this.#windowMs).cancel;
  }

  /** Hand everything pending to the sink, now. Safe to call with nothing pending. */
  flush(): void {
    // A sink that pushes from inside its own callback must not recurse: the loop below
    // picks up whatever arrived while the previous batch was being delivered.
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      this.#clearTimer();
      while (this.#pending.length > 0) {
        const chunks = this.#pending;
        this.#pending = [];
        this.#chars = 0;
        for (const chunk of chunks) {
          try {
            this.#sink.onOutput(chunk.stream, chunk.text);
          } catch {
            // A renderer that throws is a bug in the renderer. Killing the command (or
            // failing the run) because a frame could not be drawn would make the gateway's
            // result depend on the UI, which is the coupling this port exists to avoid.
            // The live view loses that frame and the run reports exactly what it saw.
          }
        }
      }
      // A push during delivery may have armed a window that the loop just drained.
      this.#clearTimer();
    } finally {
      this.#flushing = false;
    }
  }

  #clearTimer(): void {
    const cancel = this.#cancel;
    if (cancel === null) return;
    this.#cancel = null;
    cancel();
  }
}

/** Default scheduler. `unref` so a pending flush never keeps the process alive. */
function timerSchedule(flush: () => void, delayMs: number): { readonly cancel: () => void } {
  const timer = setTimeout(flush, delayMs);
  timer.unref();
  return {
    cancel: () => {
      clearTimeout(timer);
    },
  };
}
