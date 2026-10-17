# P4 调研：模型层

> 依据 [`dev-plan-v2.md`](../dev-plan-v2.md)「工作规则 1」：每个阶段开始前先做调研，回答阶段内的开放问题，列出被否决的方案及理由。本文件回答 P4 的开放问题，并给出它们对 P4 五项范围的具体影响。
>
> 最后更新：**2026-10-18**。状态：**调研完成，决定已定（评审通过）**。本文件给出的各项决定已由评审拍板（§2.4、§3.5、§4.5、§5.4、§6.4/§6.6、§7.4），并已全部落成 **ADR-035~043**（见 [`architecture/README.md`](../architecture/README.md) 的 ADR 表）。其中 **ADR-041 的形状由评审直接拍板**——用量进日志用**独立的 `model.usage` 事件**，不挂在 `model.message` 上。
> 前置：[`dev-plan-v2.md`](../dev-plan-v2.md) 的 `## P4` 段、[`HANDOFF.md`](../HANDOFF.md) §3、[`architecture/04-dependencies.md`](../architecture/04-dependencies.md)。
>
> **本文件的证据边界（必须先说清）**：
> - **本次没有新增探针**，因此本文件**关于协议行为的结论没有一条是【实测】**——那些结论是【源码】与【上游】。P4 的实测对象是「协议在流上的实际行为」，而适配器还不存在，仓库里也没有录制夹具——**先把夹具做出来，实测才有落脚点**。这不是省略：§8 把「T1 必须先钉住的断言」逐条列出，那些断言连同夹具就是本阶段的实测入口。
> - 除仓库既有测试套件（§1）外，本文件只有**一次新增实测**：为了给 ADR-036 的依赖预算一个真实数字，在仓库外的隔离目录装了一次两家 SDK 并数了依赖树（§1、§9 注）。**协议行为本身仍然没有实测。**
> - 【源码】分两类，**都给出 `文件:行号`**：v2 现状（`packages/cowcat/`）与 v1 旧版对照（`agent/`）。厂商清单一节的数据来自仓库自带的 `agent/assets/providers.json`，属【源码】。
> - 【上游】来自官方文档与官方 SDK 源码（出处见**附录 B**）。本轮 `websearch` 不可用（HTTP 402），全部上游证据走 `webfetch` 与 Context7 的官方文档库；凡只有单方来源的结论都标了出处，未交叉验证的另有标注。
> - 【推断】是尚未验证的推论，**不得作为决策依据**。

## 证据标注约定

沿用 [`p1-kernel.md`](p1-kernel.md)、[`p2-ports.md`](p2-ports.md) 与 [`p3-policy.md`](p3-policy.md) 的约定：

- **【源码】** 本次会话直接读到实现或数据，给出 `文件:行号`
- **【上游】** 来自官方文档或官方 SDK 源码，给出链接（附录 B）
- **【推断】** 尚未实测的推论，**不得作为决策依据**
- **【未验证】** 明确未核对

---

## 0. 结论摘要

| # | 问题 | 决定（已定 → ADR） | 依据 |
|---|---|---|---|
| 二 | `ModelPort` 契约是否够用 | **不够**。`ModelRequest` 缺 model 标识与 system；`ModelChunk` 缺用量与结束原因 | §2、【源码】`ports/index.ts:54-65` |
| 三 | 流式归一化能否做到协议无关 | **能**，但必须处理三处形态差异：工具调用**按 index 拼装**、结束信号**不看 `finish_reason`**、assistant 消息的**线格式回放** | §3、【源码】`llm/openai.js:69-71` |
| 四 | 用量统计放哪 | 归一成内部四项（input/output/cacheRead/cacheCreation）随 `ModelChunk` 出，**是否进日志单独立项** | §4、【源码】`loop.js:417-425` |
| 五 | 重试与取消的边界 | 重试**只在适配器内**、只对可重试错误；**取消立即生效且必须涵盖退避等待期** | §5、【源码】`llm/client.js:15-24` |
| 六 | 录制-回放夹具 | 录**原始 SSE 字节流**而非解析后对象；CI 不访问网络由「适配器只经注入的 transport」保证 | §6 |
| 七 | 必须支持几种协议 | **OpenAI 兼容（主力）+ Anthropic 原生**。209 家预设里 201 家是 OpenAI 协议，8 家是 Anthropic | §7、【源码】`assets/providers.json` |

**五条纠正前提的发现**（都是本次读源码/上游得出的，与前一份文档的口径不同）：

1. **v2 的 `ModelRequest` 里没有模型标识**。【源码】`ports/index.ts:58-61` 只有 `messages` 与 `tools`；`run-turn.ts:91-94` 照此构造请求。也就是说，**当前契约下内核不知道该调哪个模型**——模型选择、`max_tokens`、system 提示词都无处安放。这不是「扩字段」，是契约缺了一整类必填信息。
2. **v1 已经踩过并在注释里写明了 P4 最大的一个坑**：【源码】`llm/openai.js:69-71` 写着「完成信号在循环之后判定，不按 `finish_reason`——各家在 finish chunk 之后是否再跟一个 usage-only chunk 或 `[DONE]` 并不一致，且部分端点在 `finish_reason` 之后仍会继续发 tool delta」。同时 `:50` 显式跳过 `choices` 为空的 chunk（那就是 usage-only chunk）。**这两条是 v1 用真实端点换来的，v2 必须原样继承**，否则会重犯。
3. **Anthropic 的 `max_tokens` 是必填、`system` 是顶层字段**。【上游】附录 B-2 的 `MessageCreateParamsBase`。而 v2 内部 `Message` 联合类型**根本没有 system 角色**（【源码】`messages.ts:7-10`）。所以「把内部消息映射到线格式」不是机械翻译，system 提示词要作为**新增概念**进契约。
4. **用量归一化 v1 已经做过一遍**：【源码】`loop.js:417-425` 用 `u.input_tokens ?? u.prompt_tokens` 这类写法把两家的 usage 归到同一组四字段。v2 的 `ModelChunk` 里目前**完全没有用量**，这一段必须重做，而且要把 v1 的字段对照表当基线。
5. **v1 的协议层比想象中厚：两套 SSE 解析 + 一套错误分类**。【源码】SSE 解析器有两个——LLM 层 `llm/client.js:59-88`、MCP 传输 `sse.js:12-85`（`sse.js:9-11` 说明为何另写）；错误分类 `parseApiError`（`errfmt.js:58-80`）已有固定六类 `hint`，且**已经照顾了两家的码位差异**（OpenAI 系读 `error.code`、Anthropic 系读 `error.type`，`:65`）。这两块 P4 可以**照抄形状而不必重新发明**——但也说明「自己写协议层」在这个仓库里的实际成本已经验证过一次。

---

## 1. 验证环境

| 项 | 值 |
|---|---|
| 平台 | `win32`（Windows 11），shell 为 PowerShell / Git Bash |
| Node | `v24.18.0` |
| 仓库状态 | `main = 0d7a1f1`（P4 调研开工前刚合并 PR #25），与 `origin/main` 一致，工作区干净 |
| 测试套件 | **【实测】** 本轮开工时在 `3b28b3e` 上跑过一次：`packages/cowcat` = `347 tests / 331 pass / 0 fail / 16 skipped`（8.4s）；`agent` = `762 tests / 742 pass / 0 fail / 20 skipped`（34.6s）。此后 main 只前进了一个 **docs-only** 提交（`0d7a1f1`，仅改 `docs/` 两个文件），不可能改变测试结果 |
| 三个探针 | **【实测】** `tools/policy-decide-probe.mjs` 16/16、`tools/legacy-config-probe.mjs` 10/10、`tools/legacy-trust-probe.mjs` 8/8。这是 P3 的探针，本次重跑只为确认它们仍然全绿 |
| 本次新增实测 | **依赖树实测**（为 ADR-036）：仓库外隔离目录跑 `npm i zod@4.6.7 openai@7.36.0 @anthropic-ai/sdk@0.135.0` → **added 10 packages**；枚举与由此暴露的口径问题见 §9 注。**协议行为仍无实测** |
| 本次**未**做 | 未访问任何真实模型端点（无凭据）；未安装 `openai` / `@anthropic-ai/sdk` 做行为对照；未录任何夹具；未在 Linux/macOS 上跑东西 |

