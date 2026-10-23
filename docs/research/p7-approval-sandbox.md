# P7 专项调研：审批与沙箱闭环（D7 / T-B）

日期：2026-10-23 · 状态：调研（只出决定草案与 ADR 清单，不改 ADR 表、不改源码）

## 1. 问题与范围

dev-plan P7 行：「沙箱/权限拒绝 → **一次性扩权申请与重试**；**用量仪表**（token / 成本进事件与状态条）（D7）｜依赖 P2、P3」。上游信号：dsh 借鉴 4——「沙箱拒绝 → `sandbox_permissions + justification` 申请扩权 → 用户审批 → **加宽后只重试一次**」【上游源码】frontier-survey §2.1；frontier-survey §7.2 的用量/成本信号（`model.usage` 已在日志）。

P2（执行网关含沙箱执行器）、P3（策略、配置与审批协议）均已完成（dev-plan §2 阶段表），依赖就绪。

三件事的边界：

1. **拒绝→携理由扩权→加宽后只重试一次**：deny（含沙箱拒绝）之后，模型有一条「申诉」通路，用户批准后精确重试一次；拒绝后不重复打扰。
2. **沙箱闭环**：沙箱拒绝不再伪装成「启动失败」，扩权批准后该命令可无沙箱执行一次（用户知情）。
3. **用量仪表**：token 状态条已存在（见 §2.5），补**会话累计**与**成本**（preset 配价才有，派生不存）。

非目标：硬编码厂商价目；多层沙箱 profile 的运行时编辑 UI；MCP 工具的扩权（v1 只接 Bash——唯一沙箱消费者）；plan mode 下的写扩权（plan mode 是显式用户意图，批准扩权不代表退出）；审批卡的 UI 重设计（Escalate 复用现有审批卡，零新 UI）。

## 2. 本仓库现状（【源码】）

### 2.1 拒绝路径（无申诉通路）

- `policy.decided` 事件 = `{callId, decision:{verdict, rule, reason}}`【源码】`events.ts:213`；deny 分支直接返回工具错误 `denied by {rule}: {reason}`【源码】`run-turn.ts:839-841`，模型没有任何「问用户」的选项。
- ask 分支的审批桥成熟：`approval.requested`（含 warning，ADR-095）→ host `askApproval`【源码】`host.ts:1065` → verdict `once|always|session|reject`【源码】`policy/approval.ts:4`；答案写 `approval.answered {key, verdict, by}`【源码】`events.ts:243-`。
- grants：`approvalKey(request)`= `name NUL (command ?? path ?? JSON(input))`【源码】`approval.ts:39-44`；`toolGrantKey`=`name NUL *`（session 级粗授权，ADR-094）【源码】`approval.ts:60-62`；fold：always/session → `state.grants`【源码】`state.ts:326-328`；standing grant 命中 → 不再问、记 `by:'policy'` 放行【源码】`run-turn.ts:873-896`。
- **缺口**：reject 不留痕（fold 只记 always/session）——同一动作被拒后再次 ask 会**再问一遍**用户（`refused` 语义无载体）；deny 分支**不查 grants**——即使同会话批准过该 subject，配置的 deny 永远拒（`decide` 的 deny 优先于一切，run-turn 不例外）。

### 2.2 沙箱（拒绝伪装成启动失败）

- 产品契约（ADR-016）：后端不可用 `SandboxUnavailableError`、请求无法满足 `SandboxRequestRefusedError`，**绝不静默降级**【源码】`adapters/sandbox/executor.ts:9-16`。
- 但 Bash 侧：`options.process.run` 抛错统一包成 `failed to start command: ...`【源码】`adapters/tools/bash.ts:148-153`——沙箱拒绝与真的启动失败在模型眼里是同一种错误，无申诉指引。
- 扩权→沙箱加宽已有先例：`ToolGrant.networkApproved` → `decideNetwork` 把 profile 的 `network:'ask'` 放宽为 `'on'`【源码】`ports/index.ts:82-92`、`bash.ts:199-203`。形状就是 `ToolGrant` 加布尔字段。
- v1 唯一沙箱消费者是 Bash（`createTools` 只给 Bash 传 sandbox【源码】`host.ts` createTools 段）。

