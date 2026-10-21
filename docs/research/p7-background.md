# P7 后台任务调研：Bash 实时输出与后台进程（#125）

> 状态：**调研稿**（2026-10-22）。本文件只出决定草案与 ADR 清单；**不改 ADR 表、不改源码**（工作规则 3）。
> 关联：#125、`dev-plan-v2.md` P7「后台任务」行、ADR-015（截断）、ADR-033（执行事实）、ADR-086（`open()`）、ADR-099（运行中卡）、ADR-079（子 agent 生命周期事件先例）。
> 证据分级沿用 `docs/research/` 的纪律：**【源码】**读实现给 `文件:行号`；**【实测】**本次跑出来的，给脚本与数字；**【上游】**官方文档，给链接；**【推断】**未实测，不得作为决策依据。

---

## 0. 结论摘要

1. **实时输出不能复用 `open()`**。它是为 MCP stdio 的行协议设计的：只在新行处交付、单行超过 1 MB 直接丢弃。实测 1.2 MB 单行只收到 85,888 字符，丢失 1,114,112 字符。【实测】
2. 实时通道走 **`run()` 增加可选 `onOutput` 回调**，由适配器合并后回调字符串；`open()` 与 MCP 路径不动。【源码 + 实测】
3. 实时增量是 **ephemeral**：新增 `tool.output.delta`，不落盘。`tool.finished.output` 仍是唯一的持久记录，落盘内容与截断策略完全不变。【源码】
4. 协议需要改两处（`deltaParamsSchema` 的封闭枚举、`server.ts` 的 `isDelta` 白名单）。**旧 client 收到新 type 会被 `parseNotification` 丢弃**——这是静默降级，不是向后兼容，必须写进 ADR。【源码】
5. **截断只在一处兑现**：日志侧仍是 `OutputTail`（保尾部 + `dropped` 计数，默认每流 100,000 字符）。实时通道原样转发，TUI 自己保留显示尾部，因此「实时看到的」永远是「最终输出的后缀」。【源码】
6. 后台只做**模型显式 `run_in_background`**（恢复 v1 语义）；命令内部的 `&`/`nohup` **明确非目标**：Windows 没有进程组可枚举，沙箱里这类进程活不过那条命令（已记录为预期行为）。【源码 + 实测记录】
7. 生命周期 **`tool.background.started/finished` 落盘**（与 `subagent.started/finished` 同构），运行中列表由宿主注册表 + 日志重建。Replay 见到 started 没有 finished 时显示「状态未知」，不假装还活着。【源码】
8. 无人值守（`cowcat run`、`-p` 等价路径）**第一版默认拒绝后台启动**：v1 的「`-p` + 后台 = CI 静默 hang」是实测教训；Claude Code 的选择是等待并设 30 分钟/2 小时上限，我们第一版取更窄的口径。【源码 + 上游】

---

## 1. 取证方式

| 级别 | 本次做了什么 |
|---|---|
| 【源码】 | 逐文件读 `packages/` 下的端口、适配器、内核事件、协议、TUI 组件；行号以 2026-10-22 的 `main`（`01187b8`）为准 |
| 【实测】 | `tools/process-open-probe.mjs`：用真实 `NodeProcess` 跑三个短行与一个 1.2 MB 单行，统计 `onStdoutLine` 实际收到的字符数 |
| 【上游】 | Claude Code 官方文档 `Tools reference` 的 Bash / Background commands 两节（链接见 §2） |
| 【推断】 | 所有未跑过的行为，例如 Windows 上命令内 `&` 派生进程的可枚举性 |

---

## 2. 上游对照

### 2.1 Claude Code（【上游】，2026-10-22 读取）

来源：<https://code.claude.com/docs/en/tools-reference>，`Bash tool behavior` 与 `Background commands` 两节。

