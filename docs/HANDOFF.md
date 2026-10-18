# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾（或按用户要求做会话收尾）重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-19（会话收尾：P5 完成 + P6 开工）**；**同日追加五件：T1 前提验证（#56 已合）、T2 协议（#57 已合）、T3 `serve`（#58 已合）、T4 CLI 入口（#59 已合）、T5 附件契约（本 PR）**——都不是阶段收尾，且**组合根与包结构仍未定**（T4a，见 §3）。
> 交接时仓库状态：**`main` = `988169b`**（#59 T4 合入）。本会话（2026-10-18 → 2026-10-19）产出 **13 个已合并 PR（#42–#54）**；此后 **#55–#59 已合**，**T5 在 `988169b` 之上开的分支上**。
>
> **证据分级**（沿用前几轮，逐条标注）：**【源码】**读代码/读装机类型；**【构建】**`tsc` 通过；**【本机测试】**Windows + Node 24.18.0 跑 `node:test`（跑在 `dist/` 编译产物上）；**【本机命令】**本机跑的其他命令（`git`、`npm view`、探针脚本）；**【CI 远端】**GitHub Actions 的运行结果（**只观察状态，未在本地复现**）；**【上游】**厂商文档或开源仓库源码（**不是本仓库源码**）；**【registry】**npm registry 查询；**【推断】**未实测的推论，不得作为决策依据。
> **本会话没有真机沙箱、没有模型端点、没有发布动作、没有真实终端**：本机真实进程只跑 `mode: 'off'`；stdout 不是 TTY；厂商对 wire JSON Schema 的接受度仍为零实测。

---

## 1. 本次会话实际做了什么

### 先说归属（避免把别人的工作记到本会话）

**PR #42 的内容是前序会话的产出**：`docs/research/p5-tools.md`（567 行调研）、ADR-047~052 落表、P5 拆成 T0–T7，都躺在一个**未推送**的分支 `docs/p5-adr` 上（前序会话的提交 `ea5813f`、`9aac9ef`）。本会话对它只做了三件事：改掉 `README.md` 那行过期的 v2 状态、`git push -u`、以**非草稿** PR 合并。**不要把它记成本会话的调研工作。**

同理：`e33b654`（#41 P4 T6c）及更早的提交都是前序会话的。

### 本会话的 13 个 PR

| 任务 | PR | 交付 | 测试数 | 提交日期 |
|---|---|---|---|---|
| P5 T0 合并 + README 修正 | #42 | 推送并合并前序会话的调研分支；`README.md` 的 v2 状态行改对 | 436 | 2026-10-18 |
| P5 T1 | #43 | `ToolResult.truncation`、`tool.finished.truncation` + canonical `path`、`ToolPort.run` 第三参数 `grant`、`reduce` 派生 `readFiles` | 436 → 448 | 2026-10-18 |
| P5 T2 | #44 | `defineTool()` + `toWireSchema()`（派生、剥 `$schema`、禁词汇在**派生结果**上拒绝） | 448 → 458 | 2026-10-19 |
| P5 T3a | #45 | Glob + 遍历器：`.gitignore` 六种写法子集、三种不支持能力上报、100 上限 + 截断事实 | 458 → 470 | 2026-10-19 |
| P5 T3b | #46 | Grep：三模式、**默认模式早退**、上下文、超大/二进制计数；**ADR-053** | 470 → 485 | 2026-10-19 |
| P5 T3c | #47 | Read：分页、5MB/20MB、**CRLF 作为事实告知**、图像/PDF/notebook 显式拒绝（当时指向 P7） | 485 → 500 | 2026-10-19 |
| P5 T4 | #48 | Write + Edit；**「先读后改」闸门落在 `runTurn`**（工具看不到会话状态） | 500 → 517 | 2026-10-19 |
| P5 T5 | #49 | Bash 薄壳（argv 不经 shell）+ **`network: 'ask'` 由 Bash 兑现** + `CowcatConfig.sandbox` 与 `resolveSandboxProfile` | 517 → 537 | 2026-10-19 |
| P5 T6 | #50 | TodoWrite + `todo.updated` 事件（**ADR-054**，用户裁定「状态进日志」） | 537 → 546 | 2026-10-19 |
| P5 T7 | #51 | 七工具统一契约测试、端到端回合、v1 清单对照记录、端口表收口、HANDOFF 重写 | 546 → 555 | 2026-10-19 |
| P6 调研 | #52 | `docs/research/p6-frontend.md` + `tools/p6-tui-probe.mjs` | 555（纯文档） | 2026-10-19 |
| P6 裁定并入 | #53 | 把两处用户裁定写进调研正文（推翻自研草案与「只在预览模态」） | 555 | 2026-10-19 |
| P6 T0 | #54 | **ADR-055~060 落表**、新增 `architecture/06-frontend.md`、P6 任务表 T0–T10、**更正 P5 交付记录与 P7 模块表** | 555 | 2026-10-19 |

