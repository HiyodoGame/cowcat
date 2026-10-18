# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾（或按用户要求做会话收尾）重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-19（会话收尾：P5 完成 + P6 开工）**；**同日追加：T1 前提验证（#56）、T2 协议（#57）、T3 `serve`（#58）、T4 CLI 入口（#59）、T5 附件契约（#60）、T6 `Read` 非文本分支（#61）、T4a 1/3 协议独立成包（#62）全部已合；T4a 2/3 前半（ADR-063 + 内置表）在分支 `feat/p6-t4a-host` 上，尚未开 PR**——都不是阶段收尾，**组合根（`host/`）与 `packages/cli` 仍在 T4a 的 2/3 后半与 3/3**（见 §3）。
> 交接时仓库状态：**`main` = `89354a6`**（#62 T4a 1/3 合入）；当前分支 `feat/p6-t4a-host`（3 个提交，工作区干净，**无 PR**）。
>
> **证据分级**（沿用前几轮，逐条标注）：**【源码】**读代码/读装机类型；**【构建】**`tsc` 通过；**【本机测试】**Windows + Node 24.18.0 跑 `node:test`（跑在 `dist/` 编译产物上）；**【本机命令】**本机跑的其他命令（`git`、`npm view`、探针脚本）；**【CI 远端】**GitHub Actions 的运行结果（**只观察状态，未在本地复现**）；**【上游】**厂商文档或开源仓库源码（**不是本仓库源码**）；**【registry】**npm registry 查询；**【推断】**未实测的推论，不得作为决策依据。
> **本会话没有真机沙箱、没有模型端点、没有发布动作、没有真实终端**：本机真实进程只跑 `mode: 'off'`；stdout 不是 TTY；厂商对 wire JSON Schema 的接受度仍为零实测。

---

## 1. 本次会话实际做了什么

### 先说归属（避免把别人的工作记到本会话）

**PR #42 的内容是前序会话的产出**：`docs/research/p5-tools.md`（567 行调研）、ADR-047~052 落表、P5 拆成 T0–T7，都躺在一个**未推送**的分支 `docs/p5-adr` 上（前序会话的提交 `ea5813f`、`9aac9ef`）。本会话对它只做了三件事：改掉 `README.md` 那行过期的 v2 状态、`git push -u`、以**非草稿** PR 合并。**不要把它记成本会话的调研工作。**

同理：`e33b654`（#41 P4 T6c）及更早的提交都是前序会话的。

### 本次会话（2026-10-19）实际做了什么

**7 个已合并 PR + 1 个未开 PR 的分支**（全部由本次会话产出；#55 及更早的归属见上一版记录）：

| PR | 内容 |
|---|---|
| #56 | P6 **T1 前提验证**（opentui 可用、两条 Node 26 CI 腿，并进了分支保护） |
| #57 | P6 **T2 协议**（方法表 + zod 解码边界 + 内存传输 + 27 项契约测试） |
| #58 | P6 **T3 `serve`**（stdio 传输 + 生命周期 + 3 条真实 spawn 测试） |
| #59 | P6 **T4 CLI 入口**（表是数据 + 三个出口码 + `doctor` 最小版） |
| #60 | P6 **T5 附件契约**（引用进日志、字节按需 materialize、两协议各自映射） |
| #61 | P6 **T6 `Read` 非文本分支**（图像/PDF 附件、notebook 渲染） |
| #62 | P6 **T4a 1/3**（ADR-062：协议独立成 `packages/protocol` + CI 腿） |
| — | 分支 `feat/p6-t4a-host`：**T4a 2/3 前半**（ADR-063 配置与内置预设，3 个提交，**无 PR**） |

另外两次非功能性改动：修回被 PowerShell 写坏的 `ci.yml`（`·`→`路`，见 §5 第 11 条）、把两个 macOS flake 记进 §6 的前序遗留（`chrome.test.mjs:47`、`toast.test.mjs:34`）。

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

### 已验证 —— P6 T6（内核包，Windows，Node **v26.12.0**）

