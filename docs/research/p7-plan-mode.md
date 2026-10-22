# P7 专项调研：Plan 模式（进入/退出契约 + 多方案预审）

日期：2026-10-23 · 状态：调研（只出决定草案与 ADR 清单，不改 ADR 表、不改源码）

## 1. 问题与范围

dev-plan P7 行两件事：

1. **进入/退出契约**：plan 模式是什么、存在哪、谁切换、切换后工具行为怎么变（ADR-032 记为既有缺口，约束 `ExitPlanMode` 的后代实现必须过策略分层）；
2. **多方案预审（D5）**：执行前生成 2~N 个方案供用户选择，**复用审批卡**（上游证据：Codex 执行前生成 2~4 方案、Jules 修码带验证循环——【上游文档】二手，zackproser.com / cloud.google.com/blog，frontier-survey §3.2）。

上游锚点：Claude Code 的 plan mode 是**权限模式**的一种（与 default/acceptEdits/auto/dontAsk 并列）——「Claude reads files and runs read-only shell commands to explore but doesn't edit your source files」【上游】code.claude.com/docs/en/permissions（2026-10-23 抓取）。即：**plan 模式 = 凌驾于规则之上的只读约束**，模型自评不算数（"Permission rules are enforced by Claude Code, not by the model"）。

非目标：auto 模式分类器（不在 v1）；plan 模式下的 Bash 命令级只读判定（见 §6 待验证 1）；CC 的「Tab to amend」改方案交互（v1 用「都不选+补充意见」覆盖）；worktree 隔离方案。

## 2. 结论摘要（决定草案）

| # | 草案 | 一句话理由 |
|---|---|---|
| D1 | Plan 模式是**会话级状态**，事件溯源：`plan.mode-changed { enabled, by: 'user' \| 'plan-approved' }` 折叠成 `SessionState.planMode: boolean` | 状态唯一变更途径是 reduce（【源码】`state.ts:127-306` 无 setter），布尔先例 `compactionOpen`；快照兼容走 ADR-013 replay 兜底（`schema.ts:388-403` 既有策略），不升 schemaVersion |
| D2 | 门控挂在 runCall 的 risk 覆盖点（子代理 ceiling 同位置【源码】`run-turn.ts:805-808`）：`planMode && risk !== 'read' && 工具名 ≠ TodoWrite → 合成 deny`，输出形状照 policy deny（`run-turn.ts:825-827`） | 不落 `policy.decided`（像 ceiling 一样不是规则裁决）；deny 消息模型可读、回合继续；**不覆盖显式 deny**（deny 永远最优先，ADR-024/027）——plan 门控只把 ask/allow 降级 |
| D3 | **Bash 在 plan 模式一律拒**（risk='exec' 一刀切），deny 文案指引改用 Read/Glob/Grep | 命令级只读判定需要解析重定向/包装器/复合命令（CC 的内建只读集合是一整套解析），v1 不值得再造一个可被绕过的半成品；模型改用文件工具探索，能力无损 |
| D4 | 方案预审 = 内核虚拟工具 **`ExitPlan({ plans: [{title, summary}] })`**（Task 先例 ADR-080：内核注入、不在 `deps.tools`、条件上 wire）；只在 planMode 出现，工具描述即契约（无需额外系统注入） | 条件注入有现成路径（`run-turn.ts:632-635`）；工具在 wire 上模型才看得到、才学得到规则 |
| D5 | ExitPlan 执行：emit `plan.proposed { callId, plans }` → `transition('awaiting_approval')` → host 桥问用户（**复用审批卡**，plan.reply）→ emit `plan.decided { callId, choice: number\|null, reason }` → 结果作为 ExitPlan 的 tool 结果回给模型 | 状态机零改动（`awaiting_approval` 既有回路，`turn.ts:14-24`）；方案与抉择都进日志可重放；模型所见 = tool 结果，无需额外消息事件 |
| D6 | 选中方案 → `plan.mode-changed { enabled: false, by: 'plan-approved' }` 自动退出 plan 模式，工具结果写明「用户选择了方案 k《title》，照此执行」；选「都不选」→ 结果带用户 reason，模型修订后重新 ExitPlan，**留在 plan 模式** | 批准即执行是 CC ExitPlanMode 语义；拒绝不留痕在状态里（mode 不变），只留痕在日志（plan.decided） |
| D7 | 切换入口：用户经 protocol method `plan.setMode`（TUI `/plan` 命令）；模型**不能**自己进出；子会话不继承也不注入 ExitPlan（plan 是顶层会话功能，委派工具 Task 在 plan 模式下被 D2 门控） | 「进出由人」是 plan 模式的安全语义（模型自己解锁 = 没有模式）；子会话父已批准才存在 |
| D8 | 无人值守归宿（ADR-032 精神）：plan 评审没有读者 → 不调桥，ExitPlan 直接返回 deny 形状结果「plan review needs a reader; run interactively」，**不暂停**；oneshot 不新增旗标 | 「等 5 分钟超时是最差答复」（ADR-081 ③ 同句）；--yes 不放行方案选择（选择不是权限，没有审计等价物） |
| D9 | TodoWrite 豁免（plan 模式可用）：纯会话内列表、无文件副作用（`todo.ts:29` risk 是 'write' 但载荷不出会话）；按工具名单独豁免有先例（`subagent-roles.ts:23` NEVER_GIVEN 单独点名） | 计划阶段维护任务清单是 plan 模式的核心工作流，拒了它模型只能用文本列计划 |