**一条方法说明**：§7 的「逐家核实」不是靠印象，而是**读仓库自带的 provider catalog**。【源码】`agent/src/llm/presets.js:9-15` 从 `agent/assets/providers.json` 读入——那是从 models.dev 蒸馏的 209 家快照，每家带 `protocol` / `api` / `env` / `models[]`。这条比搜网页更可信（它就在仓库里、可复现、有版本），所以厂商协议归属一律以它为准，网页只用来核实**线上行为的细节差异**。**注意**：蒸馏脚本本身**不在仓库里**（`presets.js:2` 的注释指向 `tools/distill-providers.mjs`，该文件不存在，见 §7.3）——所以能沿用的是**数据的形状**，不是产出它的流程。

---

## 2. 问题一：`ModelPort` 契约够不够

### 2.1 v2 现状【源码】

```ts
// packages/cowcat/src/ports/index.ts:54-65
export type ModelChunk =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_call'; readonly call: ToolCall };

export interface ModelRequest {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
}

export interface ModelPort {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>;
}
```

缺口逐条（每条都能指到具体行）：

| 缺什么 | 现状 | 后果 |
|---|---|---|
| **模型标识** | `ModelRequest` 无 model 字段（`ports/index.ts:58-61`） | 适配器不知道该调哪个模型；只能靠组合根构造适配器时闭包注入，**换模型要换适配器实例** |
| **system 提示词** | `Message` 联合类型只有 `user` / `assistant` / `tool`（`messages.ts:7-10`），**没有 system** | 项目指令（`AGENTS.md`，ADR-029/030）无处可传；Anthropic 侧它是顶层参数，OpenAI 侧是一条 message —— 两种映射都需要它先存在于契约里 |
| **生成长度上限** | 无 `max_tokens` | Anthropic 侧 **必填**（附录 B-2）；缺失会直接 400 |
| **用量** | `ModelChunk` 只有 text 与 tool_call | token 用量无处可出，「用量统计」这项范围**在契约上没有对应物** |
| **结束原因** | 无 `stop_reason` / `finish_reason` | 无法区分「正常结束」与「被 `max_tokens` 截断」；而截断是必须上报的事实（否则用户看到的是一个莫名其妙断掉的回答） |
| **错误词汇** | 无 | 适配器抛什么、内核怎么分类「可重试 / 不可重试」，目前没有任何约定 |

### 2.2 内核怎么用它【源码】

`run-turn.ts:86-111` 是唯一的生产者：构造请求 → `transition('streaming')` → `for await` 累加 text、收集 tool_call → **循环结束后**才 `emit({type:'model.message', text, toolCalls})`。

两处承重事实：

- **`model.message` 只在流结束后落盘**（`run-turn.ts:109`）。这直接决定了出口标准第二条「取消不产生半条 `model.message`」——结构上已经成立（流中途抛异常时根本走不到这一行）。
- **但取消是否在流中途生效，完全取决于适配器**。`run-turn.ts:99-106` 的 `for await` 只在**适配器吐出下一个 chunk 时**才有机会响应；`:107` 的 `signal.aborted` 检查在**循环之后**。若适配器收到 `signal` 却不理会，取消就要等到流自然结束。所以「取消立即生效」不是内核给的，是**适配器必须遵守的契约**，且必须有夹具钉住。

### 2.3 被否决的方案

- **「靠组合根闭包注入模型名，不加字段」**：否决。模型切换（P7 的「模型预设」要支持用户改）就会变成重建适配器；而且 `max_tokens` / system 缺失是**功能缺口**不是风格问题。
- **「在 `ModelRequest` 里塞一个自由的 `options: Record<string, unknown>`」**：否决。厂商扩展（§7 的 `thinking`、`reasoning_effort`）确实需要逃生口，但把**通用**字段也塞进去，等于放弃类型；通用字段显式列，厂商扩展单独走一个明确命名的字段。

### 2.4 决定（评审通过）

1. `ModelRequest` 增加：`model: string`、`system?: string`、`maxTokens?: number`（以及 §7 需要的厂商扩展逃生口）。
2. `ModelChunk` 增加两个成员：用量（`{ type: 'usage'; usage: ModelUsage }`）与结束原因（`{ type: 'stop'; reason: StopReason }`）。
3. **`ModelUsage` 定为四项**：`input` / `output` / `cacheRead` / `cacheCreation`，与 v1 的 `loop.js:417-425` 对齐；缺项填 `0`，取不到的项不得编造（沿用 ADR-033 的「拿不到就记录拿不到」）。
4. `StopReason` 用内部词汇（`end` / `toolCalls` / `maxTokens` / 厂商原值兜底），**不把 `finish_reason` 直接透给内核**：「协议细节不进内核」是本轮分层的既有取向。

### 2.5 待验证

- **用量是否要进日志，本文件留空为单独立项**（§0 摘要第 4 行）。若最终决定要进日志，那就要改 `model.message` 的形状或新增一个事件，会连带触发 ADR-031 记录过的三处编译期硬失败（`adapters/schema.ts` 的 `discriminatedUnion`、`state.ts` 的 switch 穷尽性、编译期等价断言）。**这是 P4 最大的一个未定项**，建议在 T1 之前先拍板。
- `test/support.ts:103-121` 的 `ScriptedModel` 是唯一现成的 `ModelPort` 替身；契约一改，它必然要改——这正是「新增依赖只改 `support.ts`」那条约定的落点。

---

## 3. 问题二：流式归一化——两家的形态差异

### 3.1 v1 已经做过，且把结论写在注释里【源码】

**OpenAI 侧**（`agent/src/llm/openai.js`）：

- 文本与「推理文本」分开取：`reasoning_content ?? reasoning`（`:7-10`）——**注释明说这是为兼容厂商扩展**。
- tool_calls 增量**按 `index` 归并**：`agg.args += tc.function.arguments`，并以 `{ index, id?, name?, argsDelta }` 的形式向上抛（`:56-65`、`:37`）。
- **完成信号不看 `finish_reason`**：`:69-71` 的注释是这一段的核心——
  > 「Completion signal fires after the loop (not on finish_reason): providers vary on whether a usage-only chunk or `[DONE]` follows the finish chunk, and tool deltas may still arrive after finish_reason on some endpoints.」
- **显式跳过空 `choices` 的 chunk**：`if (!choice) { if (ev.usage) usage = ev.usage; continue; }`（`:50`）。
- 请求侧已经开了用量：`stream_options: { include_usage: true }`（`:119`）。

**Anthropic 侧**（`agent/src/llm/anthropic.js`）：

- tool_use 从 `{ index, id, name, argsDelta: '' }` 起，逐条 `input_json_delta` 拼 `argsDelta`（`:30`、`:63`）。
- `message_delta` 给 `stop_reason`（`:74`）；**usage 用合并而不是覆盖**：`usage = { ...(usage||{}), ...ev.usage }`（`:75`、`:78`）——`:78` 是 `message_start.message.usage`。

### 3.2 上游确认这两条不是 v1 的臆断【上游】

- OpenAI：`stream_options: {include_usage: true}` 之后，**最后一个 chunk 的 `choices` 是空数组**，usage 只在这条上（附录 B-1 的 `how_to_stream_completions` 逐 chunk 输出即为此）。
- Anthropic：`message_delta` 的 usage 是**累积量且会省略可选键**，官方 SDK 自己有一条测试就叫 `keeps message_start usage when message_delta omits the optional keys`（附录 B-2）。**「合并而非覆盖」有官方测试背书**，v1 的做法是对的。

