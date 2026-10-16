# Read 多模态 + NotebookEdit 方案（P3-6 收口）

> 目标：把 ROADMAP「整块缺失」里的 **Read 多模态（图片 / PDF / notebook）** 与 **NotebookEdit** 做完，
> 并落实用户确认的两项决策：**视觉门控用 `providers.json` 的 `attachment` + env 覆盖**、
> **Notebook 读写配对一次做完**。
> 版本：本批次完成后记 `0.13.0`（按 ROADMAP 执行原则 1：实现 + 测试 + 文档 + 版本号）。

## 0. 实施状态（0.13.0，已发布 2026-10-16）

**已按本方案实现并发布**，与方案的差异、本轮发现并修复的两个既有 P1 缺陷、以及验证结果记录在
`docs/fix-plan-2026-10-15.md` 的「第十轮」段。要点：

- `npm test` 656 passed / 0 failed（新增 63 项）；6 个 MCP 联调脚本全绿。
- registry：`@corescense/cowcat@0.13.0`（99 files，`dist.shasum` 与本地打包一致），官方源隔离安装验证通过。
- 与方案的偏差：① PDF 的 best-effort 文本抽取**已实现**（原列为可选）；② notebook 渲染截断按**字符数**（20000/输出、400KB/整册）而非「2000 行 / 100KB」；③ `NotebookEdit` 的 insert 语义在工具描述与测试里固化为「插在 `cell_index` 处，原单元格顺延」。
- 本方案 §3.3 的「附件只存引用」不变式已落实：图片字节不落会话、`/export`、compact、`/context`。
- 下面 §1 的「不做」清单里，notebook output 内嵌图片、CMap 解析、图片压缩、SVG 栅格化仍未做（保持后置）。

## 1. 范围

**做**
1. `Read` 支持图片（png/jpeg/gif/webp）→ 作为图片内容块交给上游，不再报 "Binary file"。
2. `Read` 支持 PDF：Anthropic 协议走原生 `document` 块；OpenAI 兼容协议走 best-effort 文本抽取（带质量门）。
3. `Read` 支持 `.ipynb`：按单元格文本化渲染（对标 Claude Code 的 notebook 读取）。
4. 新增 `NotebookEdit`（对标原版）：按 cell 索引 replace/insert/delete，写操作进权限体系与 checkpoint。
5. 视觉能力门控：`attachment` 目录字段判定 + `COWCAT_VISION=force|off` 覆盖 + 上游报错的明确翻译。

**不做（本批次明确后置，附理由）**
- **notebook output 里的图片不随 Read 回传**（只标注 `[image output: image/png, 45.2 KB]`）。理由：它们内嵌在 `.ipynb` 里、没有独立文件路径，会破坏下面 §3.3 的「附件只存引用」不变式。后续若要做，需给附件加 base64 兜底与大小预算。
- **SVG 按文本读**（它本身就是可读 XML），不做栅格化（零依赖下无可行路径）。
- **图片缩放/压缩**：超限直接报错并给出建议，不引入图像处理。
- **PDF on Anthropic-compatible 第三方端点**（如 Kimi 的 anthropic 端点）：照发原生 `document` 块，若不支持由上游报错，靠 §3.5 的错误翻译提示，不做事前探测。
- `SubscribePolling`、MCP 侧多模态（`ReadMcpResource` 的 blob）不并入本批次。

## 2. 现状与关键通路（已核实）

