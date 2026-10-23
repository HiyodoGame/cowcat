# P7 Cron/Worktree 调研：会话内定时任务与并行工作树（#202）

> 状态：**调研稿**（2026-10-24）。本文件只出决定草案与 ADR 清单；**不改 ADR 表、不改源码**（工作规则 3）。
> 关联：`dev-plan-v2.md` P7「Cron」「Worktree」两行、P2 接口债（worktree 兄弟目录写路径）、`research/p7-background.md`（后台任务，已落地 #135~138）、`research/p7-frontier-survey.md`（D1~D12）、ADR-024（deny 永不短路）、ADR-016（refuse, never degrade）、ADR-014（ProcessPort 唯一网关）、ADR-017（路径身份只在 FsPort）、ADR-028（信任门控）、ADR-081（子 agent 收窄先例）、ADR-107~113（后台任务）、ADR-126（会话头 cwd/model）、ADR-131（用量累计）、ADR-137（reflect 后台回合先例）。
> 证据分级沿用 `docs/research/` 的纪律：**【源码】**读实现给 `文件:行号`；**【实测】**本次跑出来的，给脚本与数字；**【上游】**官方文档，给链接与读取日期；**【推断】**未实测，不得作为决策依据。

---

## 0. 结论摘要

1. **Cron 作业是事件，不是配置文件**。`cron.created` / `cron.deleted` / `cron.fired` 落会话日志，调度器是「日志投影 + 宿主心跳」。resume 天然恢复作业表，v1 的 `crons.json` 双写漂移和跨会话串台（实测 bug #4）从结构上消失。【源码 + 上游】
2. **cron 回合 = turn-scoped 无人值守**。调度器触发时给 `runTurn` 传 `unattended` deps（ask → `by: 'unattended'` 拒绝、无 Escalate、无 plan review），与子 agent 的收窄完全同构（ADR-081 ③ 先例）。**这不是会话级开关**——ADR-024 的「deny 永不短路」不动，用户回到终端后交互回合照旧问审批。【源码】
3. **触发语义照抄上游的保守口径**：会话空闲才触发、忙则等当前回合结束（错过不补发）、一次性与 5 字段 cron、本地时区、每会话 50 个上限。7 天过期与 jitter 两个上游机制进开放问题（§9），不在调研里拍板。【上游】
4. **Worktree = 「cwd 是 worktree 目录的会话」**。CLI `cowcat tui --worktree <name>` 由宿主经 ProcessPort 跑 `git worktree add`（宿主创建动作，沙箱 off，失败留现场），会话头 cwd 记 worktree 路径。`.cowcat/worktrees/<name>/` + `worktree-<name>` 分支，从当前 HEAD 建（不追 CC 的 origin/HEAD fresh——本地工具 remote 不可保证）。【上游 + 源码】
5. **信任是创建时继承，不是推导**：主检出受信 → 创建动作把 worktree 路径**显式追加**进 trust store（可审计的继承）；主检出不受信 → 拒绝创建并指 `cowcat trust`。**不做** CC 的「`-p` skip trust check」——那违反 ADR-016 的 refuse, never degrade。【源码 + 上游】
6. **resume 必须恢复 cwd**——这是存量缺口（`buildHost` 恒用 `process.cwd()`），worktree 使它就绪必需：resume 读会话头 cwd 建宿主；目录已消失 → 警告并在启动目录继续（日志只追加，不改历史头）。CC 的「清绑定」在事件溯源里等价于「每次 resume 重新检查、如实警告」。【源码 + 上游】
7. **P2 接口债在此兑现**：`createHost` 增加 `extraWritePaths`，worktree 会话的沙箱 `write.allow`/`read.allow` 追加主检出 `.git` 的 canonical 路径——worktree 里 `git commit` 写的是共享 `.git`（CC 官方明确沙箱放行此写入）。CC 的四条工具调用隔离检查第一版不做：v2 的沙箱写允许已近似覆盖，且那套检查是独立大投入。【源码 + 上游】

---

## 1. 取证方式

| 级别 | 本次做了什么 |
|---|---|
| 【源码】 | 逐文件读 `packages/` 下的端口、内核、宿主、协议、CLI；行号以 2026-10-24 的 `main`（`63f2269`）为准 |
| 【上游】 | Claude Code 官方文档两页：`scheduled-tasks`（/loop、CronCreate/CronList/CronDelete、jitter、7 天过期、Limitations 全节）与 `worktrees`（--worktree、隔离检查、清理、resume 绑定、信任、.worktreeinclude），均 2026-10-24 读取；v1 事故清单读 `docs/archive/fix-plan-2026-10-15.md` |
| 【实测】 | 本调研**没有**跑任何新探针；标注【推断】处实现前必须补实测（§8） |
| 【推断】 | Windows 上 `git worktree add` 的具体行为、trust store 追加写的并发形态、cron 心跳与 reflect 回合的互斥细节 |