### 2.3 ExitPlan 虚拟工具先例（Escalate 照此办理）

- 顶层门控：`deps.planReview === undefined || !planMode` 时 ExitPlan 不上 wire、调用读作 unknown tool【源码】`run-turn.ts:800-801`；Skill 同理（ADR-114）。
- 执行形态：`runExitPlanCall` 直接返回 `CompletedCall`，**无 tool.finished**（自己的事件 `plan.proposed` 已留痕）【源码】`run-turn.ts:1052-1082`。
- 桥复用：`awaiting_approval` 状态 + host 侧 pending 桥；无人值守（`deps.unattended`）直接拒绝不挂起【源码】`run-turn.ts:1059-1067`。

### 2.4 顺序与不可覆盖项（run-turn 判定流水线）

`decide`（deny 直接拒）→ plan mode 检查（不覆盖显式 deny，Bash 一刀切）→ read-before-write 门（ADR-049）→ ask/grants【源码】`run-turn.ts:838-866`。**grants 覆盖 deny 的插入点就在 deny 分支内**；plan mode 与 unattended 保持在覆盖之后，不受影响。

### 2.5 用量（一半已完成）

- `model.usage {input, output, cacheRead, cacheCreation}` 已进日志【源码】`events.ts:127-129`，stream 每轮 emit【源码】`run-turn.ts:616`；fold 出 `state.lastUsage`（anchor，ADR-070）【源码】`state.ts:177-`。
- TUI 状态条已渲染 `ctx N% · 入 X · 出 Y`（最后一次）【源码】`tui/src/components/status-bar.ts:55-68`。
- **缺口**：无**跨回合累计**（`lastUsage` 只记住一次）；无**成本**（config/preset 无任何价目字段【源码】`policy/config.ts`、`kernel/preset.ts` grep 无 price/cost）；protocol 的 `SessionSummary` 无 usage 字段【源码】`protocol/methods.ts:84-`。

### 2.6 兼容纪律（复用即可）

新 method 五处注册（plan.setMode 先例）；state 新字段「必填+失败重放」（planMode 先例 `schema.ts:404-406`）；SessionSummary 纯增量（ADR-126 ③）；`ToolGrant` 加字段是纯增量（TypeScript structural，工具拿到旧 grant 也不读新字段）。

## 3. 决定草案（给 ADR 的输入）

| # | 草案 | 备选（被否/待定） |
|---|---|---|
| E1 | **`Escalate` 内核虚拟工具**（顶层 only，ExitPlan 同款门控）：input `{name, command?, path?, justification}`，subject 复用 `approvalKey` 规则；行为=写 `approval.requested`（`rule:'escalation'`、`reason:justification`）走**现有审批桥**，批准 once/always/session → grants 记 `approvalKey` → 模型重试原动作即放行 | 新事件类型承载扩权请求——approval.requested 语义完全贴合，新事件是重复发明 |
| E2 | **grants 覆盖 deny**：deny 分支先查 standing grants（`approvalKey`/`toolGrantKey`），命中记 `approval.answered(by:'policy')` 放行；plan mode（检查在其后）与 unattended（工具不上 wire）**不可覆盖** | deny 永不可覆盖——那「配置误拒」无救济，上游借鉴 4 的整个闭环落空 |
| E3 | **reject 折叠 `state.refused`**：`approval.answered` 的明确 `reject` fold 进 `refused: string[]`（key）；ask/Escalate 的 standing 顺序 = grants → refused（自动拒，记 by:'policy'，**不重复问**）；timeout **不** fold（没人答 ≠ 拒答）；unattended 的自动 reject 不 fold（子代无此语义）。「加宽后只重试一次」的两半齐了：批了=grant 放行一次；拒了=不再打扰 | per-turn 内存表——不可重放，resume 后同一动作又会打扰用户；与事件溯源纪律相悖 |
| E4 | **拒绝文案指引**：deny 输出附「若认为这是误拒，调用 `Escalate` 说明理由」；ask 的 reject 输出同理；justification 长度上限 500 字符（防刷屏式申请） | 只在系统提示里教——模型对具体哪条 deny 可申诉无感知；deny 文案是最近触点 |
| E5 | **沙箱闭环**：Bash 识别 `SandboxRequestRefusedError`/`SandboxUnavailableError` → 专属输出（拒绝原因 + Escalate 指引）；`ToolGrant` 增 `unsandboxedApproved: boolean`（批准 Escalate(Bash,该命令) 后重试时置位）；Bash 照 `decideNetwork` 先例 `decideSandbox`：profile 要求隔离而本次获准无沙箱 → **该次**无沙箱执行，facts.sandbox 记录实际状态（日志诚实） | 批准后永久改 profile——profile 是配置事实，运行时改配置违背「配置即文件」；一次性授权放 grant 才对 |
| E6 | **用量累计 + 成本**：`state.usageTotals` fold `model.usage` 累加（重放自然继承）；`SessionSummary` 增可选 `usage`（host open/create 时从 state 读）；成本=现算（usageTotals × preset 价），**事件不存金额**（派生不存，ADR-126 ② 同款论证）；preset 增可选 `price: {input, output, cacheRead?, cacheCreation?}`（USD/1M token，custom preset 自填），**无 price 不显示成本** | 硬编码厂商价目——必腐烂；成本进事件——派生数据入库，换价后历史日志说谎 |
| E7 | **TUI 复用零新 UI**：Escalate 的审批卡 = 现有卡（rule 显示 escalation，reason=justification 已在卡上）；状态条在 `ctx/入/出` 后加累计与成本（`计 入X 出Y`、`≈$0.02`，有 price 才显示），80 列截断已有 | 为 escalation 做专属卡片——区别只有文案，copy 表加一行即可 |