| 位置 | 事实 |
|---|---|
| `src/tools/read.js` | 纯文本；`MAX_LINES=2000`、`LARGE_LIMIT=5MB`、`ABSOLUTE_LIMIT=20MB`；二进制判定是 `buf.includes(0)`；成功时 `ctx.readSet.add(path)` |
| `src/loop.js:169/176` | 工具结果统一为 `{type:'tool_result', tool_use_id, content: string, is_error?}`；`:389-392` 打包成**一条** `{role:'user', content: results}` 推入 messages 并落盘 |
| `src/llm/anthropic.js:224-236` | `role:'tool'` → 单个 `tool_result` 块；`tool_result.content` 可为 block 数组（官方支持 text/image） |
| `src/llm/openai.js:139-186` | `role:'tool'` → 字符串 `content`；`tool_result` 在 user 消息里被拆成 `role:'tool'` 消息，且**必须紧跟 assistant.tool_calls**；非 tool_result 的 text 块另发一条 user 消息 |
| `src/session.js:32-34` | `append(record)` 直接 `JSON.stringify` 落盘 → 消息里的任何 base64 都会写进会话文件 |
| `src/prompts/compact.js:32-42,138-142` | 摘要只渲染 `b.content`（字符串）；`estimateTokens` 用 `JSON.stringify(m).length/4` |
| `src/contextviz.js:3-10` | `/context` 复用 `estimateTokens([m])` → 只要 estimateTokens 认图片 token，可视化自动正确 |
| `src/slashcmds.js:86-90` | `/export` 只渲染 text/tool_use/tool_result，未知块类型自然跳过 |
| `src/errfmt.js:7-74` | 错误→hint 的纯函数表，加一条规则即可 |
| `assets/providers.json` | 每个 model 有 `attachment: true|false`（视觉/附件能力），**当前无人消费** |
| `bin/cowcat.mjs:417` | `baseCtx = { cwd, readSet, state, ui, permissions, config, session, ... }` → 工具里可用 `ctx.config.provider/model` |
| `src/llm/presets.js` | `listModels/getProvider/resolveModelRef` 可用；模型名可能是自由字符串（如 `glm-4.6`），不一定形如 `provider/model` |

## 3. 设计

### 3.1 内部表示：附件以「引用」形式挂在 tool_result 上

工具结果新增可选字段（其余字段不动）：

```js
{ type:'tool_result', tool_use_id, content: '<文本>', is_error?,
  attachments?: [
    { type:'image',    mediaType:'image/png',      path:'F:\\...\\a.png', bytes:12345, tokens:1120 },
    { type:'document', mediaType:'application/pdf', path:'F:\\...\\b.pdf', bytes:234567, tokens:8000 }
  ] }
```

要点：
- **不存 base64**，只存路径 + 元数据（`bytes`/`tokens`/可选 `dims`）。base64 在**发请求那一刻**由 `src/attach.js#materialize()` 从磁盘读出。
- `tokens` 由 Read 侧算好（`src/imageinfo.js` 嗅探尺寸 → `ceil(w*h/750)`，Anthropic 公式；未知尺寸回落 1600）→ `estimateTokens` 直接累加即可，不必解析图片。
- 附件挂在对应的那条 tool_result 上（而不是另起消息），保证与 tool_use 的配对关系在所有通路里都不丢。

### 3.2 上游翻译

- **Anthropic**（`toAnthropicMessages`）：`tool_result.content` 从字符串变为数组
  `[{type:'text',text}, {type:'image',source:{type:'base64',media_type,data}}…]`。
  `document` **不进 tool_result**（官方只在 user 消息里文档化）→ 在该 tool_result 之后追加一条 user 消息承载 `{type:'document',source:{...}}`。
- **OpenAI 兼容**（`toOpenAIMessages`）：`role:'tool'` 保持纯文本（追加一行 `[attached: a.png (image/png, 12.3 KB)]` 让模型知道有图）；
  图片放进同一轮**紧跟 tool 消息之后**的 user 消息：`{role:'user',content:[{type:'text',text:'[attached: a.png]'},{type:'image_url',image_url:{url:'data:image/png;base64,…'}}]}`。
  （`document` 在 OpenAI 侧不产生，见 §3.5。）