**三次用户拍板**（都在本会话内）：① T6 的「TodoWrite 状态存哪」→ 会话日志内的事件；② TUI 渲染 → **采纳 opentui**；③ **工具结果的内联图片进 P6**（连带把附件通路的契约工作从 P7 提前）。

---

## 2. 当前状态

### 已验证 —— 【本机测试】/【本机命令】（Windows，Node v24.18.0，`main` = `14bb122`，工作区干净）

- 【本机测试】`cd packages/cowcat && npm test`（`pretest` = `tsc` + ESLint）→ **555 tests / 539 pass / 0 fail / 16 skipped**（12330ms）
- 【本机命令】`node tools/p6-tui-probe.mjs` → **13/13 断言通过** + 5 条 finding（其中「旧版 `RANGES_EMOJI` 未排序导致二分查找漏掉 `0x2600–0x27BF`」是纯代码事实）
- 【本机命令】`node tools/check-tarball.mjs` → **passed**（`@corescense/cowcat@0.16.0`，109 files / 294,794 bytes）
- 【本机命令】`node tools/lint-probe.mjs` → **all probes behaved as expected**
- 【本机命令】上游事实核实（`npm view` / `nodejs.org/dist/index.json`）：`@opentui/core@0.6.6` 的 `engines` 是 `bun >=1.3.14`、**`node >=26.4.0`**，8 个平台原生核心走 `optionalDependencies`（含 `win32-x64`）；**Node `v26.4.0` 已于 2026-06-24 发布**，26 线当前 `v26.12.0`（2026-10-14），24 线是 LTS（Krypton）
- **工作区干净不等于没有工作**：干净对应的是 §1 的 13 个已合并 PR；`git log --oneline` 是证据，不是记忆

### 已验证 —— P6 T1（Windows，Node **v26.12.0** 便携版，系统 `node` 仍是 24）

- 【本机命令】`npm install @opentui/core@0.6.6` → 12 个包 / 8 秒；`@opentui/core-win32-x64` 落下 `opentui.dll`（5.06 MB）
- 【本机测试】`cd packages/tui && npm test` → **2 tests / 2 pass / 0 fail**（`pretest` 的 `tsc` 与 ESLint 均通过）；40×6 一帧 **12 ms**、`cellsUpdated` 240
- 【本机命令】捕获到的字符帧**落盘后**逐行核对：框线对齐、每行恰好 40 个字符（在 PowerShell 管道里看是乱码，见 §5 第 9 条）
- 【本机命令】`node:ffi`：26.12.0 **无需** `--experimental-ffi`（只把 `ExperimentalWarning` 写到 stderr）；**Node 24 上该 flag 是 `bad option` 启动期硬错误**
- 【本机命令】`npm view @opentui/core-{linux-x64,win32-x64,darwin-arm64,linux-arm64-musl}@0.6.6` 四个平台包都存在；以 `--os=linux --cpu=x64` 装出 `libopentui.so`（5.02 MB）——**只是解析到，未在 Linux 上加载**
- 【本机命令】CI YAML 用 `yaml` 解析校验：9 个 job；两条 tui 腿 `node-version=26`、`working-directory=packages/tui`、非草稿 PR 必跑
- 【CI 远端】**PR #56 全 pass**（11 项）：`packages/tui · node 26` 的 ubuntu **22 s** / windows **38 s**，其余（legacy 三腿、`packages/cowcat` 三腿 + macOS 腿、`package whitelist`、`scope`）也都 pass

### 已验证 —— P6 T2（Windows，Node **v26.12.0** 便携版）

