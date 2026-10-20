# P7 调研：上下文压缩

> **本文件只出决定草案与 ADR 清单，不改源码、不改 ADR 表。** 决定草案要等评审拍板（`docs/dev-plan-v2.md` 工作规则 3）。
>
> **这一版是重写的**：上一版拿 v1 当参照物，而 v1 只是「一个实现」。本轮按要求先做上游调研——**opencode、codex、DeepSeek Harness、Claude Code**——再决定我们的三个问题：① 用量怎么算 ② 压缩结果怎么进日志 ③ 摘要调用在架构里属于什么。
>
> v1 的实现移到附录 B，**只作历史参照，不再作为任何一条决定的依据**。

## 证据标注约定

- **【上游源码】** 直接读到上游仓库的实现，给 `仓库/路径:符号`（行号在正文里按当次读取给出，符号更稳）
- **【上游文档】** 官方文档原文，给 URL 或文档路径
- **【实测】** 本次跑出来的
- **【推断】** 未实测的推论，**不得作为决策依据**

**本文件没有【实测】条目**：四家都是读代码与文档，没有真实端点。凡【推断】都是评审时要单独安排验证的。

## 0. 结论摘要

三个问题的答案，先给结论：

| 问题 | 四家的共性答案 | 我们该抄的那一半 |
|---|---|---|
| **① 用量怎么算** | **没有一个把「请求前调 `count_tokens`」当主路径。** 全是「**真实 usage 锚 + 之后的本地估算**」：锚是上一次成功响应的 `input`（含 cache 读/写），锚之后的新消息按 4 字符/词量级估；媒体给固定值 | 锚 + 增量，两者**取大**；不要新开计数端口。阈值用窗口的一个**比例**，并预留输出余量（不是裸窗口） |
| **② 压缩结果怎么进日志** | 四家都**保留原始消息**，都记一条**「替换」事实**：谁被替换（范围或 seq）、替换成什么、花了多少。差别只在「替换」的表达：opencode 把它变成**历史的第一条消息**；codex **重写历史**并持久化 `CompactedItem`；DeepSeek 用**三个 log-only 事件 + 一条带 `surfaceOp: replace` 的用户消息**；Claude Code 在文档层面只说「替换成结构化摘要」并**重新加载启动上下文** | **替换要可重放，且必须记「被替换的是哪些 seq」**。上一版草案「把保留段复制进事件」在四家都没有对应物——真正的对应物是**按 seq 的替换范围** |
| **③ 摘要调用属于什么** | 都**不是普通对话回合**，但都有自己的生命周期：opencode 是 session 级 service + `compaction.started/delta/ended/failed` 事件；codex 是**一等 task 类型** `TaskKind::Compact`（走 turn 生命周期、有 pre/post compact hook、有 analytics）；DeepSeek 是**可选能力 seam** `ctx.compaction`，明确「不是 agent-loop 脊柱的一部分」，用 start/end **日志锁**包住整个操作；Claude Code 是**一次独立请求**，复用同一 system/tools/history 以命中前缀缓存 | 「**内核内的受控子操作**」：不进回合状态机、不写 `model.message`、**有锁**、**有自己的失败语义**，且**复用同一前缀**让摘要请求吃到缓存 |

**上一版草案被推翻的两条**（写在这里，避免评审时以为没看）：

1. ~~「事件自带保留段（`kept: Message[]`）」~~ → 四家都不复制保留段。保留段在日志里本来就存在，**用 seq 范围表达替换**即可（DeepSeek 的做法），复制只会让日志膨胀。
2. ~~「阈值就是 `preset.limits.context` 直接比」~~ → 四家都用**窗口减去输出余量/预留**再打比例：opencode 留 15%（至少 16k），DeepSeek `min(W×0.8, W−O−65536)`，codex 有 `auto_compact_token_limit` 与 `fallback_buffer`。裸窗口当阈值会先撞输出上限。

## 0.1 评审结论（2026-10-20，用户拍板）