- 【本机测试】`cd packages/cowcat && npm test` → **571 tests / 555 pass / 0 fail / 16 skipped**（新增 7 项：四种图片格式的尺寸、PDF 页数（含数不出来时记 `null`）、软限拒绝与 `allow_large`、不支持的格式点名、notebook 渲染（含图片 output 只报大小）、notebook 截断上报、坏 notebook 是普通失败）
- 【源码】v1 的两个纯函数模块被**移植**而非重写：`imageinfo.js` → `adapters/imageinfo.ts`（去掉 token 估算：v2 记录真实用量）、`notebook.js` 的**读一半** → `adapters/notebook.ts`（编辑那一半属于还没建的 NotebookEdit）
- 【源码】`Read` 的工具描述重写了——它此前写着「images/PDF/notebooks 都拒绝、计划在 P7」，而那是模型读到的文字
- 【源码】名字与内容不符时**拒绝**（魔数优先），不把这种字节当文本递给模型

### 已验证 —— P6 T4a 1/3（协议独立成包；Windows，Node **v26.12.0**）

- 【本机测试】`packages/protocol` → **42 tests / 42 pass**（就是原来那批协议测试，路径换了）；`packages/tui` → **14 tests / 14 pass**（渲染 2 + CLI 9 + spawn 3）；`packages/cowcat` 仍 **571**
- 【本机命令】`file:` 依赖的实测：`npm install` 建的是 **junction**，**不装目标的依赖、也不构建它**（0.6 s / +1 个包），而 tui 侧 `import('@corescense/cowcat-protocol')` 立刻可用——**只因为 protocol 的 `dist/` 已构建**。所以消费者的 CI 腿必须自己 `npm --prefix ../protocol ci && run build`（已加进两条 tui 腿）
- 【源码】tui 的 eslint 里那条「协议不许 import opentui/内核」的规则**跟着包走了**（`packages/protocol/eslint.config.js`），tui 侧换成反向的一条：`src/cli/**` 不许 import 内核（组合根 2/3 会把宿主注入进来）
- 【本机命令】**踩到 AGENTS.md 记过的坑**：`git mv` 之后 `packages/tui/dist/test/protocol/` 还留着旧编译产物，`npm test` 跑出 59 项（多出 42 项不该在的测试）。删掉 `dist/` 重跑才是 14 项——**删源文件必须清 `dist/`**

### 已验证 —— P6 T4a 2/3 前半（模型/供应商配置与内置预设；Windows，Node **v26.12.0**）

- 【本机测试】`cd packages/cowcat && npm test` → **583 tests / 567 pass / 0 fail / 16 skipped**（新增 12 项：解码与严格性、分层合并、not-configured、内置/自定义预设、unknown-provider、协议不一致的告警、缺 key，以及「端点真的被用上」——注入 transport 断言请求 URL 与 model 字段）
- 【源码】`policy/config.ts` 的 `model` 段 + `adapters/config.ts` 的严格解码 + `host/presets.ts`（9 条预设 / 6 个供应商，数值取自 v1 蒸馏的 catalog）+ `host/model.ts`（`selectModel` 纯函数 / `createModelPort` 唯一读环境变量处）
- 【本机命令】分支 `feat/p6-t4a-host` 的三个提交：`884ad67`（ADR-063 + 配置与预设）、`9672ca3`（加 `zai/glm-5.3-flash`）、`26b3b99`（加 `bigmodel`）
- **没有跑过一次真实请求**：宿主未写，配置也没有被任何代码读取（见 §3）

### CI 远端【CI 远端】

本会话 13 个 PR **全部是非草稿 PR**，每次都跑：`packages/cowcat` 的 ubuntu / windows / macos-15 三条腿 + macOS 的 Seatbelt 腿 + `check-tarball` + `scope` —— **全部 pass**（用 `gh pr checks` 逐次观察）。**未在本地复现 ubuntu / macOS 的结果**，macOS 侧（含 Seatbelt）只由 CI 覆盖。

### 项目状态

