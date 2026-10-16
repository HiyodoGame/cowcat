# CowCat 全量功能路线图（对标 Claude Code CLI 2.1.55）

> 目标：把 CowCat 从"核心闭环可用"推进到"Claude Code 全功能面（除账号体系）的完整体验"。
> 依据：三路侦察——CowCat 现状盘点（agent/src 全模块）、2.1.55 完整功能面（analysis/cli-2.1.55.pretty.js 50 万行 + 已有逆向文档）、本机其他 CLI 借鉴面（cline / glm-acp-agent / minimax code / openclaw / codex）。

## 0. 范围声明

**包含**：LLM 协议层全部机制、约 30 个工具、40+ 斜杠命令中除账号绑定外全部、记忆系统、设置体系、权限规则引擎、hooks、MCP 客户端、子代理体系、compact/checkpoint、会话恢复、TUI 体验（主题/vim/键位/statusline/输出样式）、自定义 agents/commands/skills 加载、后台任务、结构化输出。

**排除**（账号/商业体系，用户明确豁免"Claude 账号登录部分"，同类项一并排除）：
- OAuth 登录、订阅、/upgrade、/usage（额度）、/login /logout /privacy-settings /install-github-app /install-slack-app /desktop
- cowork 协作、远程/tmux、Claude Desktop 互转
- GCS 自动更新器（npm 分发已覆盖，原生自更新不做）
- 插件**市场**体系（marketplace 下载渠道）；但本地插件目录加载机制保留在 P2 评估

## 1. 现状快照（v0.14.1 已发布 2026-10-16；675 tests 全绿 + ESLint 门禁 + GitHub Actions CI 全绿 + main 分支保护已启用）

> v0.12.0 发布收尾过程中另修：MCP 握手的 `clientInfo.version` 从硬编码 `0.5.0` 改为读 `package.json`（单一版本源）；`Glob` 的 `path` 参数崩溃与 `/output-style` 未接线（见 `docs/fix-plan-2026-10-15.md` 第六轮）。

**已完整且健康**：双协议 LLM 层（含 cache_control、count_tokens、installId 元数据）、28 内置工具 + 动态 MCP 工具注册、default/plan/acceptEdits/yolo 四权限模式 + 危险命令启发式 + always-allow 记忆 + 结构化权限规则引擎（`permissions.allow/deny/ask` + `Tool(pattern)` 语法 + /permissions）、hooks 8 事件（PreToolUse/PostToolUse/PostToolUseFailure/UserPromptSubmit/Stop/SessionStart/SessionEnd/PreCompact）、MCP 客户端（stdio + http 流式传输 + resources list/read）、文件 checkpoint + /rewind、记忆系统完整层级、自动 compact（summarizer 全结构）、JSONL 会话三态续接、子代理（4+ 内建角色 + 自定义 agent 定义 + effort 五档 + run_in_background）、目录信任、setup/doctor 向导、审批卡/diff 卡/输出卡、启动一行文本 banner 与纯文本状态栏（猫咪视觉形象已移除）、17+ 斜杠命令、项目上下文（COWCAT.md/AGENTS.md/CLAUDE.md 向上查找）、自定义 agents/commands/skills 目录加载、输出样式 + statusline 自定义命令、全屏 TUI（v0.10.0 全面翻新：字素宽度测量 CJK/emoji 对齐、终端能力探测、语义色 token 双主题 /theme 即时生效、帧 diff 渲染 + 条目缓存、流式 markdown 渲染、六语言语法高亮、用户消息气泡、工具块 ⏺ 三态 + 回合页脚 ✻、审批卡 diff 预览、圆角输入框 + placeholder + 状态栏提示、LineEditor 完整编辑键、Tab/@ 补全；内联审批卡/Esc 中断/可滚动 transcript）、结构化输出（`--output-format stream-json` + `--output-schema`）、后台任务（Bash run_in_background 1800s 分层 + TaskOutput/TaskStop + /tasks）、plan mode 工具对（EnterPlanMode/ExitPlanMode 审批闭环）、结构化任务工具（TaskCreate 系列）、定时唤醒（CronCreate 系列 + ScheduleWakeup，~/.cowcat/crons.json 持久化）、Read allow_large 与多模态 Read（图片/PDF/notebook）+ NotebookEdit（0.13.0）、v0.12.0 新增：OpenAI 兼容 provider 思考链流式（reasoning_content/reasoning → 本地 thinking 块，不回传上游）、工具调用 delta 实时 pending 卡、右侧面板（ctrl+b / /panel）、错误卡片化 + API 错误提示（src/errfmt.js）、并行工具执行（maxParallelTools 默认 4、结果保序）、启动模型引用校验提示（src/modelhint.js）、轻量 Bash 沙箱（见下）。

