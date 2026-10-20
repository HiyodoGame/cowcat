# 06 前端：headless 协议、TUI 与终端图像

> 本文是 P6 的契约文档。决定见 [`README.md`](README.md) 的 ADR-055~060，调研与取舍见 [`../research/p6-frontend.md`](../research/p6-frontend.md)。
> **本文只写已决定且已落地或正在落地的形状**；尚未实现的部分标注「（T# 落地）」，不写成已完成。

## 为什么前端必须隔着协议

内核是一个库（`packages/cowcat/src/`），组合根负责装配。P6 加一个前端时最容易走的路是**直接 import 内核**——那样确实更快，但会同时失去两样东西：

1. **可测**：没有终端也能测的前提是「前端只是协议的客户端」，否则任何测试都要启动一个真 TUI；
2. **可换**：TUI 之后还会有别的客户端（IDE 插件、脚本），如果第一个客户端就与内核焊死，第二个客户端要么复制一遍装配，要么改内核。

`dev-plan-v2.md` 的 P6 出口标准把这条写成硬约束：**TUI 中删除任何直接访问内核内部的代码路径（lint 或测试保证）**。实现方式见 ADR-059。

## 协议（ADR-055）

**JSON-RPC 2.0 over stdio，一行一个 JSON 对象。** 不用 `Content-Length` 帧：我们的载荷里没有裸换行，而引入帧解析就等于引入一个必须两个实现同时正确的解析器。

```
请求（客户端 → 服务端）
  initialize          { protocolVersion }            必须第一个；不匹配则结构化报错并退出
  session.open        { sessionId }
  session.create      { sessionId? }
  session.list        {}
  turn.send           { sessionId, input }
  turn.cancel         { sessionId }
  approval.respond    { sessionId, callId, verdict }  once | always | reject
  attachment.read     { id, maxBytes? }               按需取附件字节（ADR-057）
  shutdown            {}

通知（服务端 → 客户端）
  event               KernelEvent（持久事实）
  delta               StreamDelta（瞬时，逐 token）
  log                 服务端自己的诊断（不是会话事实，不进日志）
```

三条纪律：

1. **协议与传输分开**。同一套方法与类型跑 **stdio**（子进程）与 **内存传输**（测试、单进程模式）。`cowcat serve` 只是「stdio 上的一个服务端」，不是协议本身。
2. **`event` 与 `delta` 分开**。前者是事实（会进日志、可重放），后者只用于实时渲染（`02-kernel.md` 的既有裁定：瞬时增量不落盘）。前端不得把 delta 当作状态来源。
3. **版本不匹配时拒绝，不降级**。`protocolVersion` 不是「尽力兼容」的协商，是一次握手：要么两端说同一个版本，要么明确失败（ADR-016 的纪律）。

### 前端不持有会话状态的副本

前端只有两种东西：**订阅到的更新**与**它自己的界面状态**（滚动位置、当前对话框、输入缓冲）。会话状态（消息、`readFiles`、`todos`、grants）的唯一权威在服务端；前端需要时通过协议问，不缓存一份「以防万一」。

这条不是洁癖：旧版 TUI 直接读内核状态，于是「屏幕上显示的」「日志里记录的」「模型下一轮看到的」三者可以不一致，而排错时无法判断哪一份是对的。

### T2 落地的形状（2026-10-19）

方法表是**数据**（`packages/protocol/src/methods.ts` 的 `METHODS` 与 `PARAMS`），与 ADR-060 对 CLI 子命令的要求同一手法：`switch` 的穷尽性让「加了方法却忘了处理」变成编译失败。

两条与直觉不同的裁剪写在这里，因为它们是**契约**而不是实现细节：

1. **params 严格、事件体宽松**。客户端发来的 params 用 `strictObject` 校验（多一个字段就是 `invalidParams`——服务端不能对看不懂的请求动作），而服务端发出的事件**只校验信封**（`seq`/`ts`/`sessionId`/`turnId`/`type`）、放过其余字段。理由：事件体是内核的事件联合类型，在协议里再描述一遍等于手写第二份 `adapters/schema.ts`（内核已经为这份漂移付过一次编译期等价断言），而且它会**在内核做加法改动时把前端打死**——`tool.finished` 已经长过 `truncation` 和 `path`，T5 还要长 `attachments`，这些都不该要协议陪着改。代价写在明处：`type` 是普通字符串，前端遇到不认识的事件走「显示为不支持」而不是崩掉。
2. **协议层既不 import 内核、也不 import opentui**，由 `packages/protocol/eslint.config.js` 强制（**T4a 1/3 之后它真的独立成包了**）。前者是 ADR-059 ③；后者当时是为了让这个模块能整体挪走——`serve` 与未来的 IDE 插件都需要一个没有渲染器的客户端，而「挪」只有在今天这条规则为真时才是机械动作。ADR-059 ③ 要求的「lint 探针证明规则真的会报错」按计划在 T10 复核（见 `dev-plan-v2.md` 的 T10 行）。