### 3.3 真正的工作量：把内部扁平消息回放到两种线格式【源码】+【上游】

v2 内部的 `Message` 是扁平的（`messages.ts:7-10`），由 `state.ts:59-68` 从 `model.message` 与 `tool.finished` 归约而来。回放到线上时两家要求不同：

| 内部 | OpenAI（Chat Completions） | Anthropic |
|---|---|---|
| `{role:'user', text}` | `{role:'user', content}` | `{role:'user', content:[{type:'text',text}]}` |
| `{role:'assistant', text, toolCalls}` | 一条 `{role:'assistant', content, tool_calls:[…]}`，`arguments` 是 **JSON 字符串** | 一条 `{role:'assistant', content:[{type:'text'},{type:'tool_use',id,name,input}]}`，`input` 是**对象** |
| `{role:'tool', callId, ok, output}` | 一条 `{role:'tool', tool_call_id, content}` | **一条 `{role:'user', content:[{type:'tool_result', tool_use_id, content}]}`** |
| 无 system | `{role:'system', content}` 一条 message | **顶层 `system` 参数** |

两条必须守住的约束：

- **`tool` 结果必须紧跟触发它的 assistant 消息**。【源码】`llm/openai.js:212` 的注释与实现都按这个顺序发；Anthropic 侧更严格——tool_result 必须落在**紧随其后的 user 回合**里，且**必须排在该条消息 content 的头部**（`llm/anthropic.js:261-276`，注释点名这是 Kimi 的转换器要求）。v2 的扁平序列天然满足「紧随其后」（`state.ts:64-68` 的追加顺序就是 assistant → tool），但**适配器不能重排或合并**。
- **附件让两家的消息形态进一步分叉**：OpenAI 协议的 tool result **只能是字符串**，于是图片得拆成后续 user 消息的 `image_url` data-URL（`llm/openai.js:143-165`）；Anthropic 侧图片直接进 tool_result 的 content、PDF 作为兄弟 document block（`llm/anthropic.js:228-246`）。**v2 的 `ToolResult` 现在只有 `ok` / `output: string`**（`ports/index.ts:37-47`），所以**多模态在 P4 的契约里根本表达不了**——它属于 P7 的模块，P4 只需保证契约**不会把它挡死**。
- **不能丢推理文本**。【上游】MiniMax 明确要求多轮 function call 时必须把**完整的 assistant 消息**（含 `content` 里的 ` thinking` 标签，或 `reasoning_content`）加回历史，否则思维链断裂（附录 B-3）。这意味着适配器**对未知字段要保留而不是过滤**——与 04-dependencies「不因不认识的字段而失败」同一取向。

### 3.4 被否决的方案

- **「自己写 SSE 解析，不引 SDK」**：**未否决，但要按判断标准 1 重新算账**。v1 手写了**两套** SSE 解析：LLM 层是 `agent/src/llm/client.js:59-88` 的 `parseSSE`（自己处理跨 chunk 断行、多行 `data:` 拼接、`[DONE]` 哨兵、以及**JSON 解析失败静默丢帧**），`agent/src/sse.js:12-85` 是**第二套**、只服务 MCP 传输——`sse.js:9-11` 的注释说明它存在的理由。也就是说「自己写」在这里的实际代价是**两套实现**。判断标准 1 说的是「承担协议责任」→ 优先官方库。§8 把它作为 T1 的第一件事去核对（含「SDK 是否真的省掉了这些活」）。
- **「统一走 OpenAI 协议，Anthropic 也用一个兼容层」**：否决。Claude 的官方端点没有 OpenAI 兼容层；`@anthropic-ai/sdk` 是协议实现方。§7 的数据也说明 Anthropic 不是长尾（`anthropic` 本体 + MiniMax 四条目）。

### 3.5 决定（评审通过）

1. 归一化**以 `ModelChunk` 为唯一出口**，两家适配器各自完成「拼装 → 归一」，内核看不到 `delta` / `content_block` / `index` 这些词。
2. **完成信号一律取「流结束」**，不取 `finish_reason` / `stop_reason`（继承 v1 `openai.js:69-71` 的实测结论）；`stop_reason` 只用于**分类**（正常 / 工具调用 / 截断），不用于判断结束。
3. usage **合并而非覆盖**，且允许中途多次出现（Anthropic 的 `message_delta` 是累积量）。
4. 工具调用**允许在 `finish_reason` 之后继续到达**：拼装不得在 `finish_reason` 出现时提前封口。

### 3.6 待验证

- 「工具调用在 `finish_reason` 之后继续到达」是 v1 注释里的说法，**本次未在真实端点上复现**【未验证】。它值得在 T1 用夹具复刻一次——若复刻不出，这条就降级为防御性写法而非必须。
- SDK 的流式形态是否**已经**替我们做了按 index 拼装（若已做，适配器只需翻译事件）。【上游】只查到事件类型清单，**未逐字段核对**〔未验证〕。

---

## 4. 问题三：用量统计

### 4.1 两家的字段名【上游】+【源码】

| 概念 | OpenAI | Anthropic | v1 的归一写法【源码】 |
|---|---|---|---|
| 输入 | `prompt_tokens` | `input_tokens` | `u.input_tokens ?? u.prompt_tokens ?? 0`（`loop.js:422`） |
| 输出 | `completion_tokens` | `output_tokens` | `u.output_tokens ?? u.completion_tokens ?? 0`（`:423`） |
| 缓存读 | `prompt_cache_hit_tokens`（厂商变体） | `cache_read_input_tokens` | `u.cache_read_input_tokens ?? u.prompt_cache_hit_tokens ?? 0`（`:424`） |
| 缓存写 | —— | `cache_creation_input_tokens` | `u.cache_creation_input_tokens ?? 0`（`:425`） |

v1 把四项累加进 `sessionArtifacts.usage`（`loop.js:313`）。**注意第四行**：OpenAI 侧没有「缓存写」，v1 直接补 `0`——这与「拿不到不得编造」有张力，但 `0` 在这里表示「该协议没有这个概念」，是**可判定**的缺失，与 ADR-033 说的「工具没上报」不同类。这条要在 ADR 里写清区分。

### 4.2 流式下用量默认拿不到【上游】

- OpenAI：必须显式 `stream_options.include_usage = true`；否则整个流里没有 usage。（v1 已经开了，`openai.js:119`。）
- Anthropic：`message_start` 给 input 与 cache 计数，`message_delta` 给累积 output。
- MiniMax：同样的 `stream_options.include_usage`，且**思考 token 计入 `max_tokens`**——设小了会 `finish_reason: 'length'` 且 `content` 为空（附录 B-3）。这是「截断必须上报」的一个真实触发场景。

### 4.3 上下文长度的计数：两家能力不对称【源码】+【上游】

v1 的做法（`agent/src/llm/`）：

- **Anthropic 有真实端点**：`POST /v1/messages/count_tokens?beta=true`，取返回的 `input_tokens`（`anthropic.js:131-141`，beta 头见 `:9`）。
- **OpenAI 兼容端没有这个端点**，退化为本地估算（`openai.js:104-109`）。
- 本地估算器**有两个且互不相干**：`llm/tokapprox.js`（无依赖启发式，自称 ±20%，按 CJK ≈1 token/字分段累计，`tokapprox.js:9-28`；**全仓唯一引用点是 `openai.js:108`**）与 `prompts/compact.js:160-164` 的 `estimateTokens`（`chars/4`，被 compact 阈值用，`loop.js:321-323`）。

对 P4 的意义：**「估算上下文长度」不是模型层的统一能力**——一种协议能问端点、另一种只能猜，且猜的精度直接决定压缩阈值什么时候触发。这条**不放进 P4**（P4 不做压缩），但 `ModelPort` 若要暴露计数能力，**必须允许「不可用」而不是假装有个数字**（与 §2.4 决定 3 的「拿不到不得编造」同一条纪律）。

### 4.4 被否决的方案