**沙箱（v0.12.0，light 档）**：secret 脱敏 env + 静态命令分级 + `~/.cowcat/audit.log` 审计追踪，`/sandbox off|light` 切换、Bash 卡 `· sandboxed` 角标。**诚实威胁模型：这是护栏不是安全边界**——无系统级隔离，不抵御恶意命令，只防误操作与留审计痕迹；系统级沙箱（容器/命名空间）仍未做（2026-10-16 已落盘：**调研** `docs/sandbox-research-2026-10-16.md` + **威胁模型与方案** `docs/sandbox-system-plan-2026-10-16.md`，方案待拍板后按 Phase 0 起实施）。

**整块缺失**（对照 2.1.55/2.1.296 功能面）：bypassPermissions 权限档、Workflow/Monitor 工具（原版 2.1.296 生态件，低优先）、系统级 Bash 沙箱（见上方威胁模型说明）。

## 2. P0 — 核心闭环补全（修 bug + 堵窟窿）

> ✅ **全部完成（v0.4.0，87 tests 全绿 + 真实 Kimi 冒烟通过，2026-10-13）**

| # | 事项 | 对标 | 说明 | 状态 |
|---|---|---|---|---|
| P0-1 | 修 5 个接线 bug | — | todo sessionId、Agent model 透传、npm test glob、死代码清理（smallModel 由 compact 消费、trackProcess 落实为 SIGINT 杀子进程）、Grep 补 -B/-A/type/multiline | ✅ |
| P0-2 | WebFetch + WebSearch | WebFetch/WebSearch 工具 | WebFetch：fetch+HTML→markdown、5MB/20k 截断；WebSearch：DuckDuckGo HTML 引擎（可换付费 provider）、域名过滤 | ✅ |
| P0-3 | 工具描述扩写 | analysis/tools-descriptions/ | 9+2 工具全部补"何时用/不用/约束/失败模式"，原创改写，schema 零变动 | ✅ |
| P0-4 | 文件 checkpoint + /rewind | persistence.md §6 | 会话内简化版：Edit/Write 前快照到 ~/.cowcat/checkpoints/，/rewind 选点回滚文件+截断对话 | ✅ |
| P0-5 | compact 增强 | agent-loop.md §2 | 双模板（全量/近期比例）、compact_boundary+compacted 落盘、resume 不重放原文、/compact [指令] | ✅ |
| P0-6 | 斜杠命令第一波 | 命令清单 | /cost /status /export /fork /todos /theme，/help 全量更新（现共 17 条命令） | ✅ |
| P0-7 | OpenAI provider countTokens | — | tokapprox.js 本地校准启发式（±20%），doctor 改极小 generate 真实探网 | ✅ |

## 3. P1 — 体系化功能

| # | 事项 | 对标 | 说明 |
|---|---|---|---|
| P1-1 | 记忆系统完整版 | persistence.md §5 | `~/.cowcat/CLAUDE.md`（user 级）→ 项目 CLAUDE.md/.cowcat/CLAUDE.md/.cowcat/rules/ → 父目录递归；/memory 交互编辑（选 scope）；企业 policy 层不做 ✅ |
| P1-2 | 权限规则引擎 | agent-loop.md §5 + 校验器 119014 | settings 里 `permissions.allow/deny/ask` 数组，`Tool(pattern)` 语法（Bash 前缀 `:*` 匹配），zod 式校验器带错误建议；/permissions 管理界面；权限档当前仅 default/plan/yolo 三档，acceptEdits（自动接受编辑）与 bypassPermissions 未实现（后续批次，见 §4.5） ✅ |
| P1-3 | hooks 核心子集 | agent-loop.md §6 | 8 事件：PreToolUse/PostToolUse/PostToolUseFailure/UserPromptSubmit/Stop/SessionStart/SessionEnd/PreCompact；command 类型（timeout/once/async）+ http 类型；prompt/agent 类型评估后置 ✅ |
| P1-4 | MCP 客户端 | protocol/README.md | stdio 传输（.cowcat.json 或 .mcp.json 项目级 + user 级）+ http 流式；动态 mcp__server__tool 注册；超时/输出截断；resources/prompts 支持（ListMcpResources/ReadMcpResource）未做（后续批次，见 §4.5）；OAuth 登录不做（与账号豁免一致） ✅ |
| P1-5 | 自定义 agents/commands/skills 加载 | persistence.md §1/§5 | `~/.cowcat/{agents,commands,skills}` + 项目 `.cowcat/{...}` 目录加载；commands 即斜杠命令 markdown（frontmatter 支持 allowed-tools/model）；agents 为角色定义（tools/model 白名单）；skills 为按需注入 prompt ✅ |
| P1-6 | 后台任务 | TaskOutput/TaskStop + /tasks | Bash run_in_background + TaskOutput 取回、TaskStop 终止、/tasks 列表管理；TaskCreate 系列结构化任务工具未实现（后续批次，见 §4.5） ✅ |
| P1-7 | 子代理体系扩展 | prompts README §2 | 内建角色增至 4 个（explore/plan/general-purpose/statusline-setup 等效物）；自定义 agent 定义生效（含 model 覆盖、只读工具集声明）；Task resume 续接子代理 transcript ✅ |
| P1-8 | 输出样式 + statusline | §14/§13 | output-styles 目录加载 + /output-style 切换；statusline 自定义命令（stdin 收 JSON：model/cost/context） ✅ |
| P1-9 | TUI 增强 | §16 | 键位：shift+tab act ↔ plan（切换时记住上一个模式，回来时恢复；未信任目录不生效）、ctrl+t todos、上一条 prompt 召回（↑）；/vim 简化版（行编辑增强或后置）； prefersReducedMotion 尊重 ✅ |
| P1-10 | 结构化输出 | minimax/codex 借鉴 | -p 增加 `--output-format stream-json`（NDJSON 事件流）与 `--output-schema`（JSON Schema 约束最终回答），CI 可用 ✅ |

