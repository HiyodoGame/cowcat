# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-23（P7 第八个模块记忆续篇·经验蒸馏全链路收尾）**。
> 交接时仓库状态：**`main` = `62eb148`，工作区干净；最新发布仍为 `v1.0.0-beta.3`（本批次未发版）。**
>
> **证据分级**：**【源码】**读代码；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（v2 跑 `dist/`）；**【CI 远端】**GitHub Actions；**【真机】**真实模型 API 跑出的会话日志；**【上游】**官方文档/上游源码；**【推断】**未实测，不作为决策依据。
>
> **归属**：本会话产出 **#147~#194**（Skills、工具结果治理、Hooks、Plan 模式、会话体验、审批与沙箱闭环、可观测性、记忆续篇·经验蒸馏八个 P7 模块全链路 + 收尾）。

---

## 1. 本次会话做了什么

八个 P7 模块，各自走完整链路「专项调研 → ADR → 实现 → post-merge 审查修复 → 真机验收」：

### 已完成模块（概要）

- **Skills（#147~152）**：ADR-114~117；T4 真机自然触发 2/2。
- **工具结果治理 T-A（#153~157）**：ADR-118~120；clearing 派生视图/spill 50KB/repeat 轮末批量；T5 三机制全触发、零 400、cache 88%–99%。
- **Hooks（#159~163）**：ADR-121~123；CC hooks.json 兼容 v1（六事件 command-only、五配置源叠加、trust 门）；T5 block-rm 照抄 CC 文档形态零改写生效。
- **Plan 模式（#165~169）**：ADR-124~125；planMode 会话级状态 + ExitPlan 方案预审复用审批卡；审查 P0 = 超时重试被陈旧 pendingPlan 杀回合（approval 桥同病同源一并修）；T4 真机：门控拒写→模型自适应→2 方案→选中退模式→UNLICENSE 落盘。
- **会话体验（#171~175）**：ADR-126~128——
  - **会话头/标题**：session.opened 可选 cwd/model（不升版本）；标题不存只派生（首个 prompt 截断 40 字符）；SessionSummary 纯增量。
  - **session.fork**：事件重放式（parent role 'fork'、seq/ts/sessionId 重铸、失败删半截日志）；源无在跑回合才允许；fork header 继承源 cwd/model。
  - **@ 文件引用**：turn.send 扩 files；host 校验（绝对/UTF-8 fatal/32KB/8 个）后回合前注入 prompt.attached；失败拒整个 send；TUI parseAtRefs（词边界+路径字符+存在性过滤）。
  - **审查捎带修的真竞态**：attach/subscribe 的 buffer flush 由 queueMicrotask 改同步——原实现里 subscribe 后微任务前到达的事件会超车缓冲队列（表现为 [1,3,2] 乱序），该竞态自接缝诞生即存在。
  - **rewind 明确不做**（grants/锁/header 三重坑，后续立项条件 = 先答「截断后授权归哪」）。
  - T5 真机：@ 注入作答、fork 重放继承实证（fork 新回合无附件即答出源上下文）、标题/cwd/模型全字段可见。
