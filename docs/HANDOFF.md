# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-19**（P5 工具层收口：T0–T7 全部落地，七个核心工具已交付）
> 交接时仓库状态：本文件写在 `feat/p5-t7-closing` 分支上；**合并前的 `main` = `6373929`**（`#50` P5 T6 已合），本 PR 合并后即为新的 `main`。P5 的六个实现 PR 是 **#43（T1）、#44（T2）、#45（T3a）、#46（T3b）、#47（T3c）、#48（T4）、#49（T5）、#50（T6）**，加上收口的 **#51（T7）**。
>
> **证据分级**（沿用前几轮，逐条标注）：**【源码】**读代码；**【构建】**`tsc` 通过；**【本机测试】**Windows + Node 24.18.0 跑 `node:test`（跑在 `dist/` 编译产物上）；**【CI 远端】**GitHub Actions 的运行结果（**只观察状态，未在本地复现**）；**【上游】**厂商文档或官方 SDK；**【推断】**未实测的推论，不得作为决策依据。
> **本次会话没有真机沙箱、没有模型端点、没有发布动作**：本机真实进程只跑 `mode: 'off'`；厂商对 JSON Schema 的接受度仍为零实测。

---

## 1. P5 做了什么（T0–T7）

| 任务 | PR | 交付 | 测试 |
|---|---|---|---|
| T0 | #42 | P5 调研 + ADR-047~052 落表 + T0–T7 拆分（纯文档） | 436 |
| T1 | #43 | `ToolResult.truncation`、`tool.finished.truncation` + canonical `path`、`ToolPort.run` 第三参数 `grant`、`reduce` 派生 `readFiles` | 436 → 448 |
| T2 | #44 | `defineTool()` + `toWireSchema()`：wire schema 机械派生、剥 `$schema`、被禁词汇在**派生结果**上拒绝 | 448 → 458 |
| T3a | #45 | Glob + 遍历器：`.gitignore` 六种写法子集、三种不支持能力上报、100 上限 + 截断事实 | 458 → 470 |
| T3b | #46 | Grep：三模式、**默认模式早退**、上下文、超大/二进制计数；新增 **ADR-053**（早退时 `dropped: null`） | 470 → 485 |
| T3c | #47 | Read：文本分页、5MB/20MB、**CRLF 作为事实告知**、图像/PDF/notebook 显式拒绝并指向 P7 | 485 → 500 |
| T4 | #48 | Write + Edit；**「先读后改」闸门落在 `runTurn`**（工具看不到会话状态） | 500 → 517 |
| T5 | #49 | Bash 薄壳（argv 不经 shell）+ **`network: 'ask'` 由 Bash 兑现** + `CowcatConfig.sandbox` 与 `resolveSandboxProfile` | 517 → 537 |
| T6 | #50 | TodoWrite + `todo.updated` 事件（**ADR-054**：状态进日志，工具不持有状态） | 537 → 546 |
| T7 | #51 | 七工具统一契约测试、端到端回合、v1 清单对照记录、端口表收口 | 546 → 555 |

---

## 2. 当前状态

### 已验证 —— 【本机测试】/【构建】（Windows，Node 24.18.0）

- `cd packages/cowcat && npm test`（`pretest` = `tsc` + ESLint）→ **555 tests / 539 pass / 0 fail / 16 skipped**；构建与 lint 全绿
- 七个工具住 `src/adapters/tools/`：`read.ts` / `write.ts` / `edit.ts` / `glob.ts` / `grep.ts` / `bash.ts` / `todo.ts`
- **P5 出口标准两条都已兑现**：① 七工具统一契约测试（`test/tools-contract.test.ts`：规格完整、wire schema 无 `$schema`、非法与垃圾入参都是 `ok:false` 结果而非抛错、每个工具都上报 `truncation`）；Edit 边界用例（多处匹配、空匹配、CRLF）逐条覆盖；② v1 清单对照写进 `dev-plan-v2.md` 的「P5 交付记录」，**每个旧版 wire 名都有归属**，P5 范围内唯一被砍的是 Read 的三个非文本分支（阻塞点是 v2 契约没有附件通路）
- 端到端：`test/end-to-end.test.ts` —— 一个回合里读 → 改 → 待办 → 审批 → 跑命令 → **两种不同的截断事实**，并且重开会话后 `todos` / `readFiles` / 消息数与实时一致
- 本仓实测（T3a）：`walkFiles` 371 个文件 vs `rg --files` 367（调研 §5.5 第 1 项首次确认）
- **本轮未跑**：`tools/lint-probe.mjs`（前序 7/7）、v1 的 `agent/` 套件（762 项是前序记录）

### CI 远端【CI 远端】

