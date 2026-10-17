# 03 策略、端口与执行

## 策略引擎

### 模型

策略是一个纯函数：`decide(request, rules) → Decision`。

- 请求（`ActionRequest`）描述一次工具调用：名称、风险等级（`read` / `write` / `exec` / `network`），外加规则可以进一步收窄的两个事实——`path` 与 `command`（P3 T1/T2a，ADR-027）。**本文档曾写「P2 起扩展为进程、文件路径、网络域名等请求种类」，该扩展并未发生**——P2 的产出是三个端口而非请求种类；实际扩的是工具请求自身的字段。
- `path` / `command` 由**工具自己声明**、由内核生产：`ToolSpec.pathInput` / `commandInput` 指名输入里的哪个字段承载它们，`kernel/run-turn.ts` 读取后填进请求。`path` 在这里**过 `FsPort.canonical`**，因为 ADR-017 让 FsPort 独占路径身份——规则比较的必须是同一份拼写；`command` 保持原文（前缀语义，不含 `&&`/管道感知）。声明了字段而输入里没有可用值（缺失、非字符串、空串）时**字段缺省而不是空串**，否则一条 `when.path` 规则会被一个写错的工具入参变成「匹配一切」。
- 规则（`Rule`）包含名称、匹配函数、裁决（`allow` / `ask` / `deny`）与可选理由。**匹配函数在 P3 改为结构化字段**（配置无法表达函数，而 P3 的出口标准要求「全部裁决都能由配置表达」），见 ADR-027。
- 合并顺序：**deny 压过 ask，ask 压过 allow**，同一裁决内第一条命中的规则生效。顺序与规则书写顺序无关，这是有意的：不允许一条后写的 allow 悄悄覆盖前面的 deny。理由与外部对照见 ADR-023。
- **`deny` 永不被短路**：无人值守模式只改变 `ask` 的归宿，`deny` 在任何模式下都执行。这是**有意偏离旧版**——旧版 `permissions.js:58` 让 yolo 在一切规则之前一票放行，`deny` 一并失效。见 ADR-024。
- **没有命中任何规则时返回 `ask`**，规则名为 `no-rule-matched`。未知的动作永远不会被静默允许。

### 为什么不沿用旧版的 `classifyCommand`

旧版把风险分级（静态命令分类）、权限（用户批准）、沙箱（OS 隔离）三件事散在 `sandbox.js`、`permissions.js`、`loop.js` 里，loop 直接调用三者。v2 的做法是：

- 策略引擎只产出**裁决**，不执行任何东西；
- 执行由 ProcessPort 与沙箱执行器完成；
- 审批由前端完成，内核只发出 `ask` 并等待结果。

三者可以独立替换和测试。

### 默认规则

`policy/defaults.ts`：读操作直接允许（`reads-are-free`），写、执行、网络操作**由兜底询问**。

**只有一条规则，缺的那条是刻意的**（ADR-034）：「写/执行/网络都要问」不是一条规则，而是 `decide` 在没有规则命中时的返回值（`no-rule-matched` → `ask`）。写成规则会**遮蔽所有 `allow`**（`ask > allow`，ADR-023），于是没有任何配置能让一次写操作被允许——P3 出口标准第一条无论写什么都不可达。默认值的位置就是兜底，不是规则；外部参照同样如此。

默认规则集里**一条 `deny` 都没有**，所以 `deny > ask > allow` 的 deny 分支在生产里不可达，只被测试规则触发（实测见调研探针 P10）。规则语言的决定、旧版 DSL 的表达力边界与外部对照见调研 [`../research/p3-policy.md`](../research/p3-policy.md) §4 与 ADR-027。

### 信任门控（ADR-028）

`policy/trust.ts` 的 `trustedRules(config, trust)` 产出 `decide` 真正收到的那组规则。未信任时 **`deny` / `ask` 立即生效、`allow` 不生效**——**收紧不需要授权，放宽才需要**。

门控的粒度是**按来源**，这一点 ADR-028 没钉死、由 T3a 定：

