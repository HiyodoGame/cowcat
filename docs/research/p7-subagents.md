# P7 调研：子 agent（上下文隔离与委派）

> **本文件只出决定草案与 ADR 清单，不改源码、不改 ADR 表**（工作规则 3）。
>
> 对应 `dev-plan-v2.md` P7 表的「子 agent」行；排期依据是 `research/p7-frontier-survey.md` 的 **D1**（子 agent 提到 MCP 之前）。时效截至 **2026-10-20**。
>
> **本文件没有【实测】条目**：本轮全部是只读调研（读本仓库源码、读上游文档），没有写代码、没有跑真实模型、没有任何子 agent 实例。凡「跑过才知道」的，一律进 §8。

## 证据标注

沿用 `AGENTS.md` 的约定，不另立一套：

- **【源码】** 本仓库实现，给 `文件:行号`
- **【实测】** 本轮真跑出来的（**本文件没有**）
- **【上游】** 上游文档或实现；文档给 URL，实现给版本
- **【推断】** 未实测的推论，**不得作为决策依据**

---

## 0. 结论摘要

1. **子 agent 的价值是上下文隔离，不是"更强的模型"**：上游一手证据把它定性为「用更多 token 换更多并行容量」——多代理系统约 **15×** 于普通对话的 token 消耗，单 agent 约 4×【上游】。这个价格只有在「被隔离掉的东西本来会污染主上下文」时才是划算的，所以**默认角色必须是只读探查**。
2. **子会话必须是独立会话，不能塞进父日志**（ADR 草案 079）。本仓库的事件溯源把「消息」与「seq 水位线」绑在一起（`kernel/state.ts:23-63`），把子对话折进父日志会同时污染压缩与渲染——而隔离正是这一行存在的理由。
3. **`Task` 不是 `ToolPort`，而是 `runTurn` 注入的虚拟工具**（ADR 草案 080）。它需要父会话身份、策略收窄与用量记账，而工具层被结构性禁止看到会话状态（`kernel/run-turn.ts:452-544` 把策略、审批、读后写闸门都放在内核里）。
4. **子会话的 `ask` 一律拒绝**（ADR 草案 081）。父会话的前端只订阅父会话，把子会话的审批请求扔到一条没人看的日志里，结果只会是等满 5 分钟超时（`kernel/run-turn.ts:21`）。
5. **T1 只做前台、串行、不嵌套、两个内置角色**。后台任务、并行、自定义 agent 文件、fork 各自有归属（P7 后台任务行 / R5 / Skills 之后 / 会话体验行），混进来会让第一版无法验收。

---

## 1. 取证方式与局限

| 项 | 做法 | 局限 |
|---|---|---|
| 本仓库 | 读 `kernel/`、`host/`、`policy/`、`ports/`、`packages/protocol`、v1 `agent/src/subagent.js` | 未跑任何测试（本轮不产生代码） |
| 上游一手 | Claude Code subagents 文档、OpenCode agents 文档、Anthropic 多代理研究系统工程文 | 均为厂商文档/工程博客，**不是**对实现的读码 |
| 未能取得 | 本仓库 v2 的任何子 agent 行为数据；真实模型下的委派收益 | 无模型端点、无 `ZHIPU_API_KEY`，见 `HANDOFF.md` §6 |

---

## 2. 上游对照

### 2.1 Claude Code（2026-10 文档，一手）

【上游】<https://docs.claude.com/en/docs/claude-code/sub-agents>（正文另含 llms.txt 索引）