- `main` = **`89354a6`**（#62 T4a 1/3 合入）；**P5 完成（T0–T7 全部落地，七个核心工具已交付）**；**P6：T0 落表、T1~T6 落地、T4a 1/3 落地；T4a 2/3 前半在分支 `feat/p6-t4a-host`（无 PR），宿主与 `packages/cli` 未写**
- `packages/protocol`（`@corescense/cowcat-protocol`，private，Node ≥22）已独立成包；`packages/tui` 通过 `file:../protocol` 依赖它（**`file:` 是 junction：npm 既不装目标的依赖也不构建它**，消费者那条腿要自己 `npm --prefix ../protocol ci && run build`）
- `packages/cowcat` 仍是 `private: true` 的 `0.0.0`，**从未发布**；`schemaVersion` 仍是 **1**（ADR-019）
- 运行时依赖 **3 / 6**（`zod`、`openai`、`@anthropic-ai/sdk`）——**内核包本会话仍未增删**；`packages/tui/` 两个运行时依赖：`@opentui/core@0.6.6`（T1 装）与 `zod`（T2 的解码边界），都不进内核的依赖计数
- 【registry】npm 上 v1 的最新版仍是 **`0.15.0`**——这是**前序会话**核实的结论，**本会话未复查**
- **平台 / 工作区设置本会话未变更**：未调用 `opencode_console` 的任何写操作。若需确认工作区设置与模型开关，**请单独核对**，不要以本文件为据
- 本会话的工具使用：只读检索（GitHub API / raw、kitty 与 iTerm2 官方文档、`nodejs.org` 版本索引）；`websearch` **失败（HTTP 402）**，改用 `webfetch`

---

## 3. 项目唯一下一步

**P6 的 T4a 2/3 前半已完成（分支 `feat/p6-t4a-host`，无 PR）；下一步是把它写完并开 PR**，内容是四件（顺序即依赖顺序）：

1. **`host/config.ts`**：读三层配置——用户 `~/.cowcat/config.json` → 项目 `<cwd>/cowcat.json` → 会话 `--config <path>`（**用户已确认这个约定**）。缺文件=该层不说话（ADR-025 决定 1）；存在但读不了=拒绝（ADR-025 决定 5）。
2. **`host/host.ts`**：真实 `ProtocolHost`——会话生命周期（`JsonlEventStore`/`FileLockPort`/`FileSnapshotPort` + `platform.resolveShell()`）、回合（`runTurn` + 每会话一个 `AbortController`）、**审批桥**、`attachment.read`（**`id` 就是日志里那条附件的 `path`，且只服务本会话日志记录过的路径**）、`ModelConfigError` → 协议可读拒绝。
3. **`run-turn.ts` 的 `TurnOutcome` 加 `turnId`**：`turn.send` 要在回合还在跑时就回答 turnId（这一轮我加过又撤了——见 §5）。
4. **`tools/glm-smoke.mjs`**：一条**真请求**探针（用户已配好 `ZHIPU_API_KEY`，是 BigModel Coding Plan，走 Anthropic 协议 `https://open.bigmodel.cn/api/anthropic`）。他的配置将是 `{"model": {"preset": "bigmodel/glm-5.3-flash"}}`。

**写第一版宿主时踩到的三个设计点（都还没落码，记在这里免得重走）**：

- **审批桥的 callId 只能从日志取**：`approval.requested` 事件带 `callId`，而 `TurnDeps.approve(request, decision)` 的 `ActionRequest` 不带 id。所以宿主订阅 `approval.requested` 记下 pendingCallId，`approve` 存 resolver，`respondApproval` 按 callId 匹配。
- **`turn.send` 的 turnId 要早拿**：`runTurn` 内部才 `openTurn`，所以要在**订阅 `turn.opened` 事件**上等（日志即真相），而不是轮询 `session.turnId`。
- **`attach` 的不丢不重**：必须**先订阅再 `readAll`**，再按 `seq` 丢掉重放里已有的更新（`events.length` 就是 lastSeq）。先读后订阅会留一个客户端无法察觉的缝隙。

