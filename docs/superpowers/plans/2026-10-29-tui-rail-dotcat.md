# TUI Fixed Rails and Grayscale Dot Cat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace empty-data-dependent sidebars with fixed, useful sections and replace the colored pixel mascot with the approved 82×46 grayscale, expression-driven dot-matrix cat.

**Architecture:** Keep `TuiView -> pure rail/frame data -> keyed native scene nodes`. `app/rails.ts` always supplies complete panels; `Screen` owns responsive sizing; `cowcat-art.ts` owns symmetric logical pixels and expressions; a quadrant adapter renders 82×46 logical points as 41×23 terminal cells without image protocols.

**Tech Stack:** TypeScript strict, Node >=26.4 for TUI, `@opentui/core@0.6.6`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-29-tui-rail-dotcat-design.md`

## Global Constraints

- Start from the latest `origin/main`; do not carry the local duplicate main commits into the implementation branch.
- No protocol, kernel event, port, model or tool behavior changes; no new dependency, React/Solid, image asset or terminal image protocol.
- The cat is 82×46 logical points, rendered as 41×23 terminal cells, with no text label and only grayscale tokens.
- Keep the approved simple shape: symmetric rounded head and ears, white face, one small nose, no mouth, no extra patches, no protruding right-ear tip.
- Keep the six approved eye expressions and the existing state priority; `COWCAT_ANIMATIONS=off`, hidden and destroyed cats do not schedule animation.
- Full three-column layout requires width >=160 and height >=32; 104–159 keeps only the information rail; narrower/shorter layouts use the existing dock.
- Do not push main or change package versions. Documentation and ADR-173 travel with the code.

## Review Focus

- Empty and overfull panels: every section keeps its title/empty state, and long lists show bounded rows plus `另有 N 项` instead of displacing the cat (Tasks 1–2).
- 160×32 and narrower/shorter terminals: the center remains readable and all left-side information stays reachable through dock (Task 2).
- Mixed quadrant input: null plus multiple colors must not create phantom pixels outside the silhouette; >2 colors must degrade deterministically without losing eyes (Task 4).
- Grayscale readability and shape integrity: the outer head is visible on `#1B1B22`, eye pupils remain visible inside their halos, and the right ear has no extra tip (Tasks 3–4).
- Reduced motion and lifecycle: static frames do not change with time, failed feedback does not shake forever, and hidden/off modes schedule nothing (Task 4).

---

### Task 0: Isolated baseline

**Files:** none in the main checkout; implementation occurs in `.worktrees/dotcat-rails`.

- [ ] **Step 1: Create the isolated worktree at execution time**

Use `superpowers:using-git-worktrees` to create branch `feat/dotcat-rails` in `.worktrees/dotcat-rails` from the latest `origin/main`. Copy this plan and `docs/superpowers/specs/2026-10-29-tui-rail-dotcat-design.md` into the same paths in that worktree. Do not commit either document to local main.

- [ ] **Step 2: Establish the green baseline**

Run in the worktree:

```bash
npm --prefix packages/tui run build
npx --yes node@26.12.0 --test "packages/tui/dist/test/**/*.test.js"
```

Expected: build succeeds and the existing TUI suite has 0 failures. Record the exact pass count before editing.

### Task 1: Complete rail data and ADR-173

**Files:**
- Modify: `packages/tui/src/app/rails.ts`
- Create: `packages/tui/test/rails.test.ts`
- Modify: `docs/architecture/README.md`
- Modify: `docs/architecture/06-frontend.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: existing `TuiView`, `runningAgents(view)`, `changedFiles(view)`, `SpriteNode`.
- Produces: `leftRailSpec()` always returns todo/subagent/background panels in that order plus `mascot`; `asideSpec()` always returns information and `CowCat 变更` content. Existing `RailPanel` / `AsidePanel` shapes remain unchanged.

- [ ] **Step 1: Record the contract and write failing structural tests**

Add ADR-173 for fixed sections, empty states, responsive thresholds, the 82×46 grayscale sprite and expression semantics. Add `.superpowers/` to `.gitignore`.

In `rails.test.ts`, assert for `initialView()`:

```ts
assert.deepEqual(left.panels.map((panel) => panel.title), ['待办 0/0', '子代理', '后台任务']);
assert.deepEqual(left.panels.map((panel) => panel.rows[0]?.text), [
  '暂无待办', '暂无运行中的子代理', '暂无后台任务',
]);
assert.equal(aside.panels.at(-1)?.title, 'CowCat 变更');
assert.equal(aside.panels.at(-1)?.rows[0]?.label, '暂无 CowCat 变更');
```

Also assert non-empty todos/tasks/agents retain their real rows and `CowCat 变更` retains diffstat.

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
npm --prefix packages/tui run build
npx --yes node@26.12.0 --test "packages/tui/dist/test/rails.test.js"
```