| 事实 | 对我们的含义 |
|---|---|
| 子 agent「跑在自己的上下文窗口里，有独立 system prompt、工具子集与独立权限」；**「subagents work within a single session」**，多会话并行是另外的能力（background agents / agent teams） | 我们把「子会话」定为**同一宿主里的独立会话**，不是跨进程编排——范围与上游一致 |
| 内置 Explore / Plan **只读**，且**不加载 CLAUDE.md 与 git status**，为的是「fast and inexpensive」 | 只读是默认角色的形状；「跳过指令链」是成本优化，可作为角色选项而不是默认 |
| 每个子 agent 都会从工具池里**无条件移除**一批工具：`Agent`（到深度上限时）、`AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode`（除非 plan）、`ScheduleWakeup`、`Workflow` 等 | 我们同样要有「子会话永远拿不到什么」的清单，而不是只做 allowlist |
| 嵌套深度默认 **3 层**（`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`，`1` = 关闭）；并发上限默认 **20**（`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`） | 上游默认鼓励编排；**我们 T1 默认 0 层**（不嵌套），因为我们还没有编排层，先要一个能验收的最小形状 |
| 模型解析顺序：单次调用传参 > 定义里的 `model`（`inherit`）> `CLAUDE_CODE_SUBAGENT_MODEL` > 主会话模型 | 我们同构但更少来源：**继承父预设**，允许按预设 id 覆盖 |
| `maxTurns` 到顶时输出标记为 **partial**，可 resume 继续；子 agent 结束返回 **agent id** | 结果要带「是否到顶」；resume 依赖会话 id ↔ 我们的 `sessionId` 天然就是 |
| 子 agent 从主会话的 cwd 开始；`isolation: worktree` 才给独立 checkout | 我们 T1 不做 worktree（P7 的 Worktree 行） |
| 子 agent 定义里的 inline MCP server **需要该目录受信**才加载 | 与 ADR-077「信任是注入前置」同一条纪律，将来 MCP 落地的对称项 |
| 自定义 agent 的 `description` 计入上下文，超过 **15,000 token** 会在启动时告警 | 我们若做自定义角色，元数据目录本身要有预算——先记着，T1 不引入 |
| `Task` 工具在 v2.1.63 **改名为 `Agent`**，`Task(...)` 仍作为别名 | **命名要选**：见 §4.2 |

### 2.2 OpenCode（2026-10 文档，一手）

【上游】<https://opencode.ai/docs/agents/>

- 三类模式 `primary` / `subagent` / `all`；内置子 agent 为 **general（全工具）/ explore（只读）/ scout（只读、可把依赖仓库克隆到托管缓存）**。
- **子 agent 会创建子会话**，并且 TUI 有专门导航：`session_child_first`（进入第一个子会话）、`session_child_cycle` / `_reverse`、`session_parent`（回到父会话）【上游】。这条直接支持「独立会话 + 可在前端打开」的形状。
- 子 agent **默认模型 = 调用它的 primary 的模型**（`model` 未指定时）。
- `task` 是权限键；`permission.task` 用 glob 控制**谁能被谁调用**；被 `deny` 的子 agent 会**从 Task 工具描述里整条移除**（模型看不见就不会硬试）。
- `steps` 限压；`hidden` 只影响 `@` 补全，不阻止模型调用。

### 2.3 Anthropic 多代理研究系统（工程文，一手；D1 的依据）

【上游】<https://www.anthropic.com/engineering/multi-agent-research-system>（2025-06-13）

- 多代理对内部研究评测相比单 Opus 4 提升 **90.2%**；分析显示 **token 使用量单独解释 80% 的方差**——「多代理之所以有效，主要是因为它花掉了足够多的 token」。
- **代价**：普通对话 ≈ 1×，单 agent ≈ **4×**，多代理系统 ≈ **15×** token。
- **不适用的场景**：需要所有 agent 共享同一上下文、或任务间依赖很多——「大多数编码任务的可并行部分比研究少」。
- **同步执行的瓶颈**：lead 逐批等待子 agent，期间无法引导子 agent，一个慢子 agent 会卡住整条流水线。
- **降低「传话游戏」**：让子 agent 把产物**落到（虚拟）文件系统**，只把轻量引用传回协调者。

> 对我们的判断很直接：子 agent 值得做，但**默认应当是「主会话不想看的过程」而不是「主会话做不完的工作」**；结果回传要有上限，且完整过程留在子会话日志里，靠 `sessionId` 回查而不是靠塞进父上下文。

### 2.4 本仓库 v1 的结论（只迁结论，不迁代码）

【源码】`agent/src/subagent.js`、`agent/src/tools/agent.js`