## 3. 取证方式与局限

- 【上游】code.claude.com/docs/en/permissions（2026-10-23 抓取）：plan 模式在权限模式表中的定义、「由 Claude Code 执行不由模型自评」原则。CC 专门的 plan-mode 文档页已 404（v2.1 文档重组），ExitPlanMode 工具细节无一手来源——相关决定不依赖它。
- 【上游】frontier-survey §3.2：多方案预审趋势（Codex 2~4 方案、Jules 验证循环），二手证据只作方向。
- 【源码】探索代理逐条取证（文件:行号见 §5）。
- 【推断】标注处未实测。

## 4. 上游形状

- **CC plan mode**：六种权限模式之一；进入后「读文件、跑只读 shell 探索但不改源码」；是被执行的约束不是模型自评；退出靠用户切模式或批准计划（ExitPlanMode 工具，细节无一手文档）。
- **多方案预审（D5）**：执行前 2~N 方案供选择，复用审批卡——上游只有二手趋势证据，形状自定。

## 5. 本仓库现状（【源码】）

### 5.1 可复用机制

- **审批桥全链路**（复用审批卡的范本）：内核 `askForApproval`（`run-turn.ts:747-783`，超时 300s）→ host `askApproval`（`host.ts:855-869`，按 callId 挂 pending、一次一问、earlyApprovals 缓冲 8 个）→ protocol `approval.respond`（`methods.ts:41-45`）→ TUI 审批卡（`approval-card.ts:30-66`，`run.ts:555-581` 提交/快捷键）。plan 桥照抄这套：pendingPlan、一次一问、`plan.reply` method。
- **虚拟工具条件注入**：`wireTools`（`run-turn.ts:632-635`）按 `TurnDeps.subagents` 追加 `TASK_SPEC`（`subagent.ts:31-59`）；runCall 在 `tools.get` 之前识别 Task 走内核自有分支（`:788-808, :925-928`）。ExitPlan 照抄。
- **risk 覆盖与合成 deny**：子代理 ceiling（`run-turn.ts:805-808`）在组 ActionRequest 之前覆盖 risk；deny 输出形状（`:825-827`）模型可读。
- **会话状态扩展**：`SessionState` 加字段走「事件 + reduce case」；快照 schema 全字段必填，老快照校验失败自动 replay（`schema.ts:388-403`、`session.ts:244-259`）——新字段零迁移成本。
- **turn 状态机**：`awaiting_approval` 是唯一「等外部输入」状态（`turn.ts:1-24`）；复用它 plan 评审零状态机改动。exit-criteria 投影、TUI 终态集合都不用动。

### 5.2 空白与代价

- **没有 Bash 只读命令分类器**：`assessCommand`（`command-risk.ts:101-107`）只做破坏性告警（rm -rf / git reset --hard 模式），不是只读判定。D3 因此选一刀切。
- **plan.proposed / plan.decided 的 fold**：都是纯事实事件 → reduce 返回 base（`policy.decided` 先例 `state.ts:289-290`）；前端渲染靠 wire 直通通知（`notifications.ts:36-42` looseObject）。
- **protocol 新 method 的完整清单**（照 `approval.respond`）：methods.ts 表 + PARAMS + ResultTable；server.ts switch + handler（有 `never` 穷尽检查）；host.ts 接口；client.ts 接口 + wrapper；refusing-host.ts 补一行；cowcat host 实现。PROTOCOL_VERSION 不 bump（`task.stop` 先例：新 method 靠 `methodNotFound` 兜底）。
- **新事件三件套 + 两处投影**：events.ts union arm → state.ts reduce case → schema.ts zod arm（`test/schema.test.ts:7-16` 编译期锁死 + everyEvent 数组）→ exit-criteria.test.ts 投影 case（`never` 穷尽）→ tui project.ts case → cli oneshot case（无人值守兜底）。
- **TUI `/plan`**：commands.ts 表加项 + `CommandEffect` 新 kind + run.ts apply 分发 + client wrapper；plan 卡渲染仿 approval-card（选项 = 方案列表 + 「都不选」）。
- **TodoWrite risk='write'**（`todo.ts:29`）——D9 豁免的必要性证据。

## 6. 决定草案（给 ADR 的输入）