- 顺序约束已核对：OpenAI 侧 tool 消息必须紧跟 assistant.tool_calls —— 追加的 user 消息在这之后，合规。
- 文件已被删除/改小改大/无法读取时：`materialize()` 返回错误 → 该附件降级为一行文本占位 `[image unavailable: <原因>]`，**不让整个请求失败**。

### 3.3 体积与持久化：靠「引用不变式」而不是事后打码

因为附件只存引用（§3.1），下面这些通路**天然安全，无需 elision**：
- 会话 JSONL（`session.append`）：只写路径与元数据 ✓
- `/export`、compact 摘要：只渲染 `content` 字符串，附件另加一行 `[attached: …]` 标注 ✓
- `/context`：`estimateTokens` 累加 `attachments[].tokens`，图片占用可被看见 ✓
- 恢复会话（resume）：引用随会话回放，再次发请求时从磁盘重新 materialize；文件已变则降级为占位 ✓
- 同一文件同一会话内不重复去重：**不做**（模型可能改了图再读；去重会让第二次读拿到旧字节）

这是本方案与「把 base64 塞进消息再逐处打码」的关键区别：**唯一需要保证的纪律就是附件永远带 `path`**（§1 因此把 notebook 内嵌图片挡在门外）。

### 3.4 视觉门控（`src/vision.js`）

```
visionSupport(config) -> 'yes' | 'no' | 'unknown'
```
1. `COWCAT_VISION=off` → `'no'`；`COWCAT_VISION=force` → `'yes'`（最高优先级，可自救误判）。
2. 否则查目录：`provider/model` 形式走 `resolveModelRef`；裸模型名（如 `glm-4.6`）在**所有 provider** 里按 `model.id` 精确匹配，命中多个时优先 `config.provider`，其次取第一个。命中 → `attachment === true ? 'yes' : 'no'`。
3. 未命中 → `'unknown'`。

行为：
- `'no'`：Read 直接拒绝图片/PDF，文案说明「目录标记该模型 `attachment: false`」，并给出两条出路（换视觉模型 / `COWCAT_VISION=force` 强制尝试）。
- `'unknown'`：放行尝试；上游报错时由 `errfmt` 的新规则识别（`image`/`vision`/`multimodal`/`does not support` 等）并追加提示「该模型可能不支持图片输入，可用 /model 切换或 `COWCAT_VISION=off` 关闭」。

### 3.5 PDF 策略

- **Anthropic 协议**：原生 `document` 块（base64，`media_type: application/pdf`），单文件上限 10MB。
- **OpenAI 兼容协议**：新增 `src/pdftext.js`（零依赖，用内置 `zlib` inflate 流 + 文本操作符扫描：`Tj`/`TJ`/`'`/`"`）做 **best-effort 文本抽取**，带质量门：
  - 抽出的可打印文本 < 200 字符，或替换字符占比 > 30% → **判定失败**，返回明确错误（建议换视觉模型或先转文本），而不是把乱码喂给模型；
  - 成功则返回文本 + 一行来源说明（`[PDF text extracted best-effort; complex/CID-encoded PDFs may lose characters]`）。
  - 已知局限（写进代码注释与文档）：不处理 ToUnicode CMap，CJK 字体可能丢字或乱码——质量门会挡住最差情况，但抽出的文本仍需模型自行判断。

### 3.6 Notebook 读取与编辑

- `src/notebook.js`（纯函数，便于离线测试）：
  - `parseNotebook(text)` → `{ nb, cells }`，单元格视图 `{index, id, cell_type, source, outputs[]}`。
  - `renderNotebook(nb, {path})` → 文本：每个 cell 一段
    `--- cell [0] code ---` + 源码（按行号缩进，与 Read 的 `行号\t内容` 风格一致）+ 输出（text/stream → 原文；`execute_result`/`display_data` 的 `text/plain` → 原文；image → 只标注 `[image output: image/png, 45.2 KB]`）。
    长输出按 2000 行 / 100KB 截断并标注。
  - `editNotebook(text, {cell_index, edit_mode, new_source, cell_type})` → 只改目标 cell：`replace`（默认）/`insert`（在 index 后插入）/`delete`；序列化保持 2 空格缩进、文件末尾换行、其余字段与顺序不动。