| v1 的做法 | 结论（迁） | 不迁的理由 |
|---|---|---|
| `AgentTool` 自带 `subagent_type`（scout/plan/general/verify/自定义）、`skill`、`resume`、`isolation: worktree`、`model`、`max_turns`、`effort`、`run_in_background` | 「角色 + 上限 + 可覆盖模型」这三个旋钮是必要的 | 参数表一次给太多，v2 第一版无法逐个验收 |
| 角色决定工具子集；受限角色走 plan（只读），general 走 yolo | 角色 → 工具子集 | **不迁**「受限角色 = plan 权限模式」：v2 没有 mode 概念（HANDOFF §6 已记），且 `yolo` 与 ADR-028 的信任闸门正面冲突 |
| `lead` 可以再委派一层，其余不能嵌套 | 深度必须封顶 | v1 的「深度」是临时变量，不是可审计事实 |
| 结果就是 `res.finalText`，无上限、无用量 | 结果必须有预算与用量 | 15× token 的价格必须在父会话里看得见 |
| 后台执行靠 `ctx.background.startAsync` | 后台是独立能力 | 依赖任务注册表，属 P7「后台任务」行 |

---

## 3. 本仓库现状（源码证据）

### 3.1 会话与回合

- 一个 `Session` = 一条 JSONL + 一把**整生命周期**的写锁（`kernel/session.ts:46-64`、`ports/index.ts:245-254`）。`create` 是唯一能写 header 的入口，header 是 `session.opened`（`kernel/session.ts:66-87`）。
- 同一会话**同时只能有一个回合**：`openTurn` 在已有未终结回合时直接抛错（`kernel/session.ts:145-152`）。
- header 目前只有 `schemaVersion` / `cowcatVersion` / `shell`（`kernel/events.ts:29`）——**没有父会话、没有 cwd、没有模型**（HANDOFF §6 第 5 条已记）。
- `runTurn` 的依赖是一张显式的 `TurnDeps`：会话、模型端口、预设、工具表、规则、`FsPort`、审批函数、id 源、指令（`kernel/run-turn.ts:36-77`）。**没有「子代理」这类东西**——全仓 `rg subagent` 在 `packages/` 下零命中（除 `child_process` 的字面）。

### 3.2 工具与策略

- 工具是纯的：`run(input, signal, grant)`（`ports/index.ts:152-160`），**看不到会话状态**；策略裁决、审批、读后写闸门全在内核里（`kernel/run-turn.ts:452-544`）。
- 规则是数据：`Rule{name, verdict, when{tool,risk,path,command}}`（`policy/decide.ts:40-56`），裁决优先级 `deny > ask > allow`（`policy/decide.ts:64`）。
- 审批按 `ActionRequest.callId` 配对（`host/host.ts:141-144`），桥是**每个会话一份**（`SessionRecord.pendingApproval`，`host/host.ts:146-155`）；超时 = 拒绝，默认 5 分钟（`kernel/run-turn.ts:21`）。
- 「读是免费的」是基线，不是配置项（`policy/trust.ts:26-35` 的注释）；组合根只额外加了一条 `TodoWrite` 免问（`host/config.ts` 的 `HOST_BASELINE_RULES`）。

### 3.3 组合根与协议面

- 模型端口是**宿主级单例**，首次 `turn.send` 时建（`host/host.ts:210-230`）；配置在构造时读，坏配置拒绝整个宿主。
- `createSession` 建会话并登记在内存表里（`host/host.ts:316-331`）；`attach` 先订阅再读日志、缓冲到重放之后（`host/host.ts:333-378`）。
- `session.list` 直接列 `sessionsDir` 下的日志（`host/host.ts:312-314` + `adapters/session-index.ts`）——**没有父子关系字段**，任何新写的日志都会被当成顶层会话列出来。
- 协议方法表固定 9 个（`packages/protocol/src/methods.ts:11-21`），`SessionSummary` 只有 `{sessionId, lastSeq}`（`methods.ts:59-62`）。
- 指令链在回合开始前注入、压缩后重注（`kernel/run-turn.ts:126-128`、`230-259`）；子会话若也要注入，走同一个 `InstructionNeeds`。

### 3.4 前端

- TUI 只吃 `WireEvent`，`project()` 是纯函数（ADR-066）。**未知事件类型第一次出现记一行 notice**，所以新增事件不会弄坏渲染器，但也**不会自动获得卡片**。
- 审批卡按会话内 `approval.requested` 渲染；前端只 attach 一个会话（`packages/cli/src/cli/tui.ts`）。

---

## 4. 决定草案