## 4. 取证方式与局限

- 【上游】dsh 借鉴 4 为 frontier-survey 二手信号（`.agents/notes/.../2026-07-06-sandbox.md`），未取一手源码；「只重试一次」的具体语义（per-turn 还是 per-session）按本仓库事件溯源重建为 grants/refused 对称结构【推断】。
- 【源码】其余全部一手（§2 带行号）。
- 局限：Escalate 被模型滥用的面（每 deny 一次就问一次用户）由 E3 refused + E4 justification 上限共同压住，但「合理的连续扩权」与「骚扰」的边界无实测数据【推断，列 T5 观察】；成本换算的币种只 USD【须裁决】。

## 5. 需要落的 ADR（草案）

| ADR | 主题 |
|---|---|
| ADR-129 | `Escalate` 扩权工具与 grant/refused 语义：顶层门控、复用审批桥、grant 可覆盖 deny（plan mode/unattended 除外）、reject 折叠 `state.refused`（timeout 不折叠）、「加宽后只重试一次」的完整含义、deny 文案指引 |
| ADR-130 | 沙箱闭环：拒绝错误识别与专属文案（不伪装成启动失败）、`ToolGrant.unsandboxedApproved`、批准后该次无沙箱执行的诚实记录（facts.sandbox）、绝不静默降级的边界不动 |
| ADR-131 | 用量累计与成本：`state.usageTotals` 折叠、SessionSummary 纯增量 usage、成本现算不存事件、preset 可选 price 字段（无 price 无成本）、TUI 状态条布局 |

## 6. 任务拆分

| 任务 | 内容 | 出口标准 |
|---|---|---|
| T1 | Escalate 工具（events 无新增；run-turn 虚拟工具 + grants 覆盖 deny + refused 折叠 + 文案）+ kernel/host 单测 | deny→Escalate→批准→重试放行全链路单测；reject→二次 ask 不再问；resume 后 refused 生效（重放） |
| T2 | 沙箱闭环（ToolGrant 字段、bash 错误识别与 decideSandbox、grant 通路）+ 单测 | 沙箱拒绝文案含指引；批准unsandboxed后该次执行 facts.sandbox 诚实；无批准仍拒绝不降级 |
| T3 | 用量累计与成本（state fold、SessionSummary、config price 字段、成本换算、protocol）+ 单测 | 两轮后 usageTotals 正确；无 price 时无成本字段；schema 兼容旧日志 |
| T4 | TUI（状态条累计/成本、escalation copy）+ 文档同步 | TUI 测试；状态条 80 列可读 |
| T5 | 真机验收：规则 deny→Escalate→批准→命令执行；reject→再试不打扰；用量/成本显示；记录写回 §10 | 真机会话日志可复查 |

