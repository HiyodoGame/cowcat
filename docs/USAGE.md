# CowCat 使用说明

CowCat 是一个跑在你自己终端里的 CLI 编程 Agent（国产模型适配的 Claude Code 代替版）。零运行时依赖，Node >= 20。

## 安装与全局启动

```bash
# 方式一：把 <repo>/bin 加入 PATH（shim 用脚本自身位置解析路径，仓库放哪都行）
export PATH="<repo>/bin:$PATH"
cowcat --version

# 方式二：npm link（agent/ 自带 bin 字段）
cd agent && npm link
```

Windows 下 `bin/cowcat.cmd` 提供同款入口。

## 配置

```bash
cowcat setup     # 交互向导：provider / baseURL / apiKey（不回显）/ model，写入 ~/.cowcat/config.json
cowcat doctor    # 逐项 ✓/✗ 检查配置完整性 + count_tokens 连通性探测
```

也可用环境变量（`COWCAT_*` 优先，过渡期 `CC_*` 仍有效）：`COWCAT_PROVIDER`、`COWCAT_BASE_URL`、`COWCAT_API_KEY`、`COWCAT_MODEL`、`COWCAT_MAX_TOKENS`、`COWCAT_CACHE=off`。未配置 API key 时交互启动会跳过连通性探针并打印配置引导（状态栏显示"未配置"）。

Kimi Code 端点：`COWCAT_PROVIDER=anthropic COWCAT_BASE_URL=https://api.kimi.com/coding COWCAT_MODEL=kimi-for-coding`。

## 日常使用

```bash
cowcat                          # 交互 REPL
cowcat "阅读 src/index.js 并说明它做了什么"   # 一次性任务（--print 直接打印结果）
cowcat -p "..."                 # 非交互打印模式：审批自动拒绝（绝不等待 stdin），权限受阻退出码 2
cowcat -y "..."                 # 自动批准所有工具（谨慎）
cowcat -c                       # 恢复本项目最近一次会话（--continue）
cowcat --resume                 # 列出本项目全部会话，输入编号恢复
cowcat --resume <file.jsonl>    # 恢复指定会话文件
```

- 会话保存在 `~/.cowcat/projects/<项目slug>/<时间戳>.jsonl`，文件头部记录 cwd。
- 启动时自动从 cwd 向上查找 `COWCAT.md` → `AGENTS.md` → `CLAUDE.md`（第一个命中），作为项目指令注入 system prompt。
- 内置 11 个工具：Read / Edit / Write / Glob / Grep / Bash / TodoWrite / AskUserQuestion / Agent / **WebFetch**（抓 URL，HTML 转可读文本）/ **WebSearch**（DuckDuckGo 免费搜索，支持域名过滤）。

## REPL 斜杠命令

| 命令 | 作用 |
|---|---|
| `/init` | 用一次只读 LLM 调用探索项目并起草 COWCAT.md，确认后写入 cwd |
| `/setup` | 就地重跑配置向导并热生效（下一次对话即用新 key/模型，无需重启） |
| `/rewind` | 列出文件检查点（Edit/Write 前自动快照），确认后回滚代码+对话 |
| `/compact [指令]` | 压缩上下文；可带自定义压缩指令透传给 summarizer |
| `/cost` | 本会话统计：轮数/工具数/真实 usage 累计（input/output/cache 分开）+ 额度消耗参考（估算） |
| `/status` | 版本/provider/脱敏 baseURL/模型/权限模式/信任状态/上下文占用% |
| `/export [文件]` | 会话导出为可读 markdown（走审批） |
| `/fork [名称]` | 会话分叉：复制 session 为新会话，原会话不受影响 |
| `/todos` | 查看当前 todo 列表 |
| `/theme dark\|light` | 切换 ANSI 配色，立即生效并持久化 |
| `/plan` / `/act` | Plan（只读探索+出计划）与 Act（执行）模式切换 |
| `/diff` | 展开本回合各文件的完整 diff |
| `/output` | 查看最近一次 Bash 的完整输出 |
| `/model <名>` | 切换模型 |
| `/clear` / `/exit` | 清会话 / 退出 |