- **「用量烂在适配器里，不往上报」**：否决。`/cost` 是 v1 已有的用户可见能力（`loop.js:417-425` 的注释就是「aggregate usage for /cost」），P8 不得功能回退。
- **「每条 chunk 都带一份累计用量」**：否决。流式下多数 chunk 没有用量；只在**拿到时**发一条 `usage` chunk，语义更诚实（与「工具没上报 ≠ 没施加沙箱」同构）。

### 4.5 决定（评审通过）

1. 适配器在拿到用量时**发一条 `{type:'usage'}` chunk**；一条流里可以出现一次或多次（后者取最后一次为最终值，因为 Anthropic 是累积量）。
2. 归一为四项 `input/output/cacheRead/cacheCreation`，缺失按 §4.1 的规则处理并在 ADR 里写明「协议无此概念」与「厂商没上报」的区别。
3. **用量进日志，形状是独立的 `model.usage` 事件**（评审拍板 → ADR-041），**不挂在 `model.message` 上**。取舍写清楚：独立事件让「流在拿到用量之后被取消」**也留下用量**，代价是新增事件变体、触发 ADR-031 记的三处编译期硬失败；挂在 `model.message` 上则只触发编译期等价断言一处，但**取消即丢用量**。v2 日志格式从未发布，**不升 `schemaVersion`**（ADR-019）。

### 4.6 待验证

- OpenAI 兼容端点里，`stream_options` 是否被普遍支持。【未验证】——`302ai` / `siliconflow` 这类聚合网关很可能支持，但**不能假定**；解析必须容忍「开了也不给」。
- Anthropic 的 `cache_creation_input_tokens` 是否在流式下仍出现。【未验证】

---

## 5. 问题四：重试、退避与取消

### 5.1 v1 的做法【源码】

`postJSON(url, headers, body, { timeoutMs = 300000, retries = 3, signal })`（`agent/src/llm/client.js:16`）是两家 provider 共用的 fetch/重试层：

- **重试判据**：`429` 与 `5xx` 显式标 `retryable: true`（`:37-39`）；`401 / 403` 归为 `ConfigError`（配置问题）**不重试**（`:32-35`）；其余非 2xx 不重试（`:41-43`）；网络层只把 `AbortError`（即超时）与 `ECONNRESET` 当可重试（`:48`）。
- **退避**：`sleep(1000 * 2 ** attempt)`（`:50`）——1s / 2s / 4s，**固定指数、无抖动、无上限**；默认 `retries = 3`（即最多 4 次请求）。
- **超时**：每次尝试各起一个 `setTimeout(() => ctrl.abort(), timeoutMs)`（`:24`、`:52`），默认 **300 000 ms**（`:16`；config 默认同值 `agent/src/config.js:65`）。它是**单次尝试的超时**，不是整个流的总时长〔是否只作用于握手阶段未验证，见 §10〕。
- **取消**：每次尝试各建一个 `AbortController`，进循环先查 `signal.aborted`（`:21`）；外层 signal 通过 `addEventListener('abort', () => ctrl.abort(), { once: true })` 桥接到本次尝试（`:22`）。
- **退避等待期不看 signal**：`sleep` 是纯 `setTimeout`（`:13`、`:50`），**不会**被取消提前打断；但下一次尝试开始时 `:21` 会立刻看到 `aborted` 并放弃。**净效果是「等待期不生效、等待结束后不再发新请求」**——这正是 §5.4 决定 3 要改掉的行为。
- **流式响应不重试**：`postJSON` 拿到响应头就返回，body 读取（`parseSSE`）在它之外；这一段失败**不重试**。`parseSSE` 的 `reader.read()` 也**不接 signal**（`client.js:60-72`），所以「流已经开始输出」之后既不能重试、也没有取消路径〔对实际中断行为的影响未实测，见 §10〕。

**一处需要精确表述的监听器问题**：`:22` 的监听器带 `{ once: true }`，所以 **abort 时会自动摘除**——它不是「泄漏」。但**成功路径上永不摘除**：一次会话里重试（或失败）次数越多，挂在**会话级长寿命 signal** 上的监听器就越多。P3 在 `run-turn.ts:215-218` 用 `finally { removeEventListener }` 处理过同类问题，P4 应沿用那个写法（而不是依赖 `once`）。

**v1 的错误分类已经存在，且值得照抄形状**（`agent/src/errfmt.js`）：

- `parseApiError`（`:58-80`）把任意异常归一为 `{ status, code, message, hint, summary }`。
- `hint` 是**固定六类**（`:8-33`）：`unknownModel` / `visionUnsupported` / `auth` / `rateLimit` / `server` / `network`。判定：`401/403` → auth，`429` → rateLimit，`5xx` → server，无 status 且匹配网络正则 → network（`:72-75`）；`unknownModel` 由厂商自定码触发——**注释里点名的例子是智谱的 `"1211"`**（`:3`、`:70`）。
- `code` 的取法已经照顾了两家的差异：`err.code ?? body.error.code ?? body.error.type`（`:65`）——**OpenAI 系读 `error.code`，Anthropic 系读 `error.type`**。
- **没有「上下文超长」与「内容过滤」两类**（全仓 grep 无匹配）；`stop_reason === 'max_tokens'` 只在 UI 侧给提示（`loop.js:435-436`），不进错误分类。

这条对 P4 的直接意义：**「可重试 / 不可重试」与「给用户看什么」是两件事，v1 已经在两个层面分开做了**（`LLMError.retryable` 在 `client.js:4-11`，`hint` 在 `errfmt.js`）。P4 只做前者，后者是前端的事。

### 5.2 上游给的默认值【上游】

- OpenAI SDK：默认 `maxRetries = 2`，指数退避；**默认重试的状态码与方法是**：连接错误、`408`、`409`、`429`、`>=500`（后四类**与方法是否幂等无关**）；连接错误/超时只在「请求体可重放、且传输层证明未发出字节」时才重试。`503` + `Retry-After` 要**至少等它说的时长**（附录 B-1）。
- Anthropic SDK：默认 `maxRetries = 2`；每次请求可传 `{ maxRetries, timeout, signal }`；错误是**按状态码二分出的 `APIError` 子类**，判断中止要用 `isAbortError(err)` 而不是 `instanceof`（附录 B-2）。

### 5.3 被否决的方案

- **「重试放内核，适配器只做一次尝试」**：否决。可重试性**是协议与厂商的知识**（`Retry-After`、`overloaded_error`、厂商自定的错误码如 MiniMax 的 `2013`），把它提到内核就要内核认识每家协议——与 ADR-014「子进程只经 ProcessPort，平台知识不进内核」同一条思路。
- **「重试次数与退避可配置，默认对齐 v1 的 3 次」**：否决「可配置」这一步。先固定一个值（**建议 2，与两家 SDK 的默认一致**），把配置面留到真有需求时。理由是 v1 的 3 次没有任何依据，而 2 有两个独立来源。
- **「取消只在 chunk 边界生效」**：否决。见 5.4 决定 3。

### 5.4 决定（评审通过）

1. **重试在适配器内**，只对可重试错误；错误分类表以「连接失败 / 408 / 409 / 429 / 5xx / 厂商自定可重试码」为准。
2. 重试次数默认 **2**，指数退避，**尊重 `Retry-After`**。
3. **取消必须涵盖退避等待期**：退避的 `sleep` 自身要响应 `signal`，否则「取消立即生效」在重试场景下不成立——这正是 P3 在审批等待上修过的同一类缺陷（`run-turn.ts:183-219` 的注释把旧版「`await` 期间从不看 signal」记为要修的缺陷）。
4. **每次尝试各自持有 AbortController，并在 `finally` 里 `removeEventListener`**——不依赖 `{ once: true }`（v1 用了 `once`，abort 时会自动摘除，但**成功路径上永不摘除**，长寿命会话 signal 上会累积）。
5. **超时语义要区分**：单次尝试的握手/首字节超时，与「整个流的总时长」是两回事；流式请求给总时长上限会误杀长回答。P4 只做前者，后者需要「空闲超时」语义〔待设计〕。
6. **已经开始输出的流不重试**（v1 本来也不重试，见 §5.1——但那是实现的结果，不是写下来的规则；P4 要把它写成规则，并有一条夹具钉住）。

