# P7 调研：上下文压缩

> **本文件只出决定草案与 ADR 清单，不改源码、不改 ADR 表。** 决定草案要等评审拍板，ADR 表与实现是后续 PR 的事（`docs/dev-plan-v2.md` 的工作规则 3）。
>
> 调研对象是 `dev-plan-v2.md` P7 表的第一行：**上下文压缩**（调研要点：压缩触发点、压缩结果是否作为事件入日志、与回放的关系；依赖 P2、P5）。

## 证据标注约定

沿用 `docs/research/` 的既有纪律，不发明：

- **【源码】** 直接读到实现，给 `文件:行号`
- **【实测】** 本次跑出来的，给脚本名与用例号
- **【上游】** 来自官方文档
- **【推断】** 未实测的推论，**不得作为决策依据**

**本文件没有【实测】条目**：压缩的行为（阈值、摘要质量、缓存命中）全部要真实模型端点，而本会话没有（见 §10）。凡是标【推断】的，都是评审时要单独安排验证的。

## 0. 结论摘要

1. **v1 已经有一份成熟的压缩实现**，结构是「阈值触发 → 摘要一次 → 就地 splice 历史 → 写两条日志记录」（`agent/src/loop.js:318-351`、`agent/src/prompts/compact.js`）。v2 没有它，**一行都没有**。
2. **v2 的硬约束比 v1 强**：`SessionState.messages` 是事件日志的**纯折叠**（`packages/cowcat/src/kernel/state.ts:51-126`），模型请求直接用这份折叠结果（`kernel/run-turn.ts:173-181`）。所以压缩**必须**是一个事件——「进程内维护一份被压缩的历史」在 v2 是架构上的错，不是风格问题。
3. **但「压缩是事件」有一个真难点，v1 的经验掩盖了它**：v1 是就地 `splice`（改写数组），而事件只能**追加**。保留最近 N 条原文（v1 的 `KEEP_RECENT = 6`）在追加模型下不能靠「这件事发生在中间」表达。本文件 §3 给出三种解法草案，倾向「**事件自带保留段**」。
4. **触发依据在 v2 现在拿不到**：`ModelPort` 只有 `stream()`，没有 token 计数（`ports/index.ts:228-230`）；`model.usage` 有真实数字但 `reduce` 刻意不折叠它（`state.ts:85-90`）。要么让 `reduce` 记住最后一次 usage，要么只靠本地估算——本文件主张**两者都要**（§2）。
5. **摘要调用不是回合**：它不能走 turn 状态机，也不能写 `model.message`，否则前端会多出一条假的助手消息、折叠还会重复（§4）。
6. **失败必须不阻塞**：压缩失败就继续用原历史 + 一条 note。这是 ADR-069 的同一条教训（辅助功能不能把主流程搞挂）。v1 在这点上做得不好：`doCompact` 外面没有 try（`loop.js:343`），异常冒泡到 `runTurn` 的调用方被兜住（`agent/bin/cowcat.mjs:1347-1348`），于是**整回合失败**；而历史没变、阈值仍然超，**下一回合会以同样方式失败**——与 ADR-069 同一形状的「会话卡死」【源码】。

## 1. 验证环境

- **【源码】** v2 代码：本仓库工作区 `02c48ed` + PR #66（ADR-069）未合时的 `main`；`packages/cowcat` 602 tests / 586 pass（Node 24.18.0）。
- **【源码】** v1 代码：`agent/src/`（已发布 0.16.0 未发，见 HANDOFF）。
- **没有真实模型端点**：`ZHIPU_API_KEY` 不在本机 shell 里，本会话未发出任何模型请求。

## 2. 问题一：谁是「上下文用量」的权威

### 2.1 v1 怎么做的【源码】

`agent/src/loop.js:316-352`，每一轮工具循环开头：

