# P0 Startup Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CowCat's default TUI readiness, command help, diagnostics, and repository launchers consistent and testable on Windows and POSIX.

**Architecture:** Preserve ADR-062/065's Node >=22 headless boundary and the TUI-only Node >=26.4 floor. Add one new ADR that makes the default entry's readiness part of `doctor`, generate all command help from the existing command table, and test repository shims from the CLI's existing Node test suite.

**Tech Stack:** TypeScript strict/ESM, Node `node:test`, zod, existing CLI command table.

**Spec:** `C:/Users/Con_WKK/.kimi-code/sessions/wd_cowcat_ee6ac06e6355/session_a9721c29-3259-4814-8bc4-a4d69b587b7e/agents/main/plans/flash-hawkman-longshot.md`, P0-A.

## Global Constraints

- Do not raise the CLI package's Node floor: `serve`, `run`, `sessions`, and headless `doctor` capabilities remain Node >=22.
- The default `cowcat`/`cowcat tui` path requires Node >=26.4; do not auto-download a runtime or silently fall back to another UI.
- Do not publish, change npm dist-tags, or change package versions in this batch.
- Use LF, Conventional Commits if a commit is explicitly requested, and keep documentation in the same change.
- Do not edit CI workflow quota shape.

## Review Focus

- Node exactly 26.4 must be accepted; 26.3 and 25.x must be rejected for the default TUI.
- `cowcat tui --help` must not build a host, load opentui, or require a model/key.
- `cowcat doctor` on Node 22/24 must fail default-entry readiness without claiming `serve/run` are broken.
- Windows shim paths must use the v2 CLI entry and work when the repository path contains spaces.
- Unknown commands and malformed option usage must retain exit code 2 rather than being swallowed by help handling.

---

### Task 1: Runtime readiness ADR and help contract

**Files:**
- Modify: `docs/architecture/README.md` (append ADR-148)
- Modify: `packages/cli/src/cli/help.ts`
- Modify: `packages/cli/src/cli/run.ts`
- Modify: `README.md`
- Test: `packages/cli/test/help.test.ts`

**Interfaces:**
- Consumes: existing `COMMANDS`, `CommandSpec`, `renderHelp(): string`, `runCli(argv, options)`.
- Produces: `renderCommandHelp(command: CommandSpec): string`; `runCli(['tui','--help'])` and `runCli(['help','tui'])` return 0 after printing command-specific usage and flags without executing `tui`.

- [ ] **Step 1: Add ADR-148 before code**

Record that CLI engines remain >=22, while `doctor` also reports the default TUI entry as a first-class readiness check; global and per-command help must state both floors; the repository Windows launcher must target `packages/cli`, not deleted `agent/`.

- [ ] **Step 2: Write failing help tests**

Create tests using captured stdout/stderr arrays:
- `renderHelp()` contains `默认 TUI 需要 Node >= 26.4` and `headless / run / doctor 等命令需要 Node >= 22`.
- `runCli(['tui','--help'])` returns 0, output contains `cowcat tui`, `--worktree <name>`, and the two runtime floors.
- `runCli(['help','tui'])` returns the same command help.
- `runCli(['doctor','--help'])` returns 0 without configuration diagnostics.
- `runCli(['not-a-command','--help'])` returns 2.
- `runCli(['run','--help'])` returns command help rather than a missing-prompt error.

- [ ] **Step 3: Run tests and confirm RED**

Run: `node --import tsx --test packages/cli/test/help.test.ts` if `tsx` is already available; otherwise build with `npm run build --prefix packages/cli` and run `node --test packages/cli/dist/test/help.test.js`.
Expected: FAIL because per-command help is not implemented and global help lacks runtime floors. Do not add `tsx` or another dependency.

- [ ] **Step 4: Implement table-generated help**

Add `renderCommandHelp(command)` beside `renderHelp()`, with shared runtime text. Handle `-h`/`--help` after resolving a valid command and before positional/option validation; support `help <command>` as a flat dispatcher special case without adding a model/host command.

- [ ] **Step 5: Update user documentation**

Make README quick-start put Node >=26.4 before installation for the default TUI, retain the Node >=22 headless note, and document `cowcat <command> --help` / `cowcat help <command>`.

- [ ] **Step 6: Run tests and confirm GREEN**

Run the same test command from Step 3 plus `npm run lint --prefix packages/cli`.
Expected: all help tests pass; lint exits 0.

### Task 2: Doctor reports default-entry readiness honestly

**Files:**
- Modify: `packages/cli/src/cli/doctor.ts`
- Modify: `packages/cli/src/cli/tui.ts`
- Test: `packages/cli/test/runtime.test.ts`