### 5.5 待验证

- `Retry-After` 在国产端点上的实际存在率。【未验证】
- 流式请求**中途断开**（而非未开始）算不算可重试。【未验证】——它不该算：部分内容已经流过，重试会导致模型重说一遍。**建议默认不重试已经开始输出的流**（§5.4 决定 6），并在 ADR 里写明。
- **流 body 读取阶段有没有取消路径**。【未验证】v1 没有（`parseSSE` 的 `reader.read()` 不接 signal，§5.1）；SDK 是否提供了这一条是 T1 要核对的。
- v1 那个 300 000 ms 超时**是否只作用于握手**（而非整个流）。【未验证】它直接决定「超时语义要区分」这条决定的形式。

---

## 6. 问题五：录制-回放夹具

### 6.1 为什么必须录「原始字节」而不是解析后的对象

P4 的出口标准要求**两种协议的录制夹具产出相同的事件序列**。若夹具存的是解析后的对象，那么录的其实是**我们的解析结果**——解析器写错时夹具会跟着一起错，测试全绿而线上全错。这正是「记录事实而不是结论」在测试层的同一条道理。

### 6.2 机制：CI 不访问网络靠「注入 transport」保证

`ModelPort` 的适配器如果在内部直接 `fetch`，就**没有任何机制**能阻止 CI 访问网络。可验证的做法是给适配器注入一个 transport（或注入两家 SDK 都支持的 `fetch` 参数——附录 B-2 的 `Anthropic({ apiKey, fetch })` 与 OpenAI SDK 的 `fetch` 选项都允许），于是：

- 单测传入**回放 transport**（从夹具返回录制好的字节流）；
- 「CI 里不发真实请求」变成**构造上不可能**，而不是一句纪律。

### 6.3 被否决的方案

- **「用假的 Response 对象打桩 SDK」**：否决。打桩的是 SDK 的入口，测到的是「我们以为 SDK 怎么调」，绕过了 SDK 真正的 SSE 解析与事件拼装——而 §3.2 恰好说明这些细节才是坑所在。
- **「录解析后的 chunk 序列」**：否决，理由同 6.1。
- **「照抄现成的录制库（如 VCR 类）」**：否决。判断标准 2/3：这是一个几十行的「读文件 → 返回 Response」适配器，不值得一个依赖，且它必须能被端口隔离。

### 6.4 决定（评审通过）

1. 夹具 = **原始 SSE 字节流 + 一份请求侧的期望**（方法、URL 路径、以及关键请求字段的快照），按「厂商 / 协议 / 场景」命名存放在 `test/fixtures/`。
2. 适配器构造参数接受注入的 transport；**录制模式下**由开发期脚本（`tools/` 下，不进 lint 门禁与发布包）在显式给定凭据时抓一次真实流并落盘。
3. 夹具同时充当**厂商差异的钉板**：§7 列出的每条差异都要有一条夹具，否则那条差异就是「文档声称」而不是「已验证」。

### 6.5 待验证

- 凭据从哪来（录制脚本读环境变量，且**不得**写进仓库）。仓库已有 `.keys.env` 忽略规则（`AGENTS.md`），录制脚本必须沿用。
- 夹具里若含真实请求的 header（如 `Authorization`），**落盘前必须裁剪**；这条要写进录制脚本而不是靠人记得〔见 §9 的「需同步修改」〕。

### 6.6 决定（评审通过）——夹具的目录与命名

```
packages/cowcat/test/fixtures/<protocol>/<provider>/<scenario>.sse     # 录制的字节流
packages/cowcat/test/fixtures/<protocol>/<provider>/<scenario>.json    # 请求侧期望
```

**注意**：`packages/cowcat` 的测试跑在 `dist/` 上，但**夹具是数据不是代码**，不应被 `tsc` 处理——T1 要确认 `tsconfig` 的 `include` 不会把它扫进去，也不会漏掉不复制到 `dist/`。这是 `AGENTS.md` 那条「改了源码没重新 build 就会测到旧的 .js」的同类问题。

---

## 7. 问题六：模型预设与厂商差异（逐家核实）

### 7.1 逐家核实的结果——不是查网页，是读仓库自带的 catalog【源码】

`agent/assets/providers.json` 共 **209 家**，每家带 `id,name,env,protocol,doc,api,models`。**协议分布**：

| protocol | 家数 |
|---|---|
| `openai` | **201** |
| `anthropic` | **8** |

8 家 Anthropic 的清单（全列，不筛）：`anthropic`、`minimax`、`minimax-cn`、`minimax-coding-plan`、`minimax-cn-coding-plan`、`subconscious`、`thinkingmachines`、`freemodel`。

**结论**：**OpenAI 兼容是主力**（201/209），Anthropic 协议也不是长尾（Claude 本体 + MiniMax 一家四条目 + 两个网关）。两种协议都必须实现。

国产/中国区厂商逐家（`protocol` | `api` | 首个模型）：

| 厂商 | protocol | api | 默认模型 | tool_call |
|---|---|---|---|---|
| `deepseek` | openai | `https://api.deepseek.com` | `deepseek-flash` | true |
| `alibaba-cn` | openai | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.8-omni-flash` | true |
| `alibaba` | openai | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | 同上 | true |
| `zhipuai` | openai | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.3-flashx` | true |
| `zai` | openai | `https://api.z.ai/api/paas/v4` | 同上 | true |
| `moonshotai-cn` | openai | `https://api.moonshot.cn/v1` | `kimi-k3` | true |
| `moonshotai` | openai | `https://api.moonshot.ai/v1` | `kimi-k3` | true |
| `volcengine` | openai | `https://ark.cn-beijing.volces.com/api/v3` | `glm-5-3-flash-260828` | true |
| `minimax-cn` | **anthropic** | `https://api.minimax.cn/anthropic/v1` | `MiniMax-M3` | true |
| `minimax` | **anthropic** | `https://api.minimax.io/anthropic/v1` | `MiniMax-M3` | true |
| `stepfun` / `stepfun-ai` | openai | `https://api.stepfun.com/v1` / `…/ai/v1` | `step-5-preview` | true |
| `siliconflow-cn` / `siliconflow` | openai | `https://api.siliconflow.cn/v1` / `…/com/v1` | `zai-org/GLM-5.2` / `zai-org/GLM-5.3-Flash` | true |
| `xiaomi` | openai | `https://api.xiaomimimo.com/v1` | `mimo-v2.6-pro` | true |
| `tencent-coding-plan` | openai | `https://api.lkeap.cloud.tencent.com/coding/v3` | `hunyuan-2.0-thinking` | true |
| `sensenova` | openai | `https://token.sensenova.cn/v1` | `deepseek-v4-pro` | true |
| `modelscope` | openai | `https://api-inference.modelscope.cn/v1` | `ZhipuAI/GLM-4.6` | true |
| `qiniu-ai` · `iflowcn` · `longcat` · `scnet-token-plan` · `kimi-code-plan-cn` | openai | （见 catalog） | —— | true |
| `bailing` | openai | `https://api.tbox.cn/api/llm/v1` | `Ring-1T` | **false** |

**三条从数据里直接读出来的结论**：