| 事实 | 对我们的意义 |
|---|---|
| Bash 有 `run_in_background: true`；`/tasks` 列出与停止后台任务；`TaskStop` 按 ID 停止 | 工具面与用户面是两条入口，我们第一版只做后者（§4 ADR-113） |
| 输出**流式写入工作文件**，超过 5 GB 杀掉；完成后从文件读回，内联约 30,000 字符，超出给文件路径 + 2,000 字符预览 | 「文件 + tail」是一条可行路线；我们第一版不引入文件通道（§5 有被否决理由与触发条件） |
| 前台命令超时会**自动转入后台**（`sleep` 除外），结果里给出任务 ID 与输出文件路径 | 我们不采纳：那会把「命令没跑完」从失败改写成另一个状态，审批语义也要跟着变 |
| 无人值守（`-p`、SDK、CI）后台命令有 30 分钟默认上限、2 小时最大；交互式会话无上限 | 说明「无人值守必须有时限」是行业共识，我们的拒绝口径更保守 |
| `-p` 在给出结果后仍会等后台命令退出（有上限）；`TaskOutput` 在 v2.1.277 移除，改成用 `Read` 读输出文件 | 直接印证 v1 的 hang 教训：退出路径必须被设计，不能留给事件循环 |
| 前台子 agent 启动的后台命令随子 agent 结束而停止；主会话启动的不会 | 我们第一版不支持子 agent 启动后台（子 agent 工具面本来就更窄） |

### 2.2 opencode（未取证）

本次未在 opencode 官方文档中找到与「后台任务 / 实时输出」对应的条目，**不将其作为对照依据**。若实现阶段需要第二个样本，再单独补【上游】。

---

## 3. 本仓库现状

### 3.1 端口：两种形状，都不适合实时输出

- `ProcessPort.run(spec, signal): Promise<ProcessResult>`：缓冲到进程结束，返回 `stdout`/`stderr`/`truncated`/`dropped`。【源码】`packages/cowcat/src/ports/process.ts:193-203`
- `ProcessPort.open(spec, signal): Promise<ProcessHandle>`：长驻、行导向，为 MCP stdio 设计。【源码】`packages/cowcat/src/ports/process.ts:205-250`；`ProcessHandle` 只有 `onStdoutLine` / `onExit`，没有字节流。【源码】`packages/cowcat/src/ports/process.ts:233-250`

### 3.2 实测：`open()` 会丢 Bash 输出

`node tools/process-open-probe.mjs`（真实 `NodeProcess`，`sandbox: off`）：

```
short lines      : ["alpha","beta","gamma"] exit 0
1.2 MB line      : received 1 line(s), 85888 chars
1.2 MB expected  : 1200000 chars in one line; anything less means the buffer was discarded
RESULT: open() dropped 1114112 chars (reuse is NOT viable as a Bash channel)
```

原因在实现里写得很清楚：行缓冲超过 `MAX_LINE_CHARS = 1_048_576` 就整段清空重同步（【源码】`packages/cowcat/src/adapters/process.ts:36`、`:257-264`），并且**只有遇到换行才交付**（`:265-271`），剩余部分要等进程关闭才 flush（`:279-281`）。

对 Bash 的两个直接后果：

1. 压缩后的单行产物（minified JS、单行 JSON）会被截掉大半，且没有任何提示。
2. 只用 `\r` 刷新的进度条（`pnpm`、`cargo`、`docker pull`）在运行期间**一行都不会显示**，因为根本没有 `\n`。

**结论：不复用 `open()`。** 这条也解释了为什么 #125 不是「把 Bash 接到 `open()` 上」那么小。

### 3.3 截断：`OutputTail` 是现有唯一口径

- `OutputTail` 保尾部、按 `cap` 裁剪、`dropped = total - kept`。【源码】`packages/cowcat/src/adapters/output-tail.ts:15-40`
- `run()` 对 stdout/stderr 各建一个 `OutputTail`，`outputCap` 来自调用方。【源码】`packages/cowcat/src/adapters/process.ts:90-91`
- Bash 工具默认 `BASH_DEFAULT_OUTPUT_CAP = 100_000` 字符/流；`truncation.reason` 会写明是输出上限。【源码】`packages/cowcat/src/adapters/tools/bash.ts:10`、`:73-83`、`:106-110`

### 3.4 既有 ephemeral 通道与协议边界