| 项 | 草案 | 备选（被否/待定） |
|---|---|---|
| 状态位置 | SessionState.planMode（D1） | TurnDeps 布尔：跨 turn 不存活，前端无投影源；preset 档位：preset 是模型能力数据（ADR-046），权限状态混入张冠李戴 |
| 门控形态 | runCall 合成 deny（D2） | rulesForRole 式注入 deny 规则：污染 policy.decided 日志语义（plan 不是用户规则的裁决），且规则语言没有「plan 模式」维度 |
| Bash 处置 | 一律拒（D3） | 命令级只读集合：需重定向/包装器/复合命令解析才不被绕过，v1 造半成品不如不造；列后续 |
| 评审暂停 | 复用 awaiting_approval（D5） | 新状态 awaiting_plan：turn.ts/schema/tui/oneshot 四处联动，收益只是名字更准确 |
| 方案数 | 1..4 接受，描述鼓励 2~3 | 强制 ≥2：单方案场景（小改动）被迫注水；上限 4 对齐上游「2~4 方案」证据 |
| 都不选 | 留 plan 模式 + reason 给模型（D6） | 直接退出 plan 模式：拒绝的语义是「方案不行」，不是「别计划了」 |
| 无人值守 | 不暂停直接拒（D8） | 选第一个方案自动执行：--yes 的语义是放行审批，不是替用户做方案抉择（无审计等价物） |
| 子会话 | 不继承不注入（D7） | 继承 planMode：父批准方案后子会话还在 plan 模式 = 永远执行不了，自相矛盾 |

## 7. 需要落的 ADR（草案）

| ADR | 主题 |
|---|---|
| ADR-124 | Plan 模式定位与门控：会话级 `planMode` 状态（`plan.mode-changed` 事件 + reduce + 快照 replay 兜底）；runCall 合成 deny 的位置/形状/不覆盖显式 deny；Bash 一刀切与命令级只读判定的后续项；TodoWrite 豁免；切换入口（protocol `plan.setMode`、TUI `/plan`）与「进出由人」 |
| ADR-125 | 方案预审契约：`ExitPlan` 虚拟工具（条件注入、输入形状 1..4 方案）；`plan.proposed`/`plan.decided` 事件形状与 fold（纯事实）；评审桥（复用 awaiting_approval + 审批卡 + `plan.reply`）；选中自动退 plan 模式、都不选留模式带 reason；无人值守归宿；oneshot 兜底 |

## 8. 任务拆分

| 任务 | 内容 | 出口标准 |
|---|---|---|
| T1 | 内核：`plan.mode-changed`/`plan.proposed`/`plan.decided` 三事件 + `SessionState.planMode` + runCall 门控（含 TodoWrite 豁免与 Bash 文案）+ `EXIT_PLAN_SPEC` 虚拟工具与执行（含桥接口 `TurnDeps.planReview?`）+ 单测 | 门控矩阵（read/write/exec × plan on/off × 显式 deny 优先）；ExitPlan 全流程（选中/都不选/无桥）；事件可重放；schema 编译期锁过 |
| T2 | host + protocol：`plan.setMode`/`plan.reply` 两 method 注册全套；host plan 桥（pendingPlan 照抄 approval）；TUI `/plan` 命令 + plan 卡组件（复用审批卡交互）；oneshot 兜底；exit-criteria 投影 + cli 出口标准 | methodNotFound 兜底；一次一问；卡片的选项渲染与回答回环；真实协议事件流过 project() |
| T3 | doctor 不新增行（plan 无可报告配置量——切换是运行时行为）；dev-plan 行更新 | — |
| T4 | 真机验收：TUI 交互式会话 `/plan` → 模型探索（read 放行、Bash 被拒）→ ExitPlan 出 2 方案 → 选 1 → 自动退出执行；记录写回 §11 | 真机会话日志可复查 |

## 9. 待验证

1. **Bash 一刀切的真实摩擦**【推断】：glm 级模型习惯先 `ls`/`git status` 再读文件，被 deny 一两次后能否稳定改用 Glob/Read？真机观察；若摩擦大，命令级只读判定立项（需重定向/复合命令解析，单独调研）。【须实测】
2. **方案数的合理上限**【推断】：4 借自上游二手证据；真机看模型给 2 还是给 4，卡片可读性如何。【须实测】
3. **awaiting_approval 复用的语义混淆**【推断】：plan 评审挂在审批状态下，TUI 状态栏会显示「等待审批」字样——文案层混淆不是状态机混淆；TUI 可区分渲染（plan 卡 vs 审批卡）。接受。【源码可验证：TUI 渲染分支】
4. **plan 模式与 compaction 的交互**【推断】：plan 模式不注入额外消息（工具描述即契约），压缩无特殊交互；planMode 是 state 字段不受水位线影响。接受，T1 加一条折叠共存测试即可。【须实测（单测）】