1. **同一个厂商会给两套端点**：`minimax-cn` 在 catalog 里是 `anthropic` + `…/anthropic/v1`，而 **MiniMax 官方文档同时给出了 OpenAI 兼容端点 `https://api.minimax.cn/v1`**（附录 B-3）。**「某家只支持哪种协议」是 catalog 的分类选择，不等于该家的能力上限**——这条对「预设以数据形式存在」的设计有直接影响（见决定 3）。
2. **`tool_call: false` 的模型真的存在**（`bailing/Ring-1T`）。所以「把工具 schema 发下去」不能无条件做：模型不支持时**发与不发都是错的**，正确行为是**发之前看预设**，并把「该模型不支持工具」作为可判定的事实上报。
3. **catalog 自身有缺口**：8 家 openai 协议厂商**没有 `api` 字段**（`deepinfra` / `groq` / `cerebras` / `perplexity` / `xai` / `mistral` / `togetherai` / `openai`），按 `agent/src/config.js:311` 会回落到 `https://api.openai.com/v1`。**所以「catalog 可信」要加限定**：条目与形状可信，**完整性未验证**（见 §10 第 12 项）。

### 7.2 线上行为的差异（有出处）【上游】

| 差异 | 出处 | 对适配器的影响 |
|---|---|---|
| DeepSeek 同时提供 OpenAI 与 Anthropic 端点，并带 `thinking` / `reasoning_effort` 扩展 | B-4 | 通用字段之外要有厂商扩展逃生口；**同一个模型可经两种协议访问** |
| MiniMax 的思考增量走 **`reasoning_content`**（新模型）或**留在 `content` 里的 ` thinking` 标签**（M2.x） | B-3 | 「文本」不是单一来源；**且历史回放时必须原样保留**，否则多轮思维链断裂 |
| MiniMax `reasoning_effort` 不支持 `none`，传了**直接 400**；`thinking.type='disabled'` 对 M3.1-Flash-Preview 也 **400** | B-3 | 厂商扩展**不能靠默认值猜**：预设里没有的档位不能发 |
| MiniMax 部分 OpenAI 参数（`presence_penalty` / `frequency_penalty` / `logit_bias`）被**静默忽略**；`n` 只接受 1；旧 `function_call` 已废弃 | B-3 | 「发下去没报错」不等于「生效了」；这也解释了为什么不能靠试探失败来发现能力 |
| `max_tokens` 与 `max_completion_tokens` 并存，后者是新推荐字段 | B-3 | §2 的 `maxTokens` 映射到哪一侧需要按协议决定，不是一对一 |
| 错误里带厂商自定码（如 MiniMax 的 `2013`） | B-3 | 可重试分类要有「厂商自定码」这一档 |
| OpenAI `503 server_is_overloaded` + `Retry-After`；`slow_down` 独立于 `server_is_overloaded` | B-1 | §5.4 决定 2 的直接依据 |
| **同一个「思考深度」档位在两家要映射成不同参数**：v1 的经验是 OpenAI 侧发 `reasoning_effort`（`llm/openai.js:90`、`:120`），Anthropic 侧发 thinking budget（`llm/anthropic.js:170-177`），注入点是 subagent 包装器 `withEffort`（`subagent.js:16-21`） | 【源码】 | §7.4 决定 4 的逃生口**必须按协议分别映射**，不能一个字段名走天下 |
| Anthropic 有**协议专属**的 prompt cache 断点（system 尾块 + 最新消息尾块，`llm/anthropic.js:182-208`；开关 `config.js:66`），OpenAI 侧没有对应物 | 【源码】 | 缓存控制是协议专属能力，预设要能表达「这家有这个开关」；它正是 §4.1 里 `cacheRead` / `cacheCreation` 两项的来源 |

### 7.3 被否决的方案

- **「预设写死在代码里」**：否决，且**有明确的替代品**——仓库已经有 209 家的 catalog，形状是 `protocol` / `api` / `env` + 每模型的 `limit` / `tool_call` / `reasoning_options` / `cost`（【源码】`agent/assets/providers.json`，读入点 `llm/presets.js:9-15`）。P4 应当**沿用这个形状**。**但要注意**：产出它的蒸馏脚本**不在仓库里**（`presets.js:2` 注释指向 `tools/distill-providers.mjs`，该路径不存在，`agent/tools/` 也不存在）——沿用形状可行，沿用「怎么更新它」这件事**没有现成答案**，需要另定（见 §10 第 11 项）。
- **「预设随包发一份 209 家的大表」**：否决。v2 是内核库（`private: true`，从未发布），预设应该由**组合根**注入数据；内核只认形状（`ModelPreset` 类型），不认某一家。
- **「靠失败探测厂商能力（发一次看报不报错）」**：否决。§7.2 第 4 行正是反例：参数被**静默忽略**时探测结果与「支持」无法区分，而 MiniMax 的 `400` 又会让探测本身失败。

### 7.4 决定（评审通过）

1. **首个适配器做 OpenAI 兼容（Chat Completions）**，不做 Responses API。理由：201/209 家是它；【上游】OpenAI 自己也说 Responses 是新项目推荐，但**兼容端点只实现 Chat Completions**。
2. **第二个适配器做 Anthropic 原生**，走 `messages` + `stream: true` + 6 种 `RawMessageStreamEvent`。
3. **预设是数据**：形状由 `ModelPreset` 类型固定（厂商 / 协议 / baseURL / 环境变量名 / 模型条目 / 每模型的 `limit`、`toolCall`、`reasoningOptions`），**数据由组合根给**，内核不认识任何具体厂商。
4. **厂商扩展走一个显式命名的逃生口**字段（如 `providerOptions`），**只在预设声明了该档位时才发**——不猜默认值。
5. **`toolCall: false` 的模型不发 `tools`**，并把这件事作为可判定事实返回。

### 7.5 待验证（本节最重的一堆）

- §7.2 的每一条都来自**厂商文档**。而 HANDOFF §3 的教训正是「**文档声称与实现实际经常不一致**」。**所以 §7.2 全部标【上游】，未经端点实测**；每条差异都要在 T1 用夹具（§6.4 决定 3）钉住之后才算【实测】。
- 其余 200 家的端点在流式细节上是否一致。【未验证】——只能靠夹具逐个覆盖，不能推断。
- 智谱 / Moonshot / 火山 / 阶跃等的**流式 tool_calls 拼装与 usage 字段名**是否与 OpenAI 完全一致。【未验证】。本轮未逐家取到可核实的流式样例。

---

## 8. 对 P4 五项范围的具体影响

| # | 范围 | 现状 | P4 要做的事 |
|---|---|---|---|
| 1 | `ModelPort` 适配器（OpenAI 兼容 + Anthropic） | **不存在**：`src/adapters/` 下无任何 model 文件 | 两个适配器 + 注入式 transport；契约先改（§2.4） |
| 2 | 流式归一化 → `ModelChunk` | `ModelChunk` 只有 text / tool_call（`ports/index.ts:54-56`） | 扩契约；按 index 拼装、按「流结束」判完成、usage 合并而非覆盖（§3.5、§4.5） |
| 3 | 重试与退避 | 无 | 适配器内；默认 2 次；尊重 `Retry-After`；**取消涵盖退避等待**；不留监听器泄漏（§5.4） |
| 4 | 录制-回放夹具 | 无 | 原始 SSE 字节 + 请求期望；注入 transport 使 CI 无法访问网络（§6） |
| 5 | 模型预设以数据形式存在 | 无（v1 有 209 家 catalog，形状可沿用） | `ModelPreset` 类型 + 组合根注入；`toolCall:false` 不发 tools；厂商扩展不猜默认（§7.4） |

**出口标准的两条，落到具体机制上**：

- **「同一回合脚本在两种协议的录制夹具上得到相同的事件序列」**：要求 §3 的归一化真正协议无关。**会被两个协议天然打断的地方有三处，都必须在比对前归一**：① tool call id 由各协议自造；② `stop_reason` 词汇不同；③ usage 字段名不同（§4.1）。**建议比对的是「归一后的事件序列」，且把 id 用夹具里的稳定值替换**——否则这条出口标准写不成测试。这是一条**必须在 ADR 里定死的口径**。
- **「取消在流式中途生效且不产生半条 `model.message`」**：后半句由 `run-turn.ts:109` 结构保证；前半句**只能靠夹具**：喂一条「中途 abort」的夹具，断言（a）适配器在收到 abort 后**不再产出 chunk**，（b）`model.message` **一条都没有**，（c）退避等待期内的 abort 同样立即生效。