其余落地细节：

| 项 | 形状 |
|---|---|
| 传输 | T2 只交付**内存传输**（`memoryTransport`：投递走 microtask，且 `defer` 可注入，因此顺序断言是确定的）——ADR-059 ① 的契约测试要的就是它。**stdio 传输是 T3 的活** |
| `initialize` | 版本不匹配 → `versionMismatch` 响应**先发出**，然后服务端停止（拒绝 = 停止，不降级）；测试断言了这条顺序，也正是内存传输把 close 也排进队列的原因 |
| 错误 | JSON-RPC 保留码之外用实现定义段：`versionMismatch`/`notInitialized`/`noSuchSession`/`hostRefused`/`attachmentTooLarge`。客户端按**码**分支，不按文案 |
| `session.open` | 回 `{sessionId, lastSeq, replayed}`，**然后**按序补发日志里的每条事件：前端靠重放重建屏幕，不需要第二种「现在长什么样」的查询（ADR-059 ②）。`session.list` 的每条摘要可带 `parentSessionId`（ADR-079 ③ 的可选新增字段），客户端据此折叠子会话 |
| `attachment.read` | 超限一律**拒绝并带数字**（`{id, byteLength, limit}`），不截断字节；调用方的 `maxBytes` 只会更严、不会更松（ADR-057 的 5MB 口径在 T5/T6 落到真实附件上） |
| 宿主端口 | `ProtocolHost`（`packages/protocol/src/host.ts`）是「会话持有者」的端口：T3/T4 拿它接内核，协议层因此完全不认识内核。`attach()` 的原子性（replay 与 subscribe 之间不丢不重）写在端口注释里，因为那是**实现者的义务**，协议无法在运行时检查它 |

### T3 落地的形状（2026-10-19）

T3 交付的是**进程**，不是宿主：`stdioTransport`（行帧）+ `serve()`（生命周期）+ 一条 spawn 测试。宿主做成**注入点**（`ServeOptions.host`），这一轮填的是 `refusingHost()`——它对每个方法都回 `hostRefused` 并说明缺什么。**返回空成功的占位比拒绝更糟**：客户端会把「没有会话」当成事实。为什么不在这轮落真实宿主，见 `dev-plan-v2.md` 的「包结构待定」与 T4a。

| 项 | 形状 |
|---|---|
| 帧 | 以 `\n` 分帧并容忍 `\r\n`（Windows 管道）；输入切到 `utf8` 解码，**多字节字符跨 chunk 不会被切坏**（每个 chunk 各自 `toString()` 正是会切坏模型输出与框线的那种写法）；空行忽略 |
| 上限 | 一行超过 `STDIO_MAX_LINE_BYTES`（8 MiB）视为坏对端：**关闭连接 + 走诊断**，不当成一条消息交出去——这一层在协议之下，没有可回的错误对象 |
| 背压 | **不处理**，并写明理由：两端是同一台机器上的控制消息与增量，客户端不读自己的管道是客户端的问题 |
| 退出码 | **0 是唯一的正常出口**：`shutdown`、握手被拒、stdin EOF、SIGINT/SIGTERM 都是 0——「拒绝」不是错误，客户端已经从协议里知道了发生了什么 |
| 信号 | 注入（`SignalSource`），因为 Windows 上没法真发信号；测试断言的是「收到信号就关，且返回前把进程级 handler 摘干净」 |
| stdin | 服务端可以自己决定关闭（`shutdown`）而 stdin 还开着：关闭前 pause + unref，否则进程挂在一个再也不会有人写的 stdin 上——**挂住的 `serve` 比报错的 `serve` 更糟** |

`packages/protocol/src/serve.ts`（进程）与协议本身受同一条 lint 约束（既不 import 内核、也不 import opentui）——迁移时这条规则为真，所以 T4a 1/3 的搬迁是机械动作。

## 组合根与宿主（ADR-062 ②、ADR-064）

组合根在 `packages/cowcat/src/host/`，它实现协议包的 `ProtocolHost` 端口，因此 `packages/cowcat` 依赖
`@corescense/cowcat-protocol`（ADR-062 ③ 的依赖方向）。协议侧至今不知道内核存在，这一条没有变：变的是
「谁来回答」。

| 文件 | 它决定的事 |
|---|---|
| `host/paths.ts` | 落盘布局：`~/.cowcat/{sessions,trust.json,config.json}` + `<cwd>/cowcat.json` |
| `host/config.ts` | 三层配置的读取顺序，以及组合根自己的基线规则（`TodoWrite` 免问） |
| `host/host.ts` | `createHost()`：配置 → 信任闸门 → 沙箱 profile → 七个工具 → 会话/回合/审批/附件 |