## 4. P2 — 深度体验

| # | 事项 | 说明 |
|---|---|---|
| P2-1 | /context 上下文可视化 | 用量彩色网格（本地 tokenizer 估算各消息占比） ✅ |
| P2-2 | IDE 集成 | /ide 状态 + diff 跳转（VS Code cursor 协议最小实现） ✅ |
| P2-3 | 团队/lead 模式 | 原版实验性（CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS），CowCat 用子代理编排等效实现，优先级低 ✅ |
| P2-4 | EnterWorktree 等效 | git worktree 隔离执行子代理任务 ✅ |
| P2-5 | 思考链展示 | thinking delta 作为可折叠段渲染（本地可见、不回传上游的约定不变）；v0.12.0 起 OpenAI 兼容 provider 的 reasoning_content/reasoning delta 同样流式接入（P1） ✅ |
| P2-6 | @-mention 文件补全 | 输入 @ 触发项目文件模糊补全 |
| P2-7 | doctor 三形态 | 借鉴 openclaw：inspect / fix / --json（CI） ✅ |
| P2-8 | 后台执行+通知 | 借鉴 cline --zen：长任务 detach、完成系统通知 ✅ |
| P2-9 | 全屏 TUI（alternate screen 四区布局/内联审批卡/Esc 中断/可滚动 transcript） | 用户反馈高优先级；纯 ANSI 自绘，COWCAT_TUI=off 降级线性模式 ✅ |

## 4.5 P3 — 长任务与规划基础设施

> ✅ **全部完成（v0.9.0，198 tests 全绿，2026-10-14）**