**T1 必须先钉住的断言清单**（这条清单就是本阶段缺失的【实测】的入口）：

1. OpenAI 侧：`choices: []` 的 usage chunk **不崩**、且用量被取出（对照 v1 `openai.js:50`）。
2. 工具调用参数**跨 chunk 分片**能拼出完整 JSON；分片边界落在多字节 UTF-8 中间时也是。
3. `finish_reason` 之后**继续到达**的 tool delta 不被丢弃（对照 v1 `openai.js:69-71`；若复刻不出则降级为防御性）。
4. Anthropic 侧：`message_delta` 的 usage **不覆盖** `message_start` 的 input/cache 计数（SDK 官方测试即为此）。
5. `input_json_delta` 拼装 + `content_block_start` 的 id/name 归并。
6. 流中途 abort：零 `model.message`（出口标准第二条）。
7. 退避等待期 abort：立即结束，不睡满。
8. `401/403` **不重试**、`429` **重试**且尊重 `Retry-After`（对照 v1 `client.js:15/43`）。
9. 预设里 `toolCall: false` 的模型**不发** `tools`。
10. 两个协议的夹具跑出**同一事件序列**（出口标准第一条）。
11. **拼不完的 `arguments` 怎么处理要定下来**：v1 对 `JSON.parse` 失败退回 `{ __raw: <字符串> }`（`llm/openai.js:82`），Anthropic 侧保留原始字符串（`llm/anthropic.js:94-97`）；而 v2 的 `normalizeCall`（`run-turn.ts:121-131`）对**不可序列化**的入参是**抛错**。这两个取向必须**选一个并写进 ADR**——「保留原样让模型自纠」与「直接失败」是产品决策，不能让两个模块各选一次。
12. Anthropic 侧 tool_result **位于 content 头部**（§3.3）；这是一条**请求侧**断言，夹具必须能比对请求体，而不只是响应流。

---

## 9. 需要落的文档与 ADR

ADR 编号从 **ADR-035** 起。**八条已全部落地为 ADR-035~043**（评审通过，见 [`architecture/README.md`](../architecture/README.md) 的 ADR 表）。

| 已落 ADR | 内容 | 来源 |
|---|---|---|
| ADR-035 | `ModelPort` 契约扩展：`ModelRequest` 增 `model` / `system` / `maxTokens` / 厂商扩展逃生口；`ModelChunk` 增 `usage` 与 `stop`；`StopReason` 归一但**保留厂商原值**（`{ unified, raw }`） | §2.4 |
| ADR-036 | 协议选型：OpenAI 兼容（Chat Completions，**不用 Responses**）为主力 + Anthropic 原生；数据 201/8；**采用 `openai` + `@anthropic-ai/sdk`**，两者只许出现在 `adapters/` | §7.1、§7.4 |
| ADR-037 | 模型预设以**数据**形式存在，形状沿用 providers.json（protocol/api/env/models + limit/tool_call/reasoning/cost）；内核只认类型，数据由组合根注入 | §7.3、§7.4 |
| ADR-038 | 厂商扩展不猜默认值；**只发预设声明过的档位**；`toolCall:false` 不发 `tools`；逃生口按协议分别映射 | §7.2、§7.4 |
| ADR-039 | 重试在适配器内、默认 2 次、尊重 `Retry-After`；**取消涵盖退避等待**；监听器在 `finally` 移除；**不重试已开始输出的流** | §5.4 |
| ADR-040 | 用量归一为四项、合并而非覆盖、可多次出现；「协议无此概念」与「厂商没上报」的区分 | §4.1、§4.5 |
| ADR-041 | **用量进日志，形状是独立的 `model.usage` 事件**（评审拍板）；代价是三处编译期硬失败，按 ADR-019 不升 `schemaVersion` | §4.5 |
| ADR-042 | 录制-回放夹具：录**原始字节**、注入 transport 使 CI 不访问网络、夹具兼作厂商差异钉板 | §6.4、§6.6 |
| ADR-043 | 出口标准的比对口径：比「已提交事实」不比 delta；显式投影剥掉易变字段；**配对夹具必须是同一逻辑回合的两种编码**；tool call id 由 harness 归一 | §8 |

**注：ADR-036 的依赖预算实测**（这是本文件唯一一次新增实测）。为了不凭印象说「加两个依赖」，在仓库外的隔离目录跑了一次：

```
npm i zod@4.6.7 openai@7.36.0 @anthropic-ai/sdk@0.135.0   →  added 10 packages
```

| 层 | 包 |
|---|---|
| 直接（3） | `zod`（已有）、`openai`、`@anthropic-ai/sdk` |
| 传递（7） | `standardwebhooks` → `fast-sha256`、`@stablelib/base64`；`json-schema-to-ts` → `@babel/runtime`、`ts-algebra`；`@opentelemetry/api` |

`openai@7.36.0` **零运行时依赖**，6 个 peer 全为 `optional: true` 故不会自动安装（已核对 `peerDependenciesMeta`）。**这带出一个必须回答的问题**：`04-dependencies.md:14` 写「运行时依赖的上限：不超过 6 个，每一个都必须有 ADR」——**「6」数的是直接依赖还是整棵树，本表此前没有说明**。按整棵树算是 10（超限），按直接依赖是 3（未超限），且传递依赖不可能各有 ADR。**建议在 T1 之前定死口径**；另有 7 个传递依赖里「哪些真在运行时被加载」待核实（`json-schema-to-ts` 是类型层库、`@opentelemetry/api` 默认空实现）。

**本次 PR 已同步的**：

- `architecture/README.md`——**ADR-035~043 已落表**，状态行改为「P4 调研完成、ADR 已定、实现未开始」。
- `architecture/04-dependencies.md`——「计划中的依赖」表里 `openai` / `@anthropic-ai/sdk` 一行已改为「**已定采用（ADR-036）**」，带上实测版本与依赖树；`:27` 的「运行时依赖：1 个」一段已补上「P4 已定再引入 2 个直接依赖、整棵树实测 10 个包」以及**上限口径待明确**的说明。
- `dev-plan-v2.md` 的 `## P4` 段——已补「调研已完成、ADR-035~043 已定」标记与本文件链接。
- 本文件自身的状态与 ADR 编号已同步。

**仍需随实现走（本 PR 未做）**：

- `architecture/01-layers.md:18` 的端口清单与「包结构」段——P4 会新增 `ports/model.ts`（或留在 `index.ts`）与 `adapters/model/*`，随 T1 一起改。
- `packages/cowcat/test/support.ts` 的 `ScriptedModel`（`:103-121`）——契约一改必改（ADR-035）；它是「新增依赖只改这里」那条约定的落点。
- **录制脚本必须裁剪请求头**（`Authorization` 等）才能落盘（ADR-042）；这条属于 `tools/` 的实现约束，不进发布包（`tools/check-tarball.mjs` 是守卫）。
- 上一版此处写的「若『不引 SDK、自己写 SSE』被选中」已随 **ADR-036 采用两家 SDK** 而作废，不再需要「明确不引入」条目。

---

## 10. 待验证清单（汇总）