- 【本机测试】`cd packages/tui && npm test` → **29 tests / 29 pass / 0 fail**（其中协议 27 项、T1 渲染 2 项）；`pretest` 的 `tsc` 与 ESLint 均通过
- 【本机命令】`npm ci`（锁文件已改指官方 registry）→ 109 个包 / 9 秒
- **测试抓到的真 bug**：客户端把通知处理器记进 Map 却**从不派发**（只有响应分支）——契约测试立刻红，28/29 失败暴露了它。没有这套测试，这个前端会「握手成功、什么都不显示」
- 【源码】协议层不 import 内核也不 import opentui，由 `packages/tui/eslint.config.js` 的 `no-restricted-imports` 强制；`ProtocolHost` 是它认识内核的唯一方式

### 已验证 —— P6 T3（Windows，Node **v26.12.0** 便携版）

- 【本机测试】`cd packages/tui && npm test` → **47 tests / 47 pass / 0 fail**（协议 40 + 渲染 2 + serve 5；其中 **3 条是真实 spawn 进程**）；`pretest` 的 `tsc` 与 ESLint 均通过
- 【本机测试】stdio 帧的边界用例都在：一行拆两个 chunk、一个 chunk 两行、CRLF、空行、**多字节字符跨 chunk**、超长行（8 MiB 上限）走诊断并关闭
- 【本机测试】生命周期：`shutdown` / stdin EOF / 注入的 SIGINT 都退出 **0**，且返回前把进程级 handler 摘干净（断言 `activeSignals()` 回到 0）
- 【源码】`src/serve/` 与 `src/protocol/` 受同一条 lint 约束（不 import 内核、不 import opentui）——这是「将来能整体挪包」的前提

### 已验证 —— P6 T4（Windows，Node **v26.12.0** 便携版）

- 【本机测试】`cd packages/tui && npm test` → **56 tests / 56 pass / 0 fail**（新增 CLI 9 项：帮助文本、三个出口码、参数校验、未接线动词的原因、`doctor`、经 CLI 驱动 `serve` 的握手）
- 【本机测试】`serve` 的 3 条 spawn 测试改为 spawn **真实可执行文件**（`dist/src/cli/main.js serve`），因此 argv 路径、子命令分发与进程生命周期一次覆盖
- 【源码】`src/serve/main.ts` 删除，`bin` 指向 `dist/src/cli/main.js`（一个可执行文件，六个动词）；`dist/src/serve/main.js` 旧产物已清（AGENTS.md 的提醒：删源文件要清 `dist/`）
- 【源码】`doctor` 只报它真能查的：Node 版本、平台原生核心**解析**、协议版本、未接线动词；配置与沙箱后端**明说不查**（需要内核）

### 已验证 —— P6 T5（内核包，Windows，Node **v26.12.0**）

- 【本机测试】`cd packages/cowcat && npm test` → **564 tests / 548 pass / 0 fail / 16 skipped**（新增 9 项：日志往返、**字节不进日志**、replay 进消息、旧日志缺字段解出 `null`、两适配器映射、缺文件拒绝、两处大小上限）
- 【本机测试】「字节不进日志」是**真查字节**：把带 `BYTES-MARKER-…` 的文件挂上去，再读 `.jsonl` 原文，断言路径在、大小在、**内容与它的 base64 都不在**
- 【源码】编译期守卫按设计工作了：给 `tool.finished` 加字段后，构建在 **4 处**硬失败（`schema.ts` 的 snapshot message schema、`test/schema.test.ts` 的等价断言与 fixture、两个适配器测试的 fixture），逐处补齐才通过
- 【源码】两处与 ADR-057 字面不同、已在 `06-frontend.md` 写清：元数据用 `number | null` 而非 `?`（`exactOptionalPropertyTypes` + 日志 schema 的既有口径）；拿不到字节时**拒绝**而不是静默省略

### CI 远端【CI 远端】

本会话 13 个 PR **全部是非草稿 PR**，每次都跑：`packages/cowcat` 的 ubuntu / windows / macos-15 三条腿 + macOS 的 Seatbelt 腿 + `check-tarball` + `scope` —— **全部 pass**（用 `gh pr checks` 逐次观察）。**未在本地复现 ubuntu / macOS 的结果**，macOS 侧（含 Seatbelt）只由 CI 覆盖。