| 待验证项 | 结论 |
|---|---|
| `chars/4` 对中文与代码的误差 | **可接受**，先不引入分词器 |
| 目录里的 OpenAI 兼容端点在流式响应里给不给 `input_tokens` | **给**，所以「锚 + 增量」这条腿成立 |
| 压缩后 `cacheRead` 是否归零 | 不追求保住（替换必然重建前缀），只要求**实测记录**；不做「为了缓存不压缩」的优化 |
| 15% / 16k 是否适合 1M 窗口 | **照 opencode 的做法**：`window − max(window×15%, 16k)`，1M 窗口即 850k 上限；保留段取 opencode 默认的 **15000 tokens** |
| 压缩范围 | **按当前会话整理，不要把上下文直接归零**：只替换最旧的一段，保留最近一段原文（§3.2 的水位线就是为此） |

据此，D1~D4 全部按 §6 的草案落地；ADR-070/071 的实现已开工（估算与锚、事件与折叠），072 的摘要调用与 073 的阈值接线、074 的前端呈现随后。

## 1. 取证方式（可复现）

| 工具 | 形态 | 取证 |
|---|---|---|
| **opencode** | MIT，`anomalyco/opencode`（默认分支 `dev`），TS + Effect | 【上游源码】`packages/core/src/session/compaction.ts`；【上游文档】`services/www/src/docs/content/compaction.mdx` |
| **codex** | Apache-2.0，`openai/codex`（`main`），Rust | 【上游源码】`codex-rs/core/src/tasks/compact.rs`、`codex-rs/core/src/compact.rs`、`codex-rs/core/src/session/context_window.rs`、`codex-rs/prompts/templates/compact/prompt.md`、`codex-rs/core/src/context/compaction_summary.rs` |
| **DeepSeek Harness** | 开源，`deepseek-ai/deepseek-harness`（`master`），TS | 【上游文档】`docs/subsystems/compaction.md`、`docs/subsystems/token-meter.md`、`packages/compaction/compaction-basic/README.md` |
| **Claude Code** | **闭源**；只取官方文档与本地发布产物 | 【上游文档】`code.claude.com/docs/en/prompt-caching`（Compacting the conversation）、`/docs/en/costs`、`/docs/en/context-window`、`/docs/en/model-config` |

**取证的局限**（评审必须知道）：

- Claude Code 没有源码，**实现细节一律不推断**；本文只引用它文档里明确写出的行为。
- codex 与 DeepSeek 的**阈值/保留比例**是默认值，本文不假设它们对我们是好默认值（见 §9）。
- 四家都是「单会话单上下文」，没有一家在编码 Agent 里做跨会话共享上下文——所以「压缩」在本仓库的边界就是**一个会话的历史**。

## 2. 问题一：上下文用量怎么算

### 2.1 逐家做法

**opencode**【上游源码 `compaction.ts` · `estimatePrompt` / `estimateContext` / `calculateCeiling`】

- **锚点**：找**最后一条带 provider 计数的 assistant 消息**（`hasMeasuredPrompt`：同 provider/model ref、无 error、`input + cache.read + cache.write > 0`）。锚的用量 = `input + cache.read + cache.write + output + reasoning`。
- **增量**：锚之后的消息逐条估（`estimateMessage`/`estimatePart`：文本按 `Token.estimate`，图片 1500、PDF 2000，tool call 与 schema 也算）。
- **为什么只用同一 provider 的计数**：注释写明——别的 provider 的计数可能描述的是原生（加密）上下文窗口，本模型重放不了，**数字会撒谎**。
- **阈值**：`calculateCeiling = window − max(window×15%, 16k)`；未知窗口时上限为 `Infinity`（只有 provider 拒绝才拦得住）。
- **溢出恢复**：provider 报「太长」后，下一次按**被拒请求估算的 70% / 50% / 35%** 逐级收缩（`SHRINK_STEPS`），三轮不成就放弃。

**codex**【上游源码 `session/context_window.rs` · `ContextWindowTokenStatus`】