- 先例：`model.delta` / `reasoning.delta` 是 `SessionUpdate` 的一部分，注释明确「只为实时渲染存在，永不落盘」。【源码】`packages/cowcat/src/kernel/events.ts:308-329`
- 协议侧 `deltaParamsSchema` 是**封闭枚举** `z.enum(['model.delta', 'reasoning.delta'])`。【源码】`packages/protocol/src/notifications.ts:47-51`
- 服务端路由还有一道白名单 `isDelta()`。【源码】`packages/protocol/src/server.ts:271-277`
- 旧端兼容的真实后果：`parseNotification` 在 schema 不匹配时返回 `null`，客户端把这条通知**静默丢掉**。【源码】`packages/protocol/src/notifications.ts:92-106`

### 3.5 后台进程的现状

- Bash 工具**显式拒绝** `run_in_background`，不是静默忽略。【源码】`packages/cowcat/src/adapters/tools/bash.ts:53-66`；工具描述也写明「Not supported」。【源码】`:39`
- `TaskOutput` / `TaskStop` 等六个任务工具在计划里被推迟到 P7。【源码】`docs/dev-plan-v2.md:470`
- 「沙箱里 `&` 起来的后台任务活不过那条命令」是**已记录的预期行为**，不是 bug。【源码】`docs/dev-plan-v2.md:199`
- 子 agent **不是** OS 进程，不能混进后台进程列表。【源码】`docs/research/p2-ports.md:70`
- v1 的教训清单（只迁结论，不迁代码）：【源码】`docs/research/p2-ports.md:80-88`
  - 后台任务必须 `taskkill /T` 才能带走 `cmd.exe` 包装与孙进程；
  - `/tasks kill` 曾因 `child === null` 时读 `task.child.pid` 抛 `TypeError`、又被 `catch` 吞掉，看起来成功、实际还在跑；
  - **`-p` + `run_in_background` 会让事件循环不退出 → CI 静默 hang**，每个返回路径都必须清理；
  - `SIGTERM` 原本没有 handler，Node 默认杀进程并留下 detached 子进程。

### 3.6 子 agent 事件是落盘先例

`subagent.started` 有 `callId` / `childSessionId` / `role` / `description`；`subagent.finished` 有 `ok` / `state` / `turns` / `partial` / `usage`。【源码】`packages/cowcat/src/kernel/events.ts:253-287`
**可直接复用的形状**：后台任务也需要一组「开始有事可查、结束有果可审」的配对事件，而不是只活在宿主的 Map 里。

### 3.7 TUI 现状

- 运行中的工具只有一张 `[运行中]` 卡，内容来自 `pendingTools`，没有输出正文。【源码】`packages/tui/src/components/tool-card.ts:164`；状态条的动作词在 `components/status-bar.ts:86-98`
- 渲染约束：一行一个 `Line`、`wrapMode:'none'`、固定行高（ADR-100）；帧率上限 60（ADR-099）；dock 优先级「审批 > 回到底部 > 子 agent > 待办 > 菜单」（ADR-101/105）。实时尾部必须按这些约束设计，不能塞一个会自己折行的盒子。

---

## 4. 决定草案

### A. 实时输出

#### ADR-107（草案）实时通道：`run()` 增加 `onOutput`，不复用 `open()`

**决定**：`ProcessPort.run(spec, signal, sink?)` 增加可选的 `sink`：

```ts
export interface OutputSink {
  readonly onOutput: (stream: 'stdout' | 'stderr', text: string) => void;
}
```

适配器按「时间窗 + 大小」合并后回调（建议 100ms / 8 KB，先到先触发），只传字符串，不传 Node 类型；`open()` 与 MCP 路径完全不动。回调抛异常不影响进程（内部 try/catch 后丢弃该次回调并计数，避免一个渲染 bug 杀掉命令）。

**理由**：`open()` 的丢行与行导向已在 §3.2 实测；`run()` 本来就是 Bash 的路径，加一个旁路比再开一条端口便宜。合并放在适配器是因为只有它知道真实到达节奏，内核不该为渲染节流。