1. **估算**：`estimateTokens(messages)`，算法是「序列化后字符数 / 4」+ 附件自带的 `tokens` 估算（`prompts/compact.js:160-164`、`attach.js:100-110`）。
2. **探针**（`loop.js:323-329`）：估算超过阈值 **70%**，**或者**历史里有一条 `tool_result` 超过 8000 字符 / 带附件——后者是为了「一条巨大输出把预算吃光」的情况，此时估算本身可能还没过 70%。
3. **校准**（`:330-339`）：探针命中才调 `provider.countTokens`（真实端点）；**失败就退回估算**（`catch` 空实现）。真正决定压缩的是 `real ?? est`。
4. 阈值来自配置 `config.maxContextTokens`（`:322`）。

关键取舍：**估算是常态、真值是校准**，不是反过来。理由很实际——`count_tokens` 是一次网络往返，每轮都调等于把回合变慢一倍。

### 2.2 v2 现在有什么【源码】

| 能力 | 现状 |
|---|---|
| 本地估算 | **没有**（`kernel/` 里没有任何 token 概念） |
| 真实计数 | **没有**：`ModelPort` 只有 `stream()`（`ports/index.ts:228-230`）；`ModelRequest` 的 `maxTokens` 只是**输出**上限（`:217-218`） |
| 真实用量 | **有，但拿不到**：`model.usage` 事件带 `{input, output, cacheRead, cacheCreation}`（`ports/model.ts:17-22`、`kernel/events.ts:55-57`），而 `reduce` 明确**不**折叠它（`state.ts:85-90`：「成本不改变对话」） |
| 预算配置 | **字段已经有，没人读**：`preset.limits.context` 存在（`kernel/preset.ts:10-19`），注释自己写着「carried so the catalogue's shape maps over; **nothing consults it yet**」 |

也就是说：**v2 连「现在用了多少」都回答不了**。

### 2.3 决定草案

**D1：用量 = 上一回合的真实 `input` tokens（若模型给过）+ 本地估算兜底；两者取大。**

- **为什么取大**：估算偏低会漏压（真的爆上下文），偏高只会早压一次（可忍受）。v1 的 `real ?? est` 是「二选一」，但真实 `input` 是**上一回合的**，这一回合光工具结果就可能翻倍——所以两者都要看。
- **为什么不用 `count_tokens` 端点**：Anthropic 有；OpenAI 兼容端点大多没有，而 201/209 个目录里的 provider 走的是后者【推断，需按目录抽查】。为一个可选能力开一个新的端口方法，收益（一次往返换更准的数字）不划算——ADR-041 已经把 `usage` 记下来了，那本身就是免费的校准源。
- **代价**：模型不给 `usage`（部分兼容端点会漏）时只剩估算，误差全部由兜底吸收；`cacheRead` 的语义也要单独处理（缓存命中的部分同样占窗口，只是便宜）。

**D2：阈值就用 `preset.limits.context`——它已经在目录里，只是还没有人读。**

`kernel/preset.ts:10-19` 的注释自己写着「carried so the catalogue's shape maps over; **nothing consults it yet**」，九个内置 preset 每个都填了 `context`（`host/presets.ts:65-120`），自定义 preset 的 schema 也带这个键（`adapters/config.ts:94`）。所以这一条不是新决定，是**把既有字段接线**：压缩成为它的第一个读者。

同理，窗口大小是**模型的事实**不是用户偏好——用户想调就换 preset 或写自定义 `presets`（ADR-063）。

**D3：探针要保留 v1 的「一条巨大 tool_result」这条腿。**

只按总量判断会漏掉「单条输出 8 万字符」的情况——它可能仍低于 70%，但会让**下一次**请求直接超限。v2 的对应物是 `tool.finished.output` 的长度。

## 3. 问题二：压缩结果怎么进日志（本文件最要紧的一节）

### 3.1 为什么必须是事件【源码】

