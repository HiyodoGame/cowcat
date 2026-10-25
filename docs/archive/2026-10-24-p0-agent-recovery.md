# P0 Agent Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover from provider context-overflow failures and give every model request a stable coding-agent system baseline.

**Architecture:** Protocol adapters normalize vendor overflow failures into one runtime-agnostic error; the kernel owns compaction/retry using the existing `SHRINK_STEPS`. A minimal static system prompt lives in the kernel and is shared by ordinary and compaction requests, while project instructions/skills remain replayable log messages.

**Tech Stack:** TypeScript strict/ESM, Node `node:test`, existing ModelPort, compaction, and adapter replay transports.

**Spec:** Session audit plan `flash-hawkman-longshot.md`, P0-C; ADR-070⑤ and ADR-072 prefix-parity requirements.

## Global Constraints

- Vendor-specific status/message classification stays in `src/adapters`; the kernel sees only `ContextOverflowError`.
- Never retry an ordinary model error as overflow; 400 is not sufficient without an overflow signal, 413 is sufficient.
- Do not change tool-call/result pairing or append a summary between an assistant call and its tool results.
- A failed compaction cannot silently succeed; surface the original overflow after bounded recovery.
- Project instructions and skills remain log-backed; the static system prompt is not duplicated into session history.

## Review Focus

- Exactly three shrink retries are allowed; a fourth overflow fails the turn with a bounded request count.
- Overflow during summarization is not mistaken for a successful compaction.
- Cancellation during compaction/retry remains cancellation, not a generic failure.
- OpenAI receives a system role message; Anthropic receives top-level `system`, with no duplicate system message.
- Non-overflow 400 errors (authentication, invalid max_tokens, malformed schema) retain their original failure behavior.

---

### Task 1: Bounded overflow recovery

**Files:**
- Modify: `docs/architecture/README.md` (ADR-150)
- Modify: `packages/cowcat/src/ports/model.ts`, `packages/cowcat/src/adapters/model-openai.ts`, `packages/cowcat/src/adapters/model-anthropic.ts`
- Create: `packages/cowcat/src/adapters/model-overflow.ts`
- Modify: `packages/cowcat/src/kernel/run-turn.ts`, `packages/cowcat/src/index.ts`
- Test: `packages/cowcat/test/overflow.test.ts`, `packages/cowcat/test/turn.test.ts`

**Interfaces:**
- Produces: `ContextOverflowError extends Error`; adapters throw it for 413 or overflow-shaped 400 messages; `runTurn` catches only that class and calls `compactContext(..., 'overflow')` with `keepTokens` derived from `SHRINK_STEPS` before retrying.

- [ ] Add ADR-150 documenting normalized overflow errors, 413/400 classification, 70/50/35 shrink retries, compaction failure handling, and unchanged cancellation semantics.
- [ ] Write failing adapter tests through real SDK replay/error transports: OpenAI and Anthropic 400 `context_length_exceeded` reject with `ContextOverflowError`; invalid-request 400 remains the original API error; 413 normalizes as overflow.
- [ ] Write a failing kernel test: first turn builds history; second turn gets overflow, a summary, then a final answer. Assert completion, one `trigger:'overflow'` compaction, summary request before retry, and no extra user turn. Add bounded-exhaustion and non-overflow error tests.
- [ ] Build core and run selected tests; confirm RED.
- [ ] Implement the error class and adapter normalization, then wrap only `streamModel` overflow in the bounded compaction/retry path. Reinject instructions/skills after successful compaction as the existing auto path does.
- [ ] Re-run selected tests and the full core suite; confirm GREEN.

### Task 2: Shared minimal system prompt

**Files:**
- Modify: `docs/architecture/README.md` (ADR-151)
- Create: `packages/cowcat/src/kernel/system-prompt.ts`
- Modify: `packages/cowcat/src/kernel/run-turn.ts`, `packages/cowcat/src/kernel/compact.ts`, `packages/cowcat/src/index.ts`
- Test: `packages/cowcat/test/system-prompt.test.ts`, `packages/cowcat/test/model-openai.test.ts`, `packages/cowcat/test/model-anthropic.test.ts`

**Interfaces:**
- Produces: `COWCAT_SYSTEM_PROMPT: string`; every turn and compaction `ModelRequest.system` equals it; OpenAI/Anthropic adapters serialize it once in their native location.

- [ ] Add ADR-151 defining the small stable coding baseline, no vendor text, no project-secret content, and compaction prefix parity.
- [ ] Write failing tests asserting ordinary and compaction requests carry `COWCAT_SYSTEM_PROMPT`, and both wire adapters serialize it exactly once.
- [ ] Build and run selected tests; confirm RED because turn/compaction requests omit `system`.
- [ ] Implement the constant and pass it through both request builders. Do not change instruction/skill event injection or public configuration.
- [ ] Re-run selected tests, full core suite, protocol/TUI/CLI suites, lint-probe, and `git diff --check`; confirm GREEN and record that real-provider long-context acceptance remains a separate live test if credentials/context are unavailable.