Expected: FAIL because empty panels and the empty change section are omitted.

- [ ] **Step 3: Implement complete rail specs**

In `app/rails.ts`, always produce the three left panels and the change section. Keep real counts and existing rows when data exists; use dim empty-state rows otherwise. Do not add overflow logic to this pure data layer.

- [ ] **Step 4: Verify the structural tests pass**

Run the same build and `rails.test.js` command. Expected: PASS with 0 failures.

- [ ] **Step 5: Commit**

Write the Chinese Conventional Commit message to `.git/COWCAT_COMMIT_MSG`, then:

```bash
git add .gitignore docs/architecture/README.md docs/architecture/06-frontend.md docs/superpowers packages/tui/src/app/rails.ts packages/tui/test/rails.test.ts
git commit -F .git/COWCAT_COMMIT_MSG
```

### Task 2: Fixed responsive layout and bounded panels

**Files:**
- Modify: `packages/tui/src/ui/screen.ts`
- Modify: `packages/tui/src/ui/primitives.ts`
- Modify: `packages/tui/test/layout.test.ts`

**Interfaces:**
- Consumes: Task 1's complete `LeftRailSpec` / `AsideSpec` and existing `ScreenSpec`.
- Produces: `activityRail()` is true only at width >=160 and height >=32. `createChildGroup` layout may additionally return `flexGrow`, `flexShrink`, and `minHeight`; the mascot's height comes from `heightOf(spec.mascot)` until Task 4 supplies the final 41×23 raster.

- [ ] **Step 1: Add failing layout tests**

At 160×40, mount `frameOf(initialView(), { width: 160, height: 40, now: 0, cwd: 'F:/project' })` and assert all four empty states, `CowCat 变更`, and the mascot are present in their fixed order; assert no `奶牛猫 /` label appears and `contentWidth() >= 80`. At 159×40 and 160×31, assert `activityRail() === false`; at 120×32 assert the right information rail remains and the left activity rail does not.

Add an overfull fixture with enough todos/tasks/agents to exceed 40 rows and assert the last visible summary uses `另有 N 项`, while the existing mascot remains mounted at the bottom. Include a long CJK/path value and assert no line exceeds its rail width.

- [ ] **Step 2: Verify the new tests fail**

Run:

```bash
npm --prefix packages/tui run build
npx --yes node@26.12.0 --test "packages/tui/dist/test/layout.test.js"
```

Expected: FAIL on empty placement, 160/height thresholds, or bounded content.

- [ ] **Step 3: Implement fixed rail layout**

In `screen.ts`, order left panels as todo/subagent/background then mascot. Give the three activity panels flexible remaining height with a readable minimum; reserve `heightOf(spec.mascot)` at the bottom with no label and no shrinking. Give the right change section remaining height. Extend the child-group layout callback to apply `flexGrow`, `flexShrink`, and `minHeight`.

Clip panel rows to the visible budget and append a dim `另有 N 项` row. Keep dock behavior unchanged for narrower/shorter terminals and never scale or crop the logical cat.

- [ ] **Step 4: Verify layout tests and existing native tests pass**

Run:

```bash
npm --prefix packages/tui run build
npx --yes node@26.12.0 --test "packages/tui/dist/test/layout.test.js" "packages/tui/dist/test/native-components.test.js"
```

Expected: PASS with 0 failures.

- [ ] **Step 5: Commit**

Commit `screen.ts`, `primitives.ts`, and `layout.test.ts` with `fix(tui): 固定侧栏区块并补齐响应式空态` via `git commit -F .git/COWCAT_COMMIT_MSG`.