- `src/tools/notebookedit.js`：schema `{notebook_path, cell_index, new_source?, cell_type?, edit_mode?}`；
  沿用 Edit 的「先读后写」约束（`ctx.readSet`）；返回 `{ok, output:'Edited <path>: cell [n] <mode>...'}`。
- `.ipynb` 的 `Read` 走 §3.6 的 renderer；`offset`/`limit` 对图片/PDF/notebook 不适用，返回时在输出头一行注明「whole file (no paging)」而不是报错（少一次无效回合）。

### 3.7 提示词与权限

- `Read` 描述补充：何时用图片/PDF/notebook 分支、哪些情况会拒绝（模型不支持、超限）、以及 offset/limit 对非文本文件无效。
- `NotebookEdit` 描述按现有 Edit 的「何时用/不用/约束/失败模式」四段式写。
- 权限：`NotebookEdit` 归入**写工具**——需要授权（同 Edit/Write）、plan 模式拒绝、参与 checkpoint 与审批卡 diff 预览（预览用「渲染后文本 → unifiedDiff」）。
- `src/permissions.js` 的 `READ_ONLY` 不变（`Read` 仍只读）；写工具集合处补 `NotebookEdit`。

## 4. 任务拆分（每步都有可验证产出）

| # | 步骤 | 产出与验证 |
|---|---|---|
| 1 | `src/imageinfo.js` | 魔数嗅探 png/jpeg/gif/webp/pdf + 尺寸解析 + 图片 token 估算；单测覆盖各格式与「扩展名骗人」 |
| 2 | `src/attach.js` | 附件构造/校验/materialize（读盘、上限、降级为占位文案）；单测覆盖缺失文件、超限、字节数变化 |
| 3 | `src/vision.js` | 三分支判定 + env 覆盖优先级；单测覆盖目录命中/未命中/多义/force/off |
| 4 | `src/tools/read.js` | 图片→附件、PDF→（Anthropic 原生 / OpenAI 抽取）、`.ipynb`→renderer；文本路径行为不变（回归） |
| 5 | `src/loop.js` | 工具结果透传 `attachments`；`NotebookEdit` 纳入 checkpoint 与 diff 预览 |
| 6 | `src/pdftext.js` | best-effort 抽取 + 质量门；测试用测试内生成的 Flate PDF fixture（含「无文本 PDF 必须失败」） |
| 7 | `src/llm/anthropic.js` / `openai.js` | 附件翻译（含 document 的 user 消息、OpenAI 的 tool+user 顺序）；单测断言请求体形状与顺序 |
| 8 | `src/prompts/compact.js`、`src/contextviz.js`、`src/slashcmds.js` | 附件标注与 token 计入；单测断言 `[attached: …]` 与 token 增量 |
| 9 | `src/errfmt.js` | `visionUnsupported` hint + 规则；单测覆盖典型上游文案 |
| 10 | `src/notebook.js` + `src/tools/notebookedit.js` | 读取渲染与三种编辑模式、格式稳定、权限/readSet 约束；单测 |
| 11 | `src/permissions.js`、`src/tools/registry` 接线（bin） | NotebookEdit 注册与权限分类生效；permissions 单测 + 管线测试 |
| 12 | 文档与版本 | `docs/USAGE.md`、`docs/changelog.md`、`docs/ROADMAP.md`（P3-6 → ✅、新增 NotebookEdit 条目）、版本号 `0.13.0` |

## 5. 测试清单