审批提示支持 `y` / `n` / `always`（always 记住同类操作）。危险命令会高亮警告。

## 记忆系统

启动时自动把以下来源注入 system prompt（标注 `# Memory (<层级>: <路径>)`，同一文件只注入一次）：

- **user 级**：`~/.cowcat/CLAUDE.md`
- **项目级**（从 cwd 向上逐级，止于 home/盘符根）：`CLAUDE.md`、`.cowcat/CLAUDE.md`、`.cowcat/rules/*.md`（多文件按文件名排序）
- 既有项目指令（`COWCAT.md` → `AGENTS.md` → `CLAUDE.md` 首个命中）保留，与新体系合并去重

规则：单文件超 10000 字符截断；文件不存在一律跳过、不自动创建；`COWCAT_DISABLE_MEMORY=1` 跳过全部记忆加载。`/memory` 交互选择层级并打印路径+内容（文件不存在则创建带模板头的文件，用外部编辑器编辑）；`/memory add <一行文字>` 直接追加到 project 级（走审批）。

## 权限规则

`~/.cowcat/config.json` 的 `permissions: { allow: [], deny: [], ask: [] }` 配置持久规则，语法：

```
Bash                    # 整个工具
Bash(npm run test)      # 命令精确匹配
Bash(npm run test:*)    # 前缀匹配（边界为空格/冒号/斜杠，也命中裸命令）
Edit(src/**)            # 路径工具支持 glob
```

优先级 **deny > ask > allow > 默认行为**；**yolo 模式下规则不生效**。加载时逐条校验，坏规则跳过并中文告警（带第几条与原因），不阻断启动。`/permissions` 查看三列与语法；`/permissions add <allow|deny|ask> <规则>` 与 `/permissions remove <列> <序号>` 在线增删、立即持久化生效。

## 目录信任

首次在某个目录启动时，CowCat 会询问 `Trust the files in <cwd>? [y/N]`：

- **y**：cwd 写入 `~/.cowcat/config.json` 的 `trustedProjects`，以后该目录直接放行。
- **n / 回车**：不写入，本次会话进入只读 plan 模式（状态栏 `mode: plan [受限]`）；`/act` 需再确认一次"Trust this folder for this session?"才会放行（仅本次）。
- `-p` 非交互：不提问，未信任目录一律按只读处理（写工具自动拒绝）；`-y` 不覆盖信任。

## 测试与抓包调试

```bash
cd agent && node --test 'test/**/*.test.mjs'   # 全量测试
bash tools/run-ccagent-kimi.sh "..."           # 走日志代理的 live 冒烟（抓包在 logs/cowcat-capture/）
```

详见 `agent/test/e2e-proxy.md`。

## hooks