### 项目状态

- `main` = **`988169b`**（#59 T4 合入）；**P5 完成（T0–T7 全部落地，七个核心工具已交付）**；**P6 调研完成 + T0 落表（ADR-055~060）+ T1~T4 落地 + T5 附件契约落地（本 PR），T6 起未开工；组合根与包结构 = T4a**
- `packages/cowcat` 仍是 `private: true` 的 `0.0.0`，**从未发布**；`schemaVersion` 仍是 **1**（ADR-019）
- 运行时依赖 **3 / 6**（`zod`、`openai`、`@anthropic-ai/sdk`）——**内核包本会话仍未增删**；`packages/tui/` 两个运行时依赖：`@opentui/core@0.6.6`（T1 装）与 `zod`（T2 的解码边界），都不进内核的依赖计数
- 【registry】npm 上 v1 的最新版仍是 **`0.15.0`**——这是**前序会话**核实的结论，**本会话未复查**
- **平台 / 工作区设置本会话未变更**：未调用 `opencode_console` 的任何写操作。若需确认工作区设置与模型开关，**请单独核对**，不要以本文件为据
- 本会话的工具使用：只读检索（GitHub API / raw、kitty 与 iTerm2 官方文档、`nodejs.org` 版本索引）；`websearch` **失败（HTTP 402）**，改用 `webfetch`

---

## 3. 项目唯一下一步

**P6 的 T5（附件契约）已完成（本 PR）；下一步是 T6：`Read` 的非文本分支**（图像 / PDF / notebook 走附件通路，大小与类型校验沿用 P5 口径）。T6 与 T4a 互不依赖；但**任何「真的跑一个回合」的能力仍卡在 T4a**（组合根 + 包结构，见下）。

**T5 的结论**：`Attachment`（引用，无字节）→ `ToolResult.attachments` → `tool.finished.attachments`（进日志）→ `Message`（replay 得到）→ 两个适配器各自映射。**564 项测试全绿**（【本机测试】Windows / Node 26.12.0，新增 9 项）。四条值得记住的：

- **「字节不进日志」是真查字节**：挂上带 `BYTES-MARKER-…` 的文件再读 `.jsonl` 原文，断言路径在、大小在、**内容与它的 base64 都不在**；materialize 只在序列化请求那一刻发生
- **拿到字节的失败是拒绝，不是省略**（`AttachmentUnavailableError`，请求不发）：模型被告知有图却没拿到，会当成「图里什么都没说」照常回答，而那次请求在日志里看不出异常结点
- **两个协议确实不一样**：Anthropic 把图片放进**同一个** `tool_result` 的 content 块数组；Chat Completions 的 `role:'tool'` 只能是字符串，所以图片**作为紧接着的下一条 user 消息**发出，而**文档只给引用**并在请求里写明原因
- **`?` 换成了 `number | null`**：日志 schema 用 `.optional()` 会推出 `undefined`，与 `exactOptionalPropertyTypes` 下的内核类型不等（`schema.ts` 早有注释记着这条）。ADR-057 字面写的 `width?`，实现按日志的既有口径改成 `null`，已写进 `06-frontend.md`

**T4（CLI 入口，#59 已合）一句话**：一个 `bin`、六个动词、三个出口码（`0` 做到 / `2` 命令写错 / `1` 这个构建做不到）；`serve` 与 `doctor` 可用，其余四个在表里说明缺什么。

**T4 的结论**：子命令表是数据（`src/cli/spec.ts`，六个动词，一个 `bin`），帮助文本与参数校验都从表生成；**56 项测试全绿**（【本机测试】Windows / Node 26.12.0）。三条契约：

- **三个出口码**：`0` 做到了、`2` 命令写错了、`1` 这个构建做不到。参数校验**先于**「是否接线」判断，所以 `cowcat run`（没带 prompt）报缺参数而不是缺组合根
- **未接线的动词留在表里并说明缺什么**（`status: 'blocked'` 是类型上的一支，没有处理函数可被误调），帮助文本照实标注
- `serve` 的处理函数动态 `import` 协议：`--help`/`doctor` 不需要那段模块图，T7 的 TUI 动词会把渲染器拉进来