**代价**：`run()` 的签名变了（可选参数，向后兼容）；适配器多一条测试路径；错误处理要明确「sink 出问题不改变进程结果」。

**被否**：见 §5-1、§5-2。

#### ADR-108（草案）`tool.output.delta`：ephemeral，不落盘

**决定**：新增

```ts
interface ToolOutputDelta {
  readonly type: 'tool.output.delta';
  readonly turnId: string;
  readonly callId: string;
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}
```

加入 `SessionUpdate`，经 `Session.subscribe` 直发监听者，**不进日志**。协议侧改两处：`deltaParamsSchema` 的枚举加一项、`server.ts` 的 `isDelta` 加一项。TUI 只接受「当前回合、当前 pendingTools 里的 callId」的增量，其余丢弃。

**理由**：与 `model.delta` 同一条纪律——片段不是事实，完整输出在 `tool.finished`。落盘会让一次 `pnpm install` 生成上万条事件，重放与日志体积都不可接受（ADR-019 的只追加不是这个用途）。

**代价 / 必须写明的降级**：旧 client 的 `deltaParamsSchema` 不认识新 type，`parseNotification` 返回 `null`，**静默降级为没有实时输出**（§3.4）。这不是兼容，是「旧端少一个功能」；ADR 里要照实写，不能声称向后兼容。新 server + 新 client 才完整。

#### ADR-109（草案）截断口径：日志唯一，实时只做显示尾部

**决定**：`tool.finished.output` 仍是唯一持久记录，继续由 `OutputTail` 按 `outputCap`（Bash 默认 100,000 字符/流）截尾并给 `dropped`。实时通道**原样转发**，内核不截断；TUI 自己保留显示尾部（建议 20 行 / 4,000 字符，超出显示 `… 还有 N 行`）。断言：TUI 显示的尾部必须是最终 `tool.finished.output` 的后缀（同一字节序，不做二次转义）。

**理由**：如果内核先截断再发 delta，就会出现「实时尾部」和「日志尾部」两个口径，而且 `dropped` 计数只能覆盖其中一个；两个数字迟早对不上。

**代价**：高输出命令会把更多字节推到协议层。合并窗口（ADR-107）是第一道闸；若仍然过多，再加「每秒最多 N 条」的协议级限流，而不是改截断口径。

### B. 后台进程

#### ADR-110（草案）后台语义：只认显式 `run_in_background`

**决定**：恢复 Bash 的 `run_in_background: true`；只有这种调用会进入后台注册表。**命令内部的 `&`、`nohup`、`daemonize` 不做识别、不做管理**，文档里写成非目标：

- Windows 没有进程组，`&` 派生出来的进程无法可靠枚举（【推断】未实测，但 v1 的 `taskkill /T` 结论同源）；
- 沙箱内这类进程本来就活不过命令，已有实测记录（`docs/dev-plan-v2.md:199`）。

**理由**：管理一个「模型没说要后台」的进程，等于替用户接管了他没表达的生命周期。语义边界清楚，审计才写得清楚。

**代价**：用户 `cmd &` 之后仍然看不到它；文档要显式说明「请用 `run_in_background`」。

#### ADR-111（草案）生命周期落盘：`tool.background.started/finished`

**决定**：

```ts
| { type: 'tool.background.started'; callId: string; taskId: string; command: string; pid: number | null; startedAt: number }
| { type: 'tool.background.finished'; callId: string; taskId: string; exitCode: number | null; signal: string | null; state: 'exited' | 'stopped' | 'lost' }
```

两者都落盘（与 `subagent.started/finished` 同构）。`taskId` 为会话内短 id（`bg_1`），`pid` 记录但注明「只在同一次宿主生命周期内有意义」。运行中列表 = 宿主注册表；resume 后的列表 = 从日志重建 + 注册表为空 → 全部显示「状态未知（宿主已重启）」而不是「运行中」。`stopped` 表示用户/系统主动终止；`lost` 表示宿主关闭时未能证明终止（配合 `residuePossible`）。

**理由**：可审计优先。只放在宿主内存里，resume 后「这个后台任务是什么、谁起的」就永久丢了。