---

## 2. 上游对照

### 2.1 Claude Code 会话内定时任务（【上游】，2026-10-24 读取 <https://code.claude.com/docs/en/scheduled-tasks.md>）

| 事实 | 对我们的意义 |
|---|---|
| 任务是**会话级**的；`--resume`/`--continue` 恢复未过期任务；跨会话持久的调度在云端/Desktop/GHA | v2 是事件溯源，作业表从日志投影即可 resume 恢复——比 CC 的「transcript 恢复」更直接（ADR-140） |
| 调度器每秒检查 due 任务，**低优先级入队，回合之间触发**；忙则等当前回合结束，**错过不补发** | 直接采纳为 ADR-141 的触发语义 |
| 三工具 `CronCreate`（5 字段 cron + prompt + 是否周期）/`CronList`/`CronDelete`（8 字符 id），每会话最多 50 个 | 工具面照抄（ADR-143）；50 上限采纳 |
| 全部按**本地时区**解释；扩展语法（L/W/?/名字别名）不支持；DOM 与 DOW 同约束时「或」匹配（vixie 语义） | cron 方言子集照抄，避免自创解析语义 |
| 周期任务 **7 天后自动过期**（最后 fire 一次后自删），防遗忘循环无限烧钱 | 进开放问题 §9-1（v2 按量计费，理由成立，但想给评审一个否决机会） |
| **jitter**：周期任务最多晚半个间隔（上限 30 分钟），`*/5` 反而提前 15 秒（保 5 分钟提示缓存）；整点/半点的一次性任务可早 90 秒 | 进开放问题 §9-2（防 thundering herd 主要是云端 concern；但 `*/5` 提前 15s 的缓存理由对本地轮询同样真实） |
| 自 paced `/loop`（模型动态选间隔）底层是独立的 `ScheduleWakeup` 工具，可 `stop: true`；固定间隔 `/loop 5m` 也是 CronCreate | 第一版不做动态间隔；「N 分钟后提醒我」用一次性 cron 覆盖（ADR-143 被否项） |
| 无人值守 cron 的路径在**云端/Desktop**（本地 `/loop` 要求会话开着且空闲）；云任务默认 auto mode 权限 | v2 的收窄答案不同：turn-scoped unattended（ADR-142），不引入新的权限模式 |
| `CLAUDE_CODE_DISABLE_CRON=1` 可整体禁用 | v2 倾向配置项而非环境变量（config schema 已有现成分层），评审定 |
| Limitations 实录：任务只在进程活着且空闲时 fire；resume 不补发错过的运行；`.claude/scheduled_tasks.json` 仅在 feature-flag 关闭时落盘，**symlink 报错**，且「文件拷到别的目录（如 worktree）会列出但不运行」 | 最后一条印证「作业与创建它的目录绑定」的直觉；v2 用会话日志天然绑定，无此坑 |

### 2.2 Claude Code worktrees（【上游】，2026-10-24 读取 <https://code.claude.com/docs/en/worktrees.md>）

| 事实 | 对我们的意义 |
|---|---|
| `claude --worktree <name>`：建 `.claude/worktrees/<name>/`，新分支 `worktree-<name>`，默认从 origin 默认分支（`worktree.baseRef: "head"` 可从当前 HEAD）；无 remote 回退本地 HEAD | v2 取 `head` 语义为默认（本地工具，remote 不可保证），§5-被否-4 |
| **交互式需要 workspace trust**，未信任时 `--worktree` 报错退出；**`-p` 跳过信任检查** | v2 不做 skip（ADR-016）；改为「主检出受信才允许创建，继承即显式记录 trust」（ADR-145） |
| `EnterWorktree`/`ExitWorktree` 模型工具；进入 `.claude/worktrees/` 外的路径要审批 | 第一版不做模型侧工具（§5-被否-6），CLI 入口足够 |
| 退出清理四规则：干净→自动删（无名会话）/询问（有名）；有改动→询问保留；分支被占用→保分支删目录；无法验证→询问 | v2 第一版取窄口径：交互退出时检查，干净→删 worktree+分支，脏→保留并告知（ADR-144） |
| resume 绑定：resume 时验证 worktree 仍是独立检出；**目录没了→清绑定、在启动目录继续**；无法验证→拒进（交互）/报错（`-p`） | ADR-146 照抄语义；「清绑定」在只追加日志里等价于每次 resume 重查+警告 |
| **隔离四条检查**：写主检出的 Edit/Write 被拦；命令 cwd 落在主检出被拦；git 重定向进主检出被拦（`git -C`/`GIT_DIR`/先 cd）；命令形状无法验证被拦。四条都**不跟踪 shell 实际写盘**（`cp`、重定向拦不住） | 第一版不做（投入大且本身不完备）；v2 的沙箱 write.allow 对真实写盘生效，覆盖更强（ADR-147） |
| worktree 与主检出**共享 `.git`**，官方明确「sandboxing allows those writes，所以 worktree 里 `git commit` 开着沙箱也能用」 | 这就是 P2 接口债的消费点：write.allow 必须追加主检出 `.git`（ADR-147） |
| `.worktreeinclude`（gitignore 语法）把 `.env` 等拷进新 worktree；symlink 路径拒绝创建；filter driver/LFS  Pointer 文件等创建失败矩阵 | 第一版不做 `.worktreeinclude`（开放问题 §9-5）；symlink 拒绝的谨慎口径在 ADR-144 里吸收 |
| 运行期间持 `git worktree lock` 防并发清理；后台/子 agent worktree 有 sweep | 第一版单进程宿主无并发清理者，不做锁与 sweep（§8-4 待验证留下次） |

