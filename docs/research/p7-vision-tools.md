# P7 专项调研：视觉工具（D11，给文本模型加眼）

> 状态：调研 PR（只出决定草案与 ADR 清单，不改 ADR 表、不改源码）。
> 日期：2026-10-23。依据：
> - dev-plan-v2 P7 模块表：「多模态模型的 OCR / 视觉结构基础；截图存证提取数据（ADR-057/058 页，D11）」，依赖 P6 T5~T6；
> - frontier-survey §2.3（D11 行）：「给文本模型加视觉能力（OCR/视觉/实况）的 ModLens 模式」。

## 证据分级

**【源码】**给 `文件:行`；**【上游】**官方文档；**【推断】**未实测，不作决策依据。

## 1. 结论先行

多模态直通链路 P6 已交付（ADR-057 附件进契约、ADR-058 终端渲染，均标已实现）。
D11 的缺口是**另一半**：主模型无眼时怎么办。交付 **`View` 工具**——把本地
图片发给用户配置的 vision preset（默认内置 `zai/glm-4v-flash`），把描述/
OCR 文本拿回会话，文本模型由此获得视觉。需要一个小契约增量
（`ModelRequest.images`——对话路径之外的直接调用通道）与 preset 能力声明
（`vision: true`）。截图（OS 级截屏）不在本期，登记远期。

## 2. 现状盘点【源码】

| 资产 | 位置 | 对 D11 的意义 |
|---|---|---|
| 附件进契约 | `ToolResult.attachments` → `tool.finished.attachments` → `Message` tool 结果的附件引用（`kernel/messages.ts:54`）；适配器物化字节上 wire（`adapters/model-openai.ts:4`） | 多模态模型已能看图；物化机制可复用 |
| wire 映射 | OpenAI：tool 结果带附件拆成两条 wire 消息（图作为后续 user 消息内容部件，`adapters/model-openai.ts:213-217`）；Anthropic 原生映射 | `ModelRequest.images` 两适配器各映射一次有先例 |
| Read 非文本分支 | P6 T6 已实现（图像/PDF 读取走附件） | 多模态时模型直接 Read 即可，View 不抢戏 |
| ModelPreset | `kernel/preset.ts:22`：protocol/model/limits/toolCalls/efforts/price，**无 vision 声明** | 需加 `vision?: boolean`（声明为数据，ADR-046 同款） |
| ModelRequest | `ports/model.ts:262`：messages/tools/model/system/…，**无直接图像通道** | 对话路径的图在 tool 结果附件上；View 这种「工具内部直接调 port」没有合法送图通道 |
| preset 解析 | `selectModel(settings)`（`host/model.ts:73`）支持任意 preset id（内置 + custom） | View 的 vision 端点解析可复用 |
| custom preset | `customPresetSchema`（`adapters/config.ts:90`）strictObject | 加 `vision` 布尔 |
| provider 表 | `host/presets.ts:45`：`zai` = openai 协议、`ZHIPU_API_KEY`、`https://api.z.ai/api/paas/v4` | 内置 glm-4v preset 与该 provider 同 key，零配置可用 |
| 尺寸口径 | ADR-058：5MB 上限（P5 口径沿用） | View 沿用同一闸 |

## 3. 决定草案

### E1 工具形状：`View`（给文本模型的眼）

- input `{path, prompt?}`；`pathInput: 'path'`（规则可按路径收窄，
  与 Read/Write 同构）；risk `read`。
- `prompt` 缺省 =「描述这张图的内容与结构，提取图中全部文字（OCR）」；
  用户/模型可改问具体问题（「这个报错截图里有什么」「表格里第三列是什么」）。
- 工具描述明确分工：**主 preset 声明了 vision 时，多模态模型直接用 Read**
  （字节走 ADR-057 既有通路）；View 是给无眼模型的桥——它的字节发往 vision
  端点（也是用户配置的供应商），返回的是文本。
