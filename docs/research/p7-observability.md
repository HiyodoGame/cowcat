# P7 专项调研：可观测性（D9，OTel GenAI 适配器）

> 状态：调研 PR（只出决定草案与 ADR 清单，不改 ADR 表、不改源码）。
> 日期：2026-10-23。依据：dev-plan-v2 P7 模块表「可观测性」行：
> **OTel GenAI 语义约定子集；事件日志 → span 适配器边界（D9）**，依赖 P6 组合根。

## 证据分级

沿用仓库纪律：**【源码】**直接读到实现给 `文件:行`；**【实测】**本次跑出来的；
**【上游】**官方文档；**【推断】**未实测的推论，不作为决策依据。

## 1. 结论先行

D9 落地为**纯适配器模块**：内核、policy、ports 全部零改动。`adapters/otel/`
把 `session.subscribe` 的活事件流翻译成 OTel GenAI 语义的 span 树，组合根
（`host/host.ts`）在有配置时挂上 tap。理由：

1. **内核的事件流已经足够**——turn/round/tool/usage 的全部边界与计费字段
   都已在事件上【源码】，span 是它们的纯派生视图，不需要内核知情；
2. **分层禁令**——kernel/policy/ports 禁 `node:*`，OTel SDK 只能进
   adapters【源码 eslint.config.js 分层规则】；
3. **重放安全**——`Session.subscribe` 只在 live `emit` 时通知
   【源码 session.ts:158】，re-open 的状态重建不触发监听器，遥测天然不会被
   重放污染。

## 2. 上游语义约定现状【上游】

来源：`open-telemetry/semantic-conventions-genai`（main，2026-10-23 抓取；
GenAI 约定已迁出主 semconv 仓，状态 Development）。

### 2.1 Client inference span（`gen_ai.client.inference`）

- kind SHOULD 为 `CLIENT`（同进程可 INTERNAL；CowCat 走 HTTP 出网，用 CLIENT）。
- span name SHOULD 为 `{gen_ai.operation.name} {gen_ai.request.model}`，
  chat 补全即 `chat {model}`。
- Required：`gen_ai.operation.name`（chat）、`gen_ai.provider.name`。
  provider 枚举为 well-known 表（openai/anthropic/deepseek/moonshot_ai…），
  **自定义值允许**（"otherwise, a custom value MAY be used"）。
- Conditionally Required：`gen_ai.request.model`、`error.type`（出错时）、
  `gen_ai.request.stream`、`gen_ai.conversation.id`（"if and only if the
  instrumented library has one readily available"——CowCat 天然有 sessionId）。
- Recommended：`gen_ai.usage.input_tokens/output_tokens`（**应含缓存 token 的
  总量**）、`gen_ai.usage.cache_read.input_tokens`、
  `gen_ai.usage.cache_write.input_tokens`、`gen_ai.response.finish_reasons`
  （协议词 stop/length/tool_calls…）、`gen_ai.response.model`（不可得则不设）、
  `gen_ai.response.time_to_first_chunk`（流式）。
- **Opt-In 内容属性**（`gen_ai.input.messages`/`output.messages`/
  `system_instructions`/`tool.definitions`）：上游标 PII 警告、默认不采。
  CowCat 对齐：**本期不导出任何内容属性**。

### 2.2 Agent spans

- `invoke_agent`：本地框架执行用 INTERNAL kind；name
  `invoke_agent {gen_ai.agent.name}`；属性 `gen_ai.agent.name`/
  `gen_ai.agent.version`/`gen_ai.conversation.id`。
- `execute_tool` 是 well-known operation name；agent spans 文档的
  execute-tool span 段给出 tool name / tool call id 的属性位
  （`gen_ai.tool.name`、`gen_ai.tool.call.id`）。
- OTELP 5233 提出 `span.type` 字段（`gen_ai.client.inference` /
  `gen_ai.internal.execute_tool`）——**尚是 OTEP，未批准**，本期不设。

## 3. 事件流可映射性核查【源码】

| span 需要的 | 事件来源 | 备注 |
|---|---|---|
| 会话边界 | `session.opened`（cowcatVersion、shell、model） | 会话级属性 |
| 回合边界 | `turn.opened`（含 **model**【events.ts:72】）→ `turn.transitioned` 终态 | turn span 起止 |
| 轮次边界（chat span） | `turn.transitioned`：`requesting`→`awaiting_tools` 一轮 | round span 起止 |
| token 用量 | `model.usage`（input/output/cacheRead/cacheCreation【ports/model.ts:17】） | 四字段直映 semconv 四个 usage 属性 |
| finish reason | `model.usage` 同行事件的 stopReason（kind: end/toolCalls/maxTokens/other【ports/model.ts:29】） | 映射 stop/tool_calls/length/other |
| 工具调用 | `tool.finished`（name/callId/ok/output/facts） | execute_tool span；**无 tool.started 事件**，起点近似 = 进入 `awaiting_tools` 的时刻（近似，文档标注） |
| 审批 | `approval.requested/answered` | 本期仅作 turn span 的 span event（自定义名），不建独立 span |

**无缺口**：span 树可纯事件派生，内核零改动成立。

## 4. 决定草案

### E1 边界：事件日志 → span 适配器，内核零改动

`adapters/otel/` 导出 `createTelemetryTap(input): (events: KernelEvent 流) => void`
级别的纯翻译器 + OTel provider 生命周期管理；`host/host.ts` 组合根在
`session.subscribe` 处挂 tap（现有 557 行附近已有同款订阅点）。内核不加
TelemetryPort——没有内核需要回应的能力，端口就是空壳（工作规则：端口是能力
边界，不是装饰）。