### 2.3 v1 事故清单（【源码】`docs/archive/fix-plan-2026-10-15.md`，只迁结论不迁代码）

| 事故 | 根因 | v2 对策 |
|---|---|---|
| **cron 全局串台**（P1）：A 会话的 job 在 B 会话触发 | `takeDueCrons()` 读全量 `~/.cowcat/crons.json` 不按 session 过滤（`fix-plan:108-117`） | 作业进会话日志（ADR-140），物理上不可能跨会话 |
| **cron 在 `-p` 下不工作 + TUI cron 回合丢输入**（P1）：扫描只在 REPL 循环里，`-p` 提前 return；REPL 先 await cron 回合再读输入 | 调度器与输入路径耦合在 UI 层（`fix-plan:204-215`） | 调度器是宿主组件（ADR-140），UI 只是订阅者；cron 回合经 `sendTurn` 走与 reflect 相同的宿主通道（ADR-137 先例） |
| crons.json 独立文件与会话日志双写 | 状态两存，漂移无对账 | 单一事实源 = 日志 |

---

## 3. 本仓库现状（行号以 `63f2269` 为准）

### 3.1 Cron 可复用的机制，全部已落地

- **turn-scoped `unattended`**：`runTurn` 的 `TurnDeps.unattended`——设置后每个 ask 立即拒绝并记 `by: 'unattended'`（【源码】`kernel/run-turn.ts:146-153`、`:967-993`），plan review（`:1161-1163`）与 Escalate（`:1229-1234`）各自拒绝。子 agent 已用它做收窄（【源码】`host/host.ts:484-488`）。**cron 回合不需要任何新内核机制**。
- **宿主侧回合注入先例**：reflect 回合在用户回合 completed 后自动启动，占用 `turnStarting` 旗，期间用户 `sendTurn` 吃区分文案的 busy 拒绝（【源码】`host/host.ts:830-857`、`:1066-1079`）。cron 触发器与之同构：检查空闲 → claim → `sendTurn`。
- **后台任务注册表**：会话归属、按 id 停止、`stopAll` 退出清理（【源码】`ports/background.ts:85-101`）。cron 调度器若是宿主组件，退出清理挂同一个 close 序列（【源码】`host/host.ts:1251-1261`）。
- **会话头**：`session.opened` 已带 cwd/model（ADR-126），resume 恢复 cwd 所需的数据已经在日志里。
- **事件 → 协议通知**：durable 事件经 `session.open` replay 自动到达客户端；新增 `cron.*` 事件类型只需扩 `adapters/schema.ts`（先例 `:355-362` 的 background 事件对）与协议的封闭枚举。

### 3.2 Worktree 会碰到的接口与缺口

- **ProcessPort 唯一网关**：所有子进程经它（ADR-014），宿主自己也不例外（MCP spawn、hooks 已是宿主经端口起进程的先例）。`git worktree add` 走 `ProcessPort.run(..., sandbox off)`。
- **信任是启动快照**：`createHost` 启动时读 `FileTrustStore`，`isTrusted(trusted, options.cwd, fs)` 判定本工作区（【源码】`host/host.ts:241-249`）；规则、AGENTS.md、skills、hooks、MCP 项目源全部消费这同一个 `workspaceTrusted`（`:251-373`）。**worktree 目录是新 canonical 路径，默认不受信**——不处理的话 worktree 会话里没有项目规则、没有 AGENTS.md、Remember 项目写被拒。
- **沙箱 profile 组装点**：`resolveSandboxProfile(settings, { cwd, home, fs })` 把配置里的相对路径解析成 canonical 绝对路径（【源码】`policy/sandbox-profile.ts:34-66`、`policy/sandbox-paths.ts`）。**追加写路径的接缝就在这里**：`createHost` 目前把 `settings.write.allow` 原样传入，没有调用方追加通道——P2 登记的接口债（`dev-plan-v2.md:264,268,370`）。
- **resume 不恢复 cwd（存量缺口）**：`cowcat tui` 与 `sessions resume` 都走 `startTui` → `buildHost(context)`，而 `buildHost` 恒 `cwd: process.cwd()`（【源码】`cli/src/cli/host.ts:27,48`、`cli/src/cli/tui.ts:44-58`、`cli/src/cli/sessions.ts:24-30`）。会话头的 cwd 只在 `sessions list` 展示用。worktree 会话 resume 必须落在 worktree 目录里，否则写策略、信任、AGENTS.md 全部错位——这个缺口本模块必须修（ADR-146）。
- **CLI 动词表是数据**：`packages/cli/src/cli/spec.ts`（`sessions list | resume <id>` 在 `:159-162`），加 `--worktree` 是 flag 机制扩一项 + `tui.ts` 分支。
- **协议方法表是数据**：`METHODS`/`PARAMS`/`ResultTable`（【源码】`protocol/src/methods.ts:11-156`），加 `cron.list`/`cron.remove` 三处同改（`task.stop` 是现成先例）。