### 4.1 子会话是独立会话（→ ADR 草案 079）

**决定**：`Task` 每调用一次 → 建一个**独立 `Session`**（自己的 JSONL、自己的锁、自己的 seq），父日志只记两条事实：`subagent.started` / `subagent.finished`。

**理由**：

1. **隔离是目的本身**。子对话一旦折进父日志，`reduce` 会把子消息并进 `messages`（`kernel/state.ts:23-37`），父会话的上下文**反而变大**——与这一行存在的理由相反。
2. **压缩语义会分叉**。压缩按 `seq` 水位线遮蔽历史（`kernel/events.ts:66-91`、ADR-071）；父子消息共用一条 seq 线后，「哪些消息被遮蔽」不再是一个能解释的事实。
3. **前端已经具备条件**：子会话就是一条普通日志，`session.open` / `attach` / `attachment.read` 都能直接用；OpenCode 的「子会话 + 导航」正是这个形状【上游】。
4. **成本可控**：多一条日志文件、一次 `create`/`close`；已有锁与快照机制无需新写。

**代价（写在明处）**：

- `session.list` 会开始列出子会话 → `SessionSummary` 加一个**可选** `parentSessionId`，CLI/TUI 默认折叠（见 §5 待定项）。
- 头字段变更：`session.opened` 加**可选** `parent`（会话 id + 角色名）。**不升 `schemaVersion`**：旧日志读进来是「没有父」= 顶层会话；新日志给旧读者看时，新增字段被忽略（`reduce` 不读它）。这是 ADR-019 意义上的兼容扩展，不是格式变更。

### 4.2 `Task` 是内核注入的虚拟工具，不是 `ToolPort`（→ ADR 草案 080）

**决定**：工具名 **`Task`**（不用 `Agent`），由 `runTurn` 在 `TurnDeps.subagents` 存在时注入到请求的工具表里；`runCall` 识别它并调用 `SubagentPort.spawn()`，策略与事件仍由内核写。

**命名理由**：Claude Code 把 `Task` 改名 `Agent` 是因为它同时覆盖后台会话与 agent teams【上游】；我们 T1 只有「委派一个子任务」，`Task` 更准确地描述了范围，也与 v1 的 `TaskOutput` 家族不冲突。**不叫 `Agent`** 还有一个具体好处：将来 R5 真做编排时，`Agent` 这个名字还空着。

**为什么不做成 `ToolPort`**：

- 它需要**父会话 id**（写 `parent`）与**父的预设**（继承模型），而 `ToolPort.run` 的签名里没有会话，且工具层被结构性禁止看到状态（`kernel/run-turn.ts:452-544` 的注释就是这条纪律）。
- 它要写父日志的两条事件；工具只能返回 `ToolResult`，写事件是内核的事（`todo.updated` 的先例：`run-turn.ts:170-172`）。
- 它要参与**策略收窄**（子会话拿不到 `Task`），收窄是内核与组合根的职责。

**形状（草案）**：

```text
input  { description: string(3~5 词), prompt: string, agent: 'explore' | 'general', max_turns?: number }
output { report: string, sessionId: string, agent, turns, partial: boolean }
risk   exec        // 它启动的东西会执行工具
```

- `description` 只用于父日志与前端卡片，不参与委派判断（我们不设「模型按 description 自动选角色」的自动委派，T1 由模型显式调用）。
- `risk: 'exec'`：委派是一次可审计的执行动作，与 Bash 同级；`explore` 角色在组合根基线里可免问（只读），`general` 默认 `ask`。

### 4.3 子会话的权限只收不放（→ ADR 草案 081）

**决定**（四条，缺一不可）：