| # | 事项 | 对标 | 说明 | 状态 |
|---|---|---|---|---|
| P3-1 | plan mode 工具对 | EnterPlanMode/ExitPlanMode | 模型可主动进入/退出只读规划态，配合 plan 权限档形成"先规划后执行"闭环 | ✅ |
| P3-2 | 结构化任务工具 | TaskCreate/TaskGet/TaskUpdate/TaskList | 与 Bash run_in_background 分层：后台进程归 TaskOutput/TaskStop，结构化待办归 TaskCreate 系列 | ✅ |
| P3-3 | 定时唤醒 | CronCreate/CronDelete/CronList + ScheduleWakeup | 会话内定时任务与唤醒调度，支撑周期性检查与长任务轮询 | ✅ |
| P3-4 | MCP resources | ListMcpResources/ReadMcpResource | 静态资源 list/read ✅ + resource templates 在 ListMcpResources 中列出 ✅ + prompts 作为 `/mcp__<server>__<prompt>` 斜杠命令 ✅（第八轮）+ 资源订阅 `SubscribeMcpResource`/`UnsubscribeMcpResource` ✅ + server→client 通道（GET SSE 长连接、logging、`*/list_changed` 自动刷新、`resources/updated`、断线重连与 `Last-Event-ID`）✅（第九轮）；sampling/elicitation/roots 仍只回 `-32601`，`SubscribePolling` 未做——见 `docs/fix-plan-2026-10-15.md` 第七至九轮 | ✅ |
| P3-5 | Agent 异步与思考档位 | Agent 工具 run_in_background + effort 五档 | 子代理后台派发不阻塞主循环；低/中/高/极高思考档位透传 | ✅ |
| P3-6 | Read 大文件/多模态 | Read allow_large、图片/PDF/notebook 读取 | allow_large 大文件 opt-in 直读 ✅；图片（png/jpeg/gif/webp）作为图片块交给模型 ✅ + PDF（Anthropic 原生 `document` 块 / OpenAI 兼容本地抽取 **含 ToUnicode CMap 解析**，上限 16MB）✅ + `.ipynb` 按单元格渲染 ✅（0.13.0）；视觉门控用目录 `attachment` 标记 + `COWCAT_VISION` 覆盖 ✅；真机验证见 `agent/test/live/multimodal*.mjs` 与 `pdf-extract-report.mjs`（图片/notebook/CLI 端到端 ✅；PDF 在 0.14.0 补上 CMap 后**本机 4 份真实 PDF 中 2 份可抽取**，含一份 11.7MB 中文国标 22507 字符/汉字 22%；无 ToUnicode 映射的自定义字形编码与扫描件仍明确拒绝）✅；notebook output 内嵌图片仍只标注不上传（见 `docs/read-multimodal-plan.md` §1 后置项） | ✅ |
| P3-7 | NotebookEdit | 原版 NotebookEdit | `.ipynb` 按 cell 索引 replace/insert/delete + cell_type 切换、保持原有格式、先读后写约束、审批卡渲染后 diff、checkpoint、plan 拒绝、acceptEdits 自动接受（0.13.0） | ✅ |

## 4.6 P4 — TUI 全面翻新

> ✅ **全部完成（v0.10.0，318 tests 全绿，2026-10-14）**

| # | 事项 | 说明 | 状态 |
|---|---|---|---|
| P4-1 | 字素宽度测量 | Intl.Segmenter grapheme 遍历 + CJK/emoji 宽度表，表格/边框/对齐不错位 | ✅ |
| P4-2 | 终端能力探测 | COLORTERM/TERM/NO_COLOR 探测，truecolor→256→16 色分级降级 | ✅ |
| P4-3 | 语义色 token 双主题 | dark/light 语义色 token 系统，`/theme` 切换 TUI 全界面即时生效 | ✅ |
| P4-4 | 帧 diff 渲染 + 条目缓存 | transcript 结构化条目缓存，帧 diff 只重绘变化行，替代 10fps 全量重绘 | ✅ |
| P4-5 | 流式 markdown 渲染 | 标题/列表/引用/表格/行内样式（粗体/斜体/行内码）流式解析渲染 | ✅ |
| P4-6 | 语法高亮 | js/ts/python/sh/json/md 六语言终端高亮 | ✅ |
| P4-7 | 消息气泡与工具块三态 | 用户消息气泡、工具块 ⏺ 三态 + 回合页脚 ✻ | ✅ |
| P4-8 | 审批卡 diff 预览 + 圆角输入框 | 审批卡附 diff 摘要；圆角输入框 + placeholder + 状态栏提示 | ✅ |
| P4-9 | LineEditor 编辑键 + Tab/@ 补全 | Ctrl+A/E/K/U/W、方向键、行首行尾；Tab 斜杠命令、@ 文件模糊补全 | ✅ |

## 5. 执行原则

1. **每个 P 级批次 = 实现 + 测试 + 文档 + 版本号**，跑 `cd agent && npm install && npm test` 全绿（`pretest` 先跑 ESLint `no-undef`/`no-unused-vars`）+ 真实 Kimi 冒烟后才算完
2. **法律边界不变**：prompt/描述改写不照抄；功能性短句可用；逆向产物不进发布 tarball（`files` 白名单已隔离）
3. **不冒充**：UA、user_id、产物品牌均为 CowCat/CoreScense
4. **原版实验性功能**（团队/远程/cowork）永远低优先，核心体验（工具/权限/记忆/hooks/MCP）优先
6. **改动走 PR**（分支与流程见 `docs/CONTRIBUTING.md`）：`main` 只通过 PR 合入、CI 在每个 PR 上跑；本地 pre-push 守卫拦直推。**服务端分支保护已启用**（仓库升级 GitHub Pro 后挂上：必须走 PR + 5 个固定检查全绿 + 要求分支最新 + 对 admin 同样生效 + 禁止强推/删除）。
7. 各批次间用户可随时要求 npm 发布当前版本（流程见 docs/PUBLISH.md）