**读文件不在 `host/` 里**：`src/host/**` 受 `src/**` 那条 lint 约束（不得 import `node:fs`/`node:os`/
`node:child_process`），所以「读哪些路径」是组合根的决定，「怎么读字节」在
`adapters/config-files.ts`、`adapters/session-index.ts` 与 `adapters/sandbox/fs-probe.ts`。这不是迂回，
是 ADR-009 同一条理由：字节与解码同属边界。

三件只有装起来才会暴露的事，写在这里免得重走：

1. **配置在构造时读，模型在首次回合时建**。`createHost` 是 async 工厂：文件读不了或解不开就拒绝启动
   （可修的错误早说早好）。模型不在这里——没配模型的机器要能列会话、读日志、跑 `doctor`，而缺 key 要
   变成**前端能读的拒绝**（`hostRefused` + `data.problem`）而不是进程启动失败。
2. **`attach` 是「先订阅、再读日志、读日志期间的更新缓冲到重放之后补发」**。服务端在同一个同步块里先回
   响应再发重放，所以补发放在一个 microtask 上：既不会插到重放之前，也不会漏掉缝隙里的那些。
   `host.test.ts` 用「读日志时让出事件循环」的 store 复现了这个窗口，断言的是 `seq` 连续无重复。
3. **审批桥的键是 `ActionRequest.callId`**，不是从 `approval.requested` 反查出来的。两者是同一个 id，
   而手上已经有一个值就不该再去日志里找它。

**已经接上了**：`packages/cli`（3/3）是 `bin`、子命令表与 `doctor` 的所在地（ADR-065），它用
`createHost` 装配真实宿主，因此 **`cowcat serve` 跑的就是这个宿主**——`packages/cli/test/cli/spawn.test.ts`
里那条测试会 spawn 真实的 `cowcat serve` 进程，建一个会话、在 `COWCAT_HOME` 指向的临时目录里写下
`.jsonl`、再确认退出后锁文件被清掉了。`cowcat run`（一次性回合，审批逐条答复）与 `sessions list` 同样
接在这条链上。

**T7 之后 `tui` 与 `sessions resume` 也接上了**：`packages/cli` 建宿主与内存传输，渲染器只拿
`ProtocolClient`（ADR-066 ①）。**仍然未接线的只有 `setup`**（配置的**写入**路径；键已定，见 ADR-063）。

## 前端分层（ADR-056、ADR-062）

前端是**独立包**（`packages/tui/`，`private: true`），它自己声明 `engines.node >=26.4.0`（opentui 的门槛），而内核包保持 Node ≥ 22 不变。（T1 已按此建成该包与它的两条 Node 26 CI 腿；实测见下文「T1 前提验证」。）

**包结构（ADR-062；1/3、2/3 与 3/3 都已落地）**：

```
packages/protocol/   @corescense/cowcat-protocol   Node >=22   wire + 传输 + serve 生命周期 + ProtocolHost 端口
                     ↑ 不 import opentui、不 import 内核（自己的 eslint 强制）
packages/cowcat/     @corescense/cowcat-core       Node >=22   内核 + 适配器 + 组合根 src/host/
packages/tui/        @corescense/cowcat-tui        Node >=26.4 opentui 渲染器 + 协议客户端（T7 填 app/ ui/ components/）
                     ↑ 整个包都不许 import 内核（ADR-059 ③，禁令从 src/cli/** 扩到 src/**）
packages/cli/        @corescense/cowcat         Node >=22   bin + 子命令表 + doctor（唯一同时看得到两边的包）
                     ↑ 不许直接 import @opentui/*（进渲染器只有一个门：@corescense/cowcat-tui）

依赖方向：protocol ← cowcat ← cli，protocol ← tui ← cli（无环）
```

`packages/cli` 的门槛是**内核的 22**，不是渲染器的 26.4（ADR-065 ①）：把 26.4 写在 `bin` 上，正是
ADR-062 否掉方案 B 时反对的那件事（「`serve` 被绑在渲染器的 Node 门槛上」）。渲染器的门槛落在**加载它的
那个动词**（`cowcat tui`，T7 在那里检查并拒绝），`doctor` 把它作为另一行事实报出来。

`packages/tui/src/`（协议搬走后）与将要加进来的目录：

```
packages/tui/src/
  app/          project()（KernelEvent → view model，纯函数）、视图与界面状态、文案、命令表、键位
  text/         我们自己的排版：width（宽度表，v1 的排序缺陷在此修掉）、wrap（卡片内换行）、diff（LCS）
  ui/           无状态原语：line（行模型）、card（逐字符画的卡片）、screen（**renderable 层，两个碰渲染器的文件之一**）
  components/   特性组件：session-frame / transcript / message / tool-card / approval-card /
                todo-panel / palette / status-bar（全部产出 `Line[]`）
  theme/        语义 token（ADR-061）
  image/        ImageRenderable 与能力探测（ADR-058）：`layout.ts` 算尺寸；**探测与协议选择交给渲染库**（ADR-068）
```