- **重放**：live emit 才通知【session.ts:158】，re-open 重建不进遥测。
- **fork**：fork 的历史复制走 `forked.emit`【host.ts:797】，会作为新会话的
  事件再发一遍。**不去重**：fork 的下一轮模型请求会把历史 token 重新发给
  供应商（计费现实就是双份），遥测如实跟随；`gen_ai.conversation.id` =
  fork 后的新 sessionId，语义自洽。调研文档标注，ADR 写明。

### E2 span 树形状（GenAI semconv 子集）

```
(session resource attrs: service.name=cowcat, service.version=cowcatVersion)
└─ invoke_agent cowcat            INTERNAL, conversation.id=sessionId   [turn span]
   ├─ chat glm-5.3-flash          CLIENT, gen_ai.client.inference      [每轮一个]
   │    ├─ attributes: operation/provider/request.model/request.stream=true/
   │    │  usage 四件套/finish_reasons(+error.type 于失败)
   │    └─ span event: approval.requested / approval.answered（自定义名）
   └─ execute_tool Bash           INTERNAL, tool.name/tool.call.id     [每调用一个]
```

- provider.name = preset id 的 provider 段原样（`zai-coding-plan`、
  `openai`…）；命中 well-known 表与否都合法。
- request.model = `turn.opened.model`（回合级真相【events.ts:60-62】）；
  response.model 内核未存，不設。
- time_to_first_chunk：内核无首 chunk 事件，本期不设【推断→放弃项】。
- 内容属性（input/output.messages 等）：**本期不导出**（上游 Opt-In + PII；
  与 approval-sandbox 安全评审的隐私立场一致）。留配置口子不实现 =  scope
  creep，不做。

### E3 依赖与导出器

- `dependencies` 增加 `@opentelemetry/sdk-trace-base`、
  `@opentelemetry/core`、`@opentelemetry/resources`
  （`@opentelemetry/api` 由 sdk 传递）。OTLP 导出用
  `@opentelemetry/exporter-trace-otlp-http`（SDK 标准件，http/protobuf
  之外的 json over http——以实际上游包为准【待 T1 实测锁定】）。
- **默认不初始化 provider**：无配置时零依赖实例化、零开销、零导出。
- 测试用 `InMemorySpanExporter`【sdk-trace-base 自带，上游】。

### E4 配置形状

user config 加 `otel` 块（zod schema 在 adapters/config.ts【源码】，
user 层单源、无 merge 复杂度）：

```jsonc
{ "otel": { "endpoint": "http://localhost:4318", "headersEnv": "MY_OTEL_HEADERS" } }
```

- 启用判定：`config.otel.endpoint` 或环境变量 `OTEL_EXPORTER_OTLP_ENDPOINT`
  非空（上游 SDK 惯例优先 env）。headers 取
  `OTEL_EXPORTER_OTLP_HEADERS`（标准 `k=v,k=v` 形）或 `headersEnv` 指定的
  环境变量名——密钥只经 env，不进配置文件（仓库卫生）。
- 会话级开关（每会话可关）本期不做——先全有或全无。

### E5 失败语义

遥测故障绝不影响会话：翻译器全链路不得 throw（provider 未初始化时 tap 是
no-op）；导出走 BatchSpanProcessor 异步，host 关闭时 `shutdown()` 尽力 flush
但不 await 超时超过 1s。OTLP endpoint 不可达 = 后台重试由 SDK 处理，无用户
可见输出。

### E6 版本与命名

- tracer name `cowcat`，instrumentation scope version = 包版本。
- `service.name` resource 默认 `cowcat`，可被 env
  `OTEL_SERVICE_NAME` 覆盖（上游惯例）。

## 5. ADR 清单（待 #185 落表）

- **ADR-132 OTel 适配器边界**：span 从事件流派生、内核零改动；
  subscribe-only tap；重放安全与 fork 双计语义；遥测不反馈内核。
- **ADR-133 GenAI 语义约定子集**：span 树形状、属性映射表（usage 四字段
  直映、finish_reason 映射、provider.name 原样）、内容属性默认不导出。
- **ADR-134 遥测配置与生命周期**：otel 块形状、env 优先、默认关闭、
  BatchSpan + 尽力 flush、失败静默。

## 6. T 计划

| 任务 | 内容 | 验收 |
|---|---|---|
| T1 | adapters/otel（翻译器 + provider 生命周期）+ deps + config schema | 单测：InMemory 导出 span 树形状/属性全对；无配置 = 零实例化；翻译器不 throw |
| T2 | host 组合根接线 + host 级测试（开两个会话/fork/重开） | fork 双计、re-open 不重复，事件级断言 |
| T3 | 失败语义（导出器抛错、endpoint 黑洞） | 会话不受影响；关闭 flush ≤1s |
| T4 | 真机验收：本地起 OTLP receiver（或 console 导出器落盘）+ glm 真跑一回合 | span 在 receiver 可见、usage 数字与会话 usageTotals 一致 |

## 7. 风险与待验证

- **【推断】** `@opentelemetry/exporter-trace-otlp-http` 的具体包名/传输
  （json vs proto）T1 时以上游实际为准；若引依赖过重可退回手搓
  OTLP/JSON over fetch（adapters 允许 node:*，成本自管）。
- **【推断】** glm（z.ai coding plan）侧无 OTel receiver 可配——T4 本地
  receiver 用 collector 太重，倾向 console/file 导出器 + 人工核对 JSON。
- span 起点近似（execute_tool 无 started 事件）造成时长偏短，已在 E2 标注；
  若后续需要精确时长，给内核加 `tool.started` 事件是干净路子（本期不做）。
- BatchSpanProcessor 后台定时器在测试里要强制 flush，避免假阴性。
