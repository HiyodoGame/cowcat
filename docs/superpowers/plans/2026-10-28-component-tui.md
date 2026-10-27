# Component TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace hand-drawn TUI chrome with native OpenTUI components, improve responsive layout, and add a state-driven cow-spotted cat.

**Architecture:** `TuiView -> pure keyed scene nodes -> native renderable components`. Keep protocol projection, text measurement, command dispatch, and hit IDs independent of the renderer. Virtualize transcript mounting and reuse keyed component trees.

**Tech Stack:** TypeScript strict, Node >=26.4, `@opentui/core@0.6.6`, `node:test`.

**Spec:** `docs/architecture/README.md` ADR-056/061/066/067/164/166/167/168 and the new ADR-171. The session-approved plan is the design authority for breakpoints and mascot states.

## Global Constraints

- No new framework or dependency; no protocol, kernel, port, or event-format changes.
- UI chrome uses Box/Text/Image layout, borders and backgrounds, not drawn border glyphs or selection markers.
- Markdown and diff content remain text. Theme colors use semantic tokens.
- Preserve input, keyboard, click, scroll, image, resize, teardown and reduced-motion behavior.
- Tests precede behavior changes and must be observed failing before implementation.

## Review Focus

- CJK and long untrusted approval subjects must not overflow or be truncated.
- Animation must follow the primary turn, not only background tasks; hidden/off modes must not schedule ticks.
- Fixed-height sprites must not move the transcript or side rail.
- Keyed mounting must not retain stale hits, images or content when entries change.
- Narrow terminals must retain access to todos/tasks/agents through the existing dock.

---

### Task 1: Baseline and component contract

**Files:** `docs/architecture/README.md`, `docs/architecture/06-frontend.md`, `packages/tui/src/ui/scene.ts`, `packages/tui/test/scene.test.ts`.

- [ ] Run baseline TUI build, lint and tests in `.worktrees/component-tui` under Node 26.
- [ ] Add failing structural tests for keyed text, panel, choice, status and sprite nodes, including theme tokens and hit IDs.
- [ ] Record ADR-171 before implementation; update stale ADR-167 and frontend-layer text.
- [ ] Implement pure scene factories and run structural tests.

### Task 2: Native primitives and responsive screen

**Files:** `ui/primitives.ts`, `ui/panel.ts`, `ui/choice-list.ts`, `ui/dialog.ts`, `ui/composer.ts`, `ui/transcript-view.ts`, `ui/status-view.ts`, `ui/screen.ts`, `test/visual.test.ts`, `test/composer.test.ts`.

**Interfaces:** scene nodes have stable `key`; screen consumes a structured `ScreenSpec`, keyed mounting updates in place. Breakpoints are 144/104 columns; solo reading width remains 100.

- [ ] Add failing native-renderer tests for 80/120/160-column layouts, full-row choice backgrounds, CJK alignment and long path wrapping.
- [ ] Implement native primitives and split screen responsibilities without changing the public `Screen` command/input interfaces.
- [ ] Verify mount/update/dispose, image placement, scroll and composer tests.

### Task 3: Migrate transcript, cards and panels

**Files:** all feature modules under `packages/tui/src/components/` that currently return decorative `Line[]`, `app/rails.ts`, `theme/tokens.ts`, `index.ts`, corresponding existing tests.

**Interfaces:** feature modules produce scene nodes or structured panel/status data; `run.ts` continues to decode the same hit IDs.

- [ ] Convert card/panel/status tests to assert structure, full content, selection and output tail; run to see the old glyph model fail.
- [ ] Migrate message/tool/approval/plan/trust and all dock panels to native scene nodes.
- [ ] Remove production `ui/card.ts` glyph-card path; update exports and stale comments.
- [ ] Run full TUI suite, inspect regenerated snapshots manually, and exercise scrolling and clicks.

### Task 4: Cow-spotted cat and state animation

**Files:** `components/cowcat-art.ts`, `app/rails.ts`, `app/view.ts`, `app/project.ts`, `run.ts`, `theme/tokens.ts`, new mascot tests.

**Interfaces:** `mascotFrame(state, now)` returns a fixed-size pixel matrix; `mascotState(view, now)` derives pending-approval > working > thinking > settled feedback > idle. Settled transition time is injected from events.

- [ ] Add failing tests for primary-turn states, white fur/black patches/pink nose, distinct deterministic frames, fixed dimensions and reduced motion.
- [ ] Implement pixel sprite and native `PixelSprite` mounting; do not use ASCII or depend on terminal image support.
- [ ] Schedule animation only when visible and active; use one-shot idle blink scheduling, freeze when `COWCAT_ANIMATIONS=off`, clean up on hide/destroy.
- [ ] Verify state priority, timers, narrow fallback and rendered color spans.

### Task 5: Full verification and review

- [ ] Run TUI build/lint/all tests, API/layer probes and the four-package test sequence.
- [ ] Render and inspect 80/120/160-column character and color captures, with long CJK/path, approval, tool, image and all mascot states.
- [ ] Exercise a real isolated Windows terminal where automation permits; report any unverified terminal behavior.
- [ ] Run the Impeccable detector once, review the final diff and performance-sensitive mount path, then commit `feat/component-tui`; do not push main.