## 7. 待验证

1. **Escalate 真机自然使用率**：glm-5.3-flash 收到 deny 文案后是否真会调 Escalate（不教系统提示、只改 deny 输出）【须实测】。
2. **状态条 80 列**：累计+成本加入后长会话（大数字）是否可读【须实测，T4 截图/snapshot 定】。
3. **成本币种**：preset price 只声明 USD；多币种不做（v1）【须裁决】。
4. **沙箱真机覆盖**：本机 Windows 无 bwrap/seatbelt，SandboxUnavailable 路径可测；RequestRefused 需 profile 与请求冲突的构造【须实测，T5 构造】。
5. **grants 覆盖 deny 的评审**：安全敏感语义，实现前过 security-reviewer【须执行】。

## 8. 安全评审校准（2026-10-23，security-reviewer/k3-256k）

实现**前**评审结论：结构（复用审批桥、事件折叠、不静默降级）成立，但三条
P0/P1 决定「用户批的东西 ≠ grant 实际覆盖的东西」，必须先进 ADR：

- **P0-1 卡片盲批**：approval.requested 无 subject 字段、审批卡不显示确切
  命令/路径（既有 ask 流程的缺口，Escalate 把它从弱升级为致命——deny 恰恰
  是最需要看清对象的动作）。**修订（新 E8）**：approval.requested 增
  `command?/path?`（与 grant key 同一份值），卡片第一行渲染；escalation
  的 subject 同样跑 `assessCommand` 出 warning；justification 只作补充行。
- **P1-1 once 无消耗**：once 若照草案记 grants 则变「本会话无限次」。**修订**：
  once 记 grants 的同时发 `approval.consumed {key}`（工具放行时），fold 进
  `state.consumed`；standing 检查 = grants 含 key 且 consumed 不含——「加宽后
  只重试一次」成为可重放的精确语义（消费即焚）。
- **P1-2 session 宽度失控**：Escalate 若可答 session，一次点击作废该工具全部
  deny 规则。**修订**：Escalate 选项只给 once/always/reject；deny 覆盖路径
  只认精确 approvalKey，不认 toolGrantKey。
- **P1-3 维度混淆**：deny 覆盖放行沿 approved=true 通路会静默附赠 network
  放宽与无沙箱。**修订**：grant 分维度——Escalate(deny 救济)只覆盖 deny，
  不带 network/unsandboxed；approval.requested 增 dimensions 行，卡片逐项
  列出；unsandboxedApproved **只随 once**（P1-5：always 保留沙箱）。
- **P1-4 `*` key 碰撞（既有潜伏缺陷）**：Bash 命令恰为 `*` 时 approvalKey ≡
  toolGrantKey，一次批准=全 Bash 绕过。**修订**：subject 校验拒 `'*'` 与
  NUL；toolGrantKey 换带引号前缀 `${name}\u0000"*"` 消除碰撞。
- **P2-1 骚扰回路**：Escalate 每回合硬上限 3 次（turn 内存计数，防无限
  变体串行挂起审批桥）。
- **P2-2 渲染注入**：justification/subject 渲染前剥 C0/C1 控制字符与 bidi
  控制符（TUI 渲染层）。
- **P2-3 refused 归一化**：key 计算前 trim + 折叠连续空白（堵「加个空格换
  key」）；「清除拒绝记录」逃生口 v1 不做。
- **P2-4 Escalate 后门**：仅当 decide(subject)=deny 才发起审批（预支授权/
  绕 ask 直接报错）；withoutSandbox 模式要求本会话该 subject 有
  sandboxRefused 记录（Bash 在 facts 标记，run-turn 记 turn 内集合）。
- **P2-5 不向注入面广告申诉路径**：deny 文案保持中性事实；申诉通路写进
  内核系统提示（稳定文本，ADR-078 链），不随工具结果广播。