**离线（`npm test`，可在无凭据机器跑）**
- 图片：真实最小 PNG/JPEG/GIF/WEBP 字节 → 附件形状、`mediaType`、`tokens>0`；`Read` 打开图片不再报 binary。
- 上限：图片 > 5MB、PDF > 10MB、目录 `attachment:false`、`COWCAT_VISION=off` → 各自的拒绝文案。
- 门控：`unknown` 放行 + `COWCAT_VISION=force` 覆盖。
- PDF：Anthropic 侧出现 `document` 块；OpenAI 侧成功抽取（fixture）与无文本 PDF 的失败文案。
- 翻译：Anthropic `tool_result.content` 数组含 text+image；OpenAI 输出顺序为 `assistant(tool_calls)` → `tool` → `user(image_url)`。
- 降级：materialize 时文件被删 → 文本占位且请求仍发出。
- 记账：`estimateTokens` 因附件上升；compact 渲染含 `[attached: …]`；`/export` 不出现 base64。
- Notebook：渲染含 cell 索引与输出；replace/insert/delete；非法 cell_index；未 Read 先 Edit 被拒；JSON 格式稳定（再 parse 等值）；图片型 output 只标注不上传。

**需真机/凭据（不进 CI，手工跑并标注）**
- 真实视觉模型（如 `glm-4v` / Kimi 视觉）读一张 PNG 并描述内容。
- Anthropic 协议端点读 PDF；OpenAI 兼容端点读文本型 PDF。
- 真机确认 token 消耗与 `/context` 估算量级一致（误差记录在案）。

## 6. 风险与取舍

| 风险 | 处置 |
|---|---|
| 图片体积导致 token 与上下文暴涨 | 5MB 上限 + token 估算进 `/context` + 只发引用；不做自动缩放（零依赖） |
| 图片 token 估算误差 | 用 Anthropic 官方 `w*h/750`；未知尺寸回落 1600；实测值记录到文档，不假装精确 |
| 会话文件膨胀 | 引用不变式（§3.3）从根上避免，不需要事后打码 |
| resume 后图片语义断裂 | 引用回放 + 重新 materialize；文件变了就降级为占位，不静默发错图 |
| Anthropic-compatible 第三方端点不认 `document` 块 | 交由上游报错 + errfmt 提示；不做事前探测（探测成本 > 收益） |
| 缓存断点被附件打乱 | `buildAnthropicRequestBody` 的尾部 breakpoint 逻辑不变；附件走 tool_result/user 消息，仍在同一条消息内被标记 |
| PDF 抽取在 CJK/CMap 场景失真 | 质量门拦截最差情况；局限写进代码注释与 USAGE |
| 二进制嗅探误判（UTF-16 / 含 NUL 的文本 / 超大 SVG） | 先看魔数再看扩展名；嗅探不出且含 NUL → 维持现状报 binary；SVG 归文本 |
| Windows 路径在 JSON 里的反斜杠 | 一律 `JSON.stringify`/`resolve` 处理，测试用 Windows 路径样本覆盖 |

**被否决的方案**
1. *把 base64 直接放进消息、在各处打码*：改动面大（session/export/compact/contextviz/UI 都要记得打码），漏一处就炸会话文件；引用方案让「忘记打码」不可能发生。
2. *Read 返回后用单独的 `Attachment` 工具回传*：多一轮模型交互、且模型可能不调用；配对关系也更脆弱。
3. *用图像库做缩放/转码*：违背零运行时依赖。
4. *统一把图片塞进 tool_result（两协议一致）*：OpenAI 兼容协议不接受 `role:'tool'` 带图，必须拆 user 消息，统一不了。

## 7. 后续可选项（不阻塞本批次）

- notebook output 内嵌图片回传（需给附件加 base64 兜底 + 大小预算）。
- PDF 抽取增强（ToUnicode CMap 解析）或引入可选的本地 `pdftotext` 调用。
- 图片自动压缩/缩放（若引入可选依赖，走 opt-in）。
- `Read` 支持音频/视频（无上游支持，暂列观察）。
