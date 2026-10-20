# P7 调研：Agent 前沿技术全景与插件生态（2026-10-20）

> **本文件只出决定草案与 ADR 清单，不改源码、不改 ADR 表**（工作规则 3）。
>
> 对象是 `dev-plan-v2.md` P7 表的排期校准、六个新增候选模块行与 R3~R8 远期项。调研分两轮：**① DeepSeek Harness 插件生态**（本地克隆 `deepseek-ai/deepseek-harness` @ `abe560f81e` / 0.1.0-rc.5，只读）与本仓库只读对照；**② 不限范围的前沿全景**（编码代理产品 / 上下文工程与记忆 / 协议·评测·沙箱·工程化 / 整体趋势，网络调研）。时效截至 2026-10-20。

## 证据标注约定

- **【上游源码】** 直接读到上游仓库实现。本文的 DeepSeek Harness 条目来自本地克隆（版本见引言），给 `deepseek-harness/路径`
- **【上游文档】** 公开网页 / 官方文档，给 URL；二手汇总（博客、对比站）单独注明「二手」
- **【本仓库】** 读本仓库代码 / 文档
- **【推断】** 未实测的推论，**不得作为决策依据**

**本文件没有【实测】条目**：两轮均为只读调研；「v2 一次真实模型请求都没跑过」的现状（`HANDOFF.md` §6）未变。

## 0. 结论摘要

1. **三个既有架构选择与 2026 前沿标准重合**（§6）：事件溯源 JSONL ↔ Agent Session Protocol；双边界沙箱（bwrap/Seatbelt + 读写/网络面）↔ Anthropic 官方沙箱架构文；headless JSON-RPC 协议 ↔ Agent Client Protocol。建议按 R3（ACP 适配器）/ R4（ASP 对齐）**兑现成互操作能力**，而不是另起炉灶。
2. **P7 既有多数排期被调研验证为正确方向**，只做校准：子 agent 提前（D1）、MCP 对齐 2026-07-28 规范（D2）、hooks 出生即兼容 Claude Code 格式（D3）、skills 渐进披露（D4）。
3. **新增七个模块行（D5~D11）**：Plan 模式（D5——`dev-plan-v2.md` 的 P5 对照表早已判归 P7，但此前没有对应行，见 §0 与 §7）、工具结果治理、审批与沙箱闭环、会话体验、可观测性（OTel GenAI）、记忆续篇·经验蒸馏、视觉工具；外加 R3~R8 远期清单与「插件生态三步走」路线（D12）。

## 1. 取证方式与局限（可复现）

| 轮次 | 方法 | 局限 |
|---|---|---|
| ① dsh 插件生态 | 本地克隆只读检查 + GitHub `dsh-plugin` topic 与两篇插件盘点（URL 见附录） | 克隆停在 0.1.0-rc.5，上游迭代快，**引用阈值前需复核版本** |
| ② 产品前沿 | 网络 search/fetch，约 10 次有效来源 | 多条查询遭搜索服务 429 限流：SWE-bench Pro / GAIA2 / tau-bench 最新状态、云沙箱格局、spec-driven development 2026 现状、Aider 动态**未取得一手来源**，相应论断不进决定草案 |
| ② 上下文/记忆 | 同上，约 12 次 | OpenViking、EverOS 未检索到可靠资料；提示缓存具体定价未获可靠来源 |
| ② 协议/工程化 | 同上，约 14 次 | ACP 的 adopter 清单未能从官网直接核实；AGNTCY 细节未核实 |

## 2. DeepSeek Harness 插件生态（第一轮）

### 2.1 架构与可借鉴点

【上游源码】dsh 基于 Cordis 微内核，"everything is a plugin"：插件 = ESM 模块（`name`/`inject`/`Config`/`apply(ctx, config)`），配置是分层 YAML patch 树（bundle 可分发 / profile 可运行，按行 id 覆盖），分发走 GitHub topic `dsh-plugin` + pnpm 薄转发器，无中心化市场。对本仓库最有借鉴价值的五点：