- 输出 = vision 模型的文本应答；失败（端点不可达/限流）照工具惯例
  ok:false + 原因。

### E2 vision 端点解析：懒、可覆盖、错误不进 createHost

- user config 加 `vision: '<preset-id>'`（**user 层 only**——vision 调用是
  真实供应商花费，工作区不得替用户选端点；跨层携带警告丢弃，照
  otel/memory 成例）。
- 缺省回退内置 `zai/glm-4v-flash`（glm-4v 免费档，zai provider 复用
  `ZHIPU_API_KEY`）——有 zhipu key 的用户零配置开眼【上游：z.ai 免费档，
  真机验收验证】。
- **懒解析**：View 持有 `resolve: () => ModelPort`；`createModelPort` 的
  错误（缺 key / 未知 preset / vision 未配置）在第一次 View 调用时变成
  工具拒绝输出（含 doctor 指引），**绝不让 createHost 失败**——与
  otel 的「畸形 endpoint 拖死宿主」教训同一条。

### E3 图像上 wire：`ModelRequest.images` 补充通道

- `ModelRequest` 加 `readonly images?: readonly Attachment[]`：随**首条
  user 消息**发出的内容部件。对话路径不变（图仍走 tool 结果附件，
  ADR-057  untouched）；`images` 是工具内部直接调 port 的合法通道
  （View 是唯一的第一个消费者）。
- 两适配器各映射一次（ADR-057 的既有分工）：OpenAI 并入首条 user 消息的
  content parts（`image_url` data URL）；Anthropic 并入首条 user 消息的
  image block。物化复用 `tryMaterializeAttachment`——重放语义不变
  （日志持引用，字节在序列化时读盘）。
- 形状复用 `Attachment`（type/mediaType/path/bytes），View 读盘时填入。

### E4 preset 能力声明：`vision?: boolean`

- `ModelPreset` 加 `vision?: boolean`（默认 false——无声明=无眼，与
  toolCalls 的「声明为数据」同款哲学 ADR-046）。
- custom preset schema 加 `vision`；内置 catalogue 加
  `'zai/glm-4v-flash': { protocol:'openai', model:'glm-4v-flash', vision:true, limits:{output:4096, context:8192}, toolCalls:false }`
  （vision 端点不参与会话工具调用，`toolCalls:false` 如实声明）。
- 用途：catalogue 诚实 + doctor 可列出有眼模型 + 未来 TUI 提示。
  View 不强制校验目标 preset 的 vision 位（声明是给人看的，工具只看
  调用结果）。

### E5 尺寸与类型闸

- ≤5MB（ADR-058 口径沿用）；mediaType 白名单 `image/png|jpeg|gif|webp|bmp`，
  其余（含 PDF/视频）拒绝并指引（PDF 是 Read 的附件通路的活）。
- 图读进内存后即物化上 wire；ToolResult 只带文本，**不把图作为 View
  自己的附件**（日志继续零字节，ADR-057 原则不动）。

### E6 usage 记账的诚实缺口

View 内部 vision 调用的 token 花费**没有通道**进会话 usageTotals
（`model.usage` 事件只由 run-turn 产生）。与 reflect 回合（HANDOFF 已登记）
同案：本期不造通道，登记 HANDOFF——未来统一做「工具内模型调用」的
usage 归属（turn.noted 或 ToolResult 增量字段），不在 D11 夹带。

### E7 截图不在本期

OS 级截屏需要 `PlatformPort` 新能力（三方库或平台 API），超出「视觉
结构基础」的最小交付；dev-plan「截图存证」经核对指 P6 打通路的存证语义
（附件**引用**进日志，ADR-057 已交付）。登记远期清单。

## 4. ADR 清单（待落表）

- **ADR-138 View 工具与 vision 端点**：工具形状/risk/默认 prompt；
  `vision` 配置的 user 层单源与默认 preset；懒解析与错误形态；
  `ModelPreset.vision` 声明。