- **审批与沙箱闭环（#178~182）**：ADR-129~131——
  - **Escalate 申诉**：内核虚拟工具（顶层门控）复用审批桥；仅 decide=deny 才受理；选项无 session；escalations 与 grants 完全分离（专用事件对 + 折叠，once 消费即焚=「加宽后只重试一次」的可重放形式）；reject 折叠 refused（被拒不再打扰）；每回合 3 次上限；subject 拒 `*`/NUL（修 P1-4 潜伏碰撞）。
  - **grants 覆盖 deny**：同会话人工批准可覆盖配置 deny（只认精确 key；plan mode/unattended 不可覆盖）；deny 覆盖不附赠 network/沙箱维度（各维度在自己的行上被批准）。
  - **沙箱闭环**：两类沙箱拒绝不再伪装成启动失败（专属文案 + Escalate 指引）；ToolGrant.unsandboxedApproved 只随 once，照 decideNetwork 先例 decideSandbox。
  - **用量仪表**：state.usageTotals 折叠（fork 继承）；session.open 应答携带 usage；turn.opened 带 preset price（可选）；成本现算不存事件、无 price 不显示。
  - **审批卡诚实（安全评审 P0-1）**：approval.requested 带 command/path/dimensions，卡片 subject 首行 + wrap 不截断 + stripControl（C0/C1/bidi）。
  - **实现前 security-reviewer 评审**（10 条全部落实）；**实现后 code-reviewer 抓到 2 P0**（EscalationTurnContext 轮级建导致 withoutSandbox 链路不可达；Escalate path 未 canonical）——全部修复（#181）。
  - T5 真机：glm **未加教学自然申诉** 1/1、once 重试放行、price/usage 全字段真机可见（cache 命中 ~97%）。
- **可观测性（#184~188）**：ADR-132~134——
  - **边界**：span 是事件流的纯派生视图（`adapters/otel/` 翻译器 + OTel 绑定），内核/policy/ports 零改动；host 组合根挂 subscribe tap（**遥测订阅先于 delivery**）；重放安全（subscribe 只接 live emit）；**fork 如实双计**（与供应商计费现实一致）；翻译器永不 throw、关闭 flush ≤1s 吞错。
  - **语义子集**：`invoke_agent`(回合)/`chat {model}`(每轮 CLIENT，usage 四字段直映 ModelUsage、finish_reasons 协议词映射)/`execute_tool`(每调用)；内容属性默认不导出（上游 Opt-In + PII）。
  - **审查抓到 3 P1**（#187）：provider.name 生产死代码（`session.opened` 早于订阅 → EventStore 端口加 `readHeader()` 有界读、adopt 后 prime——**Required 属性原本永远缺席，测试假象掩盖**）；畸形 endpoint 拖死 createHost（协议白名单——WHATWG 把 `localhost:` 当合法 scheme）；subagent 子会话不进遥测（其 token 是真实花费）。
  - **配置**：user config `otel` 块（endpoint/headersEnv，schema 带 `^https?://`）；project/session 层携带显式警告并丢弃；env `OTEL_EXPORTER_OTLP_ENDPOINT` 优先；**密钥只走 env**；otel 不进 index 根导出（不加载 node:http 传输图）。
  - T4 真机：span 树完整到达 OTLP receiver、provider.name/conversation.id 全字段在场、**span 级 usage 与 usageTotals 对账一致**（glm cache ~99.6%）；观察：otlp-http exporter 默认发 **application/json** 不是 protobuf。

## 2. 测试基线

| 包 | 通过 | 说明 |
|---|---|---|
| cowcat | 860+ | 逐文件全绿（host 46、remember 10、observability 17、approval 13、escalation 4、bash 25、config 24、schema 14 等） |
| protocol | 43 | |
| tui | 119 | **必须 Node 26**（本机 Node 24 是 FFI 假失败） |
| cli | 31 | |

**本机环境注意**：有两个外部 `du` 进程长期跑满磁盘 IO，全量并行的计时敏感测试（background/bash/process）本地随机 flake、**逐文件全绿**；CI 为权威门（三平台绿）。改完跑 `npm test`（含 lint），别只 `npm run build`。

## 3. 新增 ADR（本会话）

ADR-114~128（前五模块：114~117 Skills、118~120 工具治理、121~123 Hooks、124~125 Plan、126 会话头与标题、127 session.fork、128 @ 文件引用）· **129~131 审批沙箱（129 Escalate 与 grant 精确语义**（覆盖 deny、refused 折叠、once 消耗语义、审批卡 subject、维度分离）· **130 沙箱闭环**（拒绝识别、unsandboxedApproved 只随 once）· **131 用量累计与成本**（usageTotals、price 可选、成本现算不存事件）——126~128 已按 #174 审查修订，129/131 已按 #180/#181 审查修订。