| # | 借鉴点 | 证据 |
|---|---|---|
| 1 | 分层 patch + bundle/profile 双 manifest 的组合模型 | 【上游源码】`packages/bundle/base/cordis.patch.yml`、`docs/user/develop/basic/publish.md` |
| 2 | Service Definition / Provider / Consumer 三分离的 capability seam | 【上游源码】`packages/README.md:67`——与我们的 ports/adapters 同构，**不是**需要补的东西 |
| 3 | 五段工具执行管线（pre-execute 门 → guard → execute → post-execute → result 观察）+ 类型化 Decision 拦截事件；另带 CC/Codex hooks.json 兼容桥 | 【上游源码】`packages/core/tools/README.md`、`packages/hooks/hooks-claude-code/` |
| 4 | 沙箱拒绝 → 携 `sandbox_permissions + justification` 申请扩权 → 用户审批 → **加宽后只重试一次** | 【上游源码】`.agents/notes/implemented/feature/2026-07-06-sandbox.md` |
| 5 | 模型在会话内自写自装插件（`cordis_define` 等 7 个工具，不可变版本、双半运行） | 【上游源码】`packages/extensions/cordis-host-runner/` |

### 2.2 值得搬的内置能力（阈值见源码，版本敏感）

- **工具结果剪枝**：无模型、超 8192 字符截 head 4096 / tail 1024（【上游源码】`packages/bundle/base/cordis.patch.yml:360-365`）；**外置 spill**：超大结果落盘只留引用，`maxInlineBytes: 50000`。
- **会话**：JSONL + SQLite 双持久化、全文检索（opt-in）、**标题从日志推导**、fork/resume。
- **skills 渐进披露**：首轮只注入 name+description 目录，模型调 `skill` 工具再取全文（【上游源码】`dsh-tool-skill`）。
- **repeat-tool-reminder**：连续重复同工具同参数时注入提醒（循环防护）。

### 2.3 第三方插件里的信号（【上游文档】二手：Composio 盘点 + GitHub topic 页）

| 插件 | 功能 | 对我们的信号 |
|---|---|---|
| DSH-better-sidebar（~2.2k 星） | 聊天旁挂文件树/终端/git diff；**其他插件可注册 tab** | 渲染器与内核分离（ADR-055/059）之后，"侧边工作台"是 web 渲染器的自然扩展 |
| ModLens（~3.2k 星） | 给纯文本模型加视觉工具（OCR/布局/实体） | D11 |
| dsh-TUI | 双 Esc **回退并 fork** 会话 | 与事件溯源架构天作之合（D8） |
| dsh-at-file（~400 星） | 输入框 `@` 文件引用（只传校验过的路径） | D8 |
| dsh-genui | 模型渲染 30+ 交互组件、事件回传 | R5 |
| dsh-mnemon | 三层持久记忆 | 记忆续篇的参照系（D10） |
| dsh-market / dsh-find-plugin | 应用内插件市场 / 让 agent 自己搜插件 | R8 |

## 3. 编码代理产品前沿（第二轮，2026-10）

### 3.1 已成标配（我们 P7 表的既有行全部命中）

云端/后台异步执行、issue→PR 端到端、worktree 并行会话（Claude Code v2.1.49 内建）、hooks+subagents+计划-执行工作流、MCP 支持、多模型 + 用量制定价。【上游文档】uvik（JetBrains 2026 调查的二次汇总，二手）：Claude Code 采用率 39% 居首。

### 3.2 2026 新趋势

| 趋势 | 证据 | 与我们的关系 |
|---|---|---|
| orchestrator-worker 多代理编排成主流（Cursor 3 Agents Window、VS Code 原生多代理 2026-02） | 【上游文档】code.visualstudio.com/blogs/2026/02/05/multi-agent-development 等 | 子 agent（P7 既有行）是地基，编排层记 R5 |
| agent 进 CI（Codex GitHub Action / SDK / @Codex Slack） | 【上游文档】learn.chatgpt.com/docs/changelog | headless 协议（P6 已落地）之上是纯产品包装 → P8 范围第 6 条 |
| 高并发长时程（Jules 100 任务/天、15 并发） | 【上游文档】jules.google | cron + 后台任务（P7 既有行）之后的事 |
| 方案预审 / verification 循环（Codex 执行前生成 2~4 方案；Jules 修码同时自动补单测） | 【上游文档】zackproser.com（二手）、cloud.google.com/blog | D5：plan 模式加多方案预审 |
| 代理舰队治理（GitHub Agent HQ） | 【上游文档】github.com/features/copilot/agents（二手转述） | R5 |
| 大代码库检索是新瓶颈（Sourcegraph CodeScaleBench） | 【上游文档】sourcegraph.com/blog/agentic-coding | R6 |