### 3.3 显式不在本模块的事

- **后台任务**（Cron 的原表内依赖）：已落地（#135~138，ADR-107~113），无需重做。
- **云端/跨会话持久调度**：CC 由 cloud/Desktop/GHA 承担；v2 无云端，本模块只做「会话存活期内」的调度，评审若认为需要守护进程形态，单独立项。
- **rewind、子 agent worktree 隔离**（CC 的 `isolation: worktree`）：子 agent 模块已收口，此处不扩散。

---

## 4. 决定草案

### A. Cron

#### ADR-140（草案）Cron 作业即事件：调度器是日志投影 + 宿主心跳

**决定**：三个 durable 事件进会话日志：

```ts
| { type: 'cron.created';  jobId: string; schedule: string; prompt: string; recurring: boolean; createdAt: number; expiresAt: number | null }
| { type: 'cron.deleted';  jobId: string; deletedAt: number }
| { type: 'cron.fired';    jobId: string; turnId: string; firedAt: number }
```

作业表 = 日志投影（created 减 deleted，过滤过期）；调度器是**宿主组件**（每 1s 心跳投影 due 列表），不是内核状态。`cron.fired` 在入队时写，携带调度器拿到的 turnId，审计链 = fired 事件把 jobId 与回合关联；回合本身是普通 user 角色回合（input = job prompt），usage 自然进 usageTotals（ADR-131），fork 双计语义不变。

**理由**：v1 的串台与 `-p` 不工作两大事故（§2.3）全是「调度状态与会话日志两存」的结构性产物；事件溯源的单一事实源让 resume 恢复作业表成为投影的免费性质，而不是 CC 那种 transcript 特设恢复（其 Limitations 一节列了五种不恢复的例外）。

**代价**：作业表的每次变更都是日志事件（每会话 50 上限内可忽略）；`cron.fired` 让高频任务（`*/5` = 每天 288 条）放大日志——上限与过期机制（§9）就是闸。

#### ADR-141（草案）触发语义：空闲才触发、错过不补、上游保守口径

**决定**：

| 维度 | 口径 |
|---|---|
| 触发时机 | 会话无在跑回合（含 reflect 占用）才触发；忙则等当前回合结束，**错过的不补发**（CC 同款 Limitation） |
| 排队 | 同一时刻多个 due：按 due 时间顺序逐个触发，每个之间重新检查空闲；一个心跳周期最多启动 1 个 cron 回合（防作业表爆炸时雪崩） |
| 语法 | 5 字段 cron（分 时 日 月 周），本地时区；支持 `*`、`*/n`、枚举、区间；DOM+DOW 同约束时「或」匹配（vixie）；扩展语法与名字别名拒绝并给原因 |
| 上限 | 每会话 50 个在册作业（CC 同款）；超限拒绝创建并提示先删 |
| 一次性 | `recurring: false` 的作业 fire 一次后投影自删（写 fired 即终态，无需 deleted 事件） |
| 7 天过期 / jitter | **不在本 ADR**，开放问题 §9-1/§9-2 |

**理由**：「忙则等、错过不补」是上游实测过的保守语义（fire 在回合之间，模型永远不在半句话里被打断）；本地时区 + vixie 语义照抄避免自创方言。

**代价**：长回合会让周期任务看上去「不准时」——这是设计语义（不是时钟漂移），文档与 `cron.list` 的 next-run 展示都要如实呈现「下一次预计触发 = 下一个 due 且空闲的时点」。

#### ADR-142（草案）cron 回合的无人值守收窄：turn-scoped，不是会话级开关

**决定**：调度器触发回合时给 `runTurn` 传 `unattended: 'cron turns cannot ask a human; report what you needed instead'`（文案照子 agent 先例）。效果：ask → `by: 'unattended'` 拒绝并留审计（ADR-024 的 deny 永不被短路不受影响）、Escalate/plan review 不可用。用户回到终端后的正常 `sendTurn` 交互回合**不继承**此收窄——它是每次调用的 deps，不是会话状态。