**T4a 要解决的两件事（都已查清，不是猜）**：

1. **包结构**（A/B/C 见 `dev-plan-v2.md` 的「包结构待定」）：宿主必须用内核 `Session`，于是要跨包依赖 `packages/cowcat`；但仓库没有 npm workspace、cowcat 是 private 未发布 → 只能 `file:../cowcat`，且 CI 里要先构建内核。**这是 T4a 的第一个决定**。
2. **组合根本身**：v2 配置里**没有 model/provider 段**、**没有预设目录**（v1 的 209 家 catalog 在 `agent/assets/`）、`openAIModel`/`anthropicModel` **没从公共 API 导出**。所以需要：一条模型/供应商配置的 ADR + 预设来源 + 导出模型工厂 + 七个工具 + 策略 + 审批桥。

**T2 的结论**：方法表 + 类型（zod 解码边界）+ 内存传输 + 契约测试 + `attachment.read` 全部落地在 `packages/tui/src/protocol/`，**27 项协议测试全绿**（【本机测试】Windows / Node 26.12.0）。两条决定值得记住，它们都是契约：

- **params 严格、事件体宽松**：客户端发来的 params 用 `strictObject`（多一个字段就是 `invalidParams`——服务端不能对看不懂的请求动作）；服务端发出的事件**只校验信封**（`seq`/`ts`/`sessionId`/`turnId`/`type`）。后者是故意的：事件体是内核的联合类型，在协议里再描述一遍就是第二份 `adapters/schema.ts`，而且内核做**加法**改动（`tool.finished` 已长过 `truncation`/`path`，T5 还要长 `attachments`）时会把前端打死。代价写在明处：不认识的事件走「显示为不支持」，不崩。
- **协议层既不 import 内核、也不 import opentui**（lint 强制）：前者是 ADR-059 ③，后者让这个模块将来能整体挪进独立包（`serve` 与 IDE 插件都不该需要渲染器）。ADR-059 ③ 要求的「lint 探针证明规则真的会报错」按计划在 T10 复核。

**T1（已合入 main 的 #56）一句话结论**：opentui 在 Node 26.12.0 / Windows x64 上装得上、跑得起来，ADR-056 的兜底不触发；取证见 §1 的「已验证 —— P6 T1」。本机 Node 26 是**便携版** `C:\Users\Con_WKK\AppData\Local\node-v26.12.0\node-v26.12.0-win-x64`（系统 `node` 仍是 24，未改 PATH）。

之后按 T4 → T4a → T5–T10 推进（T4 CLI → T4a 组合根与包结构 → T5 附件契约 → T6 `Read` 恢复非文本分支 → T7 前端骨架 → T8 组件 → T9 图片渲染 → T10 收口）。

**P5 交给 P6 的接线点**（都已就位，只差组合根）：

| 组合根要做的 | 现成的入口 |
|---|---|
| 建七个工具 | `createReadTool` / `createWriteTool` / `createEditTool` / `createGlobTool` / `createGrepTool` / `createBashTool` / `createTodoWriteTool` |
| 解析沙箱 profile | `resolveSandboxProfile(config.sandbox, { cwd, home, fs })` |
| 给 Bash 注入网关 | `new NodeProcess({ platform, sandboxCommand: createSandboxExecutor({ platform, fsProbe }) })` |
| 注入 shell 事实 | `PlatformPort.resolveShell()` → `SessionDeps.shell` |
| 审批与前端 | `TurnDeps.approve`；`Session.subscribe` 订阅 `KernelEvent` + `StreamDelta` |
| 默认规则里加「TodoWrite 免问」 | ADR-054 明确把这留给组合根（库的 `DEFAULT_RULES` 刻意只有一条，ADR-034） |

---

## 4. 关键决策

### P5（ADR-047~054，全部已实现）

