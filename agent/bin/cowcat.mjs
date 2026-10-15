#!/usr/bin/env node
// cowcat CLI entry: REPL with slash commands, resume, streaming, tool approvals.
import { loadConfig, ConfigError, displayModel, contextLimit, resolveModelConfig, configuredProviders, writeState } from '../src/config.js';
import { catalogRefs, formatModelHint } from '../src/modelhint.js';
import { createProvider } from '../src/llm/client.js';
import { buildSystemPrompt, PLAN_MODE_ADDENDUM } from '../src/prompts/system.js';
import { compactConversation } from '../src/prompts/compact.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ReadTool } from '../src/tools/read.js';
import { EditTool } from '../src/tools/edit.js';
import { WriteTool } from '../src/tools/write.js';
import { GlobTool } from '../src/tools/glob.js';
import { GrepTool } from '../src/tools/grep.js';
import { BashTool } from '../src/tools/bash.js';
import { TodoWriteTool, loadTodos } from '../src/tools/todo.js';
import { AskUserQuestionTool } from '../src/tools/ask.js';
import { AgentTool } from '../src/tools/agent.js';
import { WebFetchTool } from '../src/tools/webfetch.js';
import { WebSearchTool } from '../src/tools/websearch.js';
import { Permissions, shiftTabModes } from '../src/permissions.js';
import { UI, detectLang, BRAND } from '../src/ui.js';
import { runLoop } from '../src/loop.js';
import { Session } from '../src/session.js';
import { createSubagentRunner } from '../src/subagent.js';
import { parseArgs } from '../src/cliargs.js';
import { findProjectContext, PROJECT_SECTION } from '../src/project.js';
import { runDoctorChecks, saveFixedConfig } from '../src/doctor.js';
import { runSetupWizard, runSetupDialog } from '../src/setup.js';
import { isTrustedProject, trustProject } from '../src/trust.js';
import { listCheckpoints, restoreCheckpoint, checkpointSummaryLine } from '../src/checkpoint.js';
import {
  formatCostReport, formatStatus, exportSessionToMarkdown, forkSessionFile,
  persistTheme, contextUsage,
} from '../src/slashcmds.js';
import {
  collectMemories, memorySection, memoryPathFor, ensureMemoryFile, appendMemory, memoryDisabled,
} from '../src/memory.js';
import { loadRules, validateRule, saveRuleColumn } from '../src/perrules.js';
import { loadHooks, fireHooks, hookPayload, updateHooksConfig, HOOK_EVENTS } from '../src/hooks.js';
import { loadMcpConfigs, connectAll, mcpToolAdapter, mcpTrustedList, trustMcpServer } from '../src/mcp.js';
import { loadCustom, expandCommand, customHelpLines } from '../src/custom.js';
import { loadOutputStyles, styleSection } from '../src/outputstyles.js';
import { runStatusLine, statuslinePayload, saveStatusLine } from '../src/statusline.js';
import { writeEvent, validateSchema, extractJson } from '../src/structured.js';
import { analyzeContext, renderContextReport } from '../src/contextviz.js';
import { thinkingBlocksOf, renderThinkingCard } from '../src/thinking.js';
import { completeFiles } from '../src/mention.js';
import { slashCommandList, slashCommandDocs } from '../src/slashlist.js';
import { parseApiError, formatApiErrorLines } from '../src/errfmt.js';
import { runInspect, renderInspect, runFix, doctorJson } from '../src/doctor.js';
import { detectIde, makeIdeSink, ideStatus } from '../src/ide.js';
import { TuiUI } from '../src/tui/ui.js';
import { PERM_LABELS } from '../src/tui/render.js';
import { createWorktree, listWorktrees, isGitRepo } from '../src/worktree.js';
import { notify, makeRunId, prepareBackgroundRun, finishBackgroundRun } from '../src/notify.js';
import { BackgroundRegistry } from '../src/background.js';
import { TaskOutputTool } from '../src/tools/taskoutput.js';
import { TaskStopTool } from '../src/tools/taskstop.js';
import { EnterPlanModeTool, ExitPlanModeTool } from '../src/tools/planmode.js';
import { CronCreateTool, CronDeleteTool, CronListTool, ScheduleWakeupTool, takeDueCrons } from '../src/tools/cron.js';
import { TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool } from '../src/tools/tasktools.js';
import { ListMcpResourcesTool, ReadMcpResourceTool } from '../src/tools/mcpresources.js';
import { generateCowcatMd } from '../src/init.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PKG_VERSION = (() => { try { return require('../package.json').version; } catch { return '0.0.0'; } })();

const HELP = `CowCat — a slightly unhinged cow-cat that writes code for you

Usage: cowcat [command] [options] ["one-shot prompt"]

Commands:
  setup                 interactive config wizard (writes ~/.cowcat/config.json)
  doctor                check config completeness and API connectivity

Options:
  -y, --yolo            skip permission prompts (dangerous)
  -c, --continue        resume the most recent session of this project
  -r, --resume [file]   resume a session JSONL (no file: list and pick)
  -m, --model <name>    override the model for this run
  -p, --print           non-interactive: print result and exit
  -v, --version         print version
  -h, --help            show this help

Slash commands (interactive): /init /clear /compact /model <name> /plan /act /diff /output /exit
Project context: COWCAT.md -> AGENTS.md -> CLAUDE.md searched upward from cwd.
Config: env COWCAT_PROVIDER COWCAT_BASE_URL COWCAT_API_KEY COWCAT_MODEL COWCAT_MAX_TOKENS
        (CC_* still accepted during migration) or ~/.cowcat/config.json
`;

// Setup wizard: dialog version for picker-capable UIs (TuiUI), line mode otherwise.
const runSetup = (ui) => (ui && typeof ui.pickOne === 'function' ? runSetupDialog(ui) : runSetupWizard(ui));

async function cmdSetup(ui) {
  try {
    await runSetup(ui);
  } catch (e) {
    ui.print(`✗ 写入失败: ${e.message}`);
    process.exitCode = 1;
  }
}

// API connectivity probe: count_tokens on anthropic, a minimal generate on
// openai (whose countTokens is a purely local estimate, not a network call).
function providerPing(provider, kind) {
  if (kind === 'openai' || !provider.countTokens) {
    return () => provider.chat({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 1, stream: false });
  }
  return () => provider.countTokens({ messages: [{ role: 'user', content: 'ping' }] });
}