**Interfaces:**
- Consumes: `RENDERER_FLOOR` semantics from Task 1's ADR.
- Produces: `meetsNodeFloor(version: string, floor: {major:number; minor:number}): boolean` in a dependency-free `packages/cli/src/cli/runtime.ts`; `startTui` and `runDoctor` use the same helper.

- [ ] **Step 1: Write failing runtime and doctor tests**

Test `meetsNodeFloor` with `22.0.0`, `25.9.0`, `26.3.9`, `26.4.0`, and `27.0.0`. Add an exported `defaultEntryProblem(version)` test: versions below 26.4 return text naming the default TUI and required floor; supported versions return null. Run the real `runDoctor` with injected version `24.18.0` and an isolated `COWCAT_HOME`, asserting exit 1 and a `默认入口 ... FAIL` row; injected `26.4.0` must not produce that runtime failure.

- [ ] **Step 2: Run tests and confirm RED**

Run: build CLI and `node --test packages/cli/dist/test/runtime.test.js`.
Expected: FAIL because the shared runtime helper does not exist and renderer readiness is only a note.

- [ ] **Step 3: Implement shared readiness**

Create `runtime.ts` with the exact two functions above. Change `runDoctor(context, nodeVersion = process.versions.node)` to use it and turn the default TUI row into a pass/fail row; keep a separate note that Node >=22 headless commands remain usable. Change `startTui` to consume the same predicate without altering its refusal behavior or workaround.

- [ ] **Step 4: Run tests and confirm GREEN**

Run: `npm test --prefix packages/cli`.
Expected: build, lint, runtime tests, help tests, and existing exit-criteria test all pass.

### Task 3: Repair and pin repository launchers

**Files:**
- Modify: `bin/cowcat.cmd`
- Modify: `bin/cowcat`
- Test: `packages/cli/test/launchers.test.ts`

**Interfaces:**
- Consumes: built `packages/cli/dist/src/cli/main.js` produced by the CLI pretest.
- Produces: both repository shims resolve that exact v2 entry relative to their own location and forward all arguments.

- [ ] **Step 1: Write failing launcher tests**

Resolve repository root from `import.meta.url`. Read both shim files; assert neither contains `agent/bin` or `agent\bin`, the cmd shim quotes the v2 entry and uses `"%DIR%..\packages\cli\dist\src\cli\main.js"`, and the POSIX shim references `../packages/cli/dist/src/cli/main.js`. Assert the built entry exists.

- [ ] **Step 2: Run tests and confirm RED**

Run: build CLI and `node --test packages/cli/dist/test/launchers.test.js`.
Expected: FAIL only on the cmd shim's deleted v1 target.

- [ ] **Step 3: Repair the cmd shim**

Point `node` at `"%DIR%..\packages\cli\dist\src\cli\main.js"`, preserve `setlocal`, argument forwarding, and exit-code propagation. Keep the already-correct POSIX shim unchanged unless its comments need alignment.

- [ ] **Step 4: Run tests and a real launcher smoke**

Run: `npm test --prefix packages/cli`, then from repository root run `bin/cowcat --version` on POSIX shells. On Windows, invoke `cmd.exe /d /c "bin\cowcat.cmd --version"` from Git Bash.
Expected: tests pass; both real commands print the current package version and exit 0.

### Task 4: Whole-batch verification

**Files:**
- Modify: `docs/HANDOFF.md` only if its current-status snapshot is required by repository convention; otherwise leave the phase snapshot untouched.
- No production files beyond Tasks 1–3.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified P0-A branch ready for review; no commit, push, or publish without an explicit user request.

- [ ] **Step 1: Run all package suites in dependency order**

Run: `npm test --prefix packages/protocol`, `npm test --prefix packages/cowcat`, Node 26 `npm test --prefix packages/tui`, and `npm test --prefix packages/cli`.
Expected: every command exits 0; platform skips are reported, not hidden.

- [ ] **Step 2: Run repository guards**

Run: `node tools/lint-probe.mjs` and `node tools/check-tarball.mjs`.
Expected: both exit 0 with no `file:` dependencies in staged tarballs.

- [ ] **Step 3: Verify the original startup scenario**

Run the real CLI with PATH Node 24: `cowcat doctor` equivalent against the branch build must fail default-entry readiness and explain why; branch `main.js --help`, `main.js tui --help`, and both launchers' `--version` must work. With Node 26, invoke `main.js tui --help` as the non-interactive smoke; do not start a long-lived TUI in automation.
Expected: no contradictory doctor success on Node 24, no npx requirement for help/version, and no deleted `agent/` launcher path.

- [ ] **Step 4: Review the diff and record residual limits**

Confirm no versions, dist-tags, CI jobs, secrets, or global user configuration changed. State that a real Node 26 interactive TUI session and clean global-install smoke remain release checklist items if not executed here.