| ADR | 内容 |
|---|---|
| 047 | 工具住 `adapters/tools/`（不给 lint 开第二个例外）；wire JSON Schema 由 zod 机械派生、剥 `$schema`；工具 schema 禁用联合/nullable/`record`/`literal` |
| 048 | 截断是结构化事实，随 `tool.finished` 进日志（`null` = 未上报） |
| 049 | `tool.finished` 带 canonical `path`，「先读后改」由日志派生；**闸门落在 `runTurn`**（工具看不到会话状态） |
| 050 | Glob/Grep 保持纯 JS，但尊重 `.gitignore` 子集并上报不支持项；`files_with_matches`/`count` 达上限即停 |
| 051 | `ToolPort.run` 增只描述「本次授予」的第三参数；**不得把 `ask` 静默当 `off`**（由 Bash 兑现） |
| 052 | 入参校验在工具内，用同一份 zod schema，失败给字段路径 |
| 053 | `Truncation.dropped` 可为 `null`：早退之后总量未知（`0` 只表示「问过、确实没丢」） |
| 054 | TodoWrite 的状态进会话日志（`todo.updated` 事件 + `reduce` 派生），工具不持有状态；`todo.updated` 写在 `tool.finished` **之前** |

### P6（ADR-055~060，已落表、**未实现**）

| ADR | 内容 |
|---|---|
| 055 | headless 协议 = JSON-RPC 2.0 over stdio；`initialize` 版本不匹配就报错退出；**协议与传输分离**；不做 HTTP/SSE/WebSocket |
| 056 | **前端采纳 `@opentui/core`，且前端是独立 workspace 包**（自己的 `engines.node >=26.4.0` + Node 26 CI 腿），内核包保持 Node ≥ 22；原生二进制缺失时**显式报错**；先用命令式 renderable |
| 057 | **附件通路进契约**：`ToolResult.attachments` → `tool.finished.attachments`（进日志）→ `Message` 引用 → `ModelRequest` 内容部件 → 协议 `attachment.read(id)`；**字节不进日志** |
| 058 | 图像渲染：`ImageRenderable` + 三级回退（kitty 占位符 / iTerm2 屏幕坐标 / 半块文本）；能力探测含 `a=q`，**必须 `q=2` 静默** |
| 059 | 无终端测试：协议契约测试 + 帧快照 + lint 禁前端 import 内核（出口标准第 2 条） |
| 060 | CLI 子命令表是数据，六个动词，不做嵌套 |

完整表见 [`architecture/README.md`](architecture/README.md)（**ADR-001~060**）。契约文档：[`architecture/06-frontend.md`](architecture/06-frontend.md)（P6 新增）。

---

## 5. 踩坑（本会话真花时间的）

1. **提交时忘了切分支**：T5 的全部实现是在 `main` 上写完的，`pre-commit` 钩子直接拦下（「main 只接受 PR」）——**守卫按设计工作**，改到 `feat/p5-t5-bash` 重提即可。教训：大改之前先看一眼 `git status -sb`。
2. **本机 shell 是 PowerShell，不是 `AGENTS.md` 写的 Git Bash**：`cmd || echo`、`node -e "…'…'…"` 这类写法直接 `ParserError`。要拆成单条命令，或**写脚本文件**（`node -e` 里套引号在 PowerShell 下必坏，与 `AGENTS.md` 的记载一致）。
3. **`edit` 工具的 `oldString` 结尾带换行 = 要删掉那个换行**：本会话**两次**把两行并成一行（一次把 `| policy.decided | … }` 与下一个 `| {` 粘在一起），都是这个原因。改完要读回来确认——Markdown 与 TS 都可能「看着正常」。
4. **`assert.equal` 会窄化类型，于是后续的 `?.` / `??` 被 lint 判为多余**（`no-unnecessary-condition`）：`assert.equal(result?.ok, false)` 之后再写 `result?.output ?? ''` 会报错。解法是先取局部变量 + `assert.ok(x !== undefined)`，或用类型谓词过滤。
5. **给真实进程的 `env` 不能伪造**：Bash 的真实进程用例一开始传了 `{ PATH: '/usr/bin' }`，在 Windows 上 Git Bash 起不来（缺 `SystemRoot`/`ComSpec`），表现为 `ok: false` 而**不是**报错。真实进程用例应当**不传 `env`**，让它继承本进程环境。
6. **PowerShell 的 `rg` 输出会把中文显示成乱码**（编码问题，不是文件坏了）：要确认文件内容用 `read` 工具或 `node -e`。
7. **冷 I/O 又一次伪装成性能差异**：同一脚本 Grep 首跑 22ms、次跑 10ms；帧构建甚至**首跑比热跑更快**（0.39ms vs 0.68ms）。**计时不作断言**（与 `research/p5-tools.md` §1 的教训同源）。
8. **`websearch` 工具返回 HTTP 402**（额度）：改用 `webfetch` 直接抓 GitHub API / raw 文件与官方文档（kitty、iTerm2、nodejs.org）——这条路在本会话是可靠的。
9. **PowerShell 的控制台码页会把 UTF-8 的框线字符打坏，看起来像渲染错了**：T1 的 `captureCharFrame()` 走管道时 `┐` / `│` 变成 `\uFFFD?`，**落盘成 UTF-8 再 `read` 就正常**（帧本身是对的）。判断「渲染对不对」不要看 PowerShell 的 stdout；`cmd | Select-String` 也一样会改写编码。
10. **`--experimental-ffi` 是版本相关的启动期错误，不是可选优化**：opentui 的 README 说 Node 需要它，26.12.0 实测不需要，而 Node 24 上写它直接 `bad option` 退出（见 §3 的 T1 结论）。任何「顺手加个 flag 更保险」的想法在这里都会把提示变成硬失败。