1. **工具子集**由角色决定：`explore` = `Read` / `Glob` / `Grep`；`general` = 父会话的全部工具**减去 `Task`**。子会话永远拿不到：`Task`（深度上限 0）、`TodoWrite`（待办属于父会话）。
2. **规则只收不放**：子会话的规则 = 父规则 **+** 一条 `Task` 的 `deny` **+** 角色 allowlist（角色之外的工具名全部 `deny`）。因为裁决是 `deny > ask > allow`，父的 `deny` 仍然赢；父的 `allow` 不会因为「这是子会话」被放大。
3. **子会话里的 `ask` 一律拒绝**，理由写进工具结果（`subagent asks are refused in T1: <tool> needs <rule>`）。原因：父前端只订阅父会话，子会话的 `approval.requested` 没有读者，等满 5 分钟换来同一个拒绝（`kernel/run-turn.ts:21`）。这条是**已知限制**，不是设计偏好——把子会话的提问提升到父会话需要新的跨会话事件与卡片，属 T3 之后的独立任务。
4. **取消沿 `signal` 传播**：父回合被取消 → 子回合收到 abort → 子会话写 `turn.transitioned(cancelled)` → 锁在 `finally` 释放。

### 4.4 结果、预算与记账（→ ADR 草案 082）

**决定**：

- 回传**只有最终文本**（`report`）+ 终止状态 + 轮数 + 用量；**完整过程留在子日志**，父会话通过 `sessionId` 回查（多代理文的「落到文件系统、只传引用」【上游】）。
- 文本上限 **20,000 字符**，超出截断并带 `truncation`（ADR-048 的既有形状），模型看到的是「被截断 + 完整内容在哪个会话」。
- **子会话的 `model.usage` 记在子日志**，父日志的 `subagent.finished` 汇总一条 `usage`。**不把子 usage 折进父的 `model.usage`**：`contextUsage()` 用 `lastUsage` 估算窗口占用（`kernel/state.ts:38-46`），把它加上会让父的压缩触发点算错——那正是「隔离」要避免的污染。
- 模型：默认**继承父预设**；`Task` 的 input **不接受** model 覆盖（T1），因为「谁来跑」在配置里是会话级决定（ADR-035/046），第一版不引入第二个决策点。
- 指令链：子会话**注入与父相同的链**（同一 workspace、同一信任，ADR-075~078）。「Explore 跳过指令链」是上游的成本优化【上游】，等有实测数据再决定要不要给角色加开关。

---

## 5. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| **把子对话折进父日志**（`subagent.message` 事件家族） | §4.1 的两条：父上下文变大、压缩水位线失去意义；且前端要区分「谁说的」才能渲染 |
| **`Task` 做成普通 `ToolPort`**，由适配器里闭包持有一个 spawner | 拿不到父会话 id / 预设；写事件要绕过分层；深度与策略收窄会散落在两个地方 |
| **子 agent 走独立进程（`cowcat serve` 子进程）** | 多一次 Node 启动与一份协议连接；锁与取消要跨进程协调；上游同样选择进程内【上游】 |
| **T1 就做后台 / 并行** | 依赖任务注册表与父子会话的并发写；`Session` 是单写者（`kernel/session.ts:46`），并行要先把「一个会话一个回合」的约束想清楚。归 P7「后台任务」行 |
| **T1 就做自定义 agent 文件**（`.cowcat/agents/*.md`） | 角色文件的价值在于 prompt 与工具子集，而我们的 Skills 与 Hooks 都还没落地；先有内置角色，才有「自定义」要对齐的形状 |
| **默认 fork 父上下文** | 与隔离目的相反；fork 的正确归属是「会话体验」行的「回退并 fork」（D8）与 R5 编排 |
| **按 description 自动委派** | 上游靠 description 匹配自动触发【上游】，但那要求一套稳定的角色目录与预算；T1 由模型显式调用，行为可预测、可测试 |

---

## 6. ADR 清单（草案，从 079 起）

> ADR 表现有最大编号是 **078**。`p7-frontier-survey.md` §8 曾把 **079** 预留给「tool clearing」，那只是暂号；**实际落表时以当时最大编号顺延**，本模块可能顺延到 080 之后。下面按内容编号，落表时统一顺延。

| 草案号 | 一句话 |
|---|---|
| ADR-079 | **子会话是独立会话**：独立日志/锁/seq；父日志只记 `subagent.started` / `subagent.finished`；`session.opened` 加可选 `parent`，`SessionSummary` 加可选 `parentSessionId`，**不升 `schemaVersion`** |
| ADR-080 | **`Task` 是内核注入的虚拟工具**（不是 `ToolPort`）：输入形状、`risk: exec`、`description` 只用于展示、`explore` 可在基线免问、`general` 默认 `ask` |
| ADR-081 | **子会话权限只收不放**：角色工具子集、父规则 + `Task` deny + 角色 allowlist、**子会话的 `ask` 一律拒绝**、取消沿 signal、深度默认 0 |
| ADR-082 | **结果与记账**：只回传最终文本（2 万字符上限 + `truncation`）、子 usage 不进父 `model.usage`、模型继承父预设、指令链继承 |

