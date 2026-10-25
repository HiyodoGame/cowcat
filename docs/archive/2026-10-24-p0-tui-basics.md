# P0 TUI Basics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make exiting, navigation, command discovery, and file-change review behave like a mature everyday coding TUI.

**Architecture:** Keep key handling as pure intents over `TuiView`; derive changed files from the existing projected tool entries and calls, with no protocol or kernel event change. Add ADR-149 for the interaction contract, then cover components with headless tests and the loop with small pure helpers where direct terminal automation is unavailable.

**Tech Stack:** TypeScript strict/ESM, Node 26 `node:test`, existing OpenTUI frame projection.

**Spec:** Session audit plan `flash-hawkman-longshot.md`, P0-B.

## Global Constraints

- Do not change the headless protocol or kernel event schema in this batch.
- Preserve textarea cursor movement, slash-menu ownership, approval/plan arrows, and existing input-history behavior where it does not conflict with empty-input scrolling.
- Write previews are explicitly labeled as new content, not before/after diffs; no invented old contents.
- No real terminal long-running process in automated tests.

## Review Focus

- Ctrl+C during a running turn must cancel, never terminate the process.
- Empty-input Ctrl+C must require a second press within the armed window; Ctrl+D remains an explicit exit route.
- Slash Escape must preserve the typed command; approval Escape still cancels only the active turn.
- Repeated Write/Edit entries for one path must produce one changed-files row with all operation kinds retained.
- Overwritten files must say “写入内容预览”, not claim the displayed added lines are a complete old/new diff.

---

### Task 1: Exit, help, and navigation contract

**Files:**
- Modify: `docs/architecture/README.md` (ADR-149)
- Modify: `packages/tui/src/app/keymap.ts`
- Modify: `packages/tui/src/app/commands.ts`
- Modify: `packages/tui/src/run.ts`
- Modify: `packages/tui/src/app/copy.ts`
- Test: `packages/tui/test/keymap.test.ts`, `packages/tui/test/project.test.ts`

**Interfaces:**
- Produces: intents `clearInput` and `armExit`; `intentFor(key, view, now?, exitArmUntil?)`; `findCommand('exit')` resolves to the existing quit command; empty-input plain arrows emit scroll intents.

- [ ] Write ADR-149: running Ctrl+C cancels; non-empty input Ctrl+C clears; empty input arms an 800ms second-press exit; Ctrl+D exits only with empty input; `/exit` aliases `/quit`; empty-input arrows scroll while non-empty input retains cursor/history behavior; Slash Escape only closes the menu; changed-files and Write previews are projections of existing log data.
- [ ] Add failing tests for the above key cases, `/exit`, empty-input arrows, non-empty arrow ownership, and help text containing PageUp/PageDown/Ctrl+End/Ctrl+D.
- [ ] Build TUI and run the selected tests under Node 26; confirm RED on the new behaviors.
- [ ] Implement the minimal keymap/command changes. In `run.ts`, pass an injected wall clock and the armed deadline, handle `clearInput`/`armExit`, remove duplicate `clearInput()`, and make `slashClose` close without clearing. Update help and placeholder copy.
- [ ] Re-run selected tests, then the full TUI suite under Node 26; confirm GREEN.

### Task 2: Changed-files projection and Write content preview

**Files:**
- Create: `packages/tui/src/app/changes.ts`
- Create: `packages/tui/src/components/changes-panel.ts`
- Modify: `packages/tui/src/app/view.ts`, `packages/tui/src/app/commands.ts`, `packages/tui/src/components/session-frame.ts`, `packages/tui/src/components/tool-card.ts`, `packages/tui/src/index.ts`
- Test: `packages/tui/test/changes.test.ts`, `packages/tui/test/cards.test.ts`

**Interfaces:**
- Produces: `changedFiles(view): readonly ChangedFile[]` where `ChangedFile = {path, operations: readonly ('Edit'|'Write')[], added:number, removed:number}`; `/changes` toggles `view.changesVisible`; Write cards show capped new-content preview and exact new line count.

- [ ] Add failing tests projecting successful Edit + Write + failed Write + repeated Edit entries; assert deduplication, operation order, Edit diff counts, failed operations excluded, and `/changes` panel visibility.
- [ ] Add a failing Write card test: title names the path, suffix reports new lines, body includes new content and says `写入内容预览`; it must not show a fabricated `-0` diff statistic.
- [ ] Build and run the two test files under Node 26; confirm RED.
- [ ] Implement the pure projection and panel. Reuse `unifiedDiff` only for actual Edit old/new strings. For Write, read `content` from the logged call and render it as an explicit preview with the existing folded/expanded budgets.
- [ ] Re-run selected tests and the full TUI suite; update frame fixtures only if the new default UI intentionally changes a frame (the panel is closed by default).

### Task 3: Filterable, clickable command palette and batch verification

**Files:**
- Modify: `packages/tui/src/app/view.ts`, `packages/tui/src/app/commands.ts`, `packages/tui/src/components/palette.ts`, `packages/tui/src/components/session-frame.ts`, `packages/tui/src/run.ts`
- Test: `packages/tui/test/palette.test.ts`, `packages/tui/test/cards.test.ts`

**Interfaces:**
- Produces: `paletteMatches(view): readonly TuiCommand[]`, filtering by the palette query without destroying the underlying prompt draft; palette rows carry `palette:<row>` hit ids.

- [ ] Add failing tests for case-insensitive command/summary filtering, empty results, selection reset on query change, mouse hit ids, and clicking a row executing the same command as Enter.
- [ ] Build and run selected tests under Node 26; confirm RED.
- [ ] Implement palette query state and filtering with a draft-preserving open/close path. Clamp selection after filtering; Enter and click share one command-resolution path.
- [ ] Run all four package suites, `node tools/lint-probe.mjs`, `git diff --check`, and real `cowcat --help`/shim smoke from P0-A. Record that real terminal keyboard/mouse verification remains required if not exercised interactively.