3/3 仍是 `packages/cli`（`bin` + 子命令表 + `doctor` 搬过去，动态 import 取 serve 与 tui）。

**T4a 1/3 的结论**（ADR-062 = 选项 A′）：协议搬进 `packages/protocol`（Node ≥22、无 opentui、无内核，42 项测试跟着走），tui 通过 `file:../protocol` 依赖它（**14 项测试**），CI 加一条 protocol 腿 + 两条 tui 腿里各加一次「构建协议包」的步骤。三条实测值得记住：

- **`file:` 是链接，不是安装**：npm 既**不装**目标的依赖也**不构建**它（0.6 s / +1 个包），消费者必须自己 `npm --prefix ../protocol ci && run build`——这条已写进 CI 的注释
- **删源文件必须清 `dist/`**：`git mv` 后 `packages/tui/dist/test/protocol/` 的旧产物把测试数从 14 顶到 59（AGENTS.md 早写过这条，这次真踩了）
- 协议那条 lint 规则**跟着包走了**（`packages/protocol/eslint.config.js`），tui 侧换成反向的一条：`src/cli/**` 不许 import 内核

**T6（#61 已合）一句话**：`Read` 真的读图像/PDF/notebook——图片与 PDF 走附件（一行头 + 引用，带尺寸/页数），notebook 渲染成文本且**不挂附件**（图片 output 活在 JSON 里）；名字与内容不符时拒绝。

**T6 的结论**：`Read` 现在真的读图像 / PDF / notebook（**571 项测试全绿**，【本机测试】Windows / Node 26.12.0，新增 7 项）。四条值得记住的：

- **附件是引用**：图片/PDF 的返回是一行头 + 附件，结果里没有字节；`width`/`height`（图片）与页数（PDF，尽力而为，数不出来记 `null`）
- **notebook 渲染成文本、不挂附件**：图片 output 活在 JSON 里，没有文件可引用——只报大小并明说「不附」
- **名字与内容不符时拒绝**（魔数优先）：不把这种字节当文本递给模型
- **两处刻意缺口**：没有移植 v1 的 `pdftext.js`（代价：非 Anthropic 端点上 PDF 只作为引用到达模型）；不按模型能力 gate（预设还没有 vision 字段）

**T5（#60 已合）一句话**：`Attachment` 引用进日志、字节在序列化请求时 materialize；Anthropic 把图片放进同一个 `tool_result`，Chat Completions 把图片作为紧接着的下一条 user 消息、文档只给引用。**564 项测试**（新增 9 项）里最值钱的两条：**「字节不进日志」是真查字节**（挂上带 marker 的文件再读 `.jsonl` 原文，断言内容与它的 base64 都不在）；**拿不到字节时拒绝而不是省略**（模型被告知有图却没拿到，会当成「图里什么都没说」照常回答）。

