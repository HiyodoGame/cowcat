# cowcat

[![CI](https://github.com/HiyodoGame/cowcat/actions/workflows/ci.yml/badge.svg)](https://github.com/HiyodoGame/cowcat/actions/workflows/ci.yml)

> CowCat 是跑在你自己终端里的开源 CLI 编程 Agent。

CowCat is an interactive CLI coding agent: high-energy, action-biased, but professionally reliable. It talks to any Anthropic-compatible or OpenAI-compatible model endpoint — including Kimi for Coding — and keeps your code, your keys, and your terminal under your own control.

## Features

- **15+ tools** — Read / Edit / Write / Glob / Grep / Bash (+ run_in_background) / TodoWrite / AskUserQuestion / Agent (roles, skills, resume) / WebFetch / WebSearch / TaskOutput / TaskStop, plus dynamically registered mcp__server__tool entries — each with JSON-schema validation and precise error reporting.
- **Plan / Act modes** — explore read-only and produce a plan first (`/plan`), then execute (`/act`).
- **Per-action approval cards** — every diff and command is its own card with a real unified diff (syntax-tinted, foldable), a one-shot or remembered (`always`) approval, and danger highlighting.
- **Context management** — automatic compaction with a summarizer pass, resume wrapper, and large-file reminders; precise `count_tokens` probes instead of guesswork.
- **Sub agents** — delegate isolated read-only reconnaissance to a scout agent that reports back with file-and-line evidence.
- **25+ slash commands** — plan/act, checkpoints with /rewind, /compact, /cost, /status, /export, /fork, /permissions rules, /hooks, /mcp, /tasks, /agents, /skills, custom markdown commands, and more.
- **IDE integration** — detects VS Code/Cursor/JetBrains, streams file/diagnostic events as JSONL for extensions.
- **Worktree isolation** — /worktree session switching and Agent isolation runs on fresh git worktrees.
- **Lead orchestration** — a lead sub agent role that delegates to scout/plan/general/verify members.
- **Background runs** — -p --background detaches long tasks with logs, result files, and a desktop notification.
- **Structured output** — --output-format stream-json (pure NDJSON event stream) and --output-schema (validate + one retry) for CI pipelines.
- **Output styles & statusline** — markdown-defined output styles, a custom statusline command fed session JSON, history recall / Tab completion / shift-tab mode switching.
- **Full-screen TUI** — alternate-screen four-pane console: inline tool/approval cards, context meter, scrollable transcript, Esc to interrupt; auto-degrades to linear mode in pipes/CI (COWCAT_TUI=off to force).
- **Project memory** — multi-level: user (`~/.cowcat/CLAUDE.md`) + project (`CLAUDE.md`, `.cowcat/CLAUDE.md`, `.cowcat/rules/*.md` walking up from cwd), merged with COWCAT.md → AGENTS.md → `CLAUDE.md` project instructions, deduplicated; `/memory` to view/append, `/init` drafts one for you.
- **Hooks** — 8 lifecycle events (command + http types); PreToolUse can veto a tool call and feed the reason back to the model; `once`/`async` supported.
- **MCP client** — stdio + http transports, dynamic `mcp__server__tool` registration, first-connect trust prompt, clean shutdown of server processes.
- **Custom commands/agents/skills** — drop `commands/*.md`, `agents/*.md`, `skills/*/SKILL.md` into `~/.cowcat/` or project `.cowcat/`; slash-command templates with `$ARGUMENTS`, custom sub agent roles, lazy-loaded skills via the Agent tool.
- **Background tasks** — `run_in_background` Bash, TaskOutput/TaskStop tools, `/tasks`; everything is SIGKILLed on exit.
- **Permission rules** — persistent `allow`/`deny`/`ask` rule lists in config.json (prefix `:*` and glob matching), validated at load with friendly warnings; `/permissions` manages them live.
- **Sessions** — JSONL transcripts under `~/.cowcat/`, with `--continue`, interactive `--resume`, and transcript-based recovery.

Zero runtime dependencies. Node.js >= 20.

## Quick start (Kimi for Coding)

```bash
npm i -g @corescense/cowcat

cowcat setup     # interactive wizard: provider / base URL / API key (not echoed) / model
cowcat doctor    # verify config + API connectivity, item by item
cowcat           # start the REPL
```

Or configure via environment variables:

```bash
export COWCAT_PROVIDER=anthropic
export COWCAT_BASE_URL=https://api.kimi.com/coding
export COWCAT_API_KEY=sk-...
export COWCAT_MODEL=kimi-for-coding
cowcat "read src/index.js and explain what it does"
```

Any Anthropic-compatible (`/v1/messages`) or OpenAI-compatible (`/chat/completions`) endpoint works.

```bash
cowcat "fix the bug in src/index.js"   # one-shot, asks before writing
cowcat -y "..."                        # auto-approve (use with care)
cowcat -p "..."                        # non-interactive print mode; write actions are auto-denied (exit code != 0)
```

## License

MIT — © 2026 心感科技（深圳）有限公司 (CoreScense).

CowCat ships **without any API key** and without any bundled model endpoint. Bring your own key, your own endpoint, your own model.