在 `~/.cowcat/config.json` 的 `hooks` 字段配置，8 个事件：`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`UserPromptSubmit`、`Stop`、`SessionStart`、`SessionEnd`、`PreCompact`。

```json
{
  "hooks": {
    "PreToolUse": [
      { "type": "command", "command": "node ~/.cowcat/hooks/guard.js", "timeout": 10 },
      { "type": "http", "url": "https://hooks.example.com/audit", "async": true }
    ],
    "Stop": [{ "type": "command", "command": "notify-send 'cowcat done'", "once": true, "async": true }]
  }
}
```

- `command`：经 shell 执行，stdin 收到 JSON 事件载荷（工具名/输入/输出/会话路径/cwd）；stdout 非空或非 0 退出会让 **PreToolUse 拒绝该工具调用**（首行作为原因回灌模型）；超时默认 60s 后 SIGKILL。
- `http`：POST JSON；2xx 放行，4xx 拒绝（body 首行为原因），网络错误放行但打印警告。
- `once` 执行一次后自动从配置移除；`async` 不阻塞主流程；hook 执行不弹审批；`COWCAT_DISABLE_HOOKS=1` 全关。
- `/hooks` 查看，`/hooks disable|enable <事件> <序号>` 开关，`/hooks test <事件>` 手动触发并打印载荷与结果。

## MCP

配置写在 `~/.cowcat/mcp.json`（user 级）或项目 `.cowcat/mcp.json`（项目级同名 server 覆盖）：

```json
{ "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "env": {} },
    "remote":     { "url": "https://mcp.example.com/sse" }
} }
```

启动时并发连接（单 server 失败不拖垮整体）；工具动态注册为 `mcp__<server>__<tool>`；首次连接新 server 需交互批准（记忆在 config.json 的 `mcpTrusted`）；`/mcp` 查看状态与工具数，`/mcp reconnect <名>` 重连；`COWCAT_MCP_TIMEOUT` 控制单次调用超时（默认 60s）；CLI 退出时统一关闭所有 server 进程。

## 自定义 commands / agents / skills

目录约定（user 级 `~/.cowcat/` 与项目级 `.cowcat/`，项目同名覆盖 user）：

**commands** — `commands/<名>.md`：frontmatter（`---` 包围）支持 `description`、`allowed-tools`（逗号分隔，可选）、`model`（可选）、`argument-hint`（可选）；正文是 prompt 模板，`$ARGUMENTS` 会被 `/名 参数...` 的参数替换。执行即把展开后的模板作为一条 user 消息送入当前会话。与内建命令重名时内建优先；`/help` 单独列出"自定义命令"组。

**agents** — `agents/<名>.md`：frontmatter 支持 `description`、`tools`（逗号分隔白名单，不写=继承全部）、`model`；正文是该角色的 system prompt。通过 Agent 工具的 `subagent_type` 参数调用（先查自定义、再查内建 scout/plan/general/verify）。`/agents` 列出全部角色。

**skills** — `skills/<名>/SKILL.md`：frontmatter 含 `name`、`description`。按需加载：启动只在 system prompt 注入索引（名字+一句话描述）；模型用 Agent 工具的 `skill` 参数调用时，SKILL.md 正文注入子代理执行。`/skills` 列出索引。

```markdown
---
description: 审查当前改动的风险
argument-hint: [关注点]
---
请审查当前 diff，重点关注 $ARGUMENTS。
```

Agent 工具新增参数：`subagent_type`（角色名）、`skill`（技能名）、`resume`（子代理会话 JSONL 路径，续跑）、`model`、`max_turns`。

## 后台任务

Bash 工具传 `run_in_background: true` 立即返回任务 id（`已后台启动 task_xxx，用 TaskOutput 查看`）：

- **TaskOutput** `{task_id, block?, timeout?}` — 非阻塞返回当前输出快照（running: true 表示还在跑）；`block: true` 等待完成或超时。输出截断 20000 字符。
- **TaskStop** `{task_id}` — SIGKILL 并返回最终输出摘要。
- `/tasks` 列出活动任务（id/命令/时长/状态），`/tasks kill <id>` 停止。

CLI 退出时未完成的后台任务全部强杀（Windows 下整树杀灭，无孤儿进程）；超时上限仍 600s。

## 输出样式与 statusline

**output-styles**：`~/.cowcat/output-styles/<名>.md` 或项目 `.cowcat/output-styles/<名>.md`（项目覆盖同名），frontmatter 只写 `description`，正文是风格指令（如"先结论后细节"）。`/output-style` 列出（`*` 标注当前），`/output-style <名>` 热生效（下一 turn 即注入 system prompt 尾部）；默认无样式。

**statusline**：config.json 加 `statusLine: { "command": "..." }`，状态栏右侧追加该命令的首行输出。命令经 shell 执行，stdin 收一行 JSON `{"model":"...","mode":"...","ctx_pct":42,"cwd":"..."}`，2s 超时静默跳过（绝卡不住 UI）。`/statusline` 查看、`/statusline set <命令>` 设置、`/statusline clear` 恢复默认。

## REPL 键位

- **↑ / ↓**：召回本会话输入历史（编辑到一半的线会先暂存）。
- **Tab**：`/` 开头时循环补全内建+自定义斜杠命令；其它位置插入两个空格。
- **shift+tab**：轮换 default ↔ plan 权限模式（等价 /act /plan），状态栏即时刷新。

非 TTY（管道/重定向）下键位全部静默禁用，行为不变。

## 结构化输出（-p 模式）

```bash
cowcat -p --output-format stream-json "任务"        # 纯 NDJSON 事件流：system/assistant/tool_use/tool_result/result/error
cowcat -p --output-schema '{"type":"object","required":["answer"],"properties":{"answer":{"type":"integer"}}}' "..."
cowcat -p --max-turns 10 "..."                       # 回合上限，超限 exit 4
```

- `stream-json` 与启动行等装饰输出互斥，stdout 只有事件行。
- `output-schema` 用内置 mini 校验器（type/object/required/properties/items/enum/字符串长度等）；校验失败自动把错误回喂模型重写一次，仍失败 exit 3。权限受阻 exit 2。

## P2 第二波

- `/ide` — IDE 集成状态：检测到的 IDE（VS Code/Cursor/JetBrains）、JSONL 事件通道（`COWCAT_IDE_PIPE=<路径>`，扩展端 tail 该文件即可收到 `file_edited`/`diagnostic` 事件）、本会话事件数。
- `/worktree [名]` — 创建 git worktree（`../<repo>-cowcat-<名>`，分支 `cowcat/<名>`）并把会话切入；`/worktree list` 列出。Agent 工具传 `isolation: "worktree"` 可让子代理在独立 worktree 里跑。
- **lead 角色** — `subagent_type: "lead"` 的团队编排：它会按 scout/plan/general/verify 分工派发、整合报告并对结果负责（可嵌套一层子代理）。
- `cowcat -p --background "长任务"` — 后台执行：立即返回任务 id，日志与结果在 `~/.cowcat/background/<id>/`；完成时系统通知（Windows 气球提示，无 GUI 静默）。

## 全屏 TUI（0.8.0，v0.10.0 全面翻新）

在交互式真实终端（Git Bash / PowerShell / Windows Terminal / cmd）中直接运行 `cowcat` 即进入全屏界面：

- **布局**：顶部 header（文本 banner 行 + context 用量条 + model/mode）；中部 transcript（帧 diff 增量重绘；工具块 ⏺ 三态 running/done/error + 回合页脚 ✻；用户消息右侧气泡；模型输出流式 markdown 渲染——标题/列表/引用/表格/行内样式，代码块六语言语法高亮 js/ts/python/sh/json/md；审批请求是内联卡片附 diff 预览，按 y/n/a 应答）；底部圆角输入框（空态 placeholder 提示；多行用 Ctrl+J 进入/再按插入换行，Enter 发送）；状态栏（版本/cwd + 状态文本 + 操作提示）。
- **键位**：↑/↓ 历史、Tab 补全斜杠命令、`@` 文件补全、shift+tab 切 plan/act、Ctrl+A/E/K/U/W 与左右方向键等行编辑、shift+↑/↓ 与 PgUp/PgDn 滚动 transcript、**Esc 中断当前任务**。
- **主题**：`/theme dark|light` 语义色 token 双主题，TUI 全界面即时生效（含输入框边框、气泡、工具块配色）。
- **降级**：管道/CI、`-p`、`--output-format stream-json`、`NO_COLOR` 自动使用原线性模式；`COWCAT_TUI=off` 可强制关闭全屏。