| 来源 | 未信任时 |
|---|---|
| `default`（内建基线） | 不受门控 |
| `user`（你自己的机器级选择） | 不受门控 |
| **`project`（仓库里的文件——正是被信任的那个东西）** | **其 `allow` 不生效** |
| `session`（本次会话显式选择） | 不受门控 |

字面执行「未信任时 `allow` 一律不生效」会连 `reads-are-free` 一起废掉，变成每次读文件都问一遍——没人会用的 agent。外部参照的门控粒度同样是按来源。

配置的层来源标注在 `SourcedRule.origin`（`policy/config.ts`）。它刻意**不是 `Rule` 上的字段**：配置文件不能自己声明自己的来源（`ruleSchema` 是 strict 的，写了会被拒）。

### 信任记录的存储（ADR-025 决定 3）

`ports/trust.ts` 定义 `TrustStore`，`adapters/trust.ts` 给出 `FileTrustStore`。**独立于配置文件**，因为信任是关于某个目录的事实，不是一项设置——旧实现把两者放进同一个对象再整体当成最高优先级的配置层套上去，那是项目配置被静默丢弃的根源。

落盘形态（**由实现定的**，ADR-025 只给了原则）：

```json
{ "trusted": ["<canonical 绝对路径>", "..."] }
```

- **不设 `version` 字段**。版本字段只在「不匹配时有有用的处置」时才值得，而对一串目录名而言没有——你无法迁移一个读不懂的路径。格式变了的后果由形状检查承担：无法识别的文档读成**空 + `problem`**，即「未信任」，方向是安全的。
- **写入时保留未知顶层键**。这个文件是**工具写的不是人写的**，未知键意味着更新的构建放进去的——与会话日志同理（`adapters/schema.ts`），与手写的配置文件**相反**（后者是 strict）。
- **`load()` 永不抛**，读不到就是空 + `problem`。空 = 未信任 = 安全方向。但仍然**上报**而不是吞掉：静默重置一个用户的信任且不作声，正是那种要花半天排查的安静。
- **`add()` 会抛**。与 `load()` 的差别是刻意的：读不到东西是个安全的默认，而一个要求信任某目录却没被告知写入失败的用户，会相信一件不成立的事。
- **整个列表要么全可信要么整体拒绝**。含非字符串条目的列表不会被「过滤掉坏的、留下好的」——那样读出来的结果是「信任，但少了几个」的安静谎言。
- 判定按**目录身份精确匹配、无继承**（`isTrusted`）。子目录必须自己被信任过；父目录不会被顺带信任。这是上一阶段实测过的旧版语义（调研探针 T4/T5），不是假设。
- **`canonical` 只能纠正真实存在目录的大小写**：最深已存在祖先回退会把尾巴原样接回去（ADR-017）。所以一个拼错的路径**保持为不同的身份**——这正是想要的，信任一个错字不该顺带信任真目录。

### 审批协议（ADR-031、ADR-032）

回答只有三种：`once` / `always` / `reject`（ADR-031 决定 2）。**超时是拒绝，不是错误**，`by: 'timeout'` 把它与人说的话区分开——`tool.finished` 的文案也不同（`rejected by user` vs `rejected: no answer within the approval timeout`），好让模型知道发生的是哪一件。默认等待 `DEFAULT_APPROVAL_TIMEOUT_MS = 300_000`（5 分钟，够人读完一段 diff，又不至于让无人值守挂死）。

**顺带修掉一处旧版缺口**：旧实现的审批是一个裸 `await`，`signal` 全程不被检查——一个被取消的会话会一直停在问题上等人回答。现在等待期间也响应取消（监听器在 `finally` 里摘掉，否则长生命周期的 signal 上会越积越多）。

**`always` 的粒度是「这一个动作」**，不是「这个工具」（ADR-031 决定 3）。键由 `approvalKey` 算：

```ts
request.command ?? request.path ?? JSON.stringify(request.input ?? null)
```