## 4. 未验证 / 风险

- **会话体验**：fork 万级事件的重放时延未实测；相对 @ 路径的 resume 跨目录语义（已知语义未真机）；TUI @ 无自动补全。
- **Plan 模式**：Bash 一刀切摩擦样本少；TUI 方案卡真人点击未验。
- **Hooks 已知偏差**（调研 §11.1）：updatedToolOutput 形状、纯文本 stdout、Windows 占位符、trust 目录语义。
- **T-A 遗留**：clearing 保留窗口三档对比、大会话缓存对照。
- **approval 桥语义变更**（#168）：超时后同回合下一次 ask 现在替换陈旧 pending 而非拒绝——行为变更，无已知外部依赖。
- **attach 语义变更**（#174）：subscribe 同步 flush——对服务端调用顺序的约束不变（server 先回复+重放再 subscribe），但自定义 host 消费者若依赖微任务延迟需知。
- **审批与沙箱闭环**：withoutSandbox 的真沙箱后端真机未验（本机无 bwrap/seatbelt，FakeProcess 全链路钉住）；Escalate 自然申诉率样本 1/1；成本只 USD；network/沙箱维度各问各的（exec ask + 申诉同回合会问到两次——真机已观察，属维度分离的设计结果）。

## 5. 开放 issue

无。

## 6. 下一步建议

1. **P7 下一个模块，用户选**：视觉工具（D11）、Cron/Worktree；或八个已完成模块攒一批发 `beta.4`。
2. **rewind**：立项前必须先答「截断后 always/session 授权归哪、锁怎么收、0 行 header 怎么办」。
3. **发版**：八个模块（Skills/T-A/Hooks/Plan/会话体验/审批沙箱闭环/可观测性/记忆蒸馏）攒一批发 `beta.4` 由用户定。

## 7. 会话踩坑（新增）

- **`@types/node` 的 assert 带断言签名**：`assert.equal(x.ok, false)` 后 TS 已收窄，守卫 if 会被 `no-unnecessary-condition` 报——收窄后直接访问。
- **事件驱动测试的时序**：completed 事件到达客户端 ≠ 主机清理完成；断言「拒绝切换」类行为要轮询。根治法（#174）：清理挂在**事件送达时同步做**，不留微任务窗口。
- **微任务 flush 是竞态温床**：「subscribe 后 queueMicrotask flush」会被期间到达的事件超车；要保序就同步 flush。
- **本机外部 `du` 进程**让全量测试 10 倍慢、计时测试随机 flake——逐文件绿即代码绿，CI 是权威。
- PowerShell here-string 不转义 `''`；带 CRLF 的文件做 .NET Replace 前先确认匹配；改完必须 `git branch --show-current`。
- **环境重启会清空含 junction 的 node_modules 树**（本会话 packages/cowcat 与 protocol 整包被清空，TUI/CLI 幸存）：恢复 = `git checkout -- <pkg>` + `npm ci` + 按依赖序重建 dist（protocol → cowcat → tui → cli）；未提交的审查修复按会话记录重放。教训：审查修复批次应尽快成 PR，别把大改留在工作区过夜。
- **记忆续篇·经验蒸馏（#190~194）**：ADR-135~137——
  - **写路闭环**：`Remember` 工具是记忆写路唯一门（四目标 instructions/skill × user/project；指令 append 或 `rewrite-cowcat-section` 标记段；skill 整文件写、frontmatter 仅 name/description；caps 8K/32K/1024）；**无自由路径参数**（枚举目标，逃逸构造上不可能）；**内核零改动、零新事件**（approval.* + tool.finished 全审计）。
  - **信任镜像（ADR-136 ② 两层）**：未信任 workspace 时 host 注入条件 deny 规则（`when: {tool: 'Remember', command: '<target>'}`）**在 ask 之前**拒绝（不问必然失败的写）；Escalate 申诉可推翻 deny → **工具内信任门兜底**拒绝重试（不可申诉）——「未信任不回写」是 ADR-030 的对称句。
  - **approvalKey 载体**：`commandInput: 'target'` 借道（ADR-027 data-only 声明不动内核）——approvalKey = name+目标；对某目标 always = 该目标后续写入免展示免问（显式接受的产品语义，卡面**无内容预览**，要更紧用规则 scoped ask/deny）。
  - **后台蒸馏（ADR-137）**：`memory.reflect` 默认 off（user 层 only，跨层警告丢弃）；on 时用户回合 completed 后自动起受限反射回合（仅 Remember 工具、无 subagents/skills/hooks/planReview/escalation；reflecting 旗覆盖整个回合；完成监视器仅非 reflect 安装防重入）；unattended/plan mode/失败回合不反射；reflect 占用期间用户 sendTurn 吃**区分文案**的 busy 拒绝。
  - 审查 #193：1 P0（maybeReflect×@文件 sendTurn 竞态可致日志永久不可 replay——守卫+claim 同一把 turnStarting 旗）+ 4 P1（description YAML 注入面→JSON.stringify；reflect 占用文案；ADR-136 ④ 文档诚实化；Escalate 链与 always 宽放补测试）+ 6 P2（子代理 NEVER_GIVEN 加 Remember 等）全修。
  - T4 真机：glm 自主 Remember 落盘 `~/.cowcat/AGENTS.md`、审批卡 subject 真机可见、reflect 回合真机触发、**新会话 probe 命中沉淀经验**（写路闭环到读取侧全通）。