P5 每个 PR 都是**非草稿** PR，三条 `packages/cowcat` 腿（ubuntu / windows / macos-15）+ macOS Seatbelt 腿 + `check-tarball` + scope **全部 pass**。**未在本地复现 ubuntu / macOS 的结果**。

### 项目状态

- `main` 合并前 = `6373929`；P5 完成。**P6 已开工**：调研与 T0 落表（ADR-055~060）已合，见 §3
- `packages/cowcat` 仍是 `private: true` 的 `0.0.0`，**从未发布**；`schemaVersion` 仍是 **1**（ADR-019）
- 运行时依赖 **3 / 6**（`zod`、`openai`、`@anthropic-ai/sdk`）——P5 **未增删任何依赖**
- **【registry】npm 上 v1 的真实最新版仍是 `0.15.0`**（`agent/package.json` 的 `0.16.0` 是未发布的本地版本号）

---

## 3. 项目唯一下一步

**P6 前端**（headless 协议与 TUI）：调研已完成、**T0 已落表（ADR-055~060）**，下一步是 **T1 前提验证**——`@opentui/core` 要求 `node >=26.4.0`（Node v26.4.0 已于 2026-06-24 发布，已核实），要确认 CI 能装该版本、且本机与 windows CI 腿能装上原生二进制；**装不上就地降级为「本机开发 + 手动验收」并把结论写回文档**。任务表见 [`dev-plan-v2.md`](dev-plan-v2.md) 的 `## P6` 段（T0–T10）。

> **两处评审裁定（2026-10-19）**：① TUI 渲染采纳 `@opentui/core`（ADR-056，代价是前端包 `node >=26.4.0` 与原生二进制，内核包保持 Node ≥ 22）；② **工具结果的内联图片进 P6**（ADR-057 把附件通路提前），因此 `Read` 的图像/PDF/notebook 三个分支由 P6 T5–T6 交付，不再属于 P7。

P5 交给 P6 的**具体接线点**（都已就位，只差组合根）：

| 组合根要做的 | 现成的入口 |
|---|---|
| 建七个工具 | `createReadTool` / `createWriteTool` / `createEditTool` / `createGlobTool` / `createGrepTool` / `createBashTool` / `createTodoWriteTool` |
| 解析沙箱 profile | `resolveSandboxProfile(config.sandbox, { cwd, home, fs })` |
| 给 Bash 注入网关 | `new NodeProcess({ platform, sandboxCommand: createSandboxExecutor({ platform, fsProbe }) })` |
| 注入 shell 事实 | `PlatformPort.resolveShell()` → `SessionDeps.shell` |
| 审批与前端 | `TurnDeps.approve`；`Session.subscribe` 订阅 `KernelEvent` + `StreamDelta` |
| 默认规则里加「TodoWrite 免问」 | ADR-054 明确把这留给组合根（库的 `DEFAULT_RULES` 刻意只有一条，ADR-034） |

---

## 4. 关键决策（P5：ADR-047~054）

| ADR | 内容 |
|---|---|
| 047 | 工具住 `adapters/tools/`（不给 lint 开第二个例外）；wire JSON Schema 由 zod 机械派生、剥 `$schema`；工具 schema 禁用联合/nullable/`record`/`literal` |
| 048 | 截断是结构化事实，随 `tool.finished` 进日志（`null` = 未上报） |
| 049 | `tool.finished` 带 canonical `path`，「先读后改」由日志派生 |
| 050 | Glob/Grep 保持纯 JS，但尊重 `.gitignore` 子集并上报不支持项；`files_with_matches`/`count` 达上限即停 |
| 051 | `ToolPort.run` 增只描述「本次授予」的第三参数；**不得把 `ask` 静默当 `off`** |
| 052 | 入参校验在工具内，用同一份 zod schema，失败给字段路径 |
| 053 | `Truncation.dropped` 可为 `null`：早退之后总量未知 |
| 054 | TodoWrite 的状态进会话日志（事件 + `reduce` 派生），工具不持有状态 |

完整表见 [`architecture/README.md`](architecture/README.md)（**ADR-001~054**）。

---

## 5. 踩坑（本次会话真花时间的）