- 用量来自 `sess.get_total_token_usage()`（累计的真实 usage），不是本地估。
- 两套口径并存：`AutoCompactTokenLimitScope::Total` 与 `BodyAfterPrefix`（后者减去窗口的 prefill 基线，只算「本窗口新增」）。
- 硬上限 `full_context_window_limit` 与可配置的 `model_auto_compact_token_limit` 分开；还有 `fallback_buffer_tokens` 与「回合结束后按百分比触发」的 `model_post_turn_compact_threshold_percent`。

**DeepSeek Harness**【上游文档 `docs/subsystems/token-meter.md`】

- 独立服务 `ctx.tokenMeter`，产出一个**不可变快照**：`baseline`（`usage` 或 `estimated`）+ `surfaceDeltaTokens`（相对锚的**带符号**重定价）+ `totalTokens` + **逐节点价格** `nodes: { seq, tokens, heuristicTokens }[]`。
- 关键设计：锚只在上一次成功请求与当前请求**同一 canonical envelope** 时复用，否则整份重新定价；替换节点用 `heuristicTokens`（与路由无关）定价，保证投影折叠自洽。
- 阈值（`compaction-basic` 文档）：`floor(min(W × 0.8, W − O − 65536))`，`O` 是路由的输出预留；保留 16% 的 `W − O`。
- 自认的局限：「4 字符/token 对 CJK 与 JSON Schema 定价偏低」，精确分词仍是待办。

**Claude Code**【上游文档 `/docs/en/costs`、`/docs/en/context-window`、`/docs/en/model-config`】

- 文档口径是**展示与告警**：`/context`（看谁占了空间）、状态行的 context-window usage、`/usage` 的真实 token 与缓存统计（`cache_creation_input_tokens` / `cache_read_input_tokens`）。
- 自动压缩有独立的「auto-compact window」设置（`/docs/en/model-config#set-the-auto-compact-window`）。
- 它明确区分「**上下文用量**」与「**本轮输出量**」：spinner 旁边的计数只算本轮输出，**不含**你发出去的上下文。

### 2.2 我们该拿走的

**D1：用量 = 真实锚 + 增量估算，两者取大；阈值 = 窗口按比例，并扣掉输出余量。**

- **锚从哪来**：`model.usage` 事件里已经有 `{input, output, cacheRead, cacheCreation}`（`packages/cowcat/src/ports/model.ts:17-22`）。但现在 `reduce` 刻意不折叠它（`kernel/state.ts:85-90`，理由是「成本不改变对话」）——压缩要它，所以这条决定要改：**state 记住最后一次 usage 与它所属的 message 位置**。
- **为什么取大**：估算偏低会漏压（真爆窗口），偏高只是早压一次。opencode 是「锚 + 增量」两段相加，我们多一层保险。
- **为什么不新开 `countTokens` 端口**：四家里只有 Anthropic 系有该端点，codex/deepseek/opencode 都没把它当主路径；而 `usage` 是**每回合免费**的。
- **阈值不是裸窗口**：`ceiling = window − max(window×15%, 16k)`（取 opencode 的形状，理由与它相同：留出最后一次回复与摘要本身的空间）。`limit.context` 字段已在 `kernel/preset.ts:10-19` 存在且注释自认「nothing consults it yet」。
- **溢出要能恢复**：provider 拒绝「太长」时按 70%/50%/35% 收缩重试一次；**不要**只在客户端等估算准确。

## 3. 问题二：压缩结果怎么进日志（最契约的一节）

### 3.1 四家的记录形态