- **reflect usage 与会话总额不可区分**（审查 P2-10 登记）：反射回合的 model.usage 混入 usageTotals，TUI 无法区分后台蒸馏花费——未来用 turn.noted 打标或按 turnId 归类。
- **reflect 占用会话的未来选项**（审查 P1-3 评估记录）：用户回合到达即 abort reflect 曾被考虑后放弃（审批 promise 悬挂到超时）；若将来要做，需先解决 askApproval 的 abort 语义。
- **configWarnings 通道无消费者**（#63 存量）：ADR-134 依赖它把「project/session 层 otel 被丢弃」送达用户，当前 CLI/TUI 均不读——下一模块顺手接上或开 issue。
- **OTel JS 依赖线**：api/core/resources/sdk-trace-base 锁 1.30.x + exporter-trace-otlp-http 0.57.x（peer 对齐）；**该 http exporter 发 application/json 不是 protobuf**；3.x core 与 sdk-trace-base 2.x peer 冲突勿混升。
- **真机驱动要当「橡皮图章用户」**：回合会停在 awaiting_approval 直到每个问题被回答——驱动循环里自动 respondApproval，别只等 completed。
- **exec ask 与申诉会问两次**：维度分离的设计结果（waiver 不豁免 exec 风险询问），真机已观察；不是 bug，但写验收驱动时要预期到。
- **`tsc`/`npm test` 必须在包目录里跑**：从仓库根 `npx tsc` 会命中 npm 的 tsc 占位包（"This is not the tsc command you are looking for"）。

## 8. 构建与测试（不变）

```bash
cd packages/cowcat && npm test        # pretest = tsc + ESLint；改完必须跑这个
cd packages/protocol && npm test
cd packages/tui && npm test           # 本机用 npx --yes node@26.12.0 --test dist/test/
cd packages/cli && npm test
```

探针 `node tools/lint-probe.mjs`。真机素材：`~/.cowcat/config.json` preset `zai-coding-plan/glm-5.3-flash`；验收驱动在 `C:\Users\Con_WKK\AppData\Local\Temp\cowcat-tui-accept\`（t4-plan-accept.mjs、t5-se-accept.mjs 可复用）。