- `SessionState.messages` 由 `reduce` 从事件算出（`state.ts:60-113`），**没有第二条写入路径**。
- 模型请求直接吃它：`messages: session.state.messages`（`run-turn.ts:173-174`）。
- 重开会话 = 重放日志（`state.ts:145-147`）。
- TUI 也是同一份事件流的投影（ADR-066 ②：同一段日志 → 同一个视图）。

所以：**任何「只在内存里替换历史」的做法，重开就失效**。这条和 ADR-059 ② 是同一个约定，不是新决定。

### 3.2 追加模型下的真难点

v1 的压缩是**就地改写**：

```js
messages.splice(0, messages.length, ...result.messages);   // loop.js:347
```

`result.messages` 可能是「wrapper + 保留的最近 6 条」（`compact.js:141-143`）。换成追加日志后，`context.compacted` 事件只能落在**当前末尾**，而它要表达的是「把**之前**的消息换成 summary，再接上**最近**几条」。

三条解法：

| 方案 | 事件形状 | `reduce` 语义 | 代价 |
|---|---|---|---|
| **A 事件自带保留段**（倾向） | `{ summary, kept: Message[] }` | `messages: [{role:'user', text: summary}, ...event.kept]` | 保留段在日志里**重复一份**（v1 是 6 条，可控）；`reduce` 仍是纯函数、仍单调 |
| B 消息带序号，读取时过滤 | `{ summary, throughSeq }` | `messages` 变成「`seq > throughSeq` 的消息」+ summary 固定在最前 | 要给 `Message` 加来源 `seq`（现在是裸结构，`kernel/messages.ts`），或者让 `state` 平行存一份序号数组——两者都会渗到每个折叠分支 |
| C 只做全量压缩（`keepRecent = 0`） | `{ summary }` | `messages: [{role:'user', text: summary}]` | 最简单，但丢掉「最近几轮原文」这个 v1 实测出来的质量差异 |

**倾向 A 的理由**：它把「重放要还原什么」写死在了事件里——`kept` 是**事实**（那几条消息曾经在窗口里），不是推算出来的。B 的正确性依赖「每条消息都有 seq」这个新不变量横跨所有折叠分支，而收益只是省几百字节。

**A 的代价要说清**：日志会**重复**最多 6 条消息（含工具输出，可能很大）。缓解：`kept` 只保留**摘要不需要**的最近轮次，并且 v1 的 `findLargeFiles` 已经证明「大文件内容可以在压缩时被替换成一行提醒」（`compact.js:30-31,133-137`）——保留段里的大 `tool_result` 同样可以被裁剪成提醒。这条建议进 ADR：**`kept` 里的单条输出也有长度上限**。

### 3.3 事件字段草案

```ts
| {
    readonly type: 'context.compacted';
    /** 给模型的那段续接文本（v1 的 WRAPPER_TEMPLATE，含指回会话文件的说明）。 */
    readonly summary: string;
    /** 被摘要覆盖的消息条数，只用于审计与前端展示，不参与折叠。 */
    readonly dropped: number;
    /** 保留的最近消息，按原顺序；全量压缩时为空数组。 */
    readonly kept: readonly Message[];
    /** 谁做的摘要（preset 名与 model），审计用。 */
    readonly model: string;
    readonly usage: ModelUsage | null;
  }
```

**为什么 `summary` 存的是「wrapper 全文」而不是纯摘要**：v1 的取舍（`compact.js:139`）——续接文本必须自解释（「本会话从一段超长对话继续」+ 指回 transcript 的路径），否则模型看到一条突兀的用户消息会困惑。存全文让重放**不需要重新拼装**。

### 3.4 与「日志是审计事实」的关系

压缩**不删除**日志里被摘要的事件：原始 `turn.opened` / `model.message` / `tool.finished` 全部还在，`context.compacted` 只影响**折叠出的 `messages`**。这一点必须写进 ADR，因为它决定了：

- 审计/成本统计仍然能看全量历史；
- `readFiles`（ADR-049）**不能**被压缩清空——它是安全闸门，压缩是上下文问题。v1 没有这个区分是因为 v1 的闸门是内存 `readSet`（`state.ts:26-34` 的注释记了这件事）。