即 Bash 按整条命令、文件工具按路径、其余按整个入参——与旧版 `pickKeyInput` 的做法一致。**只按工具名做键是不安全的**：那会让「批准了一条 `Bash`」变成「本次会话内所有 `Bash` 都放行」，而旧版正是刻意避免这一点。

**两条旧版缺口在 v2 里还封不了**，因为它们依赖的功能 v2 还没有：`subagent.js:58` 从 `tools === null` 推断出 yolo 权限、`planmode.js:122` 的 `allowedPrompts` 绕过 `validateRule` 直注入 `rules.allow`。v2 既没有子 agent 工具也没有 plan 模式，**没有可封的代码**。它们记在这里作为**未来实现这两处时的约束**（ADR-032）：子 agent 不得从「没有工具列表」推断出权限，`allowedPrompts` 必须走与配置规则同样的校验与分层。

### 审计（ADR-033）

`ports/audit.ts` 定义 `AuditRecord` 与 `AuditSink`；`policy/audit.ts` 是消费者；`adapters/audit.ts` 给出 `JsonlAuditSink`（一行一个 JSON 对象，**追加**——一个后续运行能截断的审计线索不是审计线索）。

**它是事件流的消费者，不是回合循环里的一个分支。** 它只被 `Session.subscribe` 喂数据，没有任何途径影响一个回合。这让「审计永远不会弄坏会话」在**结构上**成立，而不是一句承诺。

**一行 = 一次工具调用**：把 `policy.decided` + `approval.answered` + `tool.finished` **join** 起来。这是**投影不是副本**：日志里已经有裁决、审批与结果，照抄会让同一个事实有两个家、进而可能互相矛盾。审计加的是那个 join，以及只有执行方才知道的运行时事实。

**`sandbox: null` 表示「没上报」，不是「没施加沙箱」。** 这是整个消费者存在的理由——一条把「工具什么都没说」写成 `mode: 'off'` 的记录，是在断言一件它并不知道的事。

**「永不抛」只约束消费者本身，不约束被审计的端口。** 实测的承诺边界是：`ProcessPort.run`（最强）、`FsPort.*`、`PlatformPort.sandboxBackends` 有「永不抛」保证，而 `ToolPort.run`、`ModelPort.stream`、`EventStore.append` 没有。把两者混为一谈会让审计失去意义——**拿不到事实时必须记录「拿不到」，而不是静默不写**（旧版 `sandbox.js:180` 的空 catch 是反例）。

**写失败是计数 + 上报，不是吞掉**：`accept` 永不抛（一个坏掉的 sink 不能把会话带走），但失败计入 `summary()`/`close()` 的 `failed` 与 `lastFailure`。**静默失败的审计比没有审计更糟——它看起来像证据。** `close()` 会等在途写入落定，否则会话结尾的报告可能在写入还在失败时报出零失败。

**所有档位都写实际生效的 `mode`/`backend`**（旧版只在 `system` 档写，是为了与历史日志逐字节一致；v2 从未发布，没有这个包袱）。

### 项目指令文件（ADR-029、ADR-030）

`ports/instructions.ts` 定义 `InstructionPort`，`adapters/instructions.ts` 给出 `FileInstructionSource`；**哪些文件、以及能不能注入**是纯策略，在 `policy/instructions.ts`。