| # | 项 | 性质 | 影响 |
|---|---|---|---|
| 1 | §7.2 的七条厂商差异（DeepSeek / MiniMax 的扩展行为） | **【上游】**，本阶段最重的一堆 | §7.4 决定 4；实现前必须用夹具钉住 |
| 2 | 工具调用在 `finish_reason` 之后继续到达 | 【源码·v1 注释】+【未验证】 | §3.5 决定 4；复刻不出则降级为防御性写法 |
| 3 | SDK 是否已替我们按 index 拼装 tool_calls | 【未验证】 | §3.6；直接决定「要不要自己拼」的工作量 |
| 4 | `Retry-After` 在国产端点的存在率 | 【未验证】 | §5.4 决定 2 |
| 5 | 流式请求中途断开的可重试性 | **已决定并落地（P4 T5）**：ADR-039 决定 ③「不重试已开始输出的流」。实现上由结构保证——重试只包住「取回响应」，迭代在其之外；有测试钉住请求数为 1 | §5.5 |
| 6 | `stream_options` 在 OpenAI 兼容端点的支持率 | 【未验证】 | §4.6；解析必须容忍「开了也不给」 |
| 7 | Anthropic 流式下 `cache_creation_input_tokens` 是否出现 | 【未验证】 | §4.6 |
| 8 | 其余 200 家端点的流式细节一致性 | 【未验证】 | §7.5；只能逐家夹具覆盖 |
| 9 | 夹具目录是否被 `tsc` 扫入 / 是否复制到 `dist/` | **已解决（P4 T4）**：`tsconfig` 只 `include: ["src","test"]`，所以 `.sse`/`.json` 既不编译也不复制，而测试跑在 `dist/test`。解法是**从包根解析**（`test/fixtures.ts` 向上找 `package.json`），并有测试钉住 | §6.6；影响测试能不能读到夹具 |
| 10 | `client.js:24` 的超时是否只作用于握手 | 【推断】 | §5.1；影响「超时语义要区分」这条决定的形式 |
| 11 | **厂商 catalog 怎么更新**——蒸馏脚本不在仓库里 | 【未验证】 | §7.3；沿用「数据形状」可行，沿用「更新流程」没有现成答案 |
| 12 | 8 家 openai 协议厂商（`deepinfra` / `groq` / `cerebras` / `perplexity` / `xai` / `mistral` / `togetherai` / `openai`）**没有 `api` 字段**，按 `agent/src/config.js:311` 会回落到 `https://api.openai.com/v1` | 【未验证】 | §7.1；是蒸馏缺口还是有意为之，未定 |
| 13 | 流 body 读取阶段的取消路径（v1 没有；候选 SDK 有没有） | **已实测（P4 T3/T5）**：两家都靠传输层的 signal，中途 abort 能让流停下（有测试）；因此适配器不自建管线，**只有退避等待需要自己响应**（`sleepAbortably`） | §5.5、§8 断言 6 |
| 14 | **「运行时依赖上限 6」数直接依赖还是整棵树**；7 个传递依赖里哪些真在运行时被加载 | 【未验证】 | §9 注、[`04-dependencies.md`](../architecture/04-dependencies.md)；**T1 之前要有定论**（整棵树算 10，超限） |

---

## 附录 A：本次研究用到的旧版证据索引

| 主题 | 位置 |
|---|---|
| OpenAI 流式拼装、空 choices、完成信号 | `agent/src/llm/openai.js:37`、`:46-67`、`:50`、`:56-65`、`:69-71` |
| OpenAI 请求侧（工具与用量开关） | `agent/src/llm/openai.js:119`、`:204-212` |
| Anthropic 流式拼装与 usage 合并 | `agent/src/llm/anthropic.js:30`、`:63`、`:74-78`、`:87` |
| 两家共用的 fetch/重试/取消 | `agent/src/llm/client.js:1`、`:5-9`、`:15`、`:19-24`、`:39`、`:43`、`:48-49` |
| 用量归一与 `/cost` | `agent/src/loop.js:313`、`:417-425` |
| SSE 手写解析（LLM 层；MCP 另有第二套） | `agent/src/llm/client.js:59-88`（跨 chunk、多行 `data:`、`[DONE]` 哨兵、丢帧）、`agent/src/sse.js:12-85` 与 `:9-11` 的说明 |
| 错误分类与 `hint` 六类 | `agent/src/errfmt.js:8-33`、`:58-80`、`:65`（两家的码位取法）、`:3`（智谱 `1211`）、`:19`、`:23` |
| 上下文长度计数（Anthropic 端点 vs OpenAI 本地估算；两个估算器） | `agent/src/llm/anthropic.js:131-141`、`agent/src/llm/openai.js:104-109`、`agent/src/llm/tokapprox.js:9-28`、`agent/src/prompts/compact.js:160-164` |
| 思考档位 → 协议参数的映射 | `agent/src/llm/openai.js:90`、`:120`；`agent/src/llm/anthropic.js:170-177`；`agent/src/subagent.js:16-21` |
| Anthropic prompt cache 断点与 beta 头 | `agent/src/llm/anthropic.js:182-208`、`:9`；`agent/src/config.js:66` |
| 工具 schema 与结果消息形态（含附件分叉） | `agent/src/llm/openai.js:229-234`、`:176-178`、`:203-218`、`:143-165`；`agent/src/llm/anthropic.js:288-290`、`:252-276`、`:228-246` |
| 两条旧版缺口（本文件不改旧树，只登记） | `agent/src/subagent.js:58`（`tools === null` → yolo）；`agent/src/tools/planmode.js:121-124`（`allowedPrompts` 直推 `rules.allow`，对照正规入口 `agent/src/perrules.js:18-40`） |
| 厂商 catalog 的读取与端点解析 | `agent/src/llm/presets.js:9-15`、`:17-24`、`:49-52` |
| 厂商协议归属与模型能力（209 家） | `agent/assets/providers.json`（`protocol` / `api` / `models[].tool_call` / `limit` / `cost`） |
| 错误文案分类 | `agent/src/errfmt.js:19`、`:23`（完整条目见上一行） |

## 附录 B：上游证据出处

| 编号 | 内容 | 出处 |
|---|---|---|
| B-1 | OpenAI：`maxRetries` 默认 2；重试的四种状态码与连接错误；`503 server_is_overloaded` + `Retry-After`；`stream_options.include_usage`（usage 只在 `choices` 为空的末条）；`baseURL` 指向兼容端点；Responses vs Chat Completions | `developers.openai.com` 的 API reference（typescript / ruby / java 三版对照）与 `how_to_stream_completions`、`error-codes`、`rate-limits`、`migrate-to-responses`（经 Context7 的 `/websites/developers_openai`） |
| B-2 | Anthropic：`maxRetries` 默认 2；`RequestOptions { maxRetries, timeout, signal }`；`RawMessageStreamEvent` 六种；`MessageCreateParamsBase`（`max_tokens` 必填、`system` 顶层）；`Usage`（`input_tokens` / `output_tokens` / `cache_*`）；`MessageDeltaUsage` 省略可选键（官方测试 `keeps message_start usage when message_delta omits the optional keys`）；`ErrorType` 九个成员与 `isAbortError`；`ToolUseBlock {id,name,input}` | `github.com/anthropics/anthropic-sdk-typescript`（经 Context7 的 `/anthropics/anthropic-sdk-typescript`） |
| B-3 | MiniMax：OpenAI 兼容端点 `https://api.minimax.cn/v1`；`reasoning_content` 与 ` thinking` 标签两种思考形态；`thinking.type` / `reasoning_effort` 的取值与 `400` 行为；`max_tokens` vs `max_completion_tokens`；被静默忽略的参数；`n` 只支持 1；`function_call` 废弃；多轮必须保留完整 assistant 消息 | `platform.minimaxi.com/docs/api-reference/text-openai-api`（本次 `webfetch`） |
| B-4 | DeepSeek：OpenAI 兼容端点 `https://api.deepseek.com` 与 **Anthropic 兼容端点 `https://api.deepseek.com/anthropic`**；模型名 `deepseek-flash` / `deepseek-v4-pro`；`thinking` / `reasoning_effort` 扩展 | `api-docs.deepseek.com` 的 Your First API Call（本次 `webfetch`） |

**本轮未能取得的证据**（明确登记，避免被当成已核实）：`websearch` 不可用（HTTP 402），所以**没有做跨来源的交叉验证**；智谱 / Moonshot / 火山 / 阶跃 / 百川等**未逐家取到流式样例**，其流式细节在 §7.5 一律标【未验证】。