## 4. 问题三：摘要调用在架构里属于什么

### 4.1 v1 怎么调【源码】

`compact.js:122-129`：**独立的一次 `provider.chat`**——自己的 system（`SUMMARIZER_IDENTITY`，`:7`）、自己的 max_tokens（20000）、`temperature: 1`、只给一个 `Read` 工具（让摘要者能补读文件）、模型可以是「小模型」（`loop.js:345`）。

摘要完成后写两条记录（`loop.js:348-349`）：

- `compact_boundary`（带 wrapper 全文）→ 重放时变成一条 user 消息（`session.js:66-69`）
- `compacted`（带条数）→ 重放时**跳过**（`session.js:65`）

### 4.2 v2 有三个不能做的事【源码】

1. **不能开回合**：`session.openTurn()` 会写 `turn.opened`、改写 `state.turn`，而状态机不允许「回合里开回合」（`turn.ts` 的 `canTransition`）。
2. **不能写 `model.message`**：那会往 `messages` 里追加一条助手消息，前端会显示它，折叠会重复（`state.ts:77-84`）。
3. **不能借用 `tool.finished`**：那是工具的语义，`readFiles` 会误登记（`state.ts:136-143`）。

### 4.3 决定草案

**D4：摘要是一次「内核内部调用」，走同一个 `ModelPort.stream()`，只产出一条 `context.compacted`。**

- 请求：`system` = 摘要指令（术语：v1 的 `COMPACT_SYSTEM` 可以整体迁移），`tools: []`。
  - **v1 给摘要者 `Read` 工具，v2 不予**：那是「摘要者自己补读文件」的能力，但 v2 的工具调用要经过策略层与审批（ADR-023/024），**在压缩里弹审批是不可接受的**（用户没有在等这个）。替代品是 `kept` + 大文件提醒，以及允许用户自己重读。
- **不写 `model.delta`**：那是瞬时显示（ADR-066 ②），压缩过程不该往对话流里打字。
- **失败不阻塞**：`catch` → 不写事件、给回合加一条 `compaction-failed` note、原历史继续用（与 ADR-069 同一条课）。

**D5：摘要用「当前 preset 的模型」，不引入 `smallModel`。**

v1 有 `config.smallModel`（`loop.js:345`），目的是省钱。v2 的 preset 已经是「一切模型选择的唯一入口」（ADR-037/063），再加一个隐藏的第二模型会让 `doctor`、成本审计、preset 语义全部多一条分支。**代价**：压缩贵一点。这一条建议评审时按真实账单再定，本文件只给倾向。

## 5. 问题四：压缩后前端显示什么

### 5.1 传递路径不用改【源码】

协议的事件信封把 `type` 当**纯字符串**透传（`packages/protocol/src/notifications.ts:32-36`），所以新事件**不需要**协议新方法。`project()` 对不认识的事件「第一次出现记一行 notice」（ADR-066 ②）——压缩事件会先以这种方式出现。

### 5.2 决定草案

**D6：显式支持 `context.compacted`，画一条系统行，不展示摘要内容。**

- 文案只带数字与原因（`dropped` 条被压缩成一段），摘要本身默认不展开（品牌指南 §4.2「输出默认折叠」的同一逻辑）。
- **不给「查看摘要」的入口**：那是一个新的模态（ADR-068 ② 的预览模态还没做），先记 P8/UI 待办。
- 帧快照补一幕（`packages/tui/test/frames.ts` 的既有手法）。

## 6. 问题五：附件与大文件的交互