评审对问题 4 的答复：refused 无法被模型灌水（每条目都需用户亲手 reject；
timeout/unattended 不折叠）。对问题 1 的答复：path/command 混淆不成立
（精确匹配 + canonical），成立的是上述 P1-2/1-4/2-3 三条。
## 9. #180 审查校准（2026-10-23，code-reviewer/k3）

实现后审查：2 P0 + 5 P1 + 5 P2（#181 全部处理）。要点：

- **P0-1（真断裂）**：`EscalationTurnContext` 建在每轮模型循环体内——沙箱拒绝
  落在第 N 轮、申诉只能在第 N+1 轮，轮级集合恒为空，withoutSandbox 链路实际
  不可达；每回合上限形同虚设。修复：上下文提升到回合级。
- **P0-2**：Escalate 的 path 未过 `fs.canonical`——批准的重试按 canonical key
  查 standing，申诉按原始拼写建 key，path 型申诉在 macOS/Windows 上批准即
  失效。修复：键计算前 canonical 化（与 runCall 同源）。
- **P1**：① deny-override 的 once 消费移到 grant 组装处（plan mode /
  read-before-write 闸门之后）——批了却跑不了的调用不再白烧授权；② 申诉的
  approval.answered 记录**生效后** verdict（session/always 被窄化为 once 时
  不折叠进 grants，杜绝静默附赠 ask 通路免问）；TUI 申诉卡不再渲染
  「本会话」行，`s` 键 habit 被明确拒绝；③ deny 覆盖不再置 `approved`
  （networkApproved 只由 ask 通路人答产生——每个维度在自己的行上被批准）；
  ④ subject 行改 wrap 不截断（截断的尾巴正是藏后缀的地方）；⑤ 补测试
  （withoutSandbox 全链路/每回合上限/plan-mode 不烧授权）。
- **P2**：unattended 短路（内核作为库的组合面）；grants/refused 折叠去重；
  formatCost 小于半分钱显示 `<$0.01`（`$0.00` 读作免费）；普通 ask 的
  approval.requested 也带 command/path（所有审批卡都显示确切 subject）；
  消费与 tool.run 之间的崩溃窗口注释（宁可丢授权不可谎称已跑）。
- **环境事故**：本会话中途系统更新把 packages/cowcat 与 packages/protocol
  从磁盘清空（TUI/CLI/docs 幸存）。恢复 = git 还原到 #180 + npm ci +
  按会话记录重放内核侧修复（TUI 修复在盘上幸存）。教训：长会话的未提交
  改动是易失的，审查修复批次应尽快成 PR。
## 10. T5 真机验收记录（2026-10-23）

**结论：全链路真机通过**（glm-5.3-flash 真实 API，`cowcat serve` + 协议客户端，
驱动 `cowcat-tui-accept/t5-as-accept.mjs`，#181 后内核，隔离 HOME + 自定义
price 的 user 配置）。

### 结果

1. **deny → Escalate → once → 重试放行**：glm 收到 `denied by no-blocked-echo`
   后**未加教学即自然调用 Escalate**（调研待验证 1  closure：spec description
   作为申诉指引足够）；申诉事件 `rule=escalation`、`dimensions=[deny-override]`、
   `command=echo blocked`（卡片诚实条款真机生效）；批准后重试 `fail -> ok`，
   `escalation.granted`/`consumed` 均在日志。
2. **用量仪表**：`turn.opened.price` 携带所配价目；`session.open.usage` 返回
   真实累计（input 16937 / output 492 / cacheRead 16576——cache 命中率 ~97%，
   与 T-A 验收的 glm 账单形态一致）；日志 approval pair 完整可审计。
3. **成本显示**：价目为 input 0.11 / output 0.28（USD/1M）时本回合成本
   ≈$0.002——`formatCost` 的 `<$0.01` 档真机有意义（避免 $0.00 读作免费）。

### 观察 / 边界

- 模型自然申诉率：本样本 1/1（小样本，不作推广依据）。
- glm 的申诉 justification 质量可读（说明无副作用），卡片首行 subject +
  理由的结构在真机日志里顺序正确。
- withoutSandbox 链路的真机覆盖需要真沙箱（本机 Windows 无 bwrap/seatbelt），
  由 FakeProcess 全链路测试钉住（#181），标注为「沙箱后端真机未验」。