1. **提交时忘了切分支**：T5 的实现全部在 `main` 上完成，`pre-commit` 钩子直接拦下（「main 只接受 PR」）——**守卫按设计工作**，改到 `feat/p5-t5-bash` 重提即可。教训：`git status -sb` 要在大改之前看一次。
2. **本会话的 shell 是 PowerShell，不是 AGENTS.md 写的 Git Bash**：`cmd || echo`、`node -e "…'…'…"` 这类写法直接 `ParserError`。要么拆成单条命令，要么写脚本文件（`node -e` 里套引号必坏，与 AGENTS.md 的记载一致）。
3. **`edit` 工具的 `oldString` 结尾带换行 = 要删掉那个换行**：本轮有两次把两行并成一行（`| policy.decided | … }    | {`），都是这个原因。改完要读回来确认——Markdown 与 TS 都可能仍然"看着正常"。
4. **`assert.equal` 会窄化类型，于是后续的 `?.` / `??` 被 lint 判为多余**：`assert.equal(result?.ok, false)` 之后再写 `result?.output ?? ''` 会报 `no-unnecessary-condition`。解法是先取局部变量 + `assert.ok(x !== undefined)`，或者用类型谓词过滤。
5. **给真实进程的 `env` 不能伪造**：Bash 的真实进程用例一开始传了 `{ PATH: '/usr/bin' }`，在 Windows 上 Git Bash 起不来（缺 `SystemRoot`/`ComSpec`），表现为 `ok: false` 而不是报错。真实进程用例应当**不传 `env`**，让它继承本进程环境。
6. **PowerShell 的 `rg` 输出会把中文显示成乱码**（编码问题，不是文件坏了）：要确认文件内容用 `read` 工具或 `node -e`，与 AGENTS.md 的记载一致。
7. **冷 I/O 又一次伪装成性能差异**：同一脚本 Grep 首跑 22ms、次跑 10ms。**计时不作断言**（调研 §1 的同一教训）。

---

## 6. 未验证 / 待确认

1. **厂商侧对 wire JSON Schema 的接受度：零实测**（无凭据、无端点）。ADR-047 决定的是机制；校准排在 P6 第一次真连端点。已知会触发的形状差异：`type` 数组、`anyOf`、`$defs`/`$ref`、`propertyNames`——全部是【推断】。
2. **真实沙箱后端未在本机跑过**：本机真实进程只有 `mode: 'off'`；`system` 档（bwrap / seatbelt）由 CI 的 macOS 腿与 P6 组合根覆盖。
3. **Grep 早退的实际收益未测**：本任务主张的是「有界的工作量」，不是一个在本树上测得出的加速比（冷/热 I/O 混淆）。
4. **TodoWrite 在默认规则下每次调用都会被问一次**（ADR-054 已记）。P6 的默认配置应加一条 `allow`，否则体感很差。
5. **`.gitignore` 子集的三条限制**（嵌套 / 全局 excludes / `.git/info/exclude`）在真实多模块仓库上的影响未评估；隐藏目录一律跳过，也没有「想搜 `.github`」的逃生口。
6. **Windows 上 Edit 的 CRLF 行为已有本机用例**，但**非 Windows 的 CRLF 文件**（例如从 Windows 拷到 Linux）未测。
7. **前序遗留未关闭**：macOS flake（`agent/test/chrome.test.mjs:47` 固定 `sleep(15)`）算不算安全修复问了三轮未答；`ADR-034` 是否挪到 033 之后；**ADR-044 仍未收到显式认可**（P5 的 047/052 都引用了它）。
8. **v1 套件（762 项）本轮未重跑**；本文件不引用其数字作为本轮证据。

---

## 7. 关键文件

| 路径 | 内容 |
|---|---|
| [`dev-plan-v2.md`](dev-plan-v2.md) | **权威计划**。P5 段含任务表、**出口标准与交付记录**、v1 清单对照 |
| [`architecture/README.md`](architecture/README.md) | **ADR-001~054**（047~054 是 P5 的决策） |
| [`research/p5-tools.md`](research/p5-tools.md) | P5 调研：八个问题、被否决方案、v1 工具全量归类（§13）、T0–T7 拆分（§14） |
| [`architecture/01-layers.md`](architecture/01-layers.md) | 分层；`adapters/tools/` 的落点理由、遍历范围、Read 口径、Bash 薄壳 |
| [`architecture/02-kernel.md`](architecture/02-kernel.md) | 事件表（含 `todo.updated`）、`truncation`/`path`/`readFiles`、**闸门在 `runTurn`**、为什么工具串行 |
| [`architecture/03-policy-and-execution.md`](architecture/03-policy-and-execution.md) | 端口表、进程网关、沙箱执行器、**沙箱配置键与 profile 解析**、`ask` 的兑现 |
| `packages/cowcat/src/adapters/tools/` | 七个工具 + `wire-schema.ts` / `define-tool.ts` / `ignore.ts` |
| `packages/cowcat/src/kernel/run-turn.ts` | 回合循环、`unreadTarget`（未读闸门）、`grant` 的组合、`todo.updated` 的写入点 |
| `packages/cowcat/src/policy/sandbox-profile.ts` | 配置 → `SandboxProfile` 的纯解析 |
| `packages/cowcat/test/tools-contract.test.ts` / `end-to-end.test.ts` | 统一契约与端到端回合 |
| `tools/p5-json-schema-probe.mjs` / `tools/p5-glob-grep-probe.mjs` | P5 的两个开发期探针（不进 lint 门禁、不进发布包） |
