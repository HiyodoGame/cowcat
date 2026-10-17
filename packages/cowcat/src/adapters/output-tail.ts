// Keep the TAIL of a stream, count what was dropped (P2 T4).
//
// Why the tail and not the head: the legacy code had two implementations and both
// comments said the same thing. `background.js:135-137` — "for long logs the
// interesting part (stack traces, test summaries) is at the end. Truncating the
// head dumped exactly what the caller needed to see." `mcp.js:659` kept the head
// and wrote `[truncated]` — the opposite choice, for the opposite reader. Two
// readers is a real difference, so this settles it at the gateway: the tail, plus
// the count, and the caller decides how to say so (research/p2-ports.md §2.3).
//
// Pure and dependency-free so the arithmetic can be tested without spawning
// anything. The counting is the part that goes wrong quietly: a `dropped` that
// under-reports turns "we kept the tail" into a lie nobody can detect.

export class OutputTail {
  readonly #cap: number;
  readonly #parts: string[] = [];
  #kept = 0;
  #total = 0;

  /** Characters kept. 0 or less means "keep nothing" — the count of what was lost is the whole answer. */
  constructor(cap: number) {
    this.#cap = Math.max(0, cap);
  }

  push(text: string): void {
    if (text === '') return;
    this.#total += text.length;
    this.#parts.push(text);
    this.#kept += text.length;
    if (this.#kept <= this.#cap) return;
    this.#trim();
  }

  get text(): string {
    return this.#parts.join('');
  }

  /** Characters discarded so far. Always `total - kept`, never tracked separately: two counters would eventually disagree. */
  get dropped(): number {
    return this.#total - this.#kept;
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  // Drop from the front, whole chunks where possible, so a long stream does not
  // degenerate into one slice per character.
  #trim(): void {
    let excess = this.#kept - this.#cap;
    while (excess > 0) {
      const head = this.#parts[0];
      if (head === undefined) return;
      if (head.length <= excess) {
        this.#parts.shift();
        this.#kept -= head.length;
        excess -= head.length;
      } else {
        this.#parts[0] = head.slice(excess);
        this.#kept -= excess;
        excess = 0;
      }
    }
  }
}