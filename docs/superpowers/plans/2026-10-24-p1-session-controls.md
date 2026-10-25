# P1 Session Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users control models, compaction, sessions, permissions, and everyday output without leaving the TUI.

**Architecture:** Add narrowly scoped protocol methods before UI commands. Model overrides are per-session and validated by the existing selector; compaction reuses the kernel path. TUI commands gain typed argument effects, while export/copy/cost remain projections of existing view data. Grant revocation is append-only.

**Tech Stack:** TypeScript strict/ESM, JSON-RPC protocol, event-sourced kernel, Node `node:test`.

**Spec:** Session audit plan `flash-hawkman-longshot.md`, P1-A.

## Global Constraints

- No arbitrary config-key or secret writing; model/effort changes are validated, session-scoped, and idle-only.
- No model switching or compaction during a running/starting/reflecting turn.
- Append-only history: revocation adds an event; no log truncation in this plan.
- Clipboard/export failures are visible; no silent success or secret config output.
- Every new protocol method has client/server/host/refusing-host handling and contract tests.

## Review Focus

- Two open sessions can use different models; a child inherits its parent's selection.
- Switching to an unknown preset or missing key leaves the previous selection untouched.
- Manual compaction reinstates instructions/skills and cannot race a turn.
- Session switching clears the old view before replay and never mixes two event streams.
- Revoking `always` and `session` grants changes later policy decisions and survives replay.

---

### Task 1: Model and compaction protocol

**Files:** `docs/architecture/README.md` (ADR-152), `packages/protocol/src/{methods,host,client,server,refusing-host}.ts`, `packages/cowcat/src/host/{host,presets}.ts`, `packages/cowcat/src/kernel/run-turn.ts`, protocol/host tests.

**Interfaces:** `model.list(sessionId) → {current, models}`; `model.set(sessionId,preset,effort?) → {current}`; `context.compact(sessionId) → {compacted,dropped,reason}`; exported `ensureInstructions`/`ensureSkills` reuse after manual compaction.

- [ ] Add ADR-152 for per-session idle-only model overrides, manual compaction, and no secret/config arbitrary writes.
- [ ] Write failing protocol contract and real-host tests for list/set, independent sessions, unknown preset/missing key atomicity, busy refusal, manual compaction and instruction refresh.
- [ ] Run them RED; implement methods, per-session caches, parent inheritance, and compaction; run protocol/core suites GREEN.

### Task 2: Argument-aware commands and settings

**Files:** `packages/tui/src/app/{commands,run}.ts` (actual run at `src/run.ts`), model/config/cost commands, protocol client wrappers, tests.

**Interfaces:** `CommandEffect` adds `model`, `compact`, `config`, `cost`; command `run(view, rest)` receives args; `/model [preset]`, `/compact`, `/config [model=...|effort=...]`, `/cost`.

- [ ] Write failing tests for argument parsing, model list/set, compaction, config validation and usage/cost rendering.
- [ ] Implement minimal effects and protocol calls with visible errors and notices; preserve bare slash behavior and aliases.
- [ ] Run full TUI/protocol/core/CLI suites GREEN.

### Task 3: Session and output workflows

**Files:** TUI run/view/commands, at-file completion, tests.

**Interfaces:** `/resume [id]` interactive list or direct open, `/clear` creates and opens a fresh session, `/copy` copies latest assistant text through a platform clipboard helper, `/export [path]` writes Markdown, `@` fuzzy path suggestions.

- [ ] Write failing tests for old-view clearing before replay, no cross-session event mixing, export content, clipboard fallback, and fuzzy ranking.
- [ ] Implement with an injected clipboard/export port at the CLI/TUI boundary; no shell child process outside `ProcessPort` if a platform helper needs one.
- [ ] Run full suites and real CLI smoke GREEN.

### Task 4: Permission inspection and revocation

**Files:** kernel events/schema/state, protocol, host, TUI permission panel/commands, tests; ADR-153.

**Interfaces:** `grants.list(sessionId)` and `grants.revoke(sessionId,grantId)`; `approval.revoked` removes the matching standing grant on replay; `/permissions` lists numeric ids, `/permissions revoke <id>` revokes.

- [ ] Add ADR-153 and failing replay/protocol tests for always/session grants, revocation, unknown ids and later re-approval behavior.
- [ ] Implement append-only revocation and panel; never broaden grants or expose other sessions.
- [ ] Run all four package suites, lint-probe, tarball guard and `git diff --check`; record real interactive acceptance separately if not exercised.