**理由**：cron fire 时用户按定义不在场（会话空闲 ≠ 人在看）；ask 挂起等审批超时是三种结局里最差的（【源码】`run-turn.ts:146-153` 注释原文）。turn-scoped 与 ADR-081 ③ 的子 agent 收窄完全同构，零新内核机制。

**代价**：cron 回合里模型想要的写操作若未在规则中放行就会被拒，它只能报告「我需要 X」——这是收窄的语义本身，不是缺陷；TUI 里 cron 回合的来源要在回合卡上可见（「定时任务触发」），否则用户会看到模型「无故」拒绝自己。

#### ADR-143（草案）工具面与用户面：CronCreate/CronList/CronDelete + `cron.list`/`cron.remove`

**决定**：

- **模型侧三个工具**（照 CC 形状）：`CronCreate{schedule, prompt, recurring}` → `{jobId, nextRun}`；`CronList` → 作业表（含 nextRun）；`CronDelete{jobId}`。工具写事件（created/deleted）而非直接改宿主状态；调度器只读投影。
- **用户侧两个协议方法**：`cron.list`（含 nextRun 的投影，TUI 面板用）与 `cron.remove`（按 jobId；拒不属于本会话的 id，照 `task.stop` 先例 `methods.ts:81-84`）。用户删除写 `cron.deleted`（by 记 `user`，模型删除记 `model`——审计区分谁终止的作业）。
- **TUI `/cron` 面板**：列表 + nextRun + `x` 删除（交互照 `/tasks` 面板先例）。创建只经模型路径（用户自然语言「每 5 分钟检查部署」→ 模型 CronCreate）；不做用户直填表单的创建 UI。
- **配置键**：`cron: { enabled?: boolean }`（默认开；user 层 only，跨层警告丢弃——照 otel/vision/memory 的既定分层纪律）。禁用时不给模型三个工具（端口缺席先例：background 工具 `host.ts:1373-1375`）。

**被否**：见 §5。

### B. Worktree

#### ADR-144（草案）形态：CLI 创建的「cwd = worktree 目录的会话」

**决定**：

- **入口**：`cowcat tui --worktree <name>`（flag 机制扩一项）；`sessions resume <id>` 因 ADR-146 自动落到会话头的 cwd，无需 worktree 专属分支。`cowcat run --worktree` 第一版**不做**（开放问题 §9-4）。
- **创建**：宿主动作（非模型工具），经 `ProcessPort.run` 执行 `git worktree add .cowcat/worktrees/<name> -b worktree-<name> [base]`，**sandbox off**（宿主创建动作，与 hooks 起进程同类；沙箱内建不出 worktree——要写共享 `.git`）。base 默认当前 HEAD。已存在同名 worktree → 直接复用（CC 的 reuse 语义），不重建。
- **路径纪律**：`.cowcat/worktrees/` 自身是 symlink 则拒绝（照 CC 的谨慎口径）；创建前用 FsPort 核实主检出是 git 仓库（`git rev-parse --is-inside-work-tree` 或读 `.git`），不是则给可操作报错。
- **会话**：`createHost({ cwd: <worktree 路径>, ... })`，会话头 cwd 天然是 worktree 路径（ADR-126 不动）；`AGENTS.md`/skills/hooks/MCP 项目源全部按 worktree 目录发现——worktree 分支上的 `.claude/` 与主检出不同则如实加载分支版（CC「读穿」语义的分支版：我们**不**做读穿，worktree 就是工作区，发现逻辑不重写）。
- **退出清理**（交互式 TUI）：退出时检查 worktree 干净性（`git status --porcelain` 经 ProcessPort）：干净 → 删 worktree + 删 `worktree-<name>` 分支；有改动/未推送提交 → 保留并告知路径与分支；检查本身失败 → 保留（CC「无法验证→询问」的非交互等价：保守侧）。`-p`/`run` 形态（本模块第一版只有 tui）不涉及。

**理由**：「worktree = 新 cwd 的会话」让写策略、信任、指令发现、resume 全部落在既有机制上，不新增会话状态；创建是宿主动作则审批语义干净（用户敲的 flag，不是模型自扩地盘）。

**代价**：模型不知道自己在 worktree 里——工具描述/系统提示要带一句当前 cwd（turn.opened 已有 cwd 进事件流，TUI 状态条照显）；`.cowcat/worktrees/` 要建议进 `.gitignore`（doctor 行）。

#### ADR-145（草案）信任：创建时显式继承，主检出不受信则拒绝创建

**决定**：`--worktree` 创建路径上，宿主先查主检出的 `workspaceTrusted`：