| 工具 | 记录成什么 | 保不保留原始消息 | 「保留段」怎么留 | 重放怎么重建 |
|---|---|---|---|---|
| **opencode**【上游源码】 | 一条 **`compaction` 消息**（`text` + `recent`），成为历史的**第一条**；`previousCompaction()` 要求 `messages[0]` 是已完成的 compaction | **保留**（文档：更早的消息仍然存储，只是不再发给模型） | **字符串化进 compaction 消息的 `recent` 字段**；代码里有 TODO 说这该改成消息引用（「stringifying the recent history confuses some models」） | 从**最近一次完成的 compaction** 载入历史 |
| **codex**【上游源码】 | `sess.replace_compacted_history(...)` 持久化 `CompactedItem`，带 `window_number`、`window_ids`、`compaction_response_id`、`input_goal_ids` | **保留**（原 items 在 rollout 里） | **复制**最近用户消息，预算 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`，超预算的截断并标记「不完整」 | 新历史 = 初始上下文前缀 + 复制的用户消息 + summary（`CompactionSummary` 是**带 content-kind 的 user 消息**） |
| **DeepSeek Harness**【上游文档】 | **三个 log-only 事件**：`compaction/start`（锁）、`compaction/summary`（`summary`、`shadowedRange`、**`shadowedSeqs`**、`shadowedTokenCount`、provider/model/usage、`rawOutput`）、`compaction/end`（释放锁，可带 `error`）；再加一条 `user/message` 带 `surfaceOp: { op: 'replace', startSeq, endSeq }` | **保留**（`shadowedSeqs` 记录「被遮住的是哪些」，原始事件不动） | **不复制**：替换只覆盖 `startSeq..endSeq`，**范围之后的消息原样留在 surface 上** | surface = 日志按 seq 展开后套用所有 `replace` 操作；`SurfaceEventType` **故意不扩展**（只有产出消息的事件进模型） |
| **Claude Code**【上游文档】 | 文档只说「替换成结构化摘要」；终端看到一句 `Conversation compacted` | 未说明（闭源） | 摘要 + **启动上下文重新加载**（system/CLAUDE.md/memory/MCP 工具在消息历史之外）+ **重读最近修改的最多 5 个文件** + **重注入调用过的 skill（每个 ≤5000 tokens）** | 未说明 |

三家的共同形状可以压成一句话：

> **压缩是一条「替换」事实：替换发生在哪个位置范围、替换成什么、原来那段值多少 token。原始消息不动。**

### 3.2 对我们意味着什么

我们现在的硬约束没变：`SessionState.messages` 是事件日志的**纯折叠**，模型请求直接吃它（`kernel/run-turn.ts:173-177`）。所以「压缩」只能落在折叠规则上。

但上一版草案的「事件自带保留段」是**编出来的**——四家没有一家这么做。真正的对应物是 **DeepSeek 的 `shadowedSeqs` + `surfaceOp.replace`**：

**D2：`context.compacted` 记录「替换范围」，`messages` 按 seq 过滤。**

```ts
| {
    readonly type: 'context.compacted';
    /** 折叠后模型看到的那段续接文本（含「这是压缩检查点」的前导）。 */
    readonly summary: string;
    /** 被替换的最后一条消息的来源 seq；之后的消息原样保留。 */
    readonly throughSeq: number;
    /** 被替换的消息条数与它们的 seq（审计与前端展示用；裁决只看 throughSeq）。 */
    readonly shadowed: readonly number[];
    readonly model: string;
    readonly usage: ModelUsage | null;
  }