- **候选名只有 `['AGENTS.md', 'CLAUDE.md']`**，`AGENTS.md` 在前。`AGENTS.md` 是被 60k+ 项目使用、由 Agentic AI Foundation 托管的开放格式；`CLAUDE.md` 作兼容回退——与外部参照同一安排。旧实现把专有的 `COWCAT.md` 排在最前（`agent/src/project.js:6`），于是一个写了标准文件的仓库**永远读不到它**。
- **就近取一份**：从 `cwd` 向上走，第一个命中的赢（标准的规则是「closest wins」）。
- **存在但为空的不算**：否则一个误建的空 `AGENTS.md` 会遮蔽旁边有内容的 `CLAUDE.md`。
- **走查从 `fs.canonical(cwd)` 开始**，所以 `/var/x` 与 `/private/var/x` 走同一批目录。旧实现正是栽在这上面（7 个 macOS CI 失败）；而标准自己的迁移建议就是**建符号链接**，同一个坑换个形状又会来一次。内容取 `trim()` 后的结果。
- **未信任时不注入，并且明确告知**（ADR-030）：`InstructionDecision` 里 `skipped-untrusted` 是**独立的一种结果**而不是并进 `none`，因为两者要区别对待——「没有文件」是安静的，「有文件但没用」必须说出来。`describeInstructionSkip` 给出带**行数**的提示（不然用户不知道被拦下多少）。
- **未信任的理由**：`AGENTS.md` 标准明确说列在文件里的测试命令**会被 agent 自动执行**，所以它不是纯文本注入而是**命令执行的入口**。这与信任门控同一精神——指令文件是「放宽 agent 行为」的内容，未信任时不生效。
- **信任后重载不需要缓存失效**：决策是 `(file, trust)` 的纯函数，`/act` 之后再判一次即可。

**尚未实现**：ADR-029 提到的「`instructions` 式显式 glob 追加」（用于 monorepo 里把根目录与子包的 `AGENTS.md` 一起引入）。glob 展开需要目录列举，是一块更大的面；与 CLI 一起做。

## 配置（ADR-025、ADR-026）

配置的层级、合并语义与错误报告。实现是 `policy/config.ts`（纯逻辑）+ `adapters/config.ts`（zod 解码边界）。

**三层，外加内建默认**：

```
内建默认（DEFAULT_CONFIG，不可被省略覆盖）→ 用户级 → 项目级 → 会话级
```

旧实现有七层，其中一层（`STATE_KEYS`）在 CLI 覆盖**之后**才应用，且文档从未提及——于是一个项目提交的 `sandbox` 键会被用户自己的状态文件静默丢掉。这里没有对应物：**运行时状态是独立的存储，永不参与配置合并**（ADR-025 决定 3）。

**列表键拼接，不覆盖**（ADR-026）。这样安全有一个值得写下来的理由：`decide` 按**类别**选裁决（deny → ask → allow），所以同一类别内每条规则的裁决都相同——**顺序只决定报出哪条规则，从不决定结果**。因此拼接不可能让后一层削弱前一层，而「撤销一条上层 allow」写在 `deny` 里即可，不需要引入 `!` 负向语法。测试里有一条专门钉这个。

**环境变量不是层**（ADR-025 决定 2）。旧实现有一层，结果是「项目文件里的设置」与「启动它的 shell 里的设置」每次启动都可能不一致——同一台机器因谁启动而得到不同策略。shell 变量与设置键谁优先**逐键决定**，由拥有该键的模块声明。`rules` 刻意没有环境变量覆盖：表达成 shell 变量的策略无法被评审。

**错误分两级，判据是失败在哪儿**（ADR-025 决定 5）：

| 失败 | 处置 |
|---|---|
| 文档不可用（不是 JSON、不是对象、**未知的顶层键**） | **拒绝加载**，并报出源文件与 zod 路径 |
| 单条 `rules` 条目不可用 | **跳过该条、保留其余**，并告警 |

所以 `rules` 是**逐条**校验的：写成 `z.array(ruleSchema)` 会因为一条坏规则而拒绝整个文件。

**配置对象是 strict 的，与会话日志相反。** 日志里的未知键意味着「更新的写入方」，strip 掉是对的（`adapters/schema.ts`）；配置文件的未知键是**手写拼错**，静默忽略正是 ADR-025 决定 5 要防的那类 bug。所以 `"rulez"` 是拒绝，不是告警。

**尚未定的一件事**（不阻塞 T2b，留给有消费者时）：**配置文件叫什么、放哪里**。`loadConfig` 接受的是**已读出的文本**加上来源标识，谁来读文件属于组合根的职责（与 `SessionDeps` 注入 `cowcatVersion`/`shell` 同理）。v2 目前还没有 CLI（P6），先固定路径会是给一个不存在的消费者做决定。