## 4. 上下文工程与记忆前沿（第二轮）

1. **三件套共识**：compaction / **isolation（子代理隔离）** / agentic memory；隔离被多方评为性价比最高的单一手段。【上游文档】morphllm.com/context-engineering、docs.langchain.com（deep agents）。
2. **tool clearing 是独立技术**：旧工具输出**整段移除**而非摘要，与 compaction 分层并用。【上游文档】platform.claude.com/cookbook（Memory / Compaction / Tool Clearing 三策略对比）。
3. **提示缓存改变设计约束**：「稳定前缀 + 追加式 + 只清工具结果」是默认姿势；**任何重写历史前缀的操作都会击穿缓存**。【上游文档】同上。**对我们的含义**：ADR-071 的「按 seq 水位线替换历史」实现需要复核这一点（待验证 1）——那条 ADR 已经承认「代价是压缩后前缀重建一次」，这里要测的是**代价有多大**，不是有没有代价。
4. **AGENTS.md 已是开放标准**：Linux Foundation 旗下 Agentic AI Foundation 托管，6 万+ 仓库在用；AGENTS.md 优先、就近链、预算是共识形状。【上游文档】agents.md。
5. **ACE（arXiv 2510.04618，被引 400+）**：上下文当**可进化的 playbook**，Reflector/Curator 回路离线蒸馏经验，不动权重即可自提升；与 Letta 的 sleep-time compute 同构——**记忆巩固是后台作业**。工程对应物：任务后蒸馏回写 AGENTS.md/skills。【推断】这是 D10 的理论依据。
6. **记忆无统一标准**，收敛方向是「记忆以 MCP server 形态交付、按当前为真检索」；Mem0/Letta/Zep 三强路线互斥（层 / OS 式运行时 / 时序图谱）。【上游文档】graphlit.com 综述（二手）。
7. **窗口现实**：1M 窗口时代可靠召回约 200K（context rot 研究互证）——大窗口没有改变「该放什么」。【上游文档】trychroma.com/research/context-rot（一手研究）+ Reddit 实测帖（二手）。

## 5. 协议、评测、沙箱、工程化前沿（第二轮）

| 领域 | 状态（2026-10） | 证据 |
|---|---|---|
| MCP | 最新规范 **2026-07-28**：OAuth 2.1（PKCE + 动态注册）、elicitation 双模式（Form：服务器用 JSON Schema 向用户要结构化输入；URL）、registry 与 tool search | 【上游文档】modelcontextprotocol.io/specification/2026-07-28/client/elicitation |
| ACP | 「agent 界的 LSP」：编辑器 ↔ 外部 coding agent 的 JSON-RPC over stdio 协议，Zed 首发适配 | 【上游文档】agentclientprotocol.com；adopter 清单待核实（待验证 3） |
| A2A | Linux Foundation 托管一年，150+ 组织 | 【上游文档】linuxfoundation.org 新闻稿 |
| **Agent Session Protocol（会话存储层）** | 把任意 runtime 的 session log 统一为可恢复/可 fork/可跨 harness 迁移的格式：envelope + 27 种事件类型 + tool call/result 配对 + lineage DAG | 【上游文档】github.com/agent-session-protocol/asp |
| 评测 | Terminal-Bench 4.0 / Harbor：统一运行环境 + 95% CI + 反污染 GUID；SWE-bench Pro 等未取得一手状态（限流） | 【上游文档】tbench.ai |
| 沙箱 | Anthropic 官方架构：bash 工具 + OS 级**双边界（文件系统 + 网络）**，Seatbelt / bubblewrap；prompt injection 被定性为新供应链风险 | 【上游文档】anthropic.com/engineering/claude-code-sandboxing |
| 可观测性 | OTel GenAI 语义约定独立成 `semantic-conventions-genai` 仓库；agent 级 tracing 是最活跃工作项（issue #35） | 【上游文档】opentelemetry.io/docs/specs/semconv/gen-ai |