- **受信**：创建成功后把 worktree 的 canonical 路径**追加写入** trust store（与 `cowcat trust` 同一存储、同一 canonical 纪律），警告通道告知「已继承主检出信任」。追加是显式记录（可在 trust 文件里审计「何时因何被加」），不是运行期推导。
- **不受信**：拒绝创建，报错指 `cowcat trust`（先信任主检出再来）。**不做** CC 的「`-p` skip trust check」——ADR-016 refuse, never degrade；也不做「推导式继承」（按 repo identity 运行时判断）——启动快照纪律（ADR-028）要求信任是读到的记录，不是算出来的。

**理由**：CC 在 worktree 里的行为等效于继承（项目配置加载、审批写回主检出），说明「同一仓库的 worktree 与主检出同信任」是用户预期；显式记录让继承可审计、可单独撤销（把那条路径从 trust 文件删掉即回到不受信）。

**代价**：trust 写侧无需新机制——`FileTrustStore.add(path)` 已存在（canonical 去重、read-modify-write、未知键保留，【源码】`adapters/trust.ts:86-96`），创建路径上调它即可；继承发生在创建时——主检出之后被撤销信任，worktree 里的**已开会话**当次生命周期仍按启动快照走（与 ADR-028 现状一致，新开会话才反映）。

#### ADR-146（草案）resume 恢复 cwd：绑定检查 + 消失警告，只追加不改历史

**决定**：

1. `sessions resume <id>`（及 `tui --session`）在建宿主前读会话头 cwd：存在 → `chdir`（进程级）后照常 `buildHost`；不存在（老会话）→ 维持现状。
2. cwd 存在性/可用性检查：目录没了 → **stderr 警告**（「会话的工作目录 <path> 已不存在，在 <启动目录> 继续」）并继续；目录在 → 直接用。每次 resume 都重查，不缓存「清绑定」结论（事件日志只追加，CC 那种「写回清绑定」在 v2 里等价于重查）。
3. 拒绝「改历史」：会话头的 cwd 事件永不改写。worktree 被删后 resume 进启动目录，是显式的降级路径，警告即审计。

**理由**：存量缺口（§3.2）在 worktree 之前就存在（跨目录 resume 的会话，工具与策略看的不是同一棵树），本模块把它修掉；worktree 只是让修复从「应该」变「必须」。

**代价**：resume 从 A 目录恢复到 B 目录的会话，宿主信任/rules 都按 B 重算——这正是目的；但相对旧行为是**行为变更**（旧：静默在 A 跑），要在 changelog 与 ADR 里写明。

#### ADR-147（草案）写策略：兑现 P2 接口债，worktree 会话放行主检出 `.git`

**决定**：

1. `createHost` 增 `extraWritePaths?: readonly string[]` 与 `extraReadPaths?: readonly string[]`：在 `resolveSandboxProfile` 之前拼入 `settings.write.allow` / `read.allow`（经 `resolveEntries` 统一 canonical 化，ADR-017 纪律不变）。
2. worktree 会话默认追加：`write.allow += [<主检出>/.git]`，`read.allow += [<主检出>/.git]`（canonical；`.git` 可能是文件——worktree 的 `.git` 是指针文件，主检出的才是目录，取主检出侧）。理由照 CC 原文：worktree 与主检出共享 `.git`，worktree 里 `git commit` 必须能写它。
3. worktree 源码树本身不用追加：`write.allow` 默认含 `.`→ 解析为会话 cwd = worktree 目录，已覆盖。
4. 用户配置可显式再扩（config 的 `sandbox.write.allow` 机制不变，`extraWritePaths` 是宿主侧追加通道，配置侧看不到也不该看到）。

**理由**：这就是 P2 验收时登记的接口债（`dev-plan-v2.md:264,268,370`：「worktree 兄弟目录作为额外写路径传入」）的兑现点；接缝选在 profile 组装前，保持「策略的全部裁决都能由配置表达」——追加是宿主的**事实输入**（这是会话的真实工作区），不是新的裁决类型。

**代价**：沙箱 `off` 时这些允许无操作（沙箱不跑）——worktree 会话关沙箱跑 git 天然不受限，与现状一致；CC 的四条隔离检查（§2.2）第一版不做，防「写回主检出源码树」靠沙箱开着时的 write.allow 边界，评审认为不够再立项。

---

## 5. 被否决的方案