**T4（#59 已合）一句话**：一个 `bin`、六个动词、三个出口码（`0` 做到 / `2` 命令写错 / `1` 这个构建做不到）；参数校验先于「是否接线」，`serve` 与 `doctor` 可用，其余四个在表里说明缺什么。

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
11. **PowerShell 重写仓库文件会静默改写字符**（本次最贵的一课）：为改 YAML 里一处引号，我跑了一次 `Get-Content -Raw | Set-Content`，PowerShell 5.1 按 GBK 解 UTF-8 字节，把 `ci.yml` 里所有 `·`（U+00B7，字节 `C2 B7`）写成 `路`（U+8DEF）。**它不报错、YAML 也能解析、`git diff --check` 也干净**——但 job 名与 required contexts 不再逐字相同，PR #62 的检查全 SUCCESS 却判 **BLOCKED**。修法是 `git checkout main -- <file>` 后用 `edit` 工具重做那几处改动，并用脚本按 codepoint 比对 job 名与 required contexts。**结论：改仓库文件一律用 `edit`/`write`，不用 shell 写文件。**
12. **`git mv` 之后必须清 `dist/`**：T4a 1/3 搬迁后 `packages/tui/dist/test/protocol/` 还留着旧编译产物，`npm test` 跑出 **59 项**（多 42 项不该在的测试），删掉 `dist/` 重跑才是 14。AGENTS.md 早写过这条，这次真踩了。
13. **`pre-commit` 钩子两次拦住我**：本会话在 `main` 上直接改完两批改动才发现没切分支（一次是 T5 时代的记录，一次是 T4a 2/3 这次）。钩子按设计工作（「main 只接受 PR」）——**大改之前先看一眼 `git branch --show-current`**。
14. **写宿主时我把草稿撤了，而不是硬提交**：第一版 `host/host.ts` 有三个设计点没定（审批桥的 callId 来源、`turn.send` 的 turnId 早期信号、`attach` 的先订阅后读），当时直接删掉文件并 revert 相关改动——**半成品留在树里比撤掉更糟**：它会让接手的人以为「配置好了却跑不起来」是环境问题。三个设计点的结论已记在 §3。

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
9. **协议、CLI 与工具都过了测试，但没有跑过一次真实内核的事件流**：`ProtocolHost` 至今只有 `refusingHost()`，六个动词里只有 `serve`/`doctor` 可用——其余四个的缺口写在表里。**真实宿主 = T4a 2/3**（包结构已定：ADR-062）；`attachment.read` 的宿主实现同样在 2/3，协议与 materialize 两侧都已就位。
10. **预设里没有「模型是否支持图片」的字段**：`ModelPreset` 只有 `toolCalls`/`efforts`，给不识图的模型发图片会 400，而契约拦不住（T6 因此**不按能力 gate**，一律产出附件）。等目录（catalog）落地时按 `toolCalls: false` 的同一手法补（ADR-046 决策 ③）。
11. **v1 的 `pdftext.js` 没有移植**：非 Anthropic 端点上 PDF 只会以**引用**到达模型（`06-frontend.md` 里写明了这条代价）。若实测显示不够用，它是一个独立任务。
12. **一次真实模型请求都没跑过**：`ZHIPU_API_KEY` 已由用户配好（BigModel Coding Plan，Anthropic 协议），但宿主未写、配置也无人读取，所以**「能不能真打一次」是零实测**。预设给 `max_tokens` 填的是 catalog 的 131072——若 Coding Plan 上限更低，第一次请求会以 400 拒绝并说明上限，届时改成控制台给的值。
13. **`bigmodel` 的端点是用户控制台给的**，不是 catalog（catalog 只记了 OpenAI 协议的 `zai` 路线）。它按「用户提供的权威值」入表，**没有独立核实**（比如用别的账号或文档复核）。
14. **`packages/protocol` 尚未进分支保护的 required 列表**：它按「非草稿 PR 必跑」上报（所以**可以**设为 required），但改仓库设置是用户的事。同理 `packages/tui` 那两条腿是本次会话加的（已设）。
15. **`packages/cowcat` 依赖 `@corescense/cowcat-protocol` 之后，它的 CI 腿需要先构建协议包**（`file:` 是链接，npm 不装也不构建目标）：T4a 2/3 收尾时必须给 `ci.yml` 的两条 cowcat 腿与 `ci-macos.yml` 的那条各加一步，否则三条腿会红。

### 前序遗留、本会话**未复现**

1. **macOS flake（两个，同一个病根：用真实时间等，然后断言时间相关的结果）**：
   - `agent/test/chrome.test.mjs:47` 固定 `sleep(15)` 后断言光标序列，**会随机卡住任何 PR**（它真的卡过 #26）。
   - `agent/test/toast.test.mjs:34` 用 `duration: 30` 的计时器 + `sleep(60)`，**30ms 余量**在被占满的 runner 上偶发超时。**PR #61 实测**：同一 commit 首次运行 `# fail 1`（762 项里就它），`gh run rerun --failed` 后通过。
   - 两者都在冻结的 `agent/` 树里。「算不算安全修复」的口径问了三轮未答——**只改测试的确定性修复**（注入假时钟 / 放大余量）需要用户点头，不由主 Agent 顺手带进 P6 的 PR。
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