（`cli/` 已经不在这里了：子命令表、帮助与 `doctor` 在 T4a 3/3 搬去了 `packages/cli`，ADR-065 ⑥。）

| 层 | 规则 |
|---|---|
| `protocol/` | 只做传输与解码；不认识任何界面概念（它如今是自己的包） |
| `app/` | **唯一**持有界面状态的地方；`project()` 是纯函数（同一段日志 → 同一屏）；命令表同时服务 `/命令` 与面板，键位是纯函数 |
| `text/` | 排版与测量：宽度表是**我们的**（ADR-056、ADR-067 ②），diff 是迁移 v1 的 LCS |
| `ui/` | 原语**不认识业务**：出现 `session` / `tool` / `approval` 这些词就是分层被破坏的信号。**只有 `ui/screen.ts`（renderable 层）与 `run.ts`（渲染器生命周期）可以 import `@opentui/core`**（ADR-066 ③，由 lint 强制）；卡片是文本（ADR-067 ①） |
| `components/` | 只读 view model，不订阅协议、不发命令；**产出 `Line[]` 与状态行**，因此不需要渲染器就能测 |
| `image/` | 能力探测与协议细节（kitty / iTerm2 / 半块）只在这里；组件只说「这里有一张图」 |

**依赖方向**：`components → ui → image/theme`，`app → protocol`；**整个 `packages/tui` 都不 import `@corescense/cowcat-core`**（ADR-059 ③，lint 在它的 `eslint.config.js` 里，`tools/lint-probe.mjs` 有一条探针证明它真的会报错）。同时**反向**：`packages/cli` 不许直接 import `@opentui/*`——它通过 `@corescense/cowcat-tui` 取渲染器，进渲染器只有一个门。

**为什么用 opentui 而不自研**：用户裁定采纳 `@opentui/core`（flexbox、原生图片支持），代价是 Node 门槛与原生二进制（ADR-056）。旧版的宽度实现与能力探测仍然保留——**模型侧与工具输出侧的对齐不归 opentui 管**。

## 附件与图像（ADR-057、ADR-058）

### 附件通路（**T5 已实现**）

```
工具（Read / 未来的 NotebookEdit）
  → ToolResult.attachments          形状沿用旧版 attach.js：{ type, mediaType, path, bytes, width, height, pages }
  → tool.finished.attachments       进日志（可空）——「这次回答里有一张图」是可重放的事实
  → Message 携带附件【引用】         日志是 JSON，字节不进日志
  → ModelRequest 内容部件            两个协议各自映射（否则图片只是给人看的装饰）
  → 协议 attachment.read(id)         前端与内核是两个进程，前端不能直接读内核侧的路径
```

落地时定下的四件事，其中前两件与 ADR-057 的字面不同，理由写在代码里：

| 项 | 形状 | 为什么 |
|---|---|---|
| 未知元数据 | `width`/`height`/`pages` 是 **`number \| null`（必填可为空）**，不是 ADR-057 写的 `?` | `adapters/schema.ts` 已经为这条踩过坑：日志 schema 用 `.optional()` 会推出 `undefined`，而 `exactOptionalPropertyTypes` 下那与内核类型不是同一个类型。日志里「没报」一律写 `null`，与 `facts`/`truncation`/`path` 同一口径 |
| 旧日志 | `tool.finished.attachments` 用 `nullableFromAbsent`：**这个字段不存在时解出 `null`** | 与 ADR-048/049 同手法；不想让「早于本 ADR 写的日志」被读成「工具没产出图片」 |
| 大小口径 | `ATTACHMENT_SOFT_LIMIT_BYTES` 5MB / `ATTACHMENT_HARD_LIMIT_BYTES` 20MB（与 P5 同口径，但**常量各自存在**） | 一个管「读回多少文本」，一个管「多少字节能上一趟模型请求」；合并会让「改一个动另一个」变成隐式行为 |
| 拿不到字节时 | **拒绝**（`AttachmentUnavailableError`），请求不发 | 模型被告知有图却没拿到，会当成「图里什么都没说」照常回答——而那次请求在日志里看不出任何异常（ADR-016 的纪律：拒绝，不降级）。声明的 `bytes` 先查（不读文件），文件的真实大小再查（它可能已经变了） |

**两个协议的映射各不相同**（这是「各自映射」的实测样子）：