### Task 3: Symmetric grayscale cat and six expressions

**Files:**
- Modify: `packages/tui/src/components/cowcat-art.ts`
- Modify: `packages/tui/src/ui/scene.ts`
- Modify: `packages/tui/src/theme/tokens.ts`
- Modify: `packages/tui/test/mascot.test.ts`
- Modify: `packages/tui/test/mascot-logo.test.ts`
- Modify: `docs/brand/brand-guide.md`

**Interfaces:**
- Consumes: existing `mascotState(view, now)` and `animationsEnabled(process.env)`.
- Produces: `mascotFrame(state, now, animate?)` returns 46 rows × 82 columns of `'backdrop' | 'on' | 'furDark' | 'furMid' | 'furLight' | 'iris' | 'eye' | 'nose' | 'highlight' | null`; `spriteBlock` continues to accept the matrix. `backdrop` fills the whole animation area; the other roles form the cat.

- [ ] **Step 1: Replace old pixel assertions with failing approved-shape tests**

Assert for every state: 46 rows, every row 82 columns, and only the new grayscale roles/null. For static idle/success frames, assert `row[x] === row[81 - x]`. Assert exactly four `nose` cells forming one logical 2×2 nose. After excluding `backdrop`, assert the cat's x bounds are 10…71 (no right-ear protrusion), and no old `fur`/`patch` roles remain.

Add expression tests: thinking at 0 and 600 changes only gaze/approved subtle scan; tools has shorter pupils than approval; success has curved eyes; failed has drooping eyes. For every state, `mascotFrame(state, 0, false)` equals the frame at another timestamp. Update the brand guide to v1.3 for the approved dot-matrix identity.

- [ ] **Step 2: Verify cat tests fail**

Run:

```bash
npm --prefix packages/tui run build
npx --yes node@26.12.0 --test "packages/tui/dist/test/mascot.test.js" "packages/tui/dist/test/mascot-logo.test.js"
```

Expected: FAIL on dimensions, roles, shape, or expressions.

- [ ] **Step 3: Implement the approved logical sprite**

Fill the frame with the dim `backdrop` lattice, then build the symmetric rounded head and flush ears, white face and one 2×2 nose in `cowcat-art.ts`. Implement haloed vertical pupils, blink, gaze, half-lidded, wide, curved and drooping expressions. Keep state priority unchanged and keep all motion deterministic.

Extend `SpriteColor` and `TokenName` to the new roles and map every cat token to a grayscale value; remove green/pink cat tokens and stale brand text.

- [ ] **Step 4: Verify cat tests pass**

Run the same build and mascot test command. Expected: PASS with 0 failures.

- [ ] **Step 5: Commit**

Commit the cat, scene type, tokens, mascot tests and brand guide with `feat(tui): 实现灰阶对称点阵猫与六种眼神` via `git commit -F .git/COWCAT_COMMIT_MSG`.

### Task 4: Quadrant renderer and animation lifecycle

**Files:**
- Create: `packages/tui/src/ui/quadrants.ts`
- Create: `packages/tui/test/quadrants.test.ts`
- Modify: `packages/tui/src/ui/primitives.ts`
- Modify: `packages/tui/src/app/activity.ts`
- Modify: `packages/tui/test/native-components.test.ts`
- Modify: `packages/tui/test/activity.test.ts`
- Modify: `packages/tui/test/activity-run.test.ts`

**Interfaces:**
- Consumes: Task 3's 82×46 `SpriteNode.pixels` and existing `mascotState`.
- Produces: `quadrantCell(pixels, x, y): { glyph: string; foreground: SpriteColor | null; background: SpriteColor | null }`; the sprite mount renders 41 columns × 23 rows. `activityDelay` schedules only phases used by the new frames.

- [ ] **Step 1: Add failing raster and lifecycle tests**

Cover empty, top, bottom, left, right, diagonal and full 2×2 cells. Assert null never gains a background outside the silhouette; cells with >2 colors resolve deterministically and preserve eye/nose priority. Assert pure `backdrop` cells use a small dim dot rather than a solid full block, and the lattice still fills the animation area. Assert a Task 3 sprite mounts at width 41 and height 23, and color spans distinguish the iris halo from the pupil.