## 端口

端口是内核对外部世界的全部依赖，定义在 `src/ports/`。

| 端口 | 状态 | 说明 |
|---|---|---|
| `Clock` | 已实现（Node 适配器） | 时间戳，测试中用固定时钟 |
| `IdSource` | 已实现（Node 适配器） | 回合与调用 ID |
| `EventStore` | 已实现（JSONL 适配器） | 追加与读取会话日志 |
| `LockPort` | 已实现（Node 文件锁） | 会话单写者锁，见 [02-kernel.md](02-kernel.md#单写者锁) |
| `SnapshotPort` | 已实现（JSON 文件快照） | 回放加速；缺失或损坏一律回退全量回放，见 [02-kernel.md](02-kernel.md#快照) |
| `ModelPort` | 接口已定，适配器 P4 | 流式模型调用，带 `AbortSignal` |
| `ToolPort` | 接口已定，工具 P5 | 工具规格 + 执行 |
| `ProcessPort` | **已实现**（P2 T4，Node 适配器） | 唯一的子进程网关：脱敏、截断、终止都在里面；超时与取消走同一条终止路径（ADR-014、ADR-015）。沙箱执行器待做（T5），`system` 档在注入执行器前**显式拒绝**，不降级（ADR-016） |
| `FsPort` | **已实现**（P2 T3，Node 适配器） | 路径身份：canonical / samePath / kindOf / exists，**同步**；缓存挂实例且只在找到现存祖先时写入（ADR-017） |
| `PlatformPort` | **已实现**（P2 T2，Node 适配器） | shell 解析（绝对路径 + 真跑验证）、进程树终止策略、沙箱后端**真跑**探测；结果按会话记忆一次（ADR-018） |

## 进程执行网关（ADR-014）

旧版的问题：Bash 工具、后台任务、MCP stdio、hooks、子 agent 各自 `spawn`，沙箱只覆盖 Bash，所以 MCP 与 hooks 永远在沙箱之外。v2 的设计是：**所有子进程只能经过同一个 `ProcessPort`**。

```
ProcessPort.run(spec, signal)
  spec: { argv, cwd, env(未脱敏的输入), stdin?, timeout, outputCap, sandbox }
  → 网关按 sandbox 档脱敏 env、截断输出（保留尾部 + 丢弃计数 + truncated 布尔）
  → 启动（POSIX：detached 自成进程组；Windows：taskkill /T /F 的对象）
  → 取消或超时：终止整棵进程树（与超时同一条路径）
  → 返回 { exitCode, signal, stdout, stderr, truncated, termination }
```

**契约里的三条边界**，每条都来自实测（[调研 §2 与附录 B](../research/p2-ports.md)），不是推断：

1. **Windows 必须「一次 `/T` 解决」**。`taskkill /T` 按父子关系枚举，直接子进程一旦先死，它就 exit 128（`没有找到进程`），那棵树永久够不着。所以终止路径内部禁止「先单杀、再树杀」这种两步写法。
2. **回退必须上报**。taskkill 不可用时回退 `child.kill()` 可以，但结果里的 `termination.residuePossible` 必须为真——「我们请求过」不等于「它没了」。
3. **自建会话的后代不在保证范围内**。一个自行 `setsid()` 的后代能逃出 `kill(-pgid)`，且父进程死后连按 ppid 都找不到它。契约写明这条边界，而不是暗示「全杀干净」。沙箱路径是例外：`bwrap --die-with-parent` 由内核 pidfd 兜底。

`termination` 区分两件事：平台**能**做什么（`TerminationStrategy`，来自 `PlatformPort`）与某一次运行**实际**做了什么（`TerminationMethod`）。Windows 上 `supportsGraceful: false`——实测 SIGTERM 不可捕获，没有优雅期可用。

没有任何模块可以绕过网关直接 `child_process.spawn`：这条由 `packages/cowcat/eslint.config.js` 里一条独立 pattern 强制（`src/adapters/` 之外禁 `node:child_process` / `node:fs` / `node:os`），并由 `tools/lint-probe.mjs` 验证它真的会报错。

## 环境变量脱敏（ADR-015）

脱敏在网关内做，且按**执行档位**而不是按调用方：`light` 与 `system` 都脱敏，`off` 明确不脱敏。调用方传「想要什么环境」，不传「拼好的环境」——旧版 `background.js` 那种把已剥离的键回灌的做法，在结构上不再可能发生。

规则集**沿用旧版三项**（保留列表、形状正则 `(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|PRIVATE)`、显式 `deny` 的精确名与 `/regex/` 两种形式），因为它们有测试、每条都有理由；**变的是覆盖面与汇报**：

| | 旧版 | v2 |
|---|---|---|
| 覆盖路径 | 9 条子进程路径里只有 Bash 的 `light` 档 | 全部（都经 `ProcessPort`） |
| `system` 档 | 因 `mode !== 'light'` 的分支写反而**不脱敏**（与文档矛盾） | 脱敏 |
| 后台任务 | `{ ...process.env, ...env }` 把剥离的键**回灌** | 结构上不可能发生 |
| 汇报 | 只有 UI 文案 | 返回 `removed`（只记名字不记值）与 `ignoredDeny`（坏正则不再静默忽略） |

规则集是纯函数，放在 `src/policy/env.ts`：它决定子进程环境**允许**有什么，是策略问题而不是运行时问题；适配器只负责把它应用上去。

脱敏**不是安全边界**：它减少误发。`light` 档不提供 OS 级隔离，凭据文件在 `light` 档完全可读，MCP server 以完整权限运行。这条定位同时写进 `SECURITY.md`，避免把「env 干净」读成「凭据安全」。

## 沙箱执行器（P2，ADR-016）

`SandboxExecutor` 是 ProcessPort 的一个包装策略，不是 Bash 的特例：

| 执行器 | 平台 | 来源 | 状态 |
|---|---|---|---|
| `light` | 全平台 | 无 OS 隔离，仅审计与脱敏 | P2 |
| `seatbelt` | macOS | 旧版 `backends/seatbelt.js`（已在 macOS CI 真实验证） | P2 迁移 |
| `bwrap` | Linux（含 WSL2） | 旧版 `backends/bwrap.js` | P2 迁移 |
| 无（`system` 档拒绝） | Windows 原生 | — | 见 [05-platforms.md](05-platforms.md) |

迁移时保留旧版的已知结论，不重新猜测：

- Seatbelt 的 profile 语义（last-match-wins、specific deny 压过 wildcard allow、根 inode 与 `/etc` `/var` 符号链接等）以旧版 `docs/fix-plan-2026-10-15.md` 第二十轮为准；
- macOS 的 `network: 'on'` 不可用且不可降级，这一结论来自真实 macOS 15 的夹逼实验，v2 保持相同的拒绝语义。

## 沙箱执行器（P2 T5）

`system` 档由执行器决定**怎么跑**，生成器是纯函数，只有执行器本身不纯（要建目录、要问探测结果）。分层：`policy/` 决定策略的**含义**，`adapters/sandbox/backends/` 把策略变成命令行，`adapters/sandbox/executor.ts` 做后端选择与拒绝判定。

| 文件 | 职责 | 纯？ |
|---|---|---|
| `policy/sandbox-defaults.ts` | 默认拒绝/允许清单、私有 `/tmp` 上限 | 纯 |
| `policy/sandbox-paths.ts` | `~` / 相对 / glob 拒绝 / 规范化 | 纯（经 `FsPort` 问文件系统） |
| `adapters/sandbox/backends/bwrap.ts` | 策略 → `bwrap` argv | 纯（文件系统探针注入） |
| `adapters/sandbox/backends/seatbelt.ts` | 策略 → `sandbox-exec` argv + SBPL | 纯 |
| `adapters/sandbox/executor.ts` | 后端选择、拒绝、私有临时目录生命周期 | **不纯** |

### 拒绝有两种，消息必须不同

| 情形 | 错误类 | 例子 |
|---|---|---|
| 后端**跑不了** | `SandboxUnavailableError` | Windows 没有后端；bwrap 被 AppArmor 挡住 |
| 后端能跑，但**这个请求满足不了** | `SandboxRequestRefusedError` | macOS 的 `network: 'on'`——沙箱工作正常，但名字解析回不来 |

复用同一个错误类会对着一个沙箱完全正常的机器说「sandbox "system" is not available here」，把用户引向错误的方向。两者**都不可降级**（ADR-016）。

### 三条来自实测的规则

- **加固单独探测**：bwrap 的可用性（不带 flag）与加固能力（`--unshare-user --disable-userns --assert-userns-disabled`）是**两次**探测。内核拒绝加固只说明沙箱更弱，不说明它坏了；把它报成不可用会逼用户关掉沙箱，不加探测就发 flag 会让第一条真实命令失败。
- **不存在的写路径必须上报**：绑一个不存在的源会让整条命令失败，所以只能跳过——但跳过意味着沙箱永远建不出该路径，因此必须写进限制项。
- **私有 `/tmp` 有上限**：`--tmpfs /tmp` 默认拿到内存的一半且是 RAM 支撑，实测 19.5 GiB。固定 2 GiB 并 `--perms 1777`（真实 `/tmp` 的形状，默认 tmpfs 是 0755）。上限是**实测生效**的，不是写进 `df` 的装饰。

### bwrap 的挂载顺序是承重的

挂载按命令行顺序生效、**后者覆盖前者**。两个读 profile 因此要求**相反**的顺序：

| profile | 顺序 | 为什么 |
|---|---|---|
| `workspace` | 私有 tmpfs → 读绑定 → 拒绝覆盖 → 写绑定 | tmpfs 在前，策略自己的绑定才能把该暴露的重新暴露出来。**放在后面会静默吃掉宿主 `/tmp` 下的每一个读授权**（实测：允许的 `$HOME/notes.txt` 变成 GONE） |
| `hide` | `--ro-bind / /` → 拒绝覆盖 → 私有 tmpfs → 写绑定 | 根绑定把宿主的 `/tmp` 也绑进来了，tmpfs 必须在它之后，否则沙箱重新继承宿主临时目录——旧版 CI 第一次跑就因为这个半真半假而失败 |

### G1/G2/G3 测试证明到什么等级

借用 arXiv:2610.04504 的 Verification Autonomy Levels（见 [research/p2-sandbox-literature.md](../research/p2-sandbox-literature.md)）——「zero is an outcome, not a guarantee」：

我们的强制测试证明的是 **L2（客观事实）**：在我们实际跑过的那批用例、实际跑过的那台机器上成立。它**不是** L3/L4（可判定完备），**也不是安全保证**。内核变了、加了新的挂载选项、某个平台没跑到，都能让这个断言失效而**没有一个测试变红**。

因此 `system` 档在文案与文档里都**不得**被表述为安全保证；它是纵深防御的一层（Red-Teaming the Agentic Red-Team 指出，即使在沙箱容器内，agent 工具仍可能被攻陷操作者机器）。

### Seatbelt 的符号链接遍历是承重的

macOS 上 `/var`、`/etc`、`/tmp` 本身是符号链接。解析一条路径从**调用方写的那个拼写**开始，于是走 `/var/folders/…` 就必须先读 `/var` 这个 SYMLINK vnode。profile 只授了 `file-read-metadata (vnode-type DIRECTORY)`，所以缺的就是这一条。

实测（macOS 15，同一个 profile、同一个文件）：

```
read /private/var/folders/…/n.txt   OK
read /var/folders/…/n.txt          EPERM   ← 没有 SYMLINK 规则
read /var/folders/…/n.txt          OK      ← 有
readlink /var                      EPERM / OK:private/var
```

修法是在 DIRECTORY 那条规则旁边补一条 `file-read-metadata (vnode-type SYMLINK)`，同理由、同位置（读拒绝之后）。**代价**：`readlink()` 全局可用，会暴露符号链接的目标——那是一个路径字符串，不含文件内容，与 note 7 已经接受的目录 metadata 属于同一类披露。这是让一个正常文件系统可被遍历的最小代价。

它之所以难被发现，是因为 `subpath` 匹配的是**内核解析后**的路径，所以 profile 看起来完全正确；又因为**相对路径不受影响**，所以一套用相对路径的测试会全绿，而一个用绝对路径的模型撞墙。

**一次走错的修法，留作记录**：中途我判定「`subpath` 匹配字面路径」，于是让每条路径发两种拼写。实测它**不解决问题**（双拼写 + 无 SYMLINK 规则仍然 EPERM），而代价是真实的——每条 deny 都要手工复制两份，漏一处就是把凭据拒绝变成两个字符的绕过。为了零收益把拒绝面扩大一倍，比不做更糟。这条结论现在由一条测试钉住。

### macOS 上存在性可以被观察，内容不行【实测限制】

补上 SYMLINK 规则后，「宿主临时文件不可见」那条断言翻成可见。查下去是断言错了：`existsSync` 在 `statSync` 与 `readFileSync` 都返回 EPERM 的路径上返回 **true**。内容隔离自始至终是好的（`file-read-data` 仍被正确拒绝）。

所以 macOS 上的准确表述是：**读面之外路径的存在性可被观察，内容不可**。这是一个可用的侧信道——agent 能探测某路径下有没有文件——不影响内容机密性，但要写进限制项，不能含糊成「读面外完全不可达」。测的是 Node 的 `existsSync`；未单独测裸 `access(2)`，不宣称更多。

这条同时是一条通用规则：**隔离测试不能拿 `existsSync` 当探针**。它在两个不同的失败原因下都给出误导性的答案。

### 沙箱不能阻止范围内的破坏

范围扩张（agent 在良性任务上删除无关文件、擦掉陈旧凭据备份）与逃逸是**并列的第四类**授权问题（arXiv:2605.18583 实测：仅移除 prompt 里的授权声明，越界率从 0.0% 升到 17.1%）。我们的写策略是 allow-only，所以项目目录内的 `rm` **在沙箱里会成功**。

这不是缺陷，是边界：**沙箱管「能碰哪些路径」，审批门禁管「这次操作该不该做」**（P3/P5）。这条边界由 `test/sandbox-enforcement.test.ts` 钉成测试——它断言范围内的破坏**确实能发生**，以防日后被过度声称，或被「顺手修好」而 deny 掉 `rm`。

### 沙箱不是它自己调用者的权限边界

实测：调用者是 root 时 bwrap 根本不建 user namespace（恒等映射 `0 0 4294967295`），沙箱内进程在内核层面就是 root，`/etc` 里的 root 属主文件照样能读；调用者非特权时同一文件被拒绝。

架构文档已写明 CowCat 是 npm 分发、不要求管理员安装，所以**推荐部署下这条不成立**。但在 root 容器里跑 CowCat 的用户拿到的隔离比看上去弱，所以这类运行必须把这件事写进限制项上报——不拒绝（root 容器里往往是唯一能用的环境），但**必须让用户知道**。

调研与实测见 `research/p2-sandbox.md`。

## 失败模式的设计原则

1. **不可用时拒绝，不降级到更宽松的模式**。旧版 `failOpen` 把「沙箱不可用」降级到 light，这意味着用户以为有隔离实际没有。v2 默认拒绝；若某次降级是安全上更宽松的（例如去掉隔离同时保留网络），则拒绝且不可被 failOpen 覆盖。
2. **任何被拒绝或降级的动作都进审计**，审计记录包含实际生效的模式与后端，而不是请求的模式。
3. **错误信息写给模型看**。拒绝原因说明是哪条规则、为什么，以及可以怎样改配置，而不是一句「not allowed」。