async function cmdDoctor(ui, opts = {}) {
  const action = (opts.prompt || '').split(/\s+/).filter(Boolean)[0] || null; // inspect | fix
  const json = (opts.prompt || '').includes('--json');
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (json) console.log(doctorJson({ items: [{ name: 'config', ok: false, detail: e.message }] }));
    else ui.print(`✗ 配置解析失败: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const configFile = join((await import('../src/config.js')).cowcatHome(), 'config.json');
  const hasConfigFile = existsSync(configFile);
  let fixes = [];
  if (action === 'fix') {
    const reg = buildRegistry();
    const result = runFix(cfg, { hasConfigFile, configFile, knownTools: reg.list().map((t) => t.name) });
    fixes = result.fixes;
    // persist: config layer -> config.json, state layer -> state.json
    saveFixedConfig(result.config);
  }
  const provider = await createProvider(cfg);
  const { items, ok } = await runDoctorChecks(cfg, {
    hasConfigFile: action === 'fix' ? true : hasConfigFile, // fix just created it
    ping: providerPing(provider, cfg.provider),
  });
  if (action === 'inspect') {
    const sections = runInspect(cfg, {
      knownTools: buildRegistry().list().map((t) => t.name),
      sessionCount: Session.list(process.cwd()).length,
      toolCount: buildRegistry().list().length,
      extra: fixes,
    });
    if (json) console.log(JSON.stringify({ ok, items, sections }, null, 2));
    else {
      for (const it of items) ui.print(`  ${it.ok ? '✓' : '✗'} ${it.name}${it.detail ? ` — ${it.detail}` : ''}`);
      ui.print('');
      ui.print(renderInspect(sections));
    }
  } else if (json) {
    console.log(doctorJson({ items, fixes }));
  } else {
    for (const f of fixes) ui.print(`🔧 ${f}`);
    for (const it of items) ui.print(`  ${it.ok ? '✓' : '✗'} ${it.name}${it.detail ? ` — ${it.detail}` : ''}`);
    ui.print(ok ? '全部通过。拆家许可证有效。' : '有问题。先跑 cowcat setup，或检查 COWCAT_* 环境变量。');
  }
  process.exitCode = ok && fixes.every((f) => !/^失败/.test(f)) ? 0 : 1;
}

function buildRegistry() {
  const reg = new ToolRegistry();
  for (const t of [ReadTool, EditTool, WriteTool, GlobTool, GrepTool, BashTool, TodoWriteTool, AskUserQuestionTool, AgentTool, WebFetchTool, WebSearchTool, TaskOutputTool, TaskStopTool, EnterPlanModeTool, ExitPlanModeTool, CronCreateTool, CronDeleteTool, CronListTool, ScheduleWakeupTool, TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool, ListMcpResourcesTool, ReadMcpResourceTool]) {
    reg.register(t);
  }
  return reg;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  if (opts.background) {
    if (!opts.prompt || !opts.print) { console.error('--background requires -p and a prompt'); process.exitCode = 1; return; }
    const id = makeRunId();
    const meta = prepareBackgroundRun(id, opts.prompt);
    const { spawn } = await import('node:child_process');
    const { openSync } = await import('node:fs');
    const out = openSync(meta.logFile, 'a');
    const selfPath = fileURLToPath(new URL('./cowcat.mjs', import.meta.url));
    const child = spawn(process.execPath, [selfPath, ...process.argv.slice(2).filter((a) => a !== '--background')], {
      env: { ...process.env, COWCAT_BG_ID: id, COWCAT_NOTIFY_ON_DONE: '1' },
      detached: true, stdio: ['ignore', out, out],
    });
    child.unref();
    console.log(`已后台启动 ${id}`);
    console.log(`日志: ${meta.logFile}`);
    console.log(`结果: ${meta.resultFile}`);
    return;
  }
  if (opts.version) { console.log(`cowcat/${PKG_VERSION}`); return; }
  if (opts.command === 'setup') { await cmdSetup(new UI({ colors: false })); return; }
  if (opts.command === 'doctor') { await cmdDoctor(new UI({ colors: false }), opts); return; }

  const cwd = process.cwd();
  const config = loadConfig(opts.model ? { model: opts.model } : {});
  const lang = detectLang(opts.prompt);
  const tuiWanted = !opts.print && opts.outputFormat !== 'stream-json' && process.env.COWCAT_TUI !== 'off'
    && !process.env.NO_COLOR && process.stdin.isTTY === true && process.stdout.isTTY === true;
  let ui;
  let tui = null;
  if (tuiWanted) {
    tui = new TuiUI({
      lang, colors: true, version: PKG_VERSION, cwd,
      getModel: () => config.apiKey ? displayModel(config) : (lang === 'zh' ? '未配置' : 'not configured'),
      getMode: () => permissionsPreview?.() ?? 'default',
      getCost: () => '',
      getConfig: () => config,
      getMessages: () => { try { return messages ?? []; } catch { return []; } },
      getPermissions: () => permissions,
      getTodos: () => { try { return state.todos?.length ? state.todos : null; } catch { return null; } },
      getMcp: () => {
        try {
          const names = Object.keys(mcpServers ?? {});
          return names.length ? names.map((name) => ({ name, ok: mcpClients.has(name) })) : null;
        } catch { return null; }
      },
      completions: (text) => {
        if (typeof text === 'string' && text.startsWith('/model ')) {
          const q = text.slice('/model '.length).toLowerCase();
          const refs = [];
          for (const p of configuredProviders(config)) {
            for (const [mid, m] of Object.entries(p.models || {})) {
              if (!m || m.disabled) continue;
              const name = (m.name || mid).toLowerCase();
              if (q && !mid.toLowerCase().includes(q) && !name.includes(q)) continue;
              refs.push(`${p.id}/${mid}`);
            }
          }
          return refs.slice(0, 20);
        }
        return slashCommandList();
      },
      onModelPick: (ref) => {
        const prevModel = config.model;
        const prevRef = config.modelRef;
        config.model = ref;
        try {
          resolveModelConfig(config);
          ui.print(`model: ${displayModel(config)} (${config.provider}/${config.model})`);
        } catch (e) {
          config.model = prevModel;
          config.modelRef = prevRef;
          ui.print(`✗ ${e.message}`);
        }
        refreshStatus?.();
      },
      commandDocs: slashCommandDocs(),
      fileCompletions: (prefix) => completeFiles(cwd, prefix),
    });
    ui = tui;
    if (config.panel) tui.panelVisible = true; // /panel (or a prior session) left it on
    tui.start();
    // Uncaught errors / Ctrl+C would otherwise skip the REPL-tail cleanup and
    // leave the terminal in the alternate screen with raw mode on.
    process.once('exit', () => { try { tui.close(); } catch { /* already closed */ } });
  } else {
    ui = new UI({ lang, interactive: !opts.print });
    ui.setTheme(config.theme === 'light' ? 'light' : 'dark');
  }
  function permissionsPreview() { try { return permissions.mode; } catch { return 'default'; } }
  let provider = await createProvider(config);
  const registry = buildRegistry();
  // Permission rules engine: validated config rules; bad rules warn, never abort.
  // The known-tools list is read fresh at every applyRules() call — MCP tools
  // (mcp__server__tool) only exist after connectMcp() runs below, so a startup
  // snapshot would reject every pre-configured mcp rule as "unregistered".
  const knownToolNames = () => registry.list().map((t) => t.name);
  const applyRules = () => {
    const r = loadRules(config, knownToolNames());
    permissions.setRules(r);
    for (const w of r.warnings) ui.print(`⚠ ${w}`);
  };
  const permissions = new Permissions(opts.yolo ? 'yolo' : 'default');
  applyRules();
  // Directory trust (like the reference CLI's trust dialog): ask before working
  // in an untrusted cwd. Declining — or any non-interactive run in an untrusted
  // dir — locks the session to read-only plan mode; -y never overrides trust.
  let restricted = false;
  if (!isTrustedProject(config, cwd)) {
    if (opts.print) {
      restricted = true;
      permissions.setMode('plan');
    } else {
      const q = lang === 'zh' ? `信任 ${cwd} 中的文件？[y/N] ` : `Trust the files in ${cwd}? [y/N] `;
      const a = ((await ui.ask(q)) ?? '').trim().toLowerCase();
      if (a === 'y' || a === 'yes') {
        trustProject(config, cwd);
      } else {
        restricted = true;
        permissions.setMode('plan');
        ui.print(lang === 'zh'
          ? '目录未信任：本次会话只读，可用 /act 信任并放行（仅本次）。'
          : 'Folder not trusted: this session is read-only. Use /act to trust and unblock (this session only).');
      }
    }
  }
  // system is resolved per turn so plan-mode addendum toggles take effect
  const baseSystem = buildSystemPrompt({ cwd });
  // Project instructions: COWCAT.md -> AGENTS.md -> CLAUDE.md, nearest wins.
  // Read once at startup; survives /clear since the system prompt is not reset.
  const projectCtx = findProjectContext(cwd);
  if (projectCtx) {
    baseSystem[1] += `\n\n${PROJECT_SECTION(projectCtx)}`;
    ui.print(`project: ${projectCtx.name} (${projectCtx.path})`);
  }
  // Memory system: user + project-level memory files, deduplicated against the
  // project-instruction file above. COWCAT_DISABLE_MEMORY=1 skips everything.
  if (!memoryDisabled()) {
    const skip = new Set(projectCtx ? [projectCtx.path] : []);
    const memories = collectMemories({ cwd, skipPaths: skip });
    for (const mem of memories) baseSystem[1] += `\n\n${memorySection(mem)}`;
    if (memories.length) ui.print(`memory: ${memories.length} file(s) loaded (${memories.map((m) => m.level).join(', ')})`);
  }

  // Custom commands / agents / skills (user + project levels).
  const custom = loadCustom(cwd);
  for (const w of custom.warnings) ui.print(w);
  if (Object.keys(custom.skills).length) {
    const index = Object.entries(custom.skills).map(([n, s]) => `- ${n}: ${s.description || '(no description)'}`).join('\n');
    baseSystem[1] += `\n\n# Skills index\n\nThe following skills are available. To use one, call the Agent tool with skill set to the skill name; the skill instructions are injected into the sub agent.\n${index}`;
  }
  // Output styles: loaded once, activated by /output-style, injected into the
  // per-turn system prompt tail (hence `system()` below reads the live value).
  const outputStyles = loadOutputStyles(cwd);
  for (const w of outputStyles.warnings) ui.print(w);
  let activeStyle = null;
  let activeStyleName = null;
  const system = () => {
    const blocks = permissions.mode === 'plan'
      ? [baseSystem[0], `${baseSystem[1]}\n\n${PLAN_MODE_ADDENDUM}`]
      : baseSystem;
    if (!activeStyle) return blocks;
    return [blocks[0], `${blocks[1]}\n\n${styleSection(activeStyle.body)}`];
  };
  const session = new Session(cwd);
  const state = { todos: loadTodos(session.id) };

  // Session resolution: explicit file, --continue (latest), or --resume list.
  const messages = [];
  const useSessionFile = (file) => {
    session.id = file.split(/[\\/]/).pop().replace('.jsonl', '');
    session.file = file;
    messages.push(...Session.load(file));
    provider.setSessionId?.(session.id);
  };
  if (opts.resume) {
    useSessionFile(opts.resume);
  } else if (opts.continueLast) {
    const latest = Session.list(cwd)[0];
    if (latest) {
      useSessionFile(latest);
    } else {
      ui.print(ui.lang === 'zh' ? '这个项目还没有历史会话，从空白开始。' : 'No previous sessions in this project — starting fresh.');
    }
  } else if (opts.resumeList) {
    const files = Session.list(cwd);
    if (!files.length) {
      ui.print(ui.lang === 'zh' ? '这个项目还没有会话。说点什么，让它开始拆。' : 'No sessions yet for this project. Say something to start one.');
    } else if (tui) {
      // picker instead of a numbered transcript list
      const items = files.slice(0, 50).map((f) => ({
        id: f,
        title: f.split(/[\\/]/).pop().replace('.jsonl', ''),
        description: '',
      }));
      const picked = await tui.pickOne({ title: ui.lang === 'zh' ? '恢复会话' : 'Resume session', items });
      if (picked) useSessionFile(picked.id);
    } else {
      files.forEach((f, i) => ui.print(`  ${i + 1}. ${f}`));
      ui.output.write(ui.lang === 'zh' ? '恢复第几个？ [序号]: ' : 'Resume which? [number]: ');
      const pick = parseInt((await ui.readLine()).trim(), 10);
      if (pick >= 1 && pick <= files.length) useSessionFile(files[pick - 1]);
      else ui.print(ui.lang === 'zh' ? '序号无效，从空白开始。' : 'Invalid pick — starting fresh.');
    }
  }
  provider.setSessionId?.(session.id); // fresh session, or re-assert after failed picks

  // Sub agent support (P1-7): builtin roles + custom agents + lazy skills.
  let spawnAgent = createSubagentRunner({
    provider, registry, config, ui, cwd,
    customAgents: custom.agents,
    getSkillBody: (name) => {
      const skill = custom.skills[name];
      if (!skill) return null;
      const raw = readFileSync(skill.file, 'utf8');
      const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
      return (m ? m[1] : raw).trim();
    },
  });
  // Ctrl-C forwards to any running Bash child before exiting. The full
  // cleanup (background registry + MCP servers + TUI restore) lives in
  // `shutdown`, assigned further down once everything it touches exists.
  const runningChildren = new Set();
  let shutdown = null;
  process.on('SIGINT', () => {
    for (const c of runningChildren) { try { c.kill(); } catch { /* already dead */ } }
    try { shutdown?.(); } catch { /* cleanup is best-effort on the way out */ }
    process.exit(130);
  });
  // SIGTERM (docker stop, CI runners, task managers) had no handler at all:
  // Node default-killed the process and left detached children behind.
  process.on('SIGTERM', () => {
    for (const c of runningChildren) { try { c.kill(); } catch { /* already dead */ } }
    try { shutdown?.(); } catch { /* cleanup is best-effort on the way out */ }
    process.exit(143);
  });
  const baseCtx = { cwd, readSet: new Set(), state, ui, permissions, config, session, sessionId: session.id, spawnAgent, trackProcess: (child) => { runningChildren.add(child); child.on?.('exit', () => runningChildren.delete(child)); } };
  // IDE integration sink (P2-2): detection + JSONL event channel.
  // IDE integration sink (P2-2): detection + JSONL event channel.
  const ideSink = makeIdeSink();
  const ideDetected = detectIde();

  // Background tasks: Bash run_in_background + TaskOutput/TaskStop + /tasks.
  const background = new BackgroundRegistry();
  baseCtx.background = background;

  // Hooks core subset: loaded once, fired from the loop and the REPL.
  const hooksState = loadHooks(config);
  // IDE + hooks startup notes: one muted transcript line in TUI, separate lines in line mode.
  if (tui) {
    const bits = [];
    if (ideDetected) bits.push(`IDE: ${ideDetected.name} detected (/ide for details)`);
    if (!hooksState.disabled && hooksState.count > 0) bits.push(ui.lang === 'zh' ? `已加载 ${hooksState.count} 个 hooks` : `${hooksState.count} hook(s) loaded`);
    if (bits.length) ui.print(tui.color(tui.theme.inactive, bits.join(' · ')));
  } else {
    if (ideDetected) ui.print(`IDE: ${ideDetected.name} detected (/ide for details)`);
    if (!hooksState.disabled && hooksState.count > 0) {
      ui.print(ui.lang === 'zh' ? `已加载 ${hooksState.count} 个 hooks` : `${hooksState.count} hook(s) loaded`);
    }
  }
  baseCtx.hooks = { ...hooksState, sessionFile: session.file, cwd };
  fireHooks(baseCtx.hooks, 'SessionStart', hookPayload('SessionStart', {}, baseCtx.hooks), { log: (m) => ui.print(m) }).catch(() => {});

  // MCP: connect configured servers concurrently; failures are isolated.
  const mcpServers = loadMcpConfigs(cwd);
  const mcpClients = new Map();
  baseCtx.mcpClients = mcpClients;
  let mcpResults = [];
  async function connectMcp(nameFilter = null) {
    const names = nameFilter ? [nameFilter] : Object.keys(mcpServers);
    // Overall budget for the connect phase: per-server timeouts are independent
    // (COWCAT_MCP_TIMEOUT, default 60s), so N hung servers used to block startup
    // for N×60s with no upper bound. Past the budget the rest are skipped with a
    // note instead of stalling the session.
    const budgetMs = Number(process.env.COWCAT_MCP_CONNECT_BUDGET) || 120_000;
    const deadline = Date.now() + budgetMs;
    for (const name of names) {
      if (!mcpServers[name]) { ui.print(`✗ MCP server "${name}" not configured`); continue; }
      if (Date.now() > deadline) {
        ui.print(ui.lang === 'zh'
          ? `⊘ MCP 连接总预算 ${Math.round(budgetMs / 1000)}s 已用尽，跳过 "${name}"（可用 COWCAT_MCP_CONNECT_BUDGET 调整）`
          : `⊘ MCP connect budget (${Math.round(budgetMs / 1000)}s) exhausted — skipping "${name}" (tune COWCAT_MCP_CONNECT_BUDGET)`);
        continue;
      }
      // first-connect trust prompt (remembered in config.mcpTrusted)
      if (!mcpTrustedList(config).includes(name)) {
        if (opts.print) { ui.print(`⊘ MCP server "${name}" not trusted — skipping (interactive session required to approve)`); continue; }
        let a;
        if (tui) {
          // pill approval in the composer area — no transcript spam
          a = await tui.approve('MCP server', `connect '${name}'`);
        } else {
          ui.output.write(ui.lang === 'zh' ? `连接 MCP server '${name}'？[y/N] ` : `Connect to MCP server '${name}'? [y/N] `);
          a = ((await ui.readLine()) ?? '').trim().toLowerCase();
        }
        if (a !== 'y' && a !== 'yes' && a !== 'always') { ui.print(ui.lang === 'zh' ? `已跳过 MCP server '${name}'。` : `Skipped MCP server '${name}'.`); continue; }
        trustMcpServer(config, name);
      }
      const res = (await connectAll({ [name]: mcpServers[name] }, { deadline }))[0];
      mcpResults = mcpResults.filter((r) => r.name !== name).concat(res);
      if (res.ok) {
        mcpClients.set(name, res.client);
        for (const tool of res.tools) {
          if (!registry.get(tool.name)) registry.register(mcpToolAdapter(res.client, name, tool));
        }
        if (tui) tui.toast('success', 'MCP', `${name}: ${res.tools.length} tool(s)`);
        else ui.print(`✓ MCP ${name}: ${res.tools.length} tool(s)`);
      } else {
        if (tui) tui.toast('error', 'MCP', `${name}: ${res.error}`);
        else ui.print(`✗ MCP ${name}: ${res.error}`);
        if (Date.now() >= deadline) {
          ui.print(ui.lang === 'zh'
            ? `  连接总预算 ${Math.round(budgetMs / 1000)}s 已用尽，剩余 server 将不再尝试（COWCAT_MCP_CONNECT_BUDGET 可调）`
            : `  connect budget (${Math.round(budgetMs / 1000)}s) exhausted — later servers will be skipped (tune COWCAT_MCP_CONNECT_BUDGET)`);
        }
      }
    }
  }
  if (Object.keys(mcpServers).length) await connectMcp();
  // MCP tools are registered now — re-apply so pre-configured mcp__* rules
  // (rejected as "unregistered" at startup) actually take effect this session.
  if (mcpClients.size) applyRules();
  function mcpCleanup() {
    for (const client of mcpClients.values()) { try { client.stop(); } catch { /* noop */ } }
    mcpClients.clear();
  }
  // Full child-process cleanup, shared by the signal handlers (above), the
  // print-mode early return, and the REPL tail. Best-effort: each step is
  // individually guarded so one failure never blocks the others.
  shutdown = () => {
    try { mcpCleanup(); } catch { /* noop */ }
    try { background.killAll(); } catch { /* noop */ }
  };

  const modeTag = () => {
    if (restricted) return ui.colors ? `${BRAND.plan}${ui.lang === 'zh' ? '[受限]' : '[restricted]'}\x1b[0m` : (ui.lang === 'zh' ? '[受限]' : '[restricted]');
    const tag = permissions.mode === 'plan' ? '[Plan]' : '[Act]';
    const col = permissions.mode === 'plan' ? BRAND.plan : BRAND.act;
    return ui.colors ? `${col}${tag}\x1b[0m` : tag;
  };
  let statusExtra = '';
  async function refreshStatusLine() {
    const cmd = config.statusLine?.command;
    if (!cmd) { if (statusExtra) { statusExtra = ''; } return; }
    const used = contextUsage(messages, config.maxContextTokens).used;
    const text = await runStatusLine(cmd, statuslinePayload({
      model: config.model, mode: permissions.mode,
      ctxPct: config.maxContextTokens ? Math.round((used / config.maxContextTokens) * 100) : 0, cwd,
    }));
    if (text !== null && text !== statusExtra) { statusExtra = text; refreshStatus(); }
  }
  const statusLine = () =>
    `CowCat — provider: ${config.provider} | model: ${config.apiKey ? displayModel(config) : (ui.lang === 'zh' ? '未配置' : 'not configured')} | mode: ${permissions.mode} ${modeTag()}${statusExtra ? '  | ' + statusExtra : ''}`;

  // First-run onboarding state: with no API key, skip the connectivity probe
  // (it would just spray a 403 at the default endpoint) and explain how to config.
  const missingKey = !config.apiKey;

  const refreshStatus = () => {
    if (tui) { tui._requestDraw?.(); return; } // TUI 状态栏走 chips/getModel 回调，不灌 transcript
    ui.print(statusLine());
  };

  const events = {};
  let currentAbort = null;
  if (tui) tui.onInterrupt = () => { currentAbort?.abort(); };
  if (tui) {
    // ctrl+b goes straight through TuiUI.togglePanel(), so without this hook the
    // documented "panel state is remembered" only held for the /panel command.
    tui.onTogglePanel = (on) => { writeState((s) => { s.panel = on; return s; }); };
  }
  if (tui) {
    // shift+tab: act <-> plan (the keybinding exists since the TUI redesign, but
    // nothing ever assigned onShiftTab, so the key did nothing). Plan is a
    // detour, not a tier: remember the mode we left so coming back restores it —
    // yolo has no other runtime entry point, so a peek at plan mode must not
    // strand a `-y` session in ask-on-write. An untrusted folder keeps its
    // read-only lock; the only escape stays /act, which asks for confirmation.
    let modeBeforePlan = null;
    tui.onShiftTab = () => {
      if (restricted) {
        tui.toast('warning', 'Plan', ui.lang === 'zh' ? '目录未信任：用 /act 放行' : 'Folder not trusted: use /act');
        return;
      }
      const t = shiftTabModes(permissions.mode, modeBeforePlan);
      modeBeforePlan = t.remembered;
      permissions.setMode(t.mode);
      const labels = PERM_LABELS[permissions.mode];
      tui.toast('info', ui.lang === 'zh' ? '权限模式' : 'Mode', labels?.[ui.lang === 'zh' ? 'zh' : 'en'] ?? permissions.mode);
      refreshStatus();
    };
  }

  const streamJsonMode = opts.print && opts.outputFormat === 'stream-json';
  if (streamJsonMode) {
    // pure NDJSON event stream: silence every decorative UI write
    ui.print = () => {};
    ui.streamChunk = () => {};
    ui.endStream = () => {};
    ui.toolCall = () => {};
    ui.waitingModel = () => {};
  }
  if (!streamJsonMode && !tui) {
    const modelDesc = config.apiKey ? displayModel(config) : (ui.lang === 'zh' ? '未配置' : 'not configured');
    ui.print(`CowCat v${PKG_VERSION} — ${config.provider} / ${modelDesc}`);
    ui.print(`session: ${session.file}`);
    ui.print(`type /exit to quit, /help for slash commands\n`);
    ui.print(statusLine());
  }

  // Startup model-ref validation (P5): resolveModelConfig skips the catalog
  // check for custom endpoints and empty catalogs, so a mistyped ref can slip
  // through startup — catch it here, suggest the closest known refs. Non-fatal.
  if (!streamJsonMode) {
    const knownRefs = catalogRefs(config);
    if (config.modelRef && knownRefs.length && !knownRefs.includes(config.modelRef)) {
      const hint = formatModelHint(config.modelRef, knownRefs, { lang: ui.lang });
      if (tui) tui.toast('warning', hint.title, hint.body);
      else ui.print(hint.line);
    }
  }

  // Startup connectivity probe (P1-5). Skipped in interactive mode when no
  // API key is configured — the onboarding message below replaces the noise.
  if ((!missingKey || opts.print) && !streamJsonMode) {
    try {
      await provider.countTokens?.({ messages: [{ role: 'user', content: 'ping' }] });
    } catch (e) {
      if (tui) tui.toast('error', ui.lang === 'zh' ? '连通性探针' : 'Connectivity probe', `${e.message} — check COWCAT_BASE_URL / COWCAT_API_KEY`);
      else ui.print(`[probe] count_tokens failed: ${e.message} — check COWCAT_BASE_URL / COWCAT_API_KEY (continuing anyway)`);
    }
  }
  if (missingKey && !opts.print && !streamJsonMode) {
    const zh = ui.lang === 'zh';
    if (tui) {
      // one hint toast + one muted transcript line (banner already shows 未配置)
      tui.toast('warning', zh ? '未配置模型服务' : 'No model service configured',
        zh ? '运行 /setup，或设置 COWCAT_BASE_URL / COWCAT_API_KEY / COWCAT_MODEL' : 'Run /setup, or set COWCAT_BASE_URL / COWCAT_API_KEY / COWCAT_MODEL');
      const hint = config.provider === 'anthropic' && config.baseURL === 'https://api.anthropic.com'
        ? (zh ? 'Kimi Code 推荐：/setup 选 kimi-code-plan-cn，或 baseURL https://api.kimi.com/coding + model kimi-for-coding。' : 'Kimi Code: /setup → kimi-code-plan-cn, or baseURL https://api.kimi.com/coding, model kimi-for-coding.')
        : (zh ? '运行 /setup 配置模型服务。' : 'Run /setup to configure a model service.');
      ui.print(tui.color(tui.theme.inactive, hint));
    } else {
      ui.print(zh
        ? '未配置模型服务。运行 cowcat setup 进行配置，或设置环境变量 COWCAT_BASE_URL / COWCAT_API_KEY / COWCAT_MODEL。'
        : 'No model service configured. Run `cowcat setup`, or set COWCAT_BASE_URL / COWCAT_API_KEY / COWCAT_MODEL.');
      if (config.provider === 'anthropic' && config.baseURL === 'https://api.anthropic.com') {
        ui.print(zh
          ? 'Kimi Code 推荐：baseURL 用 https://api.kimi.com/coding，model 用 kimi-for-coding。'
          : 'Kimi Code users: baseURL https://api.kimi.com/coding, model kimi-for-coding.');
      }
      ui.print(zh ? '现在可以输入问题试试（会失败），或 /exit 退出。' : 'You can type a question now (it will fail), or /exit.');
    }
  }

  const runTurn = async (userText, { onText = undefined, events: eventsOverride = null, maxTurns = null } = {}) => {
    ui.setLang(detectLang(userText));
    if (baseCtx.hooks) await fireHooks(baseCtx.hooks, 'UserPromptSubmit', hookPayload('UserPromptSubmit', { prompt: userText }, baseCtx.hooks), { log: (m) => ui.print(m) }).catch(() => {});
    const userMsg = { role: 'user', content: userText };
    messages.push(userMsg);
    session.append({ type: 'user', message: userMsg });
    currentAbort = new AbortController();
    const res = await runLoop({
      provider, registry, system, messages, ctx: baseCtx, ui, permissions, config,
      // print mode must not stream: the final answer is printed exactly once below
      onText: onText !== undefined ? onText : (opts.print ? null : (d) => ui.streamChunk(d)),
      onThinking: (onText !== undefined || opts.print) ? null : (d) => ui.thinkingChunk?.(d),
      // live tool-call formation is TUI-only; print/line modes keep today's flow
      onToolDelta: (onText !== undefined || opts.print) ? null : (d) => ui.toolCallDelta?.(d),
      events: eventsOverride ?? events,
      maxIterations: maxTurns || undefined,
      signal: currentAbort.signal,
    });
    currentAbort = null;
    if (res.diffs?.length) sessionState.lastDiffs = res.diffs;
    for (const d of res.diffs || []) ideSink.emit({ type: 'file_edited', file: d.path, added: d.added, removed: d.removed });
    if (res.lastBash) sessionState.lastBash = res.lastBash;
    if (baseCtx.hooks) await fireHooks(baseCtx.hooks, 'Stop', hookPayload('Stop', { iterations: res.iterations }, baseCtx.hooks), { log: (m) => ui.print(m) }).catch(() => {});
    turnCount++;
    const u = res.usage;
    usageTotals.input += u.input || 0;
    usageTotals.output += u.output || 0;
    usageTotals.cache_read += u.cache_read || 0;
    usageTotals.cache_creation += u.cache_creation || 0;
    sessionState.toolCalls = (sessionState.toolCalls || 0) + (res.toolCalls || 0);
    // collapsed thinking summary for this turn (expand with /thinking) —
    // every assistant message the turn produced, not just the last one.
    // The turn's root user message has string content (tool_result messages
    // are role:user too, but always carry array content).
    let rootIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && !Array.isArray(messages[i].content)) { rootIdx = i; break; }
    }
    for (const blk of thinkingBlocksOf(rootIdx >= 0 ? messages.slice(rootIdx + 1) : [])) {
      ui.print(renderThinkingCard(blk, { expanded: false, colors: ui.colors }));
    }
    return res;
  };

  const sessionState = { lastDiffs: [], lastBash: null };
  const sessionStart = Date.now();
  let turnCount = 0;
  let usageTotals = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };

  if (opts.prompt) {
    // try/finally: every return path below (max-turns overrun, schema failure,
    // plain done) must run the child-process cleanup. Without it an exec()
    // child started via run_in_background keeps the event loop alive and the
    // process hangs until the task's own timeout — a silent CI hang.
    try {
      const streamJson = opts.print && opts.outputFormat === 'stream-json';
      // Scheduled jobs fire in one-shot mode too: a CI/cron runner has no REPL,
      // so without this the only place a job could ever fire was an interactive
      // session. Each job runs as a turn BEFORE the user prompt; turns are
      // silent here (no streaming, no final-text print — that happens once
      // below), and the banner goes to stderr so stdout stays the answer.
      const dueCrons = takeDueCrons(new Date(), { sessionId: session.id });
      for (const job of dueCrons) {
        process.stderr.write(`[cron] firing ${job.id}\n`);
        await runTurn(job.prompt);
      }
      let res;
      if (streamJson) {
        // pure NDJSON event stream: no onboarding, no decorations
        writeEvent(process.stdout, { type: 'system', version: PKG_VERSION, provider: config.provider, model: config.model, cwd });
        res = await runTurn(opts.prompt, {
          onText: (d) => writeEvent(process.stdout, { type: 'assistant', delta: d }),
          events: {
            onToolStart: (name, input) => writeEvent(process.stdout, { type: 'tool_use', name, input }),
            onToolResult: (name, r) => writeEvent(process.stdout, { type: 'tool_result', name, content: String(r.content).slice(0, 2000), is_error: !!r.is_error }),
          },
          maxTurns: opts.maxTurns || null,
        });
        writeEvent(process.stdout, { type: 'result', text: res.finalText, usage: res.usage, turns: res.iterations });
      } else {
        res = await runTurn(opts.prompt, { maxTurns: opts.maxTurns || null });
        if (opts.print) console.log(res.finalText);
      }
      // --max-turns overrun
      if (opts.maxTurns && res.iterations >= opts.maxTurns && /^\[stopped/.test(res.finalText)) {
        if (streamJson) writeEvent(process.stdout, { type: 'error', message: 'max turns reached' });
        process.exitCode = 4;
        return;
      }
      if (opts.print && res.denials > 0) process.exitCode = 2; // permission-blocked in non-interactive mode
      if (process.env.COWCAT_BG_ID) {
        finishBackgroundRun(process.env.COWCAT_BG_ID, { finalText: res.finalText, exitCode: process.exitCode ?? 0, usage: res.usage });
        if (process.env.COWCAT_NOTIFY_ON_DONE) {
          await notify(process.exitCode ? 'CowCat 任务失败' : 'CowCat 任务完成', res.finalText.slice(0, 120));
        }
      }
      // --output-schema: validate; retry once with errors fed back; exit 3 on failure
      if (opts.outputSchema) {
        let schema;
        try { schema = JSON.parse(opts.outputSchema); } catch (e) {
          console.error(`invalid --output-schema: ${e.message}`);
          process.exitCode = 3;
          return;
        }
        const run = (txt) => {
          const { value } = extractJson(txt);
          return value === null
            ? { ok: false, errors: ['回答中未找到完整 JSON'] }
            : validateSchema(schema, value);
        };
        let check = run(res.finalText);
        let finalValue = extractJson(res.finalText).value;
        if (!check.ok) {
          const retryPrompt = `Your previous answer failed validation:\n${check.errors.join('\n')}\nRewrite the answer to match this JSON Schema, outputting only the JSON value:\n${opts.outputSchema}`;
          const res2 = await runTurn(retryPrompt, { maxTurns: opts.maxTurns || null });
          check = run(res2.finalText);
          if (check.ok) {
            finalValue = extractJson(res2.finalText).value;
            res.finalText = JSON.stringify(finalValue);
            if (streamJson) writeEvent(process.stdout, { type: 'result', text: res.finalText, retried: true });
          } else {
            if (streamJson) writeEvent(process.stdout, { type: 'error', message: `schema validation failed: ${check.errors.join('; ')}` });
            else console.error(`schema validation failed: ${check.errors.join('; ')}`);
            process.exitCode = 3;
            return;
          }
        }
        if (opts.print && !streamJson) console.log(JSON.stringify(finalValue, null, 2));
      }
      return;
    } finally {
      shutdown?.();
    }
  }

  while (true) {
    // TUI: open the composer BEFORE the cron sweep. Printable keys only reach
    // the editor while a read is active (tui/ui.js _handleKey default branch),
    // so anything typed during a scheduled turn was dropped — and the
    // readLine() that followed reset the editor on top of that. Line mode keeps
    // prompt-then-read order: the TTY input queue buffers keystrokes anyway.
    const queuedInput = tui ? ui.readLine() : null;
    // Cron / wakeup scheduling: while the REPL is idle (before each prompt),
    // fire any due scheduled prompts as new user turns. Recurring jobs re-arm
    // to their next fire time; one-shots (incl. ScheduleWakeup) are removed.
    // Session-scoped: a cron created in another session stays armed there
    // instead of firing as a user turn inside this one.
    try {
      const due = takeDueCrons(new Date(), { sessionId: session.id });
      for (const job of due) {
        ui.print(`[cron] firing ${job.id}`);
        await runTurn(job.prompt);
      }
    } catch (e) {
      ui.print(`cron check failed: ${e.message}`);
    }
    let rawLine;
    if (queuedInput) {
      rawLine = await queuedInput;
    } else {
      ui.output.write(ui.colors ? '\x1b[1mcowcat>\x1b[0m ' : 'cowcat> '); // the TUI composer is the prompt
      rawLine = await ui.readLine();
    }
    if (rawLine === null) break; // stdin EOF — shut down cleanly
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('/')) {
      const [cmd, ...args] = line.slice(1).split(/\s+/);
      if (cmd === 'exit' || cmd === 'quit') break;
      else if (cmd === 'clear') { messages.length = 0; ui.print('[conversation cleared]'); }
      else if (cmd === 'compact') {
        ui.compacting();
        const result = await compactConversation({
          provider, messages, sessionFile: session.file, countTokens: provider.countTokens?.bind(provider),
          model: config.smallModel || null, customInstruction: args.join(' ') || null,
        });
        messages.splice(0, messages.length, ...result.messages);
        session.append({ type: 'compact_boundary', summary: result.boundarySummary });
        session.append({ type: 'compacted', count: result.compactedCount });
        ui.print('[compacted]');
      } else if (cmd === 'model') {
        if (!args[0]) {
          ui.print(`current model: ${displayModel(config)} (${config.provider}/${config.model})`);
        } else {
          const prevModel = config.model;
          const prevRef = config.modelRef;
          config.model = args[0];
          try {
            resolveModelConfig(config);
            ui.print(`model set to ${displayModel(config)} (${config.provider}/${config.model})`);
          } catch (e) {
            config.model = prevModel;
            config.modelRef = prevRef;
            ui.print(`✗ ${e.message}`);
          }
        }
        refreshStatus();
      } else if (cmd === 'plan') {
        permissions.setMode('plan');
        ui.print(ui.lang === 'zh' ? '[Plan] 只看不拆。拆墙请 /act。' : '[Plan] look, dont touch. /act to swing the hammer.');
        refreshStatus();
      } else if (cmd === 'act') {
        if (restricted) {
          // Untrusted folder: /act is a session-scoped trust decision.
          const a = ((await ui.ask(ui.lang === 'zh' ? 'Trust this folder for this session? [y/N] ' : 'Trust this folder for this session? [y/N] ')) ?? '').trim().toLowerCase();
          if (a === 'y' || a === 'yes') {
            restricted = false;
            permissions.setMode('default');
            ui.print(ui.lang === 'zh' ? '[Act] 仅本次会话放行。' : '[Act] unblocked for this session only.');
          } else {
            ui.print(ui.lang === 'zh' ? '仍然只读。' : 'Still read-only.');
          }
        } else {
          permissions.setMode('default');
          ui.print(ui.lang === 'zh' ? '[Act] 放我出去。' : '[Act] unleashed.');
        }
        refreshStatus();
      } else if (cmd === 'setup') {
        const saved = await runSetup(ui);
        if (!saved) { refreshStatus(); continue; }
        // new-schema results replace the legacy flat endpoint fields outright
        // (otherwise the startup env values would override the fresh key)
        if (saved.providers) {
          delete config.provider;
          delete config.baseURL;
          delete config.apiKey;
        }
        Object.assign(config, saved);
        try { resolveModelConfig(config); } catch (e) { ui.print(`✗ ${e.message}`); }
        applyRules();
        provider = await createProvider(config);
        provider.setSessionId?.(session.id);
        spawnAgent = createSubagentRunner({ provider, registry, config, ui, cwd });
        baseCtx.spawnAgent = spawnAgent;
        const { items, ok } = await runDoctorChecks(config, {
          hasConfigFile: true,
          ping: providerPing(provider, config.provider),
        });
        for (const it of items) ui.print(`  ${it.ok ? '✓' : '✗'} ${it.name}${it.detail ? ` — ${it.detail}` : ''}`);
        ui.print(ok ? '全部通过。新配置已生效。' : '配置已保存，但检查未全过——看上面的 ✗。');
        refreshStatus();
      } else if (cmd === 'cost') {
        ui.print(formatCostReport({
          model: config.model, turns: turnCount, toolCalls: sessionState.toolCalls || 0,
          usage: usageTotals, startedAt: sessionStart,
        }));
      } else if (cmd === 'status') {
        const ctxUse = contextUsage(messages, contextLimit(config));
        ui.print(formatStatus({
          version: PKG_VERSION, provider: config.provider, baseURL: config.baseURL,
          model: config.apiKey ? displayModel(config) : (ui.lang === 'zh' ? '未配置' : 'not configured'),
          mode: permissions.mode + (restricted ? ' (restricted)' : ''),
          trusted: isTrustedProject(config, cwd),
          restricted,
          contextUsed: ctxUse.used, contextMax: ctxUse.max, startedAt: sessionStart,
        }));
      } else if (cmd === 'export') {
        const target = args[0] ? resolve(cwd, args[0]) : join(cwd, `cowcat-session-${session.id}.md`);
        let decision = 'y';
        if (!permissions.check('Write', { file_path: target })) {
          decision = await ui.approve('Write', target, {});
        }
        if (decision === 'y' || decision === 'yes') {
          const md = exportSessionToMarkdown(session.file);
          writeFileSync(target, md);
          ui.print(`✓ ${ui.lang === 'zh' ? '已导出' : 'exported'} ${target}`);
        }
      } else if (cmd === 'fork') {
        const fork = forkSessionFile(session, args[0] || null);
        session.id = fork.id;
        session.file = fork.file;
        provider.setSessionId?.(session.id);
        ui.print(ui.lang === 'zh' ? `已分叉，后续对话写入新会话：${fork.file}` : `Forked — future turns write to: ${fork.file}`);
      } else if (cmd === 'todos') {
        if (state.todos?.length) ui.showTodos(state.todos);
        else ui.print(ui.lang === 'zh' ? 'todo 列表是空的。' : 'Todo list is empty.');
      } else if (cmd === 'panel') {
        if (tui) {
          // single persistence path: togglePanel() reports the outcome through
          // onTogglePanel, which mirrors it into state.json
          tui.togglePanel();
        } else {
          ui.print(ui.lang === 'zh' ? '面板只在 TUI 模式下可用。' : 'The panel is only available in TUI mode.');
        }
      } else if (cmd === 'sandbox') {
        const arg = (args[0] || '').toLowerCase();
        const cur = config.sandbox === 'off' ? 'off' : 'light';
        if (arg === 'off' || arg === 'light') {
          config.sandbox = arg; // live: the next Bash run and card title pick it up
          writeState((s) => { s.sandbox = arg; return s; });
          ui.print(ui.lang === 'zh'
            ? `sandbox: ${arg}（${arg === 'off' ? '环境变量不再脱敏，危险命令改走审批流' : '轻量护栏：脱敏环境变量 + 静态分级 + 审计日志'}）`
            : `sandbox: ${arg} (${arg === 'off' ? 'env no longer sanitized; dangerous commands go through approval' : 'light guard rail: sanitized env + static triage + audit log'})`);
        } else {
          ui.print(`sandbox: ${cur} — usage: /sandbox off|light`);
        }
      } else if (cmd === 'theme') {
        const want = args[0] === 'l' || args[0] === 'light' ? 'light' : (args[0] === 'd' || args[0] === 'dark' ? 'dark' : null);
        if (!want) { ui.print('usage: /theme <dark|light>'); continue; }
        ui.setTheme(want);
        persistTheme(want);
        ui.print(`theme: ${want}`);
        refreshStatus();
      } else if (cmd === 'memory') {
        if (args[0] === 'add') {
          const line = args.slice(1).join(' ').trim();
          if (!line) { ui.print('usage: /memory add <一行文字>'); continue; }
          const target = memoryPathFor('project', cwd);
          let decision = 'y';
          if (!permissions.check('Write', { file_path: target })) {
            decision = await ui.approve('Write', target, {});
          }
          if (decision === 'y' || decision === 'yes') {
            appendMemory(target, `- ${line}`);
            ui.print(`✓ ${ui.lang === 'zh' ? '已追加到' : 'appended to'} ${target}`);
          }
          continue;
        }
        // no args: pick a scope, ensure the file exists, print path + contents
        const scope = (((await ui.ask(ui.lang === 'zh' ? '哪个层级？[user/project] (project): ' : 'Which scope? [user/project] (project): ')) ?? '').trim() || 'project') === 'user' ? 'user' : 'project';
        const file = memoryPathFor(scope, cwd);
        const created = ensureMemoryFile(file);
        ui.print(`${created ? (ui.lang === 'zh' ? '已创建（含模板说明）: ' : 'created (with template): ') : ''}${file}`);
        ui.print('---');
        ui.print(readFileSync(file, 'utf8').trim());
        ui.print('---');
        ui.print(ui.lang === 'zh' ? '用外部编辑器修改后重启生效；或 /memory add <一行> 快速追加。' : 'Edit with your own editor; restart to reload, or /memory add <line>.');
      } else if (cmd === 'permissions') {
        const col = args[0];
        if (col === 'add') {
          const column = args[1];
          const ruleStr = args.slice(2).join(' ').trim();
          if (!['allow', 'deny', 'ask'].includes(column) || !ruleStr) { ui.print('usage: /permissions add <allow|deny|ask> <规则>'); continue; }
          const { rule, error } = validateRule(ruleStr, knownToolNames());
          if (!rule) { ui.print(`✗ ${error}`); continue; }
          const current = (config.permissions?.[column]) || [];
          current.push(ruleStr);
          saveRuleColumn(column, current);
          applyRules();
          ui.print(`✓ ${column}: ${ruleStr}`);
        } else if (col === 'remove') {
          const column = args[1];
          const idx = parseInt(args[2], 10);
          if (!['allow', 'deny', 'ask'].includes(column) || !Number.isInteger(idx)) { ui.print('usage: /permissions remove <allow|deny|ask> <序号>'); continue; }
          const current = (config.permissions?.[column]) || [];
          if (idx < 1 || idx > current.length) { ui.print(ui.lang === 'zh' ? '序号超出范围。' : 'Index out of range.'); continue; }
          const removed = current.splice(idx - 1, 1)[0];
          saveRuleColumn(column, current);
          applyRules();
          ui.print(`✓ removed: ${removed}`);
        } else {
          for (const column of ['allow', 'deny', 'ask']) {
            const rules = (config.permissions?.[column]) || [];
            ui.print(`${column}:`);
            if (!rules.length) ui.print(`  (${ui.lang === 'zh' ? '空' : 'none'})`);
            rules.forEach((r, i) => ui.print(`  ${i + 1}. ${r}`));
          }
          ui.print(ui.lang === 'zh'
            ? '语法: Tool 或 Tool(模式)；模式以 :* 结尾为前缀匹配（如 Bash(npm run test:*)）。优先级 deny > ask > allow；yolo 模式下规则不生效。'
            : 'Syntax: Tool or Tool(pattern); a trailing :* is a prefix match (e.g. Bash(npm run test:*)). Priority deny > ask > allow; rules never apply in yolo mode.');
        }
      } else if (cmd === 'hooks') {
        const sub = args[0];
        if (sub === 'test') {
          const ev = args[1];
          if (!HOOK_EVENTS.includes(ev)) { ui.print(`events: ${HOOK_EVENTS.join(', ')}`); continue; }
          const payload = hookPayload(ev, ev === 'PreToolUse' ? { tool: 'Bash', input: { command: 'example' } } : { note: 'manual test' }, baseCtx.hooks);
          ui.print(JSON.stringify(payload, null, 2));
          const r = await fireHooks(baseCtx.hooks, ev, payload, { blocking: ev === 'PreToolUse', log: (m) => ui.print(m) });
          ui.print(r.denied ? `✗ denied: ${r.reason}` : '✓ allowed (see log lines above)');
        } else if (sub === 'disable' || sub === 'enable') {
          const ev = args[1];
          const idx = parseInt(args[2], 10);
          if (!HOOK_EVENTS.includes(ev) || !Number.isInteger(idx)) { ui.print(`usage: /hooks ${sub} <事件> <序号>`); continue; }
          const target = updateHooksConfig((cfg) => {
            const h = cfg.hooks?.[ev]?.[idx - 1];
            if (h) h.enabled = sub === 'enable';
            return cfg;
          });
          Object.assign(config, target);
          baseCtx.hooks = { ...loadHooks(config), sessionFile: session.file, cwd };
          ui.print(`✓ ${ev}[${idx}] ${sub === 'enable' ? 'enabled' : 'disabled'}`);
        } else {
          let any = false;
          for (const ev of HOOK_EVENTS) {
            const list = (config.hooks?.[ev]) || [];
            if (!list.length) continue;
            any = true;
            ui.print(`${ev}:`);
            list.forEach((h, i) => ui.print(`  ${i + 1}. [${h.enabled === false ? 'disabled' : 'on '}] ${h.type}: ${h.command || h.url}`));
          }
          if (!any) ui.print(ui.lang === 'zh' ? '没有配置 hooks。写在 ~/.cowcat/config.json 的 hooks 字段。' : 'No hooks configured — add them under "hooks" in ~/.cowcat/config.json.');
        }
      } else if (cmd === 'mcp') {
        if (args[0] === 'reconnect') {
          if (!args[1]) { ui.print('usage: /mcp reconnect <名>'); continue; }
          mcpClients.get(args[1])?.stop();
          mcpClients.delete(args[1]);
          // drop the adapters bound to the stopped client first: re-registering
          // would otherwise leave entries pointing at the dead transport when
          // the reconnect fails
          for (const t of registry.list()) {
            if (t.name.startsWith(`mcp__${args[1]}__`)) registry.unregister(t.name);
          }
          await connectMcp(args[1]);
        } else {
          if (!mcpResults.length) { ui.print(ui.lang === 'zh' ? '没有配置 MCP servers。写在 ~/.cowcat/mcp.json 或项目 .cowcat/mcp.json。' : 'No MCP servers configured (~/.cowcat/mcp.json or project .cowcat/mcp.json).'); continue; }
          for (const r of mcpResults) {
            ui.print(`  ${r.ok ? '✓' : '✗'} ${r.name} — ${r.ok ? `${r.tools.length} tool(s)` : r.error}`);
          }
        }
      } else if (cmd === 'rewind') {
        const cps = listCheckpoints(baseCtx);
        if (!cps.length) { ui.print(ui.lang === 'zh' ? '这个会话还没有检查点。先让它拆点什么。' : 'No checkpoints in this session yet.'); continue; }
        cps.forEach((cp, i) => ui.print(`  ${i + 1}. ${checkpointSummaryLine(cp)}`));
        const pick = parseInt(((await ui.ask(ui.lang === 'zh' ? '回滚到第几个？ [编号]: ' : 'Rewind to which? [number]: ')) ?? '').trim(), 10);
        const cp = cps[pick - 1];
        if (!cp || !cp.record) { ui.print(ui.lang === 'zh' ? '编号无效。' : 'Invalid pick.'); continue; }
        ui.print(ui.lang === 'zh' ? '将恢复：' : 'Will restore:');
        cp.record.files.forEach((f) => ui.print(`  ${f.path}`));
        let decision = 'y';
        if (!permissions.check('Write', { file_path: cp.record.files[0]?.path || cwd })) {
          decision = await ui.approve('Write', ui.lang === 'zh' ? `rewind 到 #${cp.id}` : `rewind to #${cp.id}`, {});
        }
        if (decision === 'y' || decision === 'yes') {
          restoreCheckpoint(baseCtx, cp.id);
          // Roll the conversation back to just before the checkpoint record.
          messages.splice(0, messages.length, ...Session.load(session.file, { upToCheckpointId: cp.id }));
          ui.print(ui.lang === 'zh' ? `已回滚到 #${cp.id}，文件和对话都回去了。` : `Rewound to #${cp.id} — files and conversation rolled back.`);
        } else {
          ui.print(ui.lang === 'zh' ? '行吧，墙保持原样。' : 'Fine — the wall stays as is.');
        }
      } else if (cmd === 'help') {
        ui.print('/init /setup /memory [add] /permissions [add|remove] /sandbox <off|light> /hooks [test|disable|enable] /mcp [reconnect] /rewind /compact [指令] /context /thinking /cost /status /export [f] /fork [名] /todos /tasks [kill] /agents /skills /theme <d|l> /model <名> /plan /act /panel /diff /output /clear /exit');
        if (Object.keys(custom.commands).length) {
          ui.print(ui.lang === 'zh' ? '自定义命令:' : 'Custom commands:');
          for (const l of customHelpLines(custom.commands)) ui.print(l);
        }
      }
      else if (cmd === 'diff') {
        if (!sessionState.lastDiffs.length) { ui.print(ui.t.noDiff); continue; }
        for (const d of sessionState.lastDiffs) {
          const { renderFileCard } = await import('../src/diffcard.js');
          for (const l of renderFileCard(d, { colors: ui.colors, maxLines: Number.MAX_SAFE_INTEGER })) ui.print(l);
        }
      } else if (cmd === 'output') {
        if (!sessionState.lastBash) { ui.print(ui.t.noOutput); continue; }
        ui.print(sessionState.lastBash.output);
      } else if (cmd === 'init') {
        ui.print(ui.lang === 'zh' ? '探索项目中，起草 COWCAT.md…' : 'Exploring the project to draft COWCAT.md…');
        const draft = await generateCowcatMd({ provider, registry, config, ui, cwd });
        ui.print('--- COWCAT.md (draft) ---');
        ui.print(draft);
        ui.print('--- end ---');
        const target = join(cwd, 'COWCAT.md');
        let decision = 'y';
        if (!permissions.check('Write', { file_path: target })) {
          decision = await ui.approve('Write', target, {});
        } else {
          decision = ((await ui.ask(ui.lang === 'zh' ? '写入 COWCAT.md？[y/n] ' : 'Write COWCAT.md? [y/n] ')) ?? '').trim().toLowerCase();
        }
        if (decision === 'y' || decision === 'yes') {
          if (existsSync(target)) baseCtx.readSet.add(target); // Write requires prior read for overwrites
          const res = await WriteTool.execute({ file_path: target, content: draft }, baseCtx);
          ui.print(res.ok ? `✓ ${res.output}` : `✗ ${res.error}`);
        } else {
          ui.print(ui.lang === 'zh' ? '行吧，草稿没写。（眼睛还盯着那面墙）' : 'Fine, draft stays on the floor. (eyes still on that wall)');
        }
      } else if (cmd === 'output-style') {
        const styles = outputStyles.styles;
        if (!args[0]) {
          for (const [name, def] of Object.entries(styles)) {
            ui.print(`  ${name === activeStyleName ? '* ' : '  '}${name} — ${def.description}`);
          }
          if (!Object.keys(styles).length) ui.print(ui.lang === 'zh' ? '没有可用的 output styles。' : 'No output styles loaded.');
          ui.print(ui.lang === 'zh' ? '用法: /output-style <名> 切换（下一个 turn 生效）' : 'usage: /output-style <name> to switch (next turn)');
        } else if (styles[args[0]]) {
          activeStyle = styles[args[0]];
          activeStyleName = args[0];
          ui.print(ui.lang === 'zh'
            ? `output-style: ${args[0]}（下一个 turn 注入 system prompt）`
            : `output-style: ${args[0]} (active from the next turn)`);
        } else {
          ui.print(ui.lang === 'zh' ? `未知样式 "${args[0]}"。` : `Unknown style "${args[0]}".`);
        }
      } else if (cmd === 'statusline') {
        if (args[0] === 'clear') {
          saveStatusLine(null);
          delete config.statusLine;
          statusExtra = '';
          ui.print(ui.lang === 'zh' ? '已恢复默认状态栏。' : 'Statusline cleared.');
          refreshStatus();
        } else if (args[0] === 'set') {
          const cmdLine = args.slice(1).join(' ').trim();
          if (!cmdLine) { ui.print('usage: /statusline set <命令>'); continue; }
          saveStatusLine(cmdLine);
          config.statusLine = { command: cmdLine };
          await refreshStatusLine();
          ui.print(`✓ statusline: ${cmdLine}`);
        } else {
          ui.print(config.statusLine?.command
            ? `statusline: ${config.statusLine.command}${statusExtra ? `  (now showing: ${statusExtra})` : ''}`
            : (ui.lang === 'zh' ? '未设置 statusline。用法: /statusline set <命令> 或 /statusline clear' : 'No statusline set. usage: /statusline set <command> | /statusline clear'));
        }
      } else if (cmd === 'context') {
        const analysis = analyzeContext(messages, config.maxContextTokens, { systemBlocks: system() });
        for (const l of renderContextReport(analysis, { colors: ui.colors })) ui.print(l);
      } else if (cmd === 'thinking') {
        const blocks = thinkingBlocksOf(messages.slice(-4));
        if (!blocks.length) { ui.print(ui.lang === 'zh' ? '最近没有思考链。' : 'No thinking in the recent turns.'); continue; }
        for (const blk of blocks) ui.print(renderThinkingCard(blk, { expanded: true, colors: ui.colors }));
      } else if (cmd === 'ide') {
        for (const l of ideStatus(ideSink)) ui.print(l);
      } else if (cmd === 'worktree') {
        if (!isGitRepo(cwd)) { ui.print(ui.lang === 'zh' ? '当前目录不是 git 仓库。' : 'Not a git repository.'); continue; }
        if (args[0] === 'list') {
          for (const w of listWorktrees(cwd)) ui.print(`  ${w.path}${w.branch ? `  (${w.branch})` : ''}`);
          continue;
        }
        try {
          const wt = createWorktree(cwd, args[0] || null);
          baseCtx.cwd = wt.path;
          session.append({ type: 'meta', note: `worktree:${wt.path}` });
          ui.print(`${ui.lang === 'zh' ? '已切入 worktree' : 'Switched to worktree'}: ${wt.path} (${wt.branch})`);
          ui.print(ui.lang === 'zh' ? '本会话后续工具调用都在此目录执行。/exit 不会删除它。' : 'All later tool calls run here. /exit does not remove it.');
        } catch (e) {
          ui.print(`✗ ${e.message}`);
        }
      } else if (cmd === 'agents') {
        const { BUILTIN_ROLES } = await import('../src/prompts/subagents.js');
        ui.print(ui.lang === 'zh' ? '内建角色:' : 'Builtin roles:');
        for (const [name, def] of Object.entries(BUILTIN_ROLES)) {
          ui.print(`  ${name} — ${def.description} (${def.tools ? def.tools.length + ' tools' : 'all tools'})`);
        }
        if (Object.keys(custom.agents).length) {
          ui.print(ui.lang === 'zh' ? '自定义角色:' : 'Custom roles:');
          for (const [name, def] of Object.entries(custom.agents)) {
            ui.print(`  ${name} — ${def.description}${def.tools ? ` (${def.tools})` : ''}${def.model ? ` [model: ${def.model}]` : ''}`);
          }
        }
      } else if (cmd === 'skills') {
        if (!Object.keys(custom.skills).length) { ui.print(ui.lang === 'zh' ? '没有加载任何 skills。' : 'No skills loaded.'); continue; }
        for (const [name, def] of Object.entries(custom.skills)) ui.print(`  ${name} — ${def.description || '(no description)'}`);
        ui.print(ui.lang === 'zh' ? '用法：Agent 工具传 skill 参数。' : 'Use via the Agent tool\'s skill parameter.');
      } else if (cmd === 'tasks') {
        if (args[0] === 'kill') {
          const task = background.stop(args[1]);
          ui.print(task ? `✓ killed ${args[1]}` : `unknown task: ${args[1]}`);
          continue;
        }
        const tasks = background.list();
        if (!tasks.length) { ui.print(ui.lang === 'zh' ? '没有活动任务。' : 'No background tasks.'); continue; }
        for (const t of tasks) {
          const secs = ((Date.now() - t.startedAt) / 1000).toFixed(0);
          ui.print(`  ${t.id}  ${t.done ? `exit ${t.exitCode}` : 'running'}  ${secs}s  ${t.command.slice(0, 60)}`);
        }
      } else if (custom.commands[cmd]) {
        await runTurn(expandCommand(custom.commands[cmd], args.join(' ')));
      }
      else ui.print(`unknown command: /${cmd}`);
      continue;
    }
    try {
      ui.userMessage(line); // TUI bubble + turn clock; no-op in line mode
      await runTurn(line);
    } catch (e) {
      if (e instanceof ConfigError) { ui.print(`Config error: ${e.message}`); }
      else if (tui && typeof tui.apiError === 'function') { tui.apiError(e); }
      else {
        // line mode: readable summary + actionable hint, raw detail on its own line
        const p = formatApiErrorLines(parseApiError(e), { lang: ui.lang ?? 'zh' });
        ui.print(p.lines.join('\n'));
        if (p.raw && p.raw !== p.summary) ui.print(p.raw.split('\n').slice(0, 10).join('\n'));
      }
    }
  }
  if (baseCtx.hooks) await fireHooks(baseCtx.hooks, 'SessionEnd', hookPayload('SessionEnd', { turns: turnCount }, baseCtx.hooks), { log: (m) => ui.print(m) }).catch(() => {});
  if (tui) tui.close();
  mcpCleanup();
  background.killAll();
  ui.close(); // drop stdin listeners so the process can actually exit
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? `Config error: ${e.message}` : e);
  process.exitCode = 1;
});