| 协议 | 图片 | 文档 |
|---|---|---|
| Anthropic | 放在**同一个** `tool_result` 的 content 块数组里（`{type:'image', source:{type:'base64',…}}`）——这个协议本来就能让附件跟着它所属的结果走 | 同处一块 `document` 块 |
| OpenAI (Chat Completions) | `role:'tool'` 的 content 只能是字符串，所以图片**作为紧接着的下一条 user 消息**发出（`image_url` + `data:` URL） | **只给引用**（路径/类型/大小），并在请求里写明「这个协议没有可移植的 document 部件」——不静默省略 |

**仍缺的一件事**：预设（`ModelPreset`）里**没有「模型是否支持图片」的字段**。给不识图模型发图片会 400，而现在的契约拦不住——等目录（catalog）落地时补，与 `toolCalls: false` 同一手法（ADR-046 决策 ③）。

**还没验证的**：Anthropic 的 `document` 块是否需要 beta header，以及在 `tool_result` 里放图片/文档是否被所有模型接受——本机没有凭据，两个协议的实际接受度仍是零实测（与调研里「厂商侧零实测」同一条）。

### `Read` 的非文本分支（T6 已实现）

| 输入 | 行为 |
|---|---|
| `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp`（且魔数对得上） | **附件**（`type: 'image'`，带 `width`/`height`）＋ 一行头（名字、类型、尺寸、大小、`attached for the model`）；结果里**没有字节** |
| `.pdf`（魔数 `%PDF-`） | **附件**（`type: 'document'`，带页数）；页数是**尽力而为**（数 `/Type /Page`，PDF 1.5+ 的对象流会把它压掉，那时记 `null`＝「没报」而不是「没有页」） |
| `.ipynb` | **渲染成文本**（逐 cell、逐 output），**不挂附件**——里面的图片活在 JSON 里，没有文件可引用（ADR-057 的同一条规则）。每个 output 有 20000 字符上限，命中时 `truncation.dropped = null`（「提前停止，总数未知」，ADR-053） |
| bmp / tiff / ico / avif / heic | **拒绝并点名格式**（两个协议只收 png/jpeg/gif/webp），不是静默当文本读 |
| 名字承诺是图片/PDF 但内容不是 | **拒绝并说明**：魔数优先，且不把这种字节当文本递给模型（那正是「转录稿被悄悄弄坏」的形态） |

大小沿用 ADR-057 的口径（5MB 软限 / 20MB 硬顶），**二进制没有可分页的单位**：软限是「拒绝 + `allow_large` 这个逃生口」，硬顶是终局；适配器在序列化请求时**会再查一次**（文件可能在读之后长大）。

**两处刻意的缺口（写在这里，不留给下一个人去发现）**：

1. **没有移植 v1 的 `pdftext.js`**（362 行的 PDF 文本抽取）。v1 在非 Anthropic 协议上用它是为了兜底；v2 不做——代价是：在那类端点上 PDF 只会以**引用**到达模型（适配器会如实告诉模型「这是引用」）。若实测显示这条路径不够用，它是一个独立任务，不是「顺手补上」。
2. **不按模型能力 gate**：v1 会查 catalog 里的 vision 支持再决定是否附图；v2 的预设还没有这个字段（见上），所以 `Read` 一律产出附件，能不能被接受由端点决定。

### 图像协议矩阵

