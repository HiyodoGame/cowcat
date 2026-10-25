# P1 Recovery Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make long-running work steerable and file changes recoverable without risking unrelated user work.

**Architecture:** Queue whole user turns with reserved ids and validated attachment bytes; drain only after the current turn settles. Capture Write/Edit before-images in per-session checkpoint files and restore through append-only revert/redo events. Never use Git reset or overwrite unrelated files.

**Tech Stack:** TypeScript strict/ESM, JSON-RPC, event-sourced sessions, Node `node:test`.

**Spec:** Session audit plan `flash-hawkman-longshot.md`, P1-B.

## Global Constraints

- Queued prompts never emit conversation events before their reserved turn starts.
- `turn.cancel` can cancel queued work without opening a turn; queued work cannot start while running/starting/reflecting.
- Checkpoints cover only successful CowCat Write/Edit paths; Bash and external edits are out of scope and stated as such.
- Undo/redo restores the exact before/after bytes and never touches unrelated paths.
- No history truncation, no Git reset, no unbounded queued turns.

## Review Focus

- Queue cancellation before start leaves no turn.opened or prompt.attached.
- Model selection at execution time, not enqueue time, determines the queued turn.
- New-file undo deletes only the file created by that call; redo recreates exact bytes.
- Undo/redo survives session reopen and preserves correct ordering.
- Snapshot write failure prevents the mutation rather than claiming an undo point exists.

---

### Task 1: Queued user turns

**Files:** host SessionRecord/sendTurn/startTurn/cancelTurn, protocol result docs, TUI submit notice, ADR-154, host tests.

**Interfaces:** `turn.send` returns `{turnId, queued?: true}`; queued entries carry reserved id, input, validated attachment bytes, controller; drain at settled turn.

- [ ] Add ADR-154 and failing tests for queue-after-cancel, queued cancellation, attachment timing, and execution-time model selection.
- [ ] Implement bounded per-session queue (8), no events before start, execution drain and cancel semantics.
- [ ] Show queued notice in TUI; run host/protocol/core/TUI suites GREEN.

### Task 2: Write/Edit checkpoints and undo/redo

**Files:** adapter checkpoint helper, Write/Edit tools, ToolResult/context, kernel events/schema, host, protocol, TUI `/undo` `/redo`, ADR-155, tests.

**Interfaces:** `file.changed` references before-image; `file.reverted` references redo-image; `change.undo/redo` methods restore exact bytes and report affected path.

- [ ] Add ADR-155 and failing tests for existing-file edit, new-file create/delete/recreate, snapshot failure, replay ordering and unrelated-file preservation.
- [ ] Implement atomic before-image capture before mutation, protocol restore and append-only markers, and TUI commands.
- [ ] Run all four suites and real filesystem scenario GREEN.

### Task 3: Recovery polish and final verification

**Files:** TUI input history, reconnect, usage budget if feasible within this batch, tests and docs.

**Interfaces:** persistent per-cwd prompt history with Ctrl+R filtering; reconnect uses lastSeq replay without mixing views; optional budget refusal before model call.

- [ ] Add failing tests for history persistence/search and reconnect projection.
- [ ] Implement without duplicating the event log as a second source of truth; reconnect only through existing session.open replay.
- [ ] Run four suites, lint-probe, tarball guard, real CLI smoke and final whole-branch review; explicitly record anything not completed instead of silently dropping it.