- **压缩时附件不读字节**【源码参照】：v1 的 `renderForCompact` 只输出 `attachmentLabel(a)`（`compact.js:42-63`、`attach.js:47-50`）——摘要看到的是「有一张 320x240 的 PNG」，不是像素。v2 应照做。
- **保留段里的附件仍要 materialize**：`kept` 里的 `tool.finished` 带附件引用，下次请求还会读文件——ADR-069 的降级已经把「文件没了」这条兜住（降级成一句 `[attachment unavailable: …]`）。
- **一个正向副作用**：压缩会把「已经不存在的附件引用」移出窗口，所以 ADR-069 之后仍然可能出现的「每次请求都点名一次」的噪音，会在压缩后自然消失。
- **大文件提醒**（v1 `compact.js:30-31`）：v2 的 `Read` 结果里带不带行号格式不影响这条——提醒只需要路径。建议保留，并且同样写进 `kept` 的裁剪规则（§3.2 的代价说明）。

## 7. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| **只压缩不记录**（内存里换历史） | 重开即失效，违反 `state.ts` 的折叠约定与 ADR-059 ② |
| **压缩改写旧事件**（truncate 日志） | 日志是**追加**的事实（成本侧见 ADR-041），改写历史会让成本与安全审计同时失真；`readFiles` 也不能被压缩清空（ADR-049） |
| **每轮调 `count_tokens`** | 每轮一次网络往返；且 OpenAI 兼容端点大多没有这个能力，做出来只在 Anthropic 上有效 |
| **摘要者带工具（`Read`）** | 工具调用要过策略与审批；在压缩里弹审批不可接受（§4.3） |
| **全量压缩、不保留最近几条** | v1 特意区分了 full / recent-portion（`compact.js:100-116`），保留段是实测出来的质量差异；没有实测证据能推翻它 |
| **压缩率按「条数」而不是 token** | 条数与上下文窗口没有稳定关系（一条工具输出可以比十轮对话更大） |

## 8. 需要落的 ADR（清单，草案）

| # | 一句话 | 依赖 |
|---|---|---|
| **ADR-070** | **上下文用量的权威**：本地估算（chars/4 + 附件估算）为主、上一回合 `usage.input` 为校准、两者取大；**不开 `countTokens` 端口**；探针包含「单条巨大 `tool_result`」 | D1、D3 |
| **ADR-071** | **压缩是事件**：新增 `context.compacted { summary, dropped, kept, model, usage }`；`reduce` 把 `messages` 换成 `[summary, ...kept]`；**不改写历史事件**、**不清空 `readFiles`**；`kept` 里单条输出有长度上限 | D2（§3.3） |
| **ADR-072** | **摘要调用不是回合**：走同一 `ModelPort`、不写 `model.message` / `model.delta`、不弹审批；**失败降级为 note 并继续** | D4 |
| **ADR-073** | **阈值开始读 `preset.limits.context`**（字段早已存在、无人使用）；不引入第二个「小模型」配置键 | D2、D5 |
| **ADR-074** | **前端呈现**：`context.compacted` 画一条系统行、摘要默认折叠、无查看入口 | D6 |

## 9. 任务拆分（草案，T0 落表时定稿）

| 任务 | 内容 | 依赖 |
|---|---|---|
| T1 | 估算器（移植 v1 的 chars/4 + 附件估算）与「探针」判定；纯函数 + 用例 | — |
| T2 | 事件与折叠：`context.compacted`、`reduce` 分支、replay 一致性断言（同日志同状态） | T1 |
| T3 | 摘要调用：`kernel/compact.ts`（prompt 迁移、失败降级、usage 记录） | T2 |
| T4 | 触发接线：`run-turn` 的 `for (;;)` 每轮开头检查（`run-turn.ts:97-99` 之前） | T1、T3 |
| T5 | 前端：`project()` 支持 + 帧快照 + 系统行文案 | T2 |
| T6 | 收口：`kept` 裁剪、大文件提醒、`doctor` 报告「当前 preset 的窗口与已用量」 | T3~T5 |

## 10. 待验证（本文件最重的一节）

按「不验证就不要写进 ADR-072/073」排序：