## 6. 与本仓库的对照：三个撞车点

| # | 本仓库 | 前沿对应 | 决定 |
|---|---|---|---|
| 1 | 【本仓库】`JsonlEventStore`（schemaVersion 头、tool call/result 配对、单写者锁、快照回退、可回放） | ASP 的 canonical session schema（§5） | R4：做一次 schema 对照评估，对齐后免费获得跨 harness resume/fork/handoff |
| 2 | 【本仓库】`adapters/sandbox/{executor,backends/bwrap,backends/seatbelt}` + 读写/网络面 + 默认拒绝不降级（ADR-016） | Anthropic 双边界沙箱架构文（§5） | 方向已对，**不动摇**；dsh 的「拒绝→一次性扩权重试」补产品闭环（D7） |
| 3 | 【本仓库】`packages/protocol`（JSON-RPC over stdio、不认识渲染器与内核，ADR-055/059/062） | ACP（§5） | R3：加 ACP 适配器是被编辑器生态采用的最低成本通道，比自研 IDE 插件便宜一个量级 |

其余对照：【本仓库】P7 未做项（MCP/hooks/skills/子代理/后台任务/worktree/cron/WebFetch/WebSearch/plan 模式，`dev-plan-v2.md` P5 对照表逐条有归属）与 §3.1 标配清单一一对应；v1 的 MCP 实现（`agent/src/{mcp,sse,mcpsubs,mcpnotify}.js`）基于旧规范，**只迁结论不迁代码**（工作规则 4）。

## 7. 决定草案

| # | 决定 | 依据 |
|---|---|---|
| **D1** | **子 agent 提到 MCP 之前**：上下文隔离是三件套里性价比最高的手段，也是编排的地基 | §4.1 |
| **D2** | **MCP 对齐 2026-07-28 规范**：OAuth 2.1（PKCE + 动态客户端注册）、elicitation（Form 模式复用审批卡渲染）、registry / tool search；凭证链不物化进 `process.env`（对齐 ADR-063 的 `apiKeyEnv` 思路） | §5、dsh `credentials-local` |
| **D3** | **hooks 出生即兼容 Claude Code hooks.json 格式**（含 `${CLAUDE_PLUGIN_ROOT}`、exit-code/stdout 编码语义）；skills 的 frontmatter（name/description/whenToUse）同理——生态迁移成本归零 | §2.1 借鉴点 3 |
| **D4** | **skills 渐进披露**：首轮只注入 name+description 目录，`skill` 工具按需取全文 | §2.2 |
| **D5** | **plan 模式带多方案预审**：执行前生成 2~N 个实现方案供用户选择，复用审批卡 | §3.2 |
| **D6** | **工具结果治理**：tool clearing 独立于 compaction（旧工具输出整段移除）；超限结果外置（spill）；重复调用防护（repeat-tool-reminder）；**压缩实现必须保稳定前缀**（复核 ADR-071） | §2.2、§4.2/4.3 |
| **D7** | **审批与沙箱闭环**：拒绝 → 携理由申请扩权 → 审批 → 加宽后只重试一次；用量仪表（token/成本进事件与状态条，`model.usage` 已在日志） | §2.1 借鉴点 4、§2.2 |
| **D8** | **会话体验**：会话头补 cwd 与模型（`HANDOFF.md` §6 已登记缺口）；标题从日志推导；双 Esc 回退并 fork；`@` 文件引用（只传校验过的路径） | §2.3、HANDOFF |
| **D9** | **可观测性**：OTel GenAI 语义约定适配器（事件 → span，住 `adapters/`，对齐 ADR-009 的 zod 边界） | §5 |
| **D10** | **记忆续篇·经验蒸馏**：任务结束后台蒸馏回写 AGENTS.md / skills（ACE 的 Reflector/Curator 回路）；**写入必须过信任闸门**（把 ADR-030 的「未信任不注入」对称扩成「未信任不回写」，回应 prompt injection） | §4.5、§5 |
| **D11** | **视觉工具**：给纯文本模型的 OCR / 布局结构化工具（ModLens 模式），复用 P6 附件通路（ADR-057/058） | §2.3 |
| **D12** | **插件生态三步走**：近期以 MCP + `defineTool()` 为第三方扩展边界 → 中期「能力包」（npm 分发的一组 defineTool + 指令片段）→ 远期评估运行时组合（dsh 的 patch 树模型）；「模型自装插件」记为北极星。R3~R8 见计划 | §2.1、§2.3 |