```

- **fold 语义**：`messages = [summary 作为一条 user 消息] + 所有 seq > throughSeq 的消息`。
- **为什么是水位线而不是集合**：四家的自动压缩都只压**最旧的一段**（codex「older history」、opencode「older conversation」、deepseek「oldest balanced span」、claude「older history」）。水位线覆盖这个形状；`shadowed` 只作审计，等真需要「区域压缩」（deepseek 的 `compactRegion`）再升级成集合。
- **代价（必须写进 ADR）**：`Message` 现在没有来源 seq，`reduce` 也从不记录。要么给 `Message` 加 `seq`，要么在 `state` 里平行保存 `seqs`。**推荐前者**：deepseek 的每个 surface 节点都带 `seq`，codex 的每个 item 都有 id——「消息知道自己从哪条日志来」是这类系统的通例，而我们迟早要它（审计、区域压缩、前端定位）。
- **`readFiles` 不受影响**：它是安全闸门（ADR-049），不是上下文问题。压缩只改 `messages`，不碰 `readFiles`——DeepSeek 也把「折叠历史」和「安全事实」分开（它的闸门在别的 seam）。
- **重开一致**：同一份日志折叠出同一个 `messages`，因为它就是纯函数。这条比 opencode 的「从最近 compaction 载入」更强，代价是压缩事件必须自带水位线。

### 3.3 Claude Code 那条额外要抄的

它压缩后**重新加载启动上下文**（system / CLAUDE.md / memory / MCP 工具），并**重读最近修改的 5 个文件**、**重注入调用过的 skill**。

对我们的含义：我们的「启动上下文」目前是 `ModelRequest.system`（`ports/index.ts:210-216`），由组合根传入、**不进日志**。所以压缩**天然不需要**重建它——这反而比 Claude Code 简单，但要写进 ADR 的「不做」清单，免得以后有人照着 Claude Code 加一层没用的重建逻辑。**重读最近修改文件**这一条我们**不做**（我们的工具是显式 `Read`，模型自己会决定要不要重读；自动重读会绕过策略与审批）。

## 4. 问题三：摘要调用在架构里属于什么

### 4.1 四家的归属

| 工具 | 归属 | 生命周期 | 失败的后果 |
|---|---|---|---|
| **opencode**【上游源码】 | `SessionCompaction` service，**session 级**；`compact()` 返回 `skipped / completed / failed` | `compaction.started` → `delta` → `ended` / `failed`；usage 以 `source: "compaction"` 单独记账；**一个 session 不会同时跑两个压缩** | 发 `failed` 事件；**历史不变**，报错给调用方；溢出恢复的收缩有次数上限 |
| **codex**【上游源码】 | **一等 task**：`TaskKind::Compact`（`tasks/compact.rs`），`emit_turn_started` / `emit_turn_item_started(ContextCompactionItem)` | 走它自己的 task 生命周期；`PreCompactHook` / `PostCompactHook` 可阻断；analytics 记 `active_context_tokens_before/after`、`summary_tokens`、`cached_input_tokens` | 本地失败会上报 `EventMsg::Error`（`PreTurn` 阶段除外，避免吞掉用户输入）；远程压缩失败不回落本地 |
| **DeepSeek Harness**【上游文档】 | **可选能力 seam** `ctx.compaction`，明确「**不是 agent-loop 脊柱的一部分**」；实现是插件（`compaction-basic`），另有 `tool-result-pruner`、`image-offload` 两个兄弟能力 | `compaction/start`（锁，自动压缩带 turn id，手动为 `null`）→ 摘要 → `compaction/summary` + 替换 → `compaction/end`；**锁括住整个操作**，崩在中间留下「孤儿锁」是可检测的 | 摘要失败：保留当前 surface 继续跑（可先落 pruner 的改动）；手动压缩用 `ManualCompactionErrorCode`（`busy/cancelled/changed/summary/commit/persistence`） |
| **Claude Code**【上游文档】 | 一次**独立请求**：「same system prompt, tools, and history as your conversation, plus a summarization instruction appended as a final user message」；摘要过程**不出现在终端** | 未说明（闭源） | 未说明 |

### 4.2 我们该拿走的

**D3：摘要是「内核内的一次受控子操作」——不进回合状态机、不写 `model.message`、有锁、有自己的失败事件。**

- **不进 `TurnState`**：我们的状态机是 `idle→…→completed/failed`（`kernel/turn.ts`），压缩不是回合的一个阶段。opencode 与 DeepSeek 都把它放在回合**外面**；codex 塞进 task 是因为它的 task 抽象本来就是「回合里的动作单元」，与我们不同构。
- **不写 `model.message`**：写了会多一条假助手消息、折叠会重复（`kernel/state.ts:77-84`）。
- **要锁**：DeepSeek 的 `compaction/start`→`compaction/end` 是一条可检测的日志锁（崩溃留孤儿锁而不是「假装做完了」）；opencode 用进程内状态保证「一个 session 不并发压缩」。我们要一条**日志锁**（重开也认），因为我们的重放是权威。
- **失败不阻塞**：保留原历史继续跑 + 一条 note。DeepSeek 同样「摘要失败保留 surface 继续」，而我们刚在 ADR-069 栽过一次「辅助功能把主流程搞挂」。
- **复用前缀**（三家都强调）：摘要请求 = 同一 system + 同一 tools + 被压缩区间逐字重放 + 末尾一条压缩指令。这样 provider 的 warm prefix 能命中，只有指令与摘要输出是未缓存。**这一条直接影响成本**，必须进 ADR。
- **不引入第二个「小模型」**：opencode 文档写死「Compaction uses the session's model. There is no separate compaction model.」；DeepSeek 允许配置 `summarizationProvider/Model`，但默认跟随路由。我们站 opencode 这边（ADR-037/063 的「preset 是唯一模型入口」）。

## 5. 四家的分歧（决定时要选边的地方）

| 分歧 | 各家立场 | 我们的取舍 |
|---|---|---|
| 「替换」的表达 | opencode：一条消息；codex：重写历史 + `CompactedItem`；deepseek：事件 + `surfaceOp.replace` | **deepseek**：我们的日志是事件溯源，替换必须是一条**可重放的替换事实** |
| 保留段怎么留 | opencode：字符串进 summary 消息（自认 TODO）；codex：复制（受 API 约束）；deepseek：不动，靠范围 | **deepseek**：不复制 |
| 用量测量归属 | deepseek：独立 `tokenMeter` 服务；opencode：函数；codex：session 累计 | **opencode 形状**（我们内核只有函数，没有 service 容器）+ **codex 的锚**（真实 usage） |
| 阈值默认 | opencode 15%/16k；deepseek 0.8 + 64k 余量；codex 可配/百分比 | 先取 opencode 形状，**数值待实测**（§9） |
| 官方原生压缩 | opencode：有（provider 侧，加密 checkpoint，只对同一 endpoint 有效）；codex：有（RemoteCompactionSupport） | **不做**：我们的合同是同仓库内核 + 两个协议适配器，加密 checkpoint 无法跨 provider 重放，收益不抵复杂度。记进「不做」清单 |

## 6. 决定草案（评审对象）

| # | 决定 | 依据 |
|---|---|---|
| **D1** | 用量 = 最后一次真实 `usage` 锚 + 之后的估算，**取大**；阈值 `ceiling = limit.context − max(15%, 16k)`；探针还包含「单条 tool_result 过大」；provider 报太长时按 70/50/35% 收缩重试一次 | opencode `estimatePrompt`/`calculateCeiling`/`SHRINK_STEPS`；codex `context_window.rs`；deepseek `tokenMeter` |
| **D2** | `context.compacted { summary, throughSeq, shadowed, model, usage }`；折叠 = `[summary] + seq > throughSeq`；**Message 增加来源 seq**；原始事件不动；`readFiles` 不动 | deepseek `compaction/summary` + `surfaceOp.replace`；codex `replace_compacted_history`；opencode 文档「更早的消息仍然存储」 |
| **D3** | 摘要是内核子操作：不进 TurnState、不写 `model.message`、**日志锁**（start/end 成对）、失败不阻塞；请求复用同一 system/tools/前缀 | deepseek 的 seam + 锁；opencode 的 session 级 service 与事件生命周期；claude 的「同一 system/tools/history + 末尾指令」 |
| **D4** | 前端把 `context.compacted` 画成一条系统行（被压 N 条 → 摘要），摘要默认折叠；不做「查看摘要」模态 | 四家都有「你看到一句 compacted」的呈现；模态是另一件事（ADR-068 ② 仍未做） |

## 7. 需要落的 ADR（清单，草案）

| # | 一句话 |
|---|---|
| **ADR-070** | **上下文用量的权威**：真实 usage 锚 + 增量估算取大；阈值 `limit.context − max(15%, 16k)`；含「单条巨大 tool_result」探针与 70/50/35% 溢出收缩；**不开 `countTokens` 端口** |
| **ADR-071** | **压缩是替换事实**：`context.compacted { summary, throughSeq, shadowed, model, usage }`；`Message` 带来源 `seq`；折叠按水位线；**不改写历史事件、不复制保留段、不清空 `readFiles`** |
| **ADR-072** | **摘要调用不是回合**：内核子操作 + **日志锁**（`context.compaction.started/finished` 成对，孤儿锁可检测）；不写 `model.message`/`model.delta`、不弹审批；失败降级为 note 并继续；**复用同一 system/tools/前缀以命中缓存**；不引入第二个模型 |
| **ADR-073** | **阈值接线到 `preset.limits.context`**（字段已存在、无人使用）；数值先按 15%/16k，实测后再定 |
| **ADR-074** | **前端呈现**：`context.compacted` 一条系统行、摘要默认折叠、无查看入口；**不做**原生/provider 侧压缩与「自动重读最近文件」 |

## 8. 任务拆分（草案，T0 落表时定稿）

| 任务 | 内容 | 依赖 |
|---|---|---|
| T1 | 估算器（chars/4 + 媒体固定值 + tool schema）+ 锚计算；纯函数与用例 | — |
| T2 | `Message.seq`（或 `state` 平行 seq 数组）+ `context.compacted` 折叠；**重放一致性**断言 | T1 |
| T3 | 摘要调用：prompt、前缀复用、日志锁、失败降级、usage 记录 | T2 |
| T4 | 触发接线：`run-turn` 的 `for(;;)` 每轮开头 + provider 溢出恢复 | T1、T3 |
| T5 | 前端：`project()` 支持 + 帧快照 + 系统行文案 | T2 |
| T6 | 收口：`doctor` 报告窗口与已用量、溢出收缩策略、文档 | T3~T5 |

## 9. 待验证（没有数字就不要写死 ADR-073 的数值）

1. **`chars/4` 在中文与代码上的误差**（deepseek 自认 CJK 偏低）：需要真实 `usage.input` 与估算对比。
2. **`usage` 的可得性**：目录里的 OpenAI 兼容端点有多少在**流式**响应里给 `input_tokens`（不给则「锚」这一腿是空的）。
3. **压缩后 `cacheRead` 的变化**：opencode 与 deepseek 都写明「替换会从第一个被替换 token 起失效前缀缓存」；我们的 `cacheRead` 数字**实测一次**再决定成本论证。
4. **15% / 16k 这两个数**：四家给的是各自上下文（窗口 200k~1M）；我们的主力 preset 窗口是 1M，15% 就是 150k，可能过大——需要按真实会话分布定。
5. **摘要请求自身会不会先超限**：四家都做了保护（opencode 的 `flattenAndDropOldest`、deepseek 的 shrink + retries、codex 的 `remove_first_item`）。我们至少要一条：**摘要输入 = 被替换区间，而不是全量历史**。
6. **失败后的可恢复性**：压缩失败 → 下一回合是否仍以同样方式失败（ADR-069 的形状）。

## 10. 附录 A：四家逐条取证

### opencode

| 事实 | 位置 |
|---|---|
| 锚 = 最后一条同路由、带计数的 assistant 消息；`input + cache.read + cache.write + output + reasoning` | `packages/core/src/session/compaction.ts` · `estimatePrompt` / `hasMeasuredPrompt` |
| 增量估算：文本 `Token.estimate`，图片 1500、PDF 2000，tool schema 计入 | 同上 · `estimatePart` / `estimateMedia` / `estimateTool` |
| 阈值 = `window − max(15%, 16k)`；未知窗口为 `Infinity` | 同上 · `calculateCeiling` |
| 溢出恢复 70/50/35% | 同上 · `SHRINK_STEPS`、`deliver` |
| 保留 15000 tokens，边界对齐到 user 消息（工具调用与结果不拆开） | 同上 · `recentStart`；文档 `compaction.mdx` |
| 摘要 = 全量对话 + 末尾指令，复用前缀；模板缺段落时补一次 nudge | 同上 · `summarize` / `NUDGE` |
| compaction 是历史的**第一条消息**，历史从最近一次完成处载入 | 同上 · `previousCompaction` |
| 事件 `started/delta/ended/failed`；usage 记 `source: "compaction"` | 同上 · `publish` / `spend` |
| 文档：更早的消息仍然存储，只是不再发给模型；无独立压缩模型 | `services/www/src/docs/content/compaction.mdx` |

### codex

| 事实 | 位置 |
|---|---|
| `TaskKind::Compact` 是一等 task；`emit_turn_started`/`emit_turn_item_started` | `codex-rs/core/src/tasks/compact.rs` |
| `PreCompactHook` 可中止；`PostCompactHook` 可中止；analytics 记前后 token | `codex-rs/core/src/compact.rs` |
| 替换历史：`sess.replace_compacted_history(...)` + `CompactedItem`（window_number/window_ids/response_id/goal_ids） | 同上 · `CompactedHistoryMetadata` |
| 复制的用户消息预算 20k tokens，超预算截断并标记 | 同上 · `COMPACT_USER_MESSAGE_MAX_TOKENS`、`build_compacted_history_with_limit` |
| summary 是带 content-kind 的 **user 消息** | `codex-rs/core/src/context/compaction_summary.rs` |
| 用量：累计真实 usage + `auto_compact_token_limit` + 百分比后置触发 + fallback buffer | `codex-rs/core/src/session/context_window.rs` |
| 摘要 prompt（四段式：进度/上下文/下一步/关键数据） | `codex-rs/prompts/templates/compact/prompt.md` |
| 支持远程（provider 侧）压缩 | `tasks/compact.rs` · `RemoteCompactionSupport` |

### DeepSeek Harness

| 事实 | 位置 |
|---|---|
| 压缩是**可选能力 seam**，不是 agent-loop 脊柱；三个 log-only 事件 start/summary/end | `docs/subsystems/compaction.md` |
| `SurfaceEventType` 故意不扩展；summary 走 `user/message` + `surfaceOp: { op:'replace', startSeq, endSeq }` | 同上 |
| `shadowedRange` / `shadowedSeqs` / `shadowedTokenCount` 记录被遮住的范围 | 同上 · `CompactionResult` |
| 锁括住整个操作；孤儿锁可检测；未匹配的 start 阻塞所有入口 | 同上 |
| 阈值 `floor(min(W×0.8, W−O−65536))`，保留 16% 的 `W−O` | `packages/compaction/compaction-basic/README.md` |
| 测量服务：`usage` 锚 + 带符号 `surfaceDeltaTokens` + 逐节点 `nodes[]` | `docs/subsystems/token-meter.md` |
| 摘要请求复用同一前缀以命中 KV 缓存；替换会使被替换区间的缓存失效 | `compaction-basic/README.md` · 「KV Cache effect」 |
| 兄弟能力：tool-result pruner（无模型调用）、image offload | `packages/compaction/README.md` |
| 已知局限：4 字符/token 对 CJK 与 JSON Schema 偏低 | `compaction-basic/README.md` · Dev Note |

### Claude Code

| 事实 | 位置 |
|---|---|
| 摘要 = 同一 system/tools/history + 末尾一条指令；复用前缀缓存 | `code.claude.com/docs/en/prompt-caching` · 「Compacting the conversation」 |
| 压缩后：启动上下文重新加载（system/CLAUDE.md/memory/MCP），重读最多 5 个最近修改文件，重注入调用过的 skill（≤5000 tokens/skill）；skill 索引不重载 | `/docs/en/context-window` |
| `/compact <指令>` 可定制保留重点；CLAUDE.md 里可写 Compact instructions | `/docs/en/costs` |
| 上下文用量与「本轮输出量」是两个数 | `/docs/en/costs` · spinner 段落 |
| 自动压缩窗口可配 | `/docs/en/model-config` · 「set the auto-compact window」 |
| 空闲时可在缓存过期前主动压缩（`idleCompaction`） | `/docs/en/prompt-caching` |

## 11. 附录 B：v1 实现（历史参照，不是决策依据）

`agent/src/prompts/compact.js`：阈值 70% 探针 + `count_tokens` 校准、`KEEP_RECENT = 6`、五段式摘要、`compact_boundary` + `compacted` 两条记录、就地 `splice` 历史；`agent/src/loop.js:316-352` 是触发点。

**它只说明「这条路走过」，不构成任何一条决定。** 与上游对比后有三点结论：它的「每轮调 count_tokens」是比四家都激进的取舍；它的「保留 6 条」是条数而非 token；它的「就地 splice」在事件溯源下不成立。
