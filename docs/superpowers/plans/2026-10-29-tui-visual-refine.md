# TUI Visual Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clarify rail grouping and spacing, replace the oversized quadrant cat with a 32×10 Braille dot-matrix cat, and compact empty/session information without changing interaction contracts.

**Architecture:** Preserve `TuiView -> pure specs -> keyed native SceneNode`. A Braille adapter replaces quadrant rasterization; `Screen` owns content-driven rail heights and alignment; native Box borders provide grouping. Pure helpers handle path wrapping and empty-session content.

**Tech Stack:** TypeScript strict, Node 26.12 for TUI verification, `@opentui/core@0.6.6`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-29-tui-visual-refine-design.md`

## Global Constraints

- No protocol, kernel, model, tool, dependency, package-version or responsive-breakpoint changes.
- Keep all fixed empty sections and six approved eye expressions; no text inside the mascot canvas.
- Use native borders, not hand-drawn UI decoration; keep keyed updates and pure frame generation.
- Work only in `feat/tui-rail-visual-refine`; do not push or commit unless the user asks.
- Documentation and ADR-174 travel with the code; real-terminal appearance is reported separately from automated evidence.

## Review Focus

- Mixed Braille cells: transparent/null input and multiple grayscale roles must not create phantom dots or hide eyes/nose (Task 1 tests).
- 160×32 overflow: every section and the 10-row mascot stays mounted, with exact `另有 N 项` (Task 2 tests).
- Empty vs overfull rails: empty panels use natural height while long content remains bounded (Task 2 tests).
- Long paths and CJK: segment wrapping stays within 26 content columns and falls back safely for an overlong segment (Task 3 tests).
- Empty-session false positives: streaming, pending tools and real entries suppress the welcome panel (Task 3 tests).

---

### Task 1: Braille raster and compact mascot

**Files:**
- Create: `packages/tui/src/ui/braille.ts`
- Create: `packages/tui/test/braille.test.ts`
- Modify: `packages/tui/src/components/cowcat-art.ts`
- Modify: `packages/tui/src/ui/scene.ts`
- Modify: `packages/tui/src/ui/primitives.ts`
- Modify: `packages/tui/test/mascot.test.ts`, `mascot-logo.test.ts`, `native-components.test.ts`, `activity-run.test.ts`
- Remove after replacement: `packages/tui/src/ui/quadrants.ts`, `packages/tui/test/quadrants.test.ts`
- Modify: `docs/architecture/README.md`

**Interfaces:**
- Produces: `brailleCell(pixels, x, y): { glyph: string; foreground: SpriteColor | null; background: null }` for 2×4 logical points.
- `mascotFrame()` returns 64 columns × 40 rows for every state; `heightOf(sprite)` is `ceil(rows/4)`, native sprite width is `ceil(columns/2)`.

- [ ] **Step 1: Write failing Braille and 64×40 mascot tests**

Cover all eight dot positions, transparent cells, deterministic multi-role priority, 64×40 dimensions, grayscale roles, sparse backdrop, symmetry, one nose, six expressions, reduced motion and 32×10 native mounting.

- [ ] **Step 2: Run the focused tests and verify RED**

Run `npm --prefix packages/tui run build` and `npx -y node@26.12.0 --test "packages/tui/dist/test/{braille,mascot,native-components}.test.js"`. Expected: missing Braille module and old dimension assertions fail.

- [ ] **Step 3: Implement the Braille adapter and resample the cat**

Use the standard Braille bit mapping for 2×4 points. Render only foreground dots; backdrop is sparse. Sample geometry directly onto 64×40 and preserve symmetric eye coordinates and existing animation phases. Update Scene measurement and the sprite adapter.

- [ ] **Step 4: Verify focused tests and the full TUI suite are GREEN**

Run the same focused command, then the full TUI build/lint/test command. Update only tests whose old 82×46/41×23 contract ADR-174 explicitly replaces.

### Task 2: Native rail grouping and content-driven heights

**Files:**
- Modify: `packages/tui/src/ui/primitives.ts`
- Modify: `packages/tui/src/ui/screen.ts`
- Modify: `packages/tui/test/layout.test.ts`, `native-components.test.ts`

**Interfaces:**
- Consumes: 32×10 mascot from Task 1 and existing `LeftRailSpec`/`AsideSpec`.
- Produces: content-driven panel heights with minimum 3 rows; bounded overflow and bottom-aligned, horizontally centered mascot.

- [ ] **Step 1: Write failing native-border and height tests**

Assert rail panels have native borders/titles without a full brand background. At 160×40, empty agents/tasks use their natural height rather than equal thirds; at 160×32, all sections and 10 mascot rows remain visible; overfull lists keep exact overflow counts.

- [ ] **Step 2: Verify RED**, then implement native rail title/border styling and deterministic height fitting.

Fit desired heights to budget by repeatedly reducing the tallest compressible panel to a minimum of 3. Clip rows to each panel's inner height. Put leftover space before the mascot and center it horizontally.

- [ ] **Step 3: Verify focused layout/native tests and full TUI tests**

Expected: no clipped sections at 160×32, no equal-third empty panels at 160×40, and no row exceeds terminal width.

### Task 3: Compact facts, path wrapping and empty-session guidance

**Files:**
- Modify: `packages/tui/src/app/rails.ts`
- Modify: `packages/tui/src/ui/screen.ts`
- Modify: `packages/tui/src/text/wrap.ts`
- Modify: `packages/tui/src/components/transcript.ts`
- Modify: `packages/tui/src/app/copy.ts`
- Modify: `packages/tui/test/rails.test.ts`, `wrap.test.ts`, `layout.test.ts`, `frame.test.ts`, `composer.test.ts`

**Interfaces:**
- Produces: `wrapPath(value, width): string[]` with segment-aware wrapping and existing `wrap()` fallback for an overlong segment.
- Empty transcript returns one native welcome panel only when there are no entries, reasoning, pending tools or streaming text.

- [ ] **Step 1: Write failing copy and rendering tests**

Cover `文件变更` empty copy, single-line short facts, path-segment wrapping, empty-session guidance and its suppression, and Shift+Enter discoverability.

- [ ] **Step 2: Verify RED**, then implement compact fact rows and their real natural-height measurement.

Use the same fact-line calculation for mounting and height budgeting. Keep changed-file diffstat and overflow behavior unchanged.

- [ ] **Step 3: Implement the welcome panel and bilingual input hints, then verify focused and full TUI tests**

### Task 4: Documentation and delivery verification

**Files:**
- Modify: `docs/architecture/06-frontend.md`, `docs/brand/brand-guide.md`, `docs/changelog.md`, `docs/HANDOFF.md`

- [ ] **Step 1: Sweep stale 82×46/41×23/equal-third descriptions and record ADR-174 behavior honestly.**
- [ ] **Step 2: Run TUI build + ESLint + full tests, layered/API/performance probes and real-process smoke.**
- [ ] **Step 3: Build/test protocol → cowcat → tui → cli and run `node tools/check-tarball.mjs`.**
- [ ] **Step 4: Inspect actual terminal rendering at 160×32 and 160×40 where possible; record any unverified human-visual or cross-terminal gaps.**
- [ ] **Step 5: Run the Impeccable detector once on changed UI targets and complete an independent whole-branch review; fix confirmed regressions before reporting.**