## 8. 需要落的 ADR（清单，草案）

> **ADR-075~078 已落地**（记忆与项目指令：#69 调研、#70 链与渲染、#71 注入与压缩后重注入、#72 doctor 报告）；ADR 表当前最大编号是 **078**，以下从 **079** 起暂排，实际落表时仍以当时最大编号顺延。远期项（R3/R4）的 ADR 在各自调研产出后另立。

| #（暂号） | 一句话 |
|---|---|
| ADR-079 | tool clearing 与压缩的分层；「稳定前缀不被改写」作为压缩实现的硬约束 |
| ADR-080 | MCP 现代化范围（2026-07-28：OAuth 2.1 / elicitation / tool search；凭证链形状） |
| ADR-081 | hooks 的输入输出格式与兼容策略（CC 格式优先） |
| ADR-082 | OTel GenAI 事件 → span 适配器的边界与语义约定子集 |
| ADR-083 | 会话头补 cwd / 模型与标题推导（是否升 `schemaVersion`） |
| ADR-084 | 记忆回写闸门（未信任不回写；回写产物的事件形态） |

## 9. 任务拆分（草案）

对应 `dev-plan-v2.md` P7 新增行与 R3~R8；均为候选，逐模块开工时按工作规则 1 另出专项调研。

| 任务 | 内容 | 依赖 |
|---|---|---|
| T-A | 工具结果治理：clearing / 外置 / 重复防护 + 压缩前缀复核 | P5、上下文压缩（#68） |
| T-B | 审批与沙箱闭环：扩权重试一次 + 用量仪表 | P2、P3 |
| T-C | 会话体验：会话头补字段、标题推导、回退 fork、`@` 引用 | P6 |
| T-D | 可观测性适配器（OTel GenAI） | P6 组合根 |
| T-E | 记忆续篇：蒸馏回写闸门与后台作业 | 记忆模块（ADR-075~078 拍板后） |
| T-F | 视觉工具（OCR / 布局） | P6 T5–T6 |
| T-G | Plan 模式（含多方案预审） | P3、P5 |
| R3 | ACP 适配器调研（编辑器接入） | P8 后 |
| R4 | ASP 会话格式对齐调研 | P8 后 |
| R5 | 多代理编排（orchestrator-worker、Gen UI、模型自装插件北极星） | 子 agent 落地后 |
| R6 | 大代码库检索 / 仓库知识库 | — |
| R7 | 评测 harness 与任务基准（Terminal-Bench 式） | — |
| R8 | 插件生态路线（MCP 边界 → 能力包 → 运行时组合） | D12 |

## 10. 待验证

1. **压缩是否击穿提示缓存**【推断，需实测】：ADR-071~074 的替换式实现对照两家适配器的缓存命中行为——但 v2 一次真实模型请求都没跑过（`HANDOFF.md` §6），此项排在第一次真连端点之后。
2. **dsh 阈值的版本敏感**：§2.2 的数字来自 0.1.0-rc.5 克隆；引用前对照上游 master 复核。
3. **ACP adopter 清单**：以 agentclientprotocol.com/llms.txt 核实，本轮未取得。
4. **MCP 2026-07-28 规范全文逐节核对**：本轮只直接读到 elicitation 页，OAuth / registry 部分来自二手解析。
5. **限流缺口补查**：SWE-bench Pro / GAIA2 / tau-bench 现状、云沙箱格局、spec-driven development（Spec Kit / Kiro / OpenSpec）2026 状态。