---

## 6. 未验证 / 待确认

### 本会话新增（**不要读成「不成立」**）

1. **opentui 两侧都已验证**：本机安装 + Windows 原生二进制 + 一帧渲染（见 §3），以及干净 runner 上的两条 Node 26 CI 腿（PR #56 全 pass）——T1 不再有未验证项。
2. **没有任何真实终端证据**：本会话 stdout 不是 TTY，`COLORTERM` / `TERM_PROGRAM` / `WT_SESSION` / `KITTY_WINDOW_ID` 全缺（探针实测）。因此**刷新率、闪烁、图片协议的实际渲染效果全部未测**，调研里相关结论都标了【推断】/【未验证】。
3. **octant 码位的字体覆盖**未验证（回退方案因此以半块为主）；**iTerm2 图片与滚动的交互**是【推断】（协议文档没有承诺跟随文本）。
4. **opentui 的 `<image protocol="auto">` 覆盖哪些协议**（kitty / iTerm2 / sixel）未验证。
5. **厂商侧对 wire JSON Schema 的接受度仍是零实测**（无凭据、无端点）；校准排在 P6 第一次真连端点。
6. **真实沙箱后端（bwrap / seatbelt）本机没跑过**：本机真实进程只有 `mode: 'off'`；`system` 档由 CI 的 macOS 腿与 P6 组合根覆盖。
7. **TodoWrite 在默认规则下每次调用都会被问一次**（ADR-054 记录在案）；P6 的组合根应加一条 `allow`，否则体感很差。
8. **Grep 早退的实际收益未测**（主张的是「有界的工作量」，不是本机上测得出的加速比）。
9. **协议与 CLI 都过了测试，但没有跑过一次真实内核的事件流**：`ProtocolHost` 至今只有 `refusingHost()`，六个动词里只有 `serve`/`doctor` 可用——其余四个的缺口写在表里。真实宿主 = T4a（并需先定包结构）。`attachment.read` 的**宿主实现**仍缺（= T4a），协议与 materialize 两侧都已就位。
10. **预设里没有「模型是否支持图片」的字段**：`ModelPreset` 只有 `toolCalls`/`efforts`，给不识图的模型发图片会 400，而契约拦不住。等目录（catalog）落地时按 `toolCalls: false` 的同一手法补（ADR-046 决策 ③）。

### 前序遗留、本会话**未复现**

1. **macOS flake**：`agent/test/chrome.test.mjs:47` 固定 `sleep(15)` 后断言光标序列，**会随机卡住任何 PR**（它真的卡过 #26）；因 `agent/` 树冻结，「算不算安全修复」的口径问了三轮未答。
2. **ADR-034 要不要挪到 033 之后**（ADR 表不严格单调；新 ADR 一律追加表末）。
3. **ADR-044 仍未收到显式认可**——P5 的 047/052 与 P6 的 055/058 都**引用**了它（「不发明策略」「不读不造」），但「被引用」不等于认可。
4. `agent/src/llm/presets.js:2` 指向的 `tools/distill-providers.mjs` **不在仓库里**（209 家 catalog「怎么更新」仍未定，ADR-037 已记）。
5. v1 的 `agent/` 套件（762 项）**本会话未跑**；`tools/lint-probe.mjs` 的前序记录是 7/7，本会话复跑通过（探针条数以脚本自身输出为准）。