| # | 方案 | 否决理由 |
|---|---|---|
| 1 | cron 作业存独立文件（v1 的 crons.json 或 CC 的 scheduled_tasks.json） | v1 两大事故（串台、`-p` 失效）全是状态两存的结构性产物；事件溯源下投影免费（ADR-140） |
| 2 | cron 回合继承交互式审批（ask 正常问、挂起等用户） | 用户按定义不在场；问→超时是三种结局里最差（`run-turn.ts:146-153`）；收窄是 feature 不是妥协（ADR-142） |
| 3 | 会话级 unattended 开关（cron 会话整个变无人值守） | ADR-024 的 deny 不短路不受影响，但交互回合会被连坐；turn-scoped 先例（ADR-081 ③）零新机制 |
| 4 | worktree 从 origin 默认分支创建（CC 默认 `fresh`） | v2 是本地工具，remote/网络不可保证；`head` 语义为默认，将来有云端形态再补 fresh |
| 5 | 模型侧 EnterWorktree/ExitWorktree 工具（CC 同款） | 第一版 CLI 入口覆盖全部用例；模型自扩工作区的审批语义（进哪、写谁、怎么退）是另一个模块的量 |
| 6 | CC 四条工具调用隔离检查照抄 | 投入大且本身不完备（不跟踪 shell 实际写盘）；v2 沙箱 write.allow 对真实写盘生效，覆盖更强（ADR-147） |
| 7 | CC 式 `-p` 跳过 worktree 信任检查 | 违反 ADR-016 refuse, never degrade；收窄口径是「不受信就拒绝创建」（ADR-145） |
| 8 | ScheduleWakeup 独立工具（self-paced 动态间隔） | 「N 分钟后提醒我」= 一次性 cron 已覆盖；动态间隔的预算语义（每轮现选）单独评审，不做进第一版 |
| 9 | `.worktreeinclude`（拷 gitignored 文件进 worktree） | 真实需求存在（`.env`），但第一版可用「worktree 里自己 setup」顶过；开放问题 §9-5 留下次 |
| 10 | 信任按 repo identity 运行期推导（worktree 天然继承主检出信任） | ADR-028 启动快照纪律：信任是读到的记录不是算出的；推导式继承无法单独撤销、跨文件系统边界时 repo identity 判定脆 |

---

## 6. ADR 清单（草案编号 140~147，待 ADR 表确认）

| ADR | 标题 | 一句话 |
|---|---|---|
| 140 | Cron 作业即事件 | `cron.created/deleted/fired` 落会话日志；调度器 = 日志投影 + 宿主 1s 心跳 |
| 141 | 触发语义 | 空闲才触发、错过不补、5 字段 vixie 子集、本地时区、50 上限、一次性 fire 即终态 |
| 142 | cron 回合收窄 | turn-scoped `unattended` deps；无 Escalate/plan review；交互回合不连坐 |
| 143 | 工具与用户面 | CronCreate/CronList/CronDelete 模型工具 + `cron.list`/`cron.remove` 协议方法 + TUI `/cron`；`cron.enabled` 配置键（user 层） |
| 144 | Worktree 形态 | `cowcat tui --worktree <name>` 宿主经 ProcessPort 建 `.cowcat/worktrees/<name>`（HEAD 基点）；交互退出按干净性清理 |
| 145 | 信任继承 | 主检出受信 → 创建时把 worktree 路径显式追加 trust store；不受信 → 拒绝创建 |
| 146 | resume 恢复 cwd | resume 读会话头 cwd 建宿主；目录消失 → 警告并在启动目录继续；只追加不改历史 |
| 147 | 写策略接口债 | `createHost.extraWritePaths/extraReadPaths`；worktree 会话追加主检出 `.git` 的 canonical 路径 |

---

## 7. 实现任务拆分（草案）

跨包顺序 **cowcat → protocol → cli/tui**（`file:` 依赖要求前者先构建）。一个 PR 一个任务；docs 与代码同 PR（工作规则 5）。

| # | 包 | 任务 | 依赖 | 验收 |
|---|---|---|---|---|
| T1 | cowcat | `cron.*` 三事件（events/schema/state/投影）+ `policy/cron` 纯函数（5 字段解析、next-fire 计算、due 排序、50 上限、过期过滤） | — | 单元：方言子集逐个用例（照 CC 文档例子）、vixie OR 语义、时区、夏令时边界【推断→实测 §8-6】 |
| T2 | cowcat | CronCreate/CronList/CronDelete 工具（写事件、投影作答）+ `cron.enabled` 配置键（user 层 only） | T1 | 工具契约测试（窄化字段真实存在、垃圾入参 ok:false）；禁用时工具缺席 |
| T3 | cowcat | 宿主调度器：1s 心跳、空闲检查（含 reflect 占用）、每周期至多 1 个、`unattended` deps 触发、cron.fired 写日志、退出清理挂 close 序列 | T2 | 宿主测试：due→触发→fired 关联 turnId；忙时等待不补发；占用互斥与 reflect 同旗【待验证 §8-3】 |
| T4 | protocol | `cron.list`/`cron.remove` 方法 + `cron.*` 事件 wire（schema 枚举 + replay） | T1 | 协议测试：方法往返；事件 replay 到达；他会话 id 拒绝 |
| T5 | cowcat+cli | resume 恢复 cwd（建宿主前读头 + chdir + 消失警告）+ `createHost.extraWritePaths/extraReadPaths` + worktree 创建动作（ProcessPort 建/复用/symlink 拒绝/非 git 报错）+ trust 显式继承 + 退出清理检查 | T3 | 宿主测试：resume 落对目录；extraWritePaths 进 profile canonical；不受信拒绝创建；清理四分支（干净/脏/未推送/检查失败） |
| T6 | tui | `/cron` 面板（列表/nextRun/x 删除）+ cron 回合来源标注（「定时任务触发」） | T4、T5 | 帧快照测试；回合卡来源行 |
| T7 | cli | `tui --worktree <name>` flag + spec 表 + doctor 行（.cowcat/worktrees gitignore 建议、worktree 可用性） | T5 | doctor 输出；flag 帮助 |
| T8 | docs | ADR-140~147 落表、dev-plan P7 两行收尾、HANDOFF | T1~T7 | 与代码同 PR |