---

## 7. 任务拆分（草案）

| 任务 | 内容 | 依赖 |
|---|---|---|
| **T1** | **契约与内核路由**：`subagent.started` / `subagent.finished` 事件、`SubagentPort`（`spawn(request, signal)`）、`TurnDeps.subagents?`、`runCall` 的虚拟工具分支、取消与拒绝路径；用假 port 驱动测试（事件顺序、深度上限、ask 拒绝、取消传播） | ADR-079~081 |
| **T2** | **组合根**：`Task` 的 spec、子会话 `create`/`open`/`close`（`finally` 释放锁）、`parent` 头字段、模型与指令链继承、`explore` 的基线 `allow`、`session.list` 的父子标注 | T1、ADR-082 |
| **T3** | **协议与前端**：`SessionSummary.parentSessionId`、`sessions list` 默认折叠子会话、TUI 的 `subagent` 卡片（`started`/`finished`）+ 未知事件的 notice 兜底 | T2 |
| **T4** | **端到端**：假模型跑「父 → 子 → 回传」一条完整回合；子会话日志可 `session.open` 重放；父取消时子会话留下 `cancelled` 且不残留锁 | T2、T3 |
| **T5** | **文档**：ADR 落表、`06-frontend.md` 与 `dev-plan-v2.md` 同步、`HANDOFF.md` 重写 | T4 |

**验收标准（草案）**：`packages/cowcat` 的测试能在**没有真实模型**的情况下证明——子会话是一条独立日志、父日志有两条 `subagent.*` 事件、子会话拿不到 `Task`、子会话的 `ask` 被拒绝且理由进工具结果、取消后两侧都终结且锁释放。

---

## 8. 待验证（不得作为决策依据）

1. **收益是否成立**【推断】：15× token / 90.2% 提升来自**研究型**任务【上游】；编码任务的可并行部分更少（同一篇明说）。我们的第一版要证明的是「上下文不被污染」，不是「任务完成率提升」。需要真实端点才能测。
2. **提示缓存**：子会话独立前缀必然不命中父的缓存【推断】；对成本的实际影响未测（与 `p7-frontier-survey.md` §10 待验证 1 同一批实测）。
3. **父锁与子锁并存**：两者是不同 sessionId、不同锁文件，理论上不冲突；**未实测**在 Windows 上同时持有两个 `FileLockPort` 的行为（含进程崩溃后的残留回收）。
4. **`session.list` 折叠策略**：默认隐藏子会话还是标一列 `parent`，取决于前端卡片的信息密度；T3 时按真实截图定。
5. **子会话的 `explore` 是否跳过指令链**：上游这么做是为了「快而便宜」【上游】，我们的链有 65,536 字节预算（ADR-076），实测才知道值不值。
6. **并发上限**：上游默认 20【上游】；我们 T1 串行，数值等并行落地时再定。

---

## 9. 来源清单

**一手（本轮实际读过）**

- Claude Code subagents：<https://docs.claude.com/en/docs/claude-code/sub-agents>（正文、frontmatter 表、嵌套深度与并发上限、启动上下文、resume）
- OpenCode agents：<https://opencode.ai/docs/agents/>（primary/subagent、子会话导航、`permission.task`、模型继承）
- Anthropic 工程文：<https://www.anthropic.com/engineering/multi-agent-research-system>（4×/15× token、90.2%、同步瓶颈、产物落盘）

**本仓库**

- `packages/cowcat/src/kernel/{session,run-turn,state,events}.ts`、`policy/{decide,trust}.ts`、`ports/index.ts`
- `packages/cowcat/src/host/{host,config}.ts`、`adapters/session-index.ts`
- `packages/protocol/src/methods.ts`
- `agent/src/{subagent.js,tools/agent.js}`（v1 参照，只迁结论）
- `docs/dev-plan-v2.md`、`docs/architecture/README.md`、`docs/research/p7-frontier-survey.md`