**代价**：每次后台启动多两条事件；replay 需要一个新的投影分支（TUI dock + 状态条各一处）。

#### ADR-112（草案）超时、无人值守与退出清理

**决定**：

| 场景 | 前台 | 后台 |
|---|---|---|
| 默认超时 | 60s（不变，`BASH_DEFAULT_TIMEOUT_MS`） | 30 分钟 |
| 上限 | 600s（不变，`BASH_MAX_TIMEOUT_MS`） | 2 小时 |
| 超时后 | 终止，`ok: false`（不变） | 终止，写 `finished{state:'stopped'}`，并告知模型 |
| 无人值守（`cowcat run` / `-p` 等价路径） | 不变 | **拒绝启动**，返回一句可操作的说明 |
| 会话关闭 / CLI 退出 | 终止在跑的前台 | 逐个 `terminate('shutdown')` 并等待，最多 N 秒，然后记录 `lost` |

**理由**：v1 的 CI hang 是实测事故（§3.5），第一版用「拒绝」把最坏情况直接消掉；交互式会话有人看着，30 分钟/2 小时与上游同量级。退出清理必须 await——`finish` 之后再跑事件循环是 v1 的原始错误。

**代价**：`run` 模式无法用后台（比 Claude Code 窄）；要提供 `--allow-background` 之类的逃生口只能在后续 ADR 里加。

#### ADR-113（草案）第一版范围：用户侧面板 + 运行中卡尾部；模型侧工具推迟

**决定**：

- **TUI 运行中卡**：接收 `tool.output.delta`，在 `[运行中]` 卡下方显示尾部（20 行 / 4,000 字符），按 ADR-100 的「一行一个 `Line`」渲染；刷新与 60fps 上限对齐，节流放在 TUI（每 100ms 合并一次重绘）。
- **后台面板**：dock 新增一段「后台任务」列表（taskId、命令首行、运行时长、状态），`↑↓` 选择、`x` 终止（复用审批卡的交互习惯）；优先级排在审批与回到底部之后、子 agent 之前。
- **不做（本版）**：`TaskOutput` / `TaskStop` 等模型侧工具；后台输出落文件；自动把超时前台命令转后台。

**理由**：#125 的验收是「能看到、能终止」。模型侧工具要新增工具契约、审批语义与输出对账，范围翻倍，单独排期更诚实。

**代价**：模型无法主动取回后台输出；它只能从 `tool.background.finished` 的结果里知道退出码与摘要。

---

## 5. 被否决的方案

| # | 方案 | 否决理由 |
|---|---|---|
| 1 | 复用 `open()` 作 Bash 输出通道 | 【实测】1.2 MB 单行丢 1,114,112 字符；`\r` 进度条期间零输出；行导向不适合任意二进制/文本 |
| 2 | 给 `ProcessHandle` 加字节流，Bash 也走 `open()` | 仍要为 `run()` 的路径保留两套生命周期；MCP 的行 framing 会跟着变复杂，收益不抵改动 |
| 3 | 每个 chunk 写一条持久事件 | 日志体积与重放成本不可接受（ADR-019）；片段不是事实 |
| 4 | 内核先截断再发 delta | 出现两个截断口径，`dropped` 对不上（ADR-109） |
| 5 | 输出写临时文件、前端 tail 文件（Claude Code 路线） | 第一版多一个文件通道与清理责任；等「后台输出超过内存可承受」真实出现（>10 MB 量级）再评估 |
| 6 | 后台事件只发 ephemeral | resume 后列表与审计全丢；与 `subagent` 先例不一致 |
| 7 | 探测命令内部的 `&` | Windows 无进程组可枚举；沙箱内本来活不过命令；管理未表达的意图 |
| 8 | 前台超时自动转后台 | 把「命令没跑完」伪装成「还在跑」；审批与失败语义都要重写 |
| 9 | 子 agent 也能起后台任务 | 子 agent 的工具面与生命周期更窄，第一版不扩散 |

---

## 6. ADR 清单（草案编号，待 ADR 表确认）