## 11. 附录 A：来源清单

**官方一手**

- Anthropic：context engineering（anthropic.com/engineering/effective-context-engineering-for-ai-agents）、claude-code-sandboxing
- Claude Cookbook：Tool Use — Context Engineering（platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools）
- MCP 规范 2026-07-28：modelcontextprotocol.io/specification/2026-07-28/client/elicitation、/specification
- ACP：agentclientprotocol.com、github.com/agentclientprotocol/agent-client-protocol
- 会话层 ASP：github.com/agent-session-protocol/asp、agent-session-protocol.github.io/docs
- A2A：linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations…
- OTel：opentelemetry.io/docs/specs/semconv/gen-ai、blog/2026/genai-observability、github.com/open-telemetry/semantic-conventions-genai/issues/35
- Terminal-Bench：tbench.ai
- AGENTS.md 标准：agents.md
- VS Code 多代理：code.visualstudio.com/blogs/2026/02/05/multi-agent-development
- Claude Code worktrees：code.claude.com/docs/en/worktrees
- Sourcegraph：sourcegraph.com/blog/agentic-coding
- Google：jules.google、cloud.google.com/blog（Jules 扩展）
- Chroma context rot：trychroma.com/research/context-rot
- ACE：arxiv.org/abs/2510.04618（开源实现 github.com/ace-agent/ace）
- Zep/Graphiti：arxiv.org/abs/2501.13956、github.com/getzep/graphiti
- NVIDIA 沙箱指南：developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows…

**二手（观点/数据需以原始出处复核）**

- uvik.net（采用率，转述 JetBrains 调查）、ssojet.com（基准，转述 Artificial Analysis）
- composio.dev/content/best-deepseek-harness-plugins（插件盘点）
- github.com/topics/dsh-plugin、github.com/awesome-dsh-plugin/awesome-dsh-plugin
- morphllm.com/context-engineering、docs.langchain.com（deep agents）
- graphlit.com/blog/survey-of-ai-agent-memory-frameworks（记忆综述）
- zackproser.com（Codex 方案预审）、digitalapplied.com（Cursor 3）
- firecrawl.dev/blog/agentic-ai-trends、deloitte TMT 2026（市场）
- thenewstack.io、flowtivity.ai（dsh 发布与涨星报道）

## 12. 附录 B：本仓库现状对照（逐条）

| 事实 | 位置 |
|---|---|
| v2 七个核心工具 + `defineTool()` | `packages/cowcat/src/adapters/tools/`（read/write/edit/glob/grep/bash/todo + define-tool） |
| 上下文压缩已落地（ADR-070~074） | `packages/cowcat/src/kernel/{context,compact}.ts`（#68） |
| 会话事件溯源 JSONL | `packages/cowcat/src/adapters/node.ts`（`JsonlEventStore`） |
| headless 协议方法表 | `packages/protocol/src/methods.ts:11-23` |
| 沙箱执行器与真机矩阵 | `packages/cowcat/src/adapters/sandbox/`、`test/sandbox-enforcement.test.ts` |
| 指令链已接线（ADR-075~078） | `packages/cowcat/src/kernel/run-turn.ts`（`ensureInstructions`）、`policy/instructions.ts`（渲染与预算）、`adapters/instructions.ts`（`chain`）；`host.sendTurn` 传入 `InstructionNeeds`；`cowcat doctor` 的 `instr` 行报告加载/跳过。见 `p7-memory-instructions.md` §11 与本文件 §10 的已知缺口 |
| 一次真实模型请求未跑过 | `docs/HANDOFF.md` §6 |
| v1 的 MCP（旧规范） | `agent/src/{mcp,sse,mcpsubs,mcpnotify}.js` |
| P7 未做项归属 | `dev-plan-v2.md` P5 段「与旧版清单对照」表 |