1. **真实端点上的估算误差**：`chars/4` 对中文与代码的偏差有多大？（v1 的 `tokapprox.js` 注释承认「够用」而不是准）→ 需要真实 `usage.input` 与估算对比，至少三个 provider。
2. **`usage` 的可获得性**：目录里的 OpenAI 兼容端点有多少会在**流式**响应里给 `input_tokens`？不给的话 D1 的「校准」腿就是空的。
3. **压缩后能否继续任务**：摘要 → 换窗口 → 继续做 → 是否出现「忘了刚做的事」。这是产品问题，不是代码问题。
4. **缓存命中率的变化**【推断】：压缩会改写 prompt 前缀，`cacheRead` 大概率归零一次。**ADR-073 的成本论证依赖这个数字**，没测之前不能宣称「压缩省钱」。
5. **`kept` 复制进日志的真实体积**：6 条消息里可能含大 `tool_result`，裁剪上限取多少要看实测分布。
6. **摘要调用自身的窗口**：把整段历史塞给摘要者，会不会先超限？（v1 直接塞，没有任何保护，`compact.js:121`）

## 11. 附录 A：v1 实现要点（逐条带行号）

| 要点 | 位置 |
|---|---|
| 摘要者身份与五段式摘要结构（`<analysis>` / `<summary>`） | `agent/src/prompts/compact.js:7,9-19` |
| 续接 wrapper（自解释 + 指回 transcript 路径） | `:21-28` |
| 大文件提醒（被丢弃的大文件给一行「要用 Read 重读」） | `:30-31`、`:133-137` |
| 消息渲染成摘要文本（附件只留 label） | `:42-63` |
| 收集并判定「大文件」 | `:67-98` |
| full / recent-portion 两种形态、`KEEP_RECENT = 6` | `:100-116` |
| 摘要请求（独立 system、max 20000、temperature 1、只给 Read） | `:122-129` |
| 返回 `{ messages, boundarySummary, compactedCount }` | `:139-155` |
| 估算 token（chars/4 + 附件估算） | `:160-164` |
| 触发：估算 70% 探针 + 单条巨大 tool_result 探针 | `agent/src/loop.js:323-329` |
| 校准：`count_tokens`，失败退回估算 | `:330-339` |
| 压缩后**就地 splice** 历史 | `:347` |
| 写 `compact_boundary` + `compacted` 两条记录 | `:348-349` |
| 重放：boundary 变 user 消息、`compacted` 跳过 | `agent/src/session.js:52-72` |
| 附件 token 估算（来自附件引用上的 `tokens`） | `agent/src/attach.js:100-110` |
| **v1 已经会降级不可读附件**（`Never throws`） | `agent/src/attach.js:56-59` |

最后一行值得单独看：**v2 在 ADR-069 之前把 v1 这条做丢了一次**。压缩这一块同样有「v1 有、v2 没有」的风险，所以本文件把 v1 的行为逐条列出来当参照物。

## 12. 附录 B：本仓库相关文件现状

| 文件 | 与压缩的关系 |
|---|---|
| `packages/cowcat/src/kernel/state.ts` | `messages` 的折叠入口；新增事件要在这里加分支 |
| `packages/cowcat/src/kernel/events.ts` | 事件联合；`model.usage` 已存在但 `reduce` 不折叠 |
| `packages/cowcat/src/kernel/run-turn.ts` | `for (;;)` 循环（`:97-99`）是触发的自然位置；`request.messages`（`:173-174`）是消费处 |
| `packages/cowcat/src/ports/index.ts` | `ModelRequest` 没有窗口字段；`ModelPort` 只有 `stream()` |
| `packages/cowcat/src/ports/model.ts` | `ModelUsage` 的四个数字 |
| `packages/cowcat/src/kernel/preset.ts` | `limits.context` 已有、注释自认「没人读」；压缩是它的第一个读者 |
| `packages/tui/src/app/project.ts` | 不认识的事件只记一行 notice；压缩要显式支持 |
| `packages/protocol/src/notifications.ts` | 事件按字符串透传，新事件不用改协议 |