| ADR | 标题 | 一句话 |
|---|---|---|
| 107 | 实时输出通道 | `run()` 加可选 `onOutput`，适配器合并，不复用 `open()` |
| 108 | `tool.output.delta` | ephemeral 增量；协议两处扩枚举；旧端静默降级 |
| 109 | 截断口径 | 日志仍是唯一持久记录；实时只做显示尾部 |
| 110 | 后台语义 | 只认显式 `run_in_background`；命令内 `&` 非目标 |
| 111 | 后台生命周期 | `started/finished` 落盘；resume 不假装活着 |
| 112 | 超时与无人值守 | 前台不变；后台 30m/2h；`run`/`-p` 拒绝；退出 await 清理 |
| 113 | 第一版范围 | 用户侧面板 + 运行中卡尾部；模型侧工具推迟 |

---

## 7. 实现任务拆分（草案）

按依赖顺序，跨包顺序是 **cowcat → protocol → tui → cli**（`file:` 依赖要求前者先构建）。

| # | 包 | 任务 | 依赖 | 验收 |
|---|---|---|---|---|
| T1 | cowcat | `OutputSink` + `run()` 可选参数；适配器合并与错误隔离 | — | 单元：短行/超长行/`\r` 刷新都能到达；sink 抛错不影响结果 |
| T2 | cowcat | Bash 工具把 sink 接到增量；`callId` 关联 | T1 | 工具测试：流式回调收到与最终输出同后缀 |
| T3 | cowcat | `ToolOutputDelta` + `SessionUpdate` + `subscribe` 直发 | T2 | 内核测试：不进日志、顺序稳定 |
| T4 | protocol | `deltaParamsSchema` + `isDelta` 扩一项；旧端降级测试 | T3 | 协议测试：新 type 通过；旧 schema 解析失败返回 `null` |
| T5 | tui | 运行中卡尾部渲染 + 100ms 合并重绘 | T4 | TUI 测试：尾部截断、callId 过滤、帧快照 |
| T6 | cowcat + cli | 后台注册表、`run_in_background`、30m/2h、无人值守拒绝、退出 await | T1 | 内核：生命周期事件；cli：退出后无残留、不 hang |
| T7 | tui | 后台 dock 面板 + `x` 终止 | T6 | TUI 测试：列表、选择、终止回调 |
| T8 | docs | ADR 表落 107–113、changelog、HANDOFF | T1–T7 | 与代码同 PR（工作规则 5） |

---

## 8. 待验证（实现前必须补齐）

1. **`\r` 进度条**：合并窗口下如何显示最后一行？是否把 `\r` 当行分隔（只保留最后一段）——需要一次实测决定，当前【推断】。
2. **合并阈值**：100ms / 8 KB 是估值；用 `pnpm install`、`cargo build` 跑一遍，看协议消息数与帧率。
3. **沙箱 + 后台**：`light`/`system` 档下 `run_in_background` 是否应该直接拒绝（`--die-with-parent` 会杀掉后台）——倾向拒绝，需实测确认。
4. **Windows 退出清理**：`terminate('shutdown')` 对后台任务是否仍走 `taskkill /T`，会话关闭时能否在 N 秒内完成。
5. **旧 client 降级**：真实旧版本 TUI 连新 server，确认只是没有实时输出、不报错、不中断回合。
6. **resume 语义**：从日志重建的后台列表在 UI 上如何标注「状态未知」，需要一次真实重启验证。
7. **CI 路径**：`-p` 拒绝后台后，现有 CI 用例是否覆盖到这条拒绝；需要一条回归测试防复发（v1 的 hang 教训）。

---

## 9. 开放问题（留给评审）

1. 后台超时 30m/2h 是否需要像上游一样可由环境变量提升？第一版建议写死，避免又一个可配置项。
2. `tool.background.finished` 是否要带最后 N 行输出（审计用）？带则重复 `tool.finished` 的容量问题，不带则「任务结束后看不到任何输出」。倾向：带 `tail`（≤2,000 字符）+ `dropped`。
3. 后台任务的命令全文是否要脱敏（环境变量、token）？当前 `tool.finished` 已记录命令，沿用同一规则即可。