### 证据与记忆的差异（保留差异，不覆盖）

| 项 | 上一版 HANDOFF 的说法 | 本会话的证据 | 处置 |
|---|---|---|---|
| `main` 的位置 | 上一版写「合并前 = `6373929`，本 PR 合并后即为新的 `main`」 | 【本机命令】`git log` → `main` = **`14bb122`**（#54） | 以证据为准；上一版写它时 P6 还没开始，属正常的时间差 |
| P5 的 PR 清单 | 上一版列 #43–#51（含「#51 T7」） | 【本机命令】`git log` → P5 的 PR 是 **#42–#51**，其中 #42 的**内容**属前序会话 | 以证据为准；本版已写明归属 |
| P6 的范围 | 上一版（以及调研初稿）说「图片渲染不在 P6 四项范围里」 | 用户 2026-10-19 裁定内联图片进 P6 → ADR-057 | 以裁定为准；调研正文保留原文并标注作废 |
| 「本机 shell 是 Git Bash」 | `AGENTS.md` 这么写 | 本会话实测是 **PowerShell**（POSIX 链式写法直接 `ParserError`） | **标为待确认**：不改 `AGENTS.md`（可能是 OpenCode 会话的差异），但按实测操作 |
| v1 最新发布版 | 前序会话【registry】核实 `0.15.0` | 本会话**未复查** | 保留前序结论，标注「本会话未复查」 |

---

## 7. 关键文件

| 路径 | 内容 |
|---|---|
| [`dev-plan-v2.md`](dev-plan-v2.md) | **权威计划**。P5 段含交付记录与 v1 清单对照；**P6 段含 T0–T10 任务表** |
| [`architecture/README.md`](architecture/README.md) | **ADR-001~060**（047~054 是 P5，055~060 是 P6） |
| [`architecture/06-frontend.md`](architecture/06-frontend.md) | **P6 契约文档**（协议方法表、前端分层、附件通路、图像协议矩阵、测试形态、CLI） |
| [`research/p5-tools.md`](research/p5-tools.md) | P5 调研（前序会话产出）：八个问题、被否决方案、v1 工具全量归类、T0–T7 拆分 |
| [`research/p6-frontend.md`](research/p6-frontend.md) | P6 调研：五个问题、两处裁定的正文、图像协议矩阵、探针实测 |
| [`architecture/01-layers.md`](architecture/01-layers.md) | 分层；`adapters/tools/` 落点、遍历范围、Read 口径、Bash 薄壳、**P6 起多一个包** |
| [`architecture/02-kernel.md`](architecture/02-kernel.md) | 事件表（含 `todo.updated`）、`truncation`/`path`/`readFiles`、**闸门在 `runTurn`**、为什么工具串行 |
| [`architecture/03-policy-and-execution.md`](architecture/03-policy-and-execution.md) | 端口表、进程网关、沙箱执行器、沙箱配置键与 profile 解析、`ask` 的兑现 |
| [`architecture/04-dependencies.md`](architecture/04-dependencies.md) | 依赖策略；**`@opentui/core` 的准入与四项代价**（只在前端包，内核仍 3 / 6） |
| `packages/cowcat/src/adapters/tools/` | 七个工具 + `wire-schema.ts` / `define-tool.ts` / `ignore.ts` |
| `packages/cowcat/src/kernel/run-turn.ts` | 回合循环、`unreadTarget`（未读闸门）、`grant` 组合、`todo.updated` 写入点 |
| `packages/cowcat/src/policy/sandbox-profile.ts` | 配置 → `SandboxProfile` 的纯解析 |
| `packages/cowcat/test/tools-contract.test.ts` / `end-to-end.test.ts` | 七工具统一契约与端到端回合 |
| `tools/p5-json-schema-probe.mjs` / `tools/p5-glob-grep-probe.mjs` / `tools/p6-tui-probe.mjs` | 三个开发期探针（不进 lint 门禁、不进发布包） |
| `tools/lint-probe.mjs` / `tools/check-tarball.mjs` | 分层禁令探针 / 发布白名单守卫（CI 会跑） |