真机验收（T9，照各模块先例）：glm 真机会话里模型自然语言建 cron（1 分钟间隔一次性任务）→ fired → 回合无人值守收窄可见（ask 拒绝 by 'unattended' 留审计）→ TUI `/cron` 删除；`cowcat tui --worktree` 建树 → 会话 cwd/trust/写策略实证 → 改文件退出保留 → resume 回 worktree。

---

## 8. 待验证（实现前必须补齐，全部为【推断】级）

1. **Windows `git worktree add` 行为矩阵**：路径含空格、已有同名分支、`.cowcat/worktrees` 不存在时 git 是否自建目录、`git worktree remove` 的退出码语义。本机有 git，可直接实测。
2. **trust 追加写的并发形态**：`FileTrustStore.add()` 已是 read-modify-write（`adapters/trust.ts:86-96`），单进程内顺序调用即可；要确认的是 serve 多客户端同刻 `cowcat trust` + worktree 创建两条写路径交错时行为可读（Node 单线程 + await 交错，最坏是后写覆盖前写——同文件两入口都要走 add() 而非裸写文件）。【推断】实现时把两条路径都钉到 add() 上即可。
3. **cron 心跳与 reflect 的互斥**：两者都要 claim 会话空闲。reflect 用 `reflecting` + `turnStarting` 双旗（【源码】`host/host.ts:830-848`）；cron 触发器必须消费同一对旗，否则 cron 回合能与 reflect 回合并发进同一日志。【推断】照抄即安全，实现时以测试钉住。
4. **git worktree lock**：第一版不做锁与 sweep，但要在 ADR-144 里写明「宿主运行期间不防外部 `git worktree remove`」；实测外部 remove 对在跑会话的影响（工具 cwd 消失的表现），把结果写进文档限制项。
5. **`cron.fired` 与 turn 的关联**：fired 写日志在 sendTurn 前（turnId 预先 mint）还是后（补写）。前者会让「fired 但 send 被拒」留下 fired 尸体；后者需要事件改写。倾向前者 + 投影把「无后续 turn.opened 的 fired」显示为「已入队未执行」。实现时用例钉住。
6. **cron 解析的夏令时/时区边界**：`0 9 * * *` 在夏令时切换日的行为依赖 JS `Date` 语义；用例固定下来，不追完美。

## 9. 开放问题（留给评审）

1. **7 天过期**（CC 有）：v2 按量计费，防遗忘循环烧钱的理由成立；但本地工具的用户也许就是要跑一个月。取 = 作业 7 天后自删（写 `cron.deleted` by 'expiry'）；不取 = 只靠 50 上限。倾向**取**，但请评审确认。
2. **jitter**（CC 有）：防 thundering herd 主要是云端 concern，单机意义小；但 `*/5` 提前 15s 保提示缓存的理由对本地轮询同样真实。倾向**只做「`*/5` 提前 15s」这一半**（缓存理由是真实的，herd 理由不是），或全不做。请评审定。
3. **禁用开关的形态**：`cron.enabled` 配置键（本草案）还是 CC 的 `CLAUDE_CODE_DISABLE_CRON=1` 环境变量？倾向配置键（与 otel/vision 分层纪律一致）。
4. **`cowcat run --worktree`**：CI 在隔离树跑的用例真实存在（CC `-p --worktree` 支持），但 run 形态的清理语义（非交互不能询问）要单独设计。第一版做不做？
5. **`.worktreeinclude`**：`.env` 拷不进 worktree 是实测会踩的坑（CC 专门做了文件）。第一版不做，是否在文档里给「worktree 里手动 setup」的指引？
6. **周期任务到期是否「最后 fire 一次」**（若 §9-1 取过期）：CC 是 fire 一次再删。照抄还是安静删除？倾向照抄（有头有尾，模型能交代）。
7. **cron 回合的 subagents**：cron 回合无人值守，Task 子 agent 在其下跑时子 agent 本就收窄（ADR-081）——无新语义，但要在 T3 测试里覆盖「cron 回合委托子 agent」不挂审批。