- **ADR-139 ModelRequest.images 补充通道**：与 ADR-057 的分工（对话路径
  走 tool 结果附件；直接调用走 images）；两适配器映射；尺寸/类型闸；
  usage 缺口登记。

## 5. T 计划

| 任务 | 内容 | 验收 |
|---|---|---|
| T1 | `ModelPreset.vision` + custom schema + catalogue 加 glm-4v-flash；`ModelRequest.images` + 两适配器映射；`View` 工具；config `vision` 块 | 单测：View 尺寸/类型闸、懒解析错误形态、适配器 images 映射（openai/anthropic wire 形状） |
| T2 | host 接线（懒 resolver、config 解析与跨层警告）+ host 级测试 | Fake vision port 集成：文本模型经 View 拿到描述；缺 key 时拒绝不炸宿主 |
| T3 | 真机验收：glm-5.3-flash（无眼）+ View 读预置 PNG（含文字）→ glm-4v-flash OCR → 断言提取文本；再问结构问题 | 验收记录入 §8 |

## 6. 风险与待验证

- **【推断】**`glm-4v-flash` 的模型 id 与 z.ai 免费档现状——T3 真机验证，
  若 id 失效则改 catalogue 条目（custom preset 是用户的退路）。
- **【推断】**OpenAI 兼容端点对 user 消息多内容部件（text+image_url）
  的支持面——z.ai 走 openai 协议，T3 实测；anthropic 映射按 SDK 类型
  编译钉住。
- `images` 与工具结果附件同时出现时的顺序（对话里 View 的结果无附件，
  两通道暂不交汇）——ADR-139 写明「本期唯一消费者是 View」。
- vision 端点的流式应答收集：View 取全部文本块拼接，usage 丢弃（见 E6）。

## 8. #198 审查校准（2026-10-23，code-reviewer/k3）

实现后审查：0 P0 + 3 P1 + 10 P2，全部处理或登记。要点：

- **P1-1（字段错配，测试钉住假契约）**：拒绝输出读 `error.guidance`，而 ModelConfigError 的真实字段是 `hint`——生产路径的指引（export ZHIPU_API_KEY 等）被静默吞掉，旧测试用 Object.assign 造了不存在的字段反而钉成「通过」。修复并改用真实 ModelConfigError 测试。
- **P1-2（anthropic 协议必败）**：View 请求不带 maxTokens，而 anthropicModel 对它直接 throw——ADR-138② 承诺的「任意 vision preset」有一整个协议族 100% 失败（默认 openai 恰好掩盖）。修复：visionEndpoint 带回 preset.limits.output 作 maxTokens。
- **P1-3（安全闸缺口，最值钱）**：类型闸只看扩展名 + reads-are-free 免审批 + 字节出网第三方——改名 .png 的敏感文件会在零人工干预下出网。修复：读字节后 sniffBuffer 魔数嗅探（imageinfo 同款纪律）、isFile 检查、5MB 对实读字节执行（TOCTOU 窗口收窄）。bmp 从白名单消失（Anthropic media_type 联合不含它，与 Read 对齐）。
- **P2 处理**：abort 不再吞成 ok:false（signal.aborted 重抛，run-turn 惯例）；images 通道的 document 两适配器都点名不丢；显式 effort:null 不继承主模型 effort；显式 config.vision 启动即校验（typo 早响）；makeAttachment 取代三 null 字面量；截断 break 的流清理（generator finally）有测试钉住。
- **P2 登记**：decide 规范化按 process.cwd 而 View 按 options.cwd——与 Read 同款的既有形态，非本模块引入，记入 HANDOFF；doctor 标「有眼模型」未做（拒绝文案已指向 doctor 列 preset id，足够）。
- **测试净 +4**（view 7：改名伪装/目录拒绝/maxTokens/abort 重抛+清理/截断清理/真实 ModelConfigError）。