Update activity assertions: thinking uses 600ms gaze phases, tools uses 240ms scans, approval returns null, success is one-shot, failed only waits for settled feedback to end, and animations-off/hidden return null.

- [ ] **Step 2: Verify raster/activity tests fail**

Run:

```bash
npm --prefix packages/tui run build
npx --yes node@26.12.0 --test "packages/tui/dist/test/quadrants.test.js" "packages/tui/dist/test/activity.test.js"
```

Expected: FAIL because the quadrant adapter does not exist and failed still uses the old shake cadence.

- [ ] **Step 3: Implement deterministic 2×2 mapping and scheduling**

Implement all 16 quadrant patterns. Render pure `backdrop` cells as a small dim dot and treat backdrop like transparency when it borders the cat, so the lattice never becomes a solid block wall. With transparency, preserve the silhouette rather than filling nulls; with >2 colors, choose a deterministic foreground/background pair and preserve eye/nose detail ahead of decorative shading. Use foreground for the glyph's set bits and background for the other color.

Change sprite mounting to 41×23 cells and call `quadrantCell`. Remove failed shake scheduling while retaining the static drooping expression; preserve existing reasoning reveal, approval idleness, cleanup and reduced-motion behavior.

- [ ] **Step 4: Verify renderer and integration tests pass**

Run:

```bash
npm --prefix packages/tui run build
npx --yes node@26.12.0 --test "packages/tui/dist/test/quadrants.test.js" "packages/tui/dist/test/native-components.test.js" "packages/tui/dist/test/activity.test.js" "packages/tui/dist/test/activity-run.test.js"
npm --prefix packages/tui run lint
```

Expected: all PASS and ESLint has 0 errors.

- [ ] **Step 5: Commit**

Commit the raster adapter, sprite mount, activity scheduler and tests with `feat(tui): 接入高密度点阵光栅与动画调度` via `git commit -F .git/COWCAT_COMMIT_MSG`.

### Task 5: Full verification and handoff

**Files:**
- Modify: `docs/architecture/06-frontend.md` and `docs/architecture/README.md` only if implementation evidence changes a contract statement.
- Modify: `docs/changelog.md`
- Modify: `docs/HANDOFF.md`

- [ ] **Step 1: Run the complete TUI and probe verification**

```bash
npm --prefix packages/tui run pretest
npx --yes node@26.12.0 --test "packages/tui/dist/test/**/*.test.js"
node tools/lint-probe.mjs
npx --yes node@26.12.0 tools/tui-api-probe.mjs
npx --yes node@26.12.0 tools/tui-perf-probe.mjs
npx --yes node@26.12.0 tools/tui-smoke.mjs
```

Expected: TUI build/lint/tests and all probes exit 0. Inspect 80/120/160/180-column frames and all six eye expressions, including color spans, long CJK/path content, overfull panels and reduced motion.

- [ ] **Step 2: Run the four-package verification in dependency order**

```bash
npm --prefix packages/protocol test
npm --prefix packages/cowcat test
npm --prefix packages/tui run pretest
npx --yes node@26.12.0 --test "packages/tui/dist/test/**/*.test.js"
npm --prefix packages/cli test
node tools/check-tarball.mjs
```

Expected: all four package suites and the tarball guard exit 0; record exact pass/skip counts. Use Node 26.12 for the TUI leg if the default runtime is below 26.4.

- [ ] **Step 3: Update evidence documents and inspect the final diff**

Add the unreleased changelog entry. Rewrite HANDOFF with actual commands/results and explicitly separate headless evidence from unverified real-terminal font/color behavior and remote CI. Run `git diff --check` and review the complete diff for accidental `.superpowers` files, protocol/kernel changes, colored cat tokens, or stale pixel-cat documentation.

- [ ] **Step 4: Commit and hand off**

Commit the evidence documents with `docs(tui): 记录固定侧栏与点阵猫验收证据` via `git commit -F .git/COWCAT_COMMIT_MSG`. Do not push or create a PR unless the user asks. Report the branch, tests, remaining real-terminal/CI gaps, and any behavior not verified.