| 协议 | 序列 | 是否参与文本重排 | 用途 |
|---|---|---|---|
| kitty graphics | APC `ESC _ G <k=v,…>;base64 ESC \` | **是**（`U=1` + `U+10EEEE` 占位符） | 工具结果内联、预览模态 |
| iTerm2 | OSC `1337;File=<k=v,…>:base64 BEL` | 否（挂在屏幕坐标上） | 只用于不滚动的模态 |
| sixel | DCS | 否 | 回退链的一环（覆盖范围未验证） |
| 半块 / octant | 普通文本 | **是**（就是文本） | 没有协议时；octant 需字体支持（未验证） |

**能力探测顺序**：环境变量 → 主动查询（kitty `a=q` + DA1，**必须 `q=2` 静默**）→ 半块 → 元信息。

**为什么「是否参与重排」是这条链的判据**：我们是行式重绘（每帧按行写绝对坐标）。图片若挂在屏幕坐标上，滚动一次就错位；只有作为文本（占位符或块字符）参与布局的图片才能跟着内容走。

## 测试（ADR-059）

| 形态 | 做法 | 覆盖 |
|---|---|---|
| 协议契约测试 | 内存传输 + 测试客户端，跑完整回合（打开 → 输入 → 事件 → 审批 → 取消） | 协议形状、顺序、错误路径（**T2 已落地**：27 项，含顺序与错误路径） |
| 帧快照测试 | `project()` 纯函数 + 写死的日志 → 逐字节比对一屏文本 | 渲染逻辑，不需要终端 |
| lint 探针 | 前端包禁止 import 内核与适配器；`protocol/` 与 `serve/` 还禁止 import opentui（**T2/T3 已加规则**）；`tools/lint-probe.mjs` 同款手法验证它真的会报错（**T10**） | 出口标准第 2 条 |
| 子进程测试 | **T3 已落地**：3 条 spawn 测试（握手 + 退出码 0、真实进程里的拒绝形状、stdin 关闭后干净退出） | 传输与生命周期 |
| 人工验收 | 真实终端上的刷新率、闪烁、图片协议 | **CI 覆盖不到**，记在 T10 |

## CLI（ADR-060）

| 命令 | 作用 | 状态（T7 之后） |
|---|---|---|
| `cowcat` | 进 TUI（默认） | **可用**：`project()` 骨架 + `cowcat tui`（`--session <id>` 继续一个会话） |
| `cowcat serve` | headless 协议服务（stdio）——TUI 与 IDE 都连它，也是无终端测试的入口 | **可用**（真实宿主：会话、回合、审批、附件都接上了） |
| `cowcat run "<prompt>"` | 一次性回合（非交互） | **可用**：`--yes` 放行审批，`--session <id>` 继续一个会话；默认逐条拒绝（ADR-065 ②） |
| `cowcat doctor` | Node、配置、信任、指令链（注入了哪几份 / 跳过了什么）、沙箱后端、模型与协议版本逐项检查 | **可用**（T4a 3/3 起真的查配置与沙箱；指令链一行在 ADR-078 T6 补上；不查渲染器的原生二进制，说明理由） |
| `cowcat sessions list \| resume <id>` | 会话管理 | **都可用了**：`list` 直接读会话目录，**默认折叠被委派的子会话**（`--all` 才列，并标出父会话——ADR-079 ④）；`resume` 就是「带 id 的 TUI」（同一条代码路径，Node 门槛只检查一次） |
| `cowcat setup` | 交互式配置向导 | **未接线**：配置的**写入**路径尚未实现（键已定，见 ADR-063；现在直接编辑 `~/.cowcat/config.json`） |

子命令表是**数据**（`packages/cli/src/cli/spec.ts`：名字、摘要、参数 schema、**选项**、处理函数），帮助文本与参数/选项校验都从表生成，不做嵌套子命令。T4 落的是**结构与三个出口码**：

| 出口码 | 含义 |
|---|---|
| `0` | 做到了要求的事 |
| `2` | **命令本身写错了**（未知动词、未知选项、缺值、缺参数、多参数）——参数校验先于「是否接线」判断，所以 `cowcat run`（没带 prompt）报的是缺参数，不是缺组合根 |
| `1` | 命令写得对，但这个构建做不到（未接线）或执行失败 |

**未接线的动词留在表里并说明缺什么**（`status: 'blocked'` 是类型上的一支，没有处理函数可被误调）。帮助文本也照实标注——把一个跑不起来的动词列得像能用，和「宿主返回空成功」是同一种谎。

`bin` 指向 `dist/src/cli/main.js`：**一个可执行文件，六个动词**。每个动词的处理函数里用动态 `import` 取它真正需要的那一半——`--help`、`--version` 与一个未知动词都不加载协议图、内核或模型 SDK；这也是 `packages/cli` 敢同时依赖两边的代价被压到最低的地方。

**`COWCAT_HOME`** 重定位状态目录（默认 `~/.cowcat`）。它是**进程事实，不是配置层**（ADR-065 ④）：不改任何策略值，只改日志住在哪。测试靠它不写进开发者的真实 home。

## T1 前提验证（2026-10-19）

T1 只问一件事：这套东西能不能真的装起来、跑起来。**答案是可以，ADR-056 的兜底（降级为「本机开发 + 手动验收」）不触发**；但「怎么跑起来」与 opentui 自己的 README 写的不完全一样，下面第 1 条是执行这活时最容易踩的坑。

| 验证项 | 结果 | 证据 |
|---|---|---|
| Node 门槛 | `nodejs.org` 的 26 线当前是 **v26.12.0**，与本地装的一致 | 【上游】`dist/latest-v26.x/SHASUMS256.txt`；【实测】本地解压后 `node -v` |
| 安装与原生核心 | `npm install @opentui/core@0.6.6` → 12 个包 / 8 秒；`@opentui/core-win32-x64` 随 `optionalDependencies` 落下，内含 `opentui.dll`（5.06 MB） | 【实测】`packages/tui/package-lock.json` 与本地安装 |
| 一帧渲染 | 40×6 一帧 12 ms、`cellsUpdated` 240；捕获到的字符帧是正确 UTF-8，框线与文本按列对齐，每行恰好 40 个字符 | 【实测】`packages/tui/test/render.test.ts`（Windows x64 / Node 26.12.0） |
| `node:ffi` | **26.12.0 不需要 `--experimental-ffi`**（只把 `ExperimentalWarning` 写到 **stderr**）；显式传该 flag 也无害；**Node 24 上它是启动期硬错误**（`bad option: --experimental-ffi`） | 【实测】三条命令行用例 |
| 非 TTY | `createCliRenderer` 在 `isTTY: false` 下照样创建、照样输出 ANSI（含 kitty `a=q` 静默查询与 DA1）；帧走 **stdout**，诊断走 stderr | 【实测】探针，stdout 992 B / stderr 166 B |
| CI 两条腿 | `packages/tui · node 26 · ubuntu-latest` **22 s**、`windows-latest` **38 s**，均 pass（Node 26 与对应平台二进制都在干净 runner 上解析到了） | 【CI 远端】PR #56 的 checks（只观察状态，未在本地复现） |

三条要记住的：

1. **不要把 `--experimental-ffi` 写进脚本或 `NODE_OPTIONS`**。opentui 的 README 说 Node 需要它，26.12.0 实测不需要；而一旦写进去，同一个脚本在 Node 24 上是**启动期崩溃**而不是降级——「门槛」就此从 `engines` 的提示变成硬失败。升级 Node 前先看这条 CI 腿。
2. **`packages/tui/test/render.test.ts` 是这条前提的可重复形式**，不是一次性探针：原生二进制没解析到、没加载起来、或帧的列错位，它都会失败。因此 CI 不会在「TUI 静默不可用」时保持绿灯。
3. **真实终端仍然没有证据**：刷新率、闪烁、图片协议的实际渲染全部未测，仍是 T10 的活（本节只证明「能装、能编帧」）。

**T9 落地的形状（图片，ADR-068）**：三级回退是**渲染库内建的**（`ImageRenderable` 的 `protocol: 'auto'` → `kitty` / `sixel` / `blocks`，**没有 iTerm2**），能力探测也由它做（T1 捕获里那条 `a=q` 就是它的查询）。我们负责三件事：**尺寸**（`image/imageBox`：附件自带 `width`/`height`，按单元格 2:1 算行数，超过 12 行等比缩小——布局在渲染前就知道占多少行）、**位置**（帧规格里的 `images: ImageSlot[]`；图片**绝对定位**覆盖卡片预留的行，当 flex 子元素会被推到卡片外面并把下面顶下去）、**状态**（`loading` / `ready` / `failed` 各有一行字，终端没有图片协议时也要能说「这里有一张 320×200 的 PNG」）。字节只经 `attachment.read`，日志里只有引用。

## T10 收口（2026-10-19）

**出口标准的两条，现在各有一条「接缝」测试或规则：**

| 出口标准 | 怎么被保证 |
|---|---|
| 用 headless 协议完整跑通一个带工具与审批的回合（**测试中**） | `packages/cli/test/exit-criteria.test.ts`：`createHost` + 真实协议服务端（内存传输）+ 脚本化模型 → `session.create` → `turn.send` → `approval.requested` → `respondApproval('once')` → 完成；**中间的事件流喂给 `project()` 与 `frameOf()`**，断言屏幕上出现用户卡、`⏺ Write ok` 的卡片与答案。它住在 cli 是因为只有它同时看得到两边（ADR-062 ③），而且**不碰渲染器**（`Line[]` 是纯函数产物，Node 22 腿也能跑） |
| TUI 中删除任何直接访问内核内部的代码路径（**lint 或测试保证**） | `packages/tui/eslint.config.js` 两条：整包不许 import `@corescense/cowcat-core`；**只有 `ui/screen.ts` 与 `run.ts` 可以 import `@opentui/core`**（ADR-066 ③ 从约定变成规则）。`tools/lint-probe.mjs` 有 5 条 tui 探针证明它们**真的会报错**，以及两个豁免**真的成立**。**CI 教了这里一课**：第一版规则写的是「只有 `screen.ts`」，而 `src/smoke.ts`（测试辅助）与 `run.ts`（调用 `createCliRenderer`）立刻让它红了——**跑探针不等于跑包级 lint** |

**待办与未验证**（`HANDOFF` §6 有同样的清单，这里是要人眼做的部分）：

| # | 要验的 | 怎么验（真终端） |
|---|---|---|
| 1 | 一帧的**对齐**：banner、卡片边框、状态条、输入行 | 起 `cowcat`，把终端缩到 **80 列**再看一遍（品牌指南要求 80 列可读） |
| 2 | **流式**：逐字出现、无闪烁、无跳动 | 让它跑一个会连续调工具的任务；看文字与卡片出现时屏幕是否稳定 |
| 3 | **审批**：`y`/`n`/`always` 三个答案、以及 **10 秒催促** | 让它写文件；先等 11 秒看「......你还在吗。」，再分别试三个答案 |
| 4 | **图片三级回退**：真图片 / 半块 / 只有元信息 | 在 kitty 或 WezTerm（`TERM=xterm-kitty`）上 Read 一张 PNG 应是**真图片**；普通终端应是**半块字符**；`TERM=dumb` 下应只有一行 `图片 image/png …` |
| 5 | **`a=q` 的答复会不会漏进键盘输入**（ADR-058 的「静默查询」现在是库内行为） | 图片出现后**连续打几个字符**，看输入框是否被吞字或串字 |
| 6 | **退出**：Ctrl-C 后终端恢复 | 退出后光标是否可见、alternate screen 是否干净、`~/.cowcat` 里有没有残留 `.lock` |
| 7 | **缩放**：改变窗口大小 | 边框是否按新宽度重排（每次重绘按 `renderer.width` 算，但没有监听 resize 事件——这条要专门看） |
| 8 | **长对话**：视口停在最新 | 让它输出 30+ 行，最新的卡是否在屏上（尾部挂载，**没有滚动回看**） |

**人眼验收的第一条真发现（2026-10-20）**：验收里 Read 一张 PNG，随后用 Bash 把文件删掉，下一回合**整回合失败**（状态条：「刚才那步失败了。（attachment … cannot be sent: the file it points at is gone or unreadable）」）。根因是字节在每次构建请求时重新 materialize，而引用留在历史里——因此**该会话之后每个回合都会以同样方式失败**，重开也救不回来。修法不在 UI 层，在请求构建：读不到的附件**点名缺席**而不是抛错（**ADR-069**）。它值得记在收口清单旁边，因为**自动测试覆盖不到**这种形状：单测里文件一直存在。

## 待办与未验证

- **主题 token 已落（ADR-061）**：色值来自品牌指南 §3.1，组件只说语义 token。明暗切换与用户主题文件**没做**（前者等真实需求，后者是一个配置键，得先有 ADR）。
- **卡片已落（ADR-067，T8）**：对话流是卡片（用户气泡 / 工具卡 / 审批卡 / 待办面板 / 命令面板），工具卡默认折叠成「退出状态 + 尾部三行」（品牌指南 §4.2），`Edit`/`Write` 显示 diff（靠日志里的**请求**接上结果）。**图片内联已落（ADR-068，T9）**；**预览模态没做**（它是「更大的矩形 + 一个开关键」，随 T10 的 UI 收口一起做）。**还没有**：滚动回看（只挂尾部）、Plan/Act 双模式（策略层的概念，不是组件）、语法高亮（v1 的着色是往字符串里塞 ANSI，与本仓库的 token 模型冲突，不迁移）、工具输出的自研列对齐（宽度表已在 `text/width.ts`，但还没有需要对齐的组件）。
- **图片链路只验证到 `blocks`**：测试渲染器没有原生图片协议，所以真正画出来的证据是 opentui 的 **blocks 回退**（帧快照 `image` 那一幕里能看见 `████`）。**kitty / sixel 的原生渲染没有任何实测**，也没有验证 `a=q` 的答复是否可能漏进键盘输入——两件都要真终端（T10）。
- **没有任何真实终端证据**：刷新率、闪烁、图片协议的实际渲染效果全部未测（调研 §5.6）。`tools/tui-smoke.mjs` 证明的是**进程链路**（起、画、Ctrl-C 干净退出、不留锁），**不是**观感。
- **T1 已验证**：Node ≥26.4 与 Windows 原生二进制可用，ADR-056 的 CI 部分**不需要**降级（见「T1 前提验证」）。
- **`serve` 的宿主不再是占位**：`packages/cowcat/src/host/` 是真实实现（会话生命周期、回合、审批桥、
  `attachment.read`），并且有 16 项测试经**真实协议服务端**驱动真实内核会话。
- **进程链路已覆盖（T4a 3/3）**：`packages/cli/test/cli/spawn.test.ts` spawn 真实的 `cowcat serve`，
  在 `COWCAT_HOME` 指向的临时目录里建会话、列会话、拿到 `not-configured` 的结构化拒绝，并确认退出后
  锁文件被清掉。**T7 之后 `tools/tui-smoke.mjs` 又补了一条**：真实的 `cowcat tui` 起得来、画得出帧、
  Ctrl-C 退出 0、不留锁。
- **仍未跑过一次真实的模型请求**，因此 `cowcat run` 的「整条回合」只在宿主层验证过
  （`packages/cowcat/test/host.test.ts` 注入脚本化模型），**没有**经由一个真实端点走完整条 CLI/TUI 路径。
- **帧快照只覆盖 ASCII 与一个 CJK 宽度断言**：逐字节快照刻意不含宽字符（字宽是否跨平台一致没有实测过），
  CJK 的**单元格**宽度单独用渲染器自己的 span 宽度断言（`test/frame.test.ts`）。
- **T8/T9 的缺口写在 `dev-plan-v2.md`**：卡片（message / tool-card / approval-card / todo-panel /
  diff-card / command-palette）、图片渲染与能力探测、命令面板与键位表、工具输出的自研对齐（宽度表）。
