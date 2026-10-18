# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-18**（P5 工具层：调研完成、ADR-047~052 评审通过并落表、把 P5 拆成 T0–T7；**T0 在未合分支上**）
> 交接时仓库状态：`main` = **`e33b654`**（`#41` P4 T6c 已合，**P4 五项范围全部落地**）；本轮工作在 **`docs/p5-adr`** 上：T0 = `ea5813f`、本交接 = `ffb16ad`，**均未推送、未合**
>
> **证据分级**（本文件只用这几档，逐条标注）：
> **【源码】**读代码 / 读装机类型（`node_modules` 里的 SDK 类型也算源码）；**【构建】**`tsc` 通过；**【本机测试】**Windows + Node 24.18.0 跑 `node:test`（跑在 `dist/` 编译产物上）；**【CI 远端】**GitHub Actions 的运行结果（**我只观察状态，未在本地复现**）；**【上游】**厂商文档或官方 SDK，未经端点实测；**【registry】**npm registry 的查询结果（本机命令，不是发布动作——**本档为本次新增**，因为「已发布哪个版本」既不是源码也不是厂商文档）。
> **本次会话没有真机、模拟器或生产证据**：没有对任何模型端点发起请求，没有发布动作，**没有推送任何提交**。

---

## 1. 本次会话实际做了什么

会话起点：`main` = **`e33b654`**（`#41` P4 T6c 已合），工作区干净。

会话开头收到一份**只读摸底报告**（由子 agent 产出并贴入本会话：结构地图、主流程、改动入口、10 条约定与陷阱）——**那是别人的产出，不是本次会话的工作**，本会话只对它的两条「不确定项」做了核实。

| 工作 | 产出 | 状态 |
|---|---|---|
| **核实两处不确定项**（摸底报告列的） | ① 【registry】`npm view @corescense/cowcat version` → **`0.15.0`**（`latest` 也是它）→ `README.md:15` 的「已发布 0.15.0」**是对的**，`agent/package.json:3` 的 `0.16.0` 是**未发布的本地版本号**；② 【源码】`git log` / `git branch -a` → **`#41` T6c 已在 `main`**（`e33b654`），工作区干净、与 `origin/main` 一致 | 已完成（本机命令，未写文件） |
| **P5 调研** | `docs/research/p5-tools.md`（**新增 567 行**）：八个调研问题的决定草案、逐条被否决方案、v1 **19 个工具文件 / 30 个 wire 名**的归类、T0–T7 任务拆分、ADR-047~052 的完整条目草案、证据边界写在文件头 | 在 `docs/p5-adr`，**未合** |
| **两次新增实测**（两个开发期脚本） | `tools/p5-json-schema-probe.mjs`（zod 4.6.7 → JSON Schema，**31/31**）、`tools/p5-glob-grep-probe.mjs`（3 棵树，**7/7** 结构性断言）——按 `AGENTS.md` 约定不进 lint 门禁、不进发布包 | 同上 |
| **T0 落表**（ADR 与计划） | ADR-047~052 追加进 `architecture/README.md` 的表（表尾、不打乱既有行）、状态行与调研索引同步；`dev-plan-v2.md` 的 P5 段补上任务拆分表（T0–T7）与评审前提 | 同上（提交 `ea5813f`，**5 files / +946 −3**） |

**本次会话没有改任何源码**：【源码】`git show --stat ea5813f` = `docs/architecture/README.md`、`docs/dev-plan-v2.md`、`docs/research/p5-tools.md`、两个 `tools/p5-*-probe.mjs`——**`packages/cowcat/src`、`packages/cowcat/test`、`agent/` 一行未动**。

**一次真实的返工（记下来）**：插入 ADR 行时，`edit` 的 `oldString` 以「`\n\n## 与旧文档的关系`」为锚、`newString` 以「`| ADR-047 | …`」开头，结果**少了那个换行**，ADR-047 被并进 ADR-046 那一行（该行管线从 4 条变 8 条）。被「逐行管线数 = 列数 + 1」的机械检查抓到并修正。**这类错误肉眼看不出来**，因为 Markdown 仍会把它渲染成一行。

### 前序会话留下的实测发现（保留，**不是**本次会话的产出）

1. 两家 SDK 都不把调用方的 signal 对象交给 `fetch`，而是各自桥接一层、且**桥接在请求结束时拆除**——所以「请求完成后看 signal 的 aborted」量的是拆除，不是取消。
2. Anthropic SDK 的 7 个依赖树成员只有 4 个真进运行时（`@opentelemetry/api`、`standardwebhooks`、`fast-sha256`、`@stablelib/base64`），3 个是纯类型层；`openai` 是零运行时依赖。
3. `APIError.status` 与 `.headers` 在两家 SDK 里都是 `any`，必须显式收窄。

---

## 2. 当前状态

### 已验证 —— 本机【本机测试】/【构建】（Windows，Node 24.18.0，`main` = `e33b654`）

- `cd packages/cowcat && npm test`（`pretest` = `tsc` 构建 + ESLint）→ **436 tests / 420 pass / 0 fail / 16 skipped**（10090.9ms）；构建与 lint 全绿
- 【本机测试】`node tools/p5-json-schema-probe.mjs` → **31/31 通过**（zod 4.6.7）
- 【本机测试】`node tools/p5-glob-grep-probe.mjs` → **7/7 结构性断言通过**（本仓 634 文件、`ClaudeCode_dev` 740 文件、`AIProjects` 414,839 条路径；**计时为测量值，不作断言**）
- 【本机测试】`node tools/check-tarball.mjs` → **passed**（`@corescense/cowcat@0.16.0`，109 files / 294,794 bytes；0.16.0 是**本地**版本号，见 §6）
- **本轮未跑、不要当成已验证**：`tools/lint-probe.mjs`（前序记录 7/7，本轮未复跑）、v1 的 `agent/` 套件（P4 记录的 762 项是别人的数据）、任何 Linux/macOS 上的东西

### CI 远端【CI 远端】

- **本次会话没有任何 CI 运行**：提交未推送。以下为**前序会话的记录**，原样保留：

| 对象 | 腿 | 结果 |
|---|---|---|
| PR #35（T7） | `packages/cowcat` ubuntu-latest / macos-15 / windows-latest | 全 pass |
| PR #36（docs） | 同上三条 | 全 pass |
| PR #37（T6a） | 同上三条 | 全 pass |
| `main` 的 push（#33 之后、#35 之后） | `CI` + `CI (macOS)` | success |

> **我未在本地复现 ubuntu / macOS 的结果**：macOS 侧（含 seatbelt）只由 CI 覆盖。

### 项目状态

- `main` = **`e33b654`**（`#41` P4 T6c 已合）→ **P4 五项范围全部落地**；`docs/p5-adr` = `ea5813f`（**未推送**、含 T0 与调研文档）
- **当前阶段是 P5 工具层**：调研完成、**ADR-047~052 已评审通过并落表**，T0 待合并，**T1 起未开工**
- `packages/cowcat` 仍是 `private: true` 的 `0.0.0`，**从未发布**；`schemaVersion` 仍是 **1**（ADR-019：v2 日志格式从未发布，契约变更不升版本）
- 运行时依赖 **3 / 6**（`zod`、`openai`、`@anthropic-ai/sdk`）——本次会话**未增删任何依赖**
- **【registry】npm 上的真实最新版 = `0.15.0`**（`latest` 同值）——前序交接把它列为缺口，**本次已核实**
- **平台 / 工作区设置本次会话未变更**：未调用 `opencode_console` 的任何写操作。本次只用了**只读**检索（Context7 的 zod 文档）；一次子 agent 调用因额度不足失败（见 §5）。若需确认工作区设置与模型开关，**请单独核对**，不要以本文件为据

### P5 的任务拆分与出口标准（**已进 `dev-plan-v2.md`，但 T0 未合**）

| 任务 | 内容（完整版见 `research/p5-tools.md` §14.2） | 依赖 | 状态 |
|---|---|---|---|
| T0 | 决定落表（ADR-047~052 + P5 任务表） | 六条已评审通过 | ✅ 本 PR（未合） |
| T1 | **契约与事件**：`ToolResult.truncation`、`tool.finished` 增 `truncation` + canonical `path`、`ToolPort.run` 增第三参数、`reduce` 派生「已读文件」集合 | T0 | 未开始 |
| T2 | 工具定义 API + wire schema 派生器（`toJSONSchema({io:'input',target})`、剥 `$schema`、被禁词汇执行点、`defineTool()`） | T0（可与 T1 并行） | 未开始 |
| T3a/T3b/T3c | Glob（`.gitignore` 语义子集）/ Grep（早退）/ Read（文本 + CRLF 事实） | T2 / T3a / T2 | 未开始 |
| T4 | Write + Edit（含出口标准点名的边界用例，消费日志派生的已读集合） | T1、T2、T3c | 未开始 |
| T5 | Bash 薄壳（经 `ProcessPort`；`run_in_background` 显式拒绝；消费第三参数） | T1、T2 | 未开始 |
| T6 | TodoWrite（**阻塞于「状态存哪」的小 ADR**） | T2 + 小 ADR | 未开始 |
| T7 | 出口标准与收口（七工具统一契约测试、v1 清单对照、端到端回合） | T3a–T6 | 未开始 |

### 前序会话的落地情况（P4，**保留**）

| # | 范围 | 状态 |
|---|---|---|
| 1 | `ModelPort` 适配器（OpenAI 兼容 + Anthropic） | ✅ T2/T3 已合 |
| 2 | 流式归一化 → `ModelChunk` | ✅ 含用量、结束原因与推理（T6a 契约 + T6b 适配器读写） |
| 3 | 重试与退避 | ✅ T5 已合 |
| 4 | 录制-回放夹具 | ✅ T4 已合（T7 加 `paired/final-text`；T6b 加合成钉板 `synthetic/thinking-precedes`） |
| 5 | 模型预设以数据形式存在 | ✅ T6a/b/c 全部落地 |

**P4 两条出口标准（ADR-043）均已兑现且已合入 `main`**：① 配对夹具过一次 `runTurn`，两个协议对**同一份写死的 golden**；② 两个协议各一条「流中途取消」端到端断言（状态 `cancelled`、零 `model.message`、**用量留痕**）。

---

## 3. 项目唯一下一步

**把 `docs/p5-adr` 推上去，并以「非草稿」PR 走完合并——这就是 T0 的交付。**

```bash
git push -u origin HEAD
gh pr create --fill
```

- **必须非草稿**：【源码】`ci.yml:17-18` 写着草稿 PR **不跑任何检查**，而非草稿 PR 会跑全部必需检查（v2 的 Linux + Windows、macOS 的 Seatbelt 腿、`check-tarball`）。纯文档改动预期全绿，但**先开成草稿会看到一个「没有检查」的 PR**，且不会自动补跑。
- 交接提交（本文件）若与 T0 在**同一 PR** 上，合并即一起进 `main`；要分开的话，把本文件那个提交单独开一支即可。

**T0 合并后的下一步是 T1**（契约与事件，形状已完全确定，不需要再决策）：

1. `ToolResult` 增 `truncation`；`tool.finished` 增 `truncation`（可空，`null` = 未上报）；
2. `tool.finished` 增 canonical `path`（可空），`reduce` 由它派生「本会话已读文件」集合（**恢复会话后闸门仍成立**是这条 ADR 的存在理由）；
3. `ToolPort.run` 增**第三参数**（只描述「本次授予」，例如 `{ networkApproved: boolean }`）；
4. 连带改 `adapters/schema.ts` 的解码边界、编译期等价断言、`state.ts`、`test/support.ts`；
5. **三处编译期硬失败是预期行为**（ADR-031/041 的先例），不是事故；**不动任何具体工具**（那是 T2 起）。

**顺序提醒**：T2 落地前不要写任何具体工具（契约先于实现）；T6 开不了工，直到「TodoWrite 的状态存哪」落成小 ADR；端到端收口在 T7。

---

## 4. 关键决策

### 本次会话新增（ADR-047~052，**已落表、未实现**）

| 决策 | 内容 | 出处 |
|---|---|---|
| **工具住哪 + zod 是唯一来源** | 核心工具住 **`src/adapters/tools/`**，**不给分层禁令开第二个例外**（`eslint.config.js:67-68`：`src/**/*.ts` 禁 `node:fs`/`child_process`，只放行四个既有目录；`FsPort` 只有四个方法、且它的职责是**路径身份**）；wire JSON Schema 由 `z.toJSONSchema({ io:'input', target })` **机械派生**、**剥 `$schema`**；工具 schema **编写约定禁用**联合/nullable、`record`、`literal`、`date` 一族（四种 target 产出形状不同，而**厂商接受度零实测**，所以定的是**机制**不是某个 target 值） | ADR-047 |
| **截断是结构化事实** | `ToolResult` 增 `truncation` 并随 `tool.finished` 进日志（可空，`null` = 未上报，与 `facts` 同形）；算术沿用 `ProcessPort`/`OutputTail` 的**唯一一份**；`output` 里的人可读尾注保留（两个读者、两种渲染） | ADR-048 |
| **「先读后改」闸门由日志派生** | `tool.finished` 增 canonical `path`；`reduce` 重建已读集合——内存集合会让**恢复会话后闸门静默失效**（旧版是 `agent/src/init.js:12` 的 `ctx.readSet`）；「重构不出来的事实必须进日志」与 ADR-033 同源 | ADR-049 |
| **Glob/Grep 保持纯 JS** | 但必须 ①尊重 `.gitignore`（六种模式；三条不支持且**必须上报**）②`files_with_matches`/`count` 达到 `head_limit` **即停**（旧版没有早退，而它恰好是默认模式）；**不引入 ripgrep**——它是外部可执行文件、须经 `ProcessPort` 并新增平台分支，且本机「92ms vs 11s」是**口径不同** | ADR-050 |
| **审批结果必须有载体** | `ToolPort.run` 增一个**只描述「本次授予」**的第三参数；`executor.ts:157` 早已向用户承诺 `network: 'ask'` 会「按已批准的命令授予」，而端口拿不到裁决——**不得把 `ask` 静默当 `off`** | ADR-051 |
| **入参校验在工具内** | 同一份 zod schema：`safeParse` 失败 → `ok: false` + **字段路径与原因**，成功则把解析结果交给实现；内核不新增校验分支（内核禁 import zod，ADR-009） | ADR-052 |

**同一次会话里的三处评审裁定（用户拍板，已并入文档正文）**：① ADR-049 取「由日志派生」（接受改事件形状）；② ADR-051 取「加第三参数」（降级备选作废，但「不得默默当 `off`」这条纪律不撤销）；③ 两个探针脚本**随调研 PR 留下**（后续不要搬进 `packages/`，那会让它们进 lint 门禁与发布包）。

### 前一会话的 12 条（P4，**保留**）

| 决策 | 内容 | 出处 |
|---|---|---|
| **契约要补三类信息** | `ModelRequest` 增 `model`/`system`/`maxTokens`/厂商扩展逃生口；`ModelChunk` 增 `usage` 与 `stop`；**结束原因归一但保留厂商原值** | ADR-035 |
| **协议只做两种** | OpenAI 兼容（Chat Completions，**不用 Responses**）+ Anthropic 原生；数据 201 / 8 | ADR-036 |
| **预设是数据，内核只认类型** | 形状沿用 `providers.json` | ADR-037 |
| **厂商扩展不猜默认值** | 只发预设声明过的档位 | ADR-038 |
| **重试在适配器内** | 默认 2 次、尊重 `Retry-After`、**取消涵盖退避等待**、**不重试已开始输出的流** | ADR-039 |
| **用量归一四项，合并而非覆盖** | Anthropic 的 `message_delta` 会省略可选键 | ADR-040 |
| **用量进日志，独立事件** | `model.usage`——取消时也留痕 | ADR-041 |
| **夹具录原始字节** | 注入 transport 使 CI 不访问网络；录制脚本不落请求头 | ADR-042 |
| **出口标准比对口径** | 一条 golden、两个协议、比已提交事实、配对夹具必须是同一逻辑回合的两种编码 | ADR-043 |
| **适配器不发明策略** | 契约没说的就拒绝或上报 | ADR-044 |
| **推理内容进契约** | 带不透明签名的**块序列**；块整块发出；位置不存（靠「thinking 恒前置」回放）；`ReasoningBlock` 是厂商块的封闭子集 | ADR-045 |
| **预设进内核** | `TurnDeps.preset` 单一事实源；`maxTokens ← limits.output`；`toolCalls:false` 不发 `tools` 并随 `TurnOutcome.notes` 上报 | ADR-046 |

完整表见 [`architecture/README.md`](architecture/README.md)（**ADR-001~052**；047~052 已落表，实现分 T1–T7）。

---

## 5. 踩坑

### 本次会话真花时间的

1. **冷 I/O 会伪造出一个「性能问题」。** 同一棵树（`ClaudeCode_dev`，740 文件）Grep 首轮测得 **19.3s**，紧接着同一份代码只花 **135ms**；独立脚本 warm 读完全部 740 个文件（10.1MB）只要 **52ms**，无单文件超过 50ms。**那 19.3s 不可复现**，判定为冷启动（Defender / 冷 NTFS 元数据）。教训已写进探针：**每个文件系统用例跑两遍（first touch / warm）**——只跑一遍会把结论钉成反面。
2. **`zod` 有两处与直觉相反，且探针首轮 3 条断言 FAIL 是「预期错了」而不是「代码错了」**：① `reused` 默认是 `inline`（不是 `$defs`/`$ref`，只有递归才用 `$ref` 断环）；② 联合与 nullable 在默认 target 下产出的是 **`type` 数组**（`["string","number"]`），不是 `anyOf`（`target: 'openapi-3.0'` 才是 `anyOf` + `nullable`）。**按实测改正预期**，并把实测值写成断言（zod 升级若改形状会立刻红）。
3. **`io: 'input'` 与对象闭合是对立的**：input 模式**不产出** `additionalProperties`，但让带 `.default()` 的字段正确地变成可省；output 模式产出 `additionalProperties: false`，却把带默认值的字段算作必填。两种模式各丢一样，答案只能靠实测（写进 ADR-047）。
4. **PowerShell 对中文密集 UTF-8 的行号/行数不可靠**（`AGENTS.md` 记过，这次再次命中）：`Get-Content` 数出 **398 行**，`node` 数出 **565 行**；`Select-String` 给的选择管线行号也整体错位。**要准确行号/行数用 `node` 或 `read` 工具。**
5. **`node -e` 里套反引号在 PowerShell 下必坏**（报 `SyntaxError`）：同一条命令改成写脚本文件再跑即可。**不要试第二次**——与 `AGENTS.md` 的记载一致。
6. **插入表格行时缺一个换行，会把两行并成一行**（§1 已记）：`edit` 的锚点若含 `\n\n`，`newString` 必须以换行开头，否则新行会接在上一条记录的末尾。这种错误 Markdown **不会报错**，只能靠「逐行管线数」这类机械检查发现。
7. **子 agent 额度会硬失败**：本次想用子 agent 通读 v1 的 19 个工具文件，返回「您已达到每周/每月使用上限，您的限额将在 2026-10-18 17:23:24 重置」。**改为主会话逐个精读 `文件:行号`**——结论不受影响，只是更慢。

### 前序会话的（**未复现**，按记录保留）

8. **GitHub 会直接关闭「base 分支被删」的 PR，且无法重开**（#34 → 重开为 #35）；合并后要核对 PR 状态，不要假定它转到了 `main`。
9. **PowerShell 5.1 把子进程写到 stderr 的正常输出当失败**：`git push` / `gh` 经 `2>&1 | Select-Object` 后 exit code 是 1，命令其实成功。**看输出内容，不要只看退出码**。
10. **`gh ... --jq '… > …'` 里的 `>` 会被 PowerShell 当重定向**；**`Out-File -Encoding utf8` 落盘的中文 JSON 会被 node 读成非法 JSON**（可靠做法：node 的 `execFileSync` 直接抓输出写文件，再用 `read` 工具读）。
11. `process.moduleLoadList` 不跟踪 ESM，在「哪些传递依赖真进运行时」上**假阴性**；`execFileSync` 包一层时子进程会挂住（`spawnSync ETIMEDOUT`），直接跑同一脚本正常——**根因至今未查明**。
12. **`edit` 工具的 `oldString` 结尾带 `\n` 等于要删掉那个换行**（改完要读回来确认）；`tools/` 在仓库根，在 `packages/cowcat` 里跑 `node tools/...` 会报「找不到模块」。
13. `APIError.status`/`.headers` 是 `any` → `no-unsafe-argument` 会拦，**显式收窄**；`Partial<T>` 上的 `x === null` 会被 `no-unnecessary-condition` 判为无重叠，但运行时 `null` 确实存在——用宽类型 + 运行时检查。
14. `gh pr merge --delete-branch` 会自己切分支并尝试 `git pull`；若有未提交改动它会 `Aborting`，于是**合并没走完而你以为是走完了**——合并后显式核对 `git log` 与 `git status`。

---

## 6. 未验证 / 待确认

### 本次会话新增（**不要读成「不成立」**）

1. **厂商侧对 JSON Schema 子集的接受度：零实测。** 无凭据、无端点。因此 ADR-047 决定的是**机制**（一处常量 + 语言子集约定），校准留在 P6 第一次真连端点时做。已知会触发的形状差异：`$schema` 键、`type` 数组、`anyOf`、`$defs`/`$ref`、`record` 产出的 `propertyNames`——**全部是【推断】/【未验证】**。
2. **两个探针只在 Windows 上跑过**，且它们**不进 CI**（开发期脚本）。Linux/macOS 的计时与 `.gitignore` 对比（期望「跳过后的文件数 ≈ `rg --files` 的文件数」）**未做**。
3. **v1 的 `agent/` 套件本轮未跑**（762 项是前序记录）；本文件不引用其数字作为本轮证据。
4. **TodoWrite 的状态存哪未决**（会话日志内 vs 外部文件 vs 纯事件）→ **T6 被它阻塞**。
5. **`command` 字符串 → `argv` 的组合面未读**（`adapters/shell.ts` 的调用形状）。v2 的 `argv` 是数组且 `NodeProcess` **不经过 shell**，所以这一步必须由 Bash 工具完成——属 T5 开工前的技术确认，不是决策缺口。

### 本次会话关闭的（证据在 §1/§2）

1. **npm 真实最新版 = `0.15.0`**【registry】（前序交接列为缺口）→ `README.md:15` 无需修改；`agent/package.json:3` 的 `0.16.0` 是**未发布的本地版本号**。
2. **`#41` T6c 已在 `main`**（`e33b654`）→ 前序交接文件内部的时态矛盾（抬头说「T6 全部落地」，正文又说「T6c 在未合 PR 上」）**是文档陈旧，不是代码状态**。
3. **`README.md:16` 的 v2 状态行仍滞后**（还写着「P2『端口与执行网关』起继续推进」，实际已到 P5）→ 【源码】已核实，**本次未修**（属 docs 清理，可随任一 PR 带走）。

### 来自前序记录、**本次未复现**的

1. **macOS flake**：`agent/test/chrome.test.mjs:47` 固定 `sleep(15)` 后断言光标序列，**会随机卡住任何 PR**（它真的卡过 #26）；因 `agent/` 树冻结，「算不算安全修复」的口径问了三轮未答。
2. **`execFileSync` 子进程挂起**的根因（§5 第 11 条）。
3. 「thinking 块恒在文本与工具调用之前」仍靠**合成夹具**钉住（`synthetic/thinking-precedes`），**不是实测**。
4. `ReasoningBlock` 是厂商块的**封闭子集**：厂商将来在块里加字段会被解码边界 strip → 回放 400。已记档（ADR-045），**未处理**。
5. 产出 catalog 的蒸馏脚本**不在仓库里**（`agent/src/llm/presets.js:2` 指向的 `tools/distill-providers.mjs` 不存在）→「预设怎么更新」仍未定。

### 三个未答的小问题（不阻塞；本轮**未再问**）

1. **macOS flake 要不要开 issue**（同上）。
2. **ADR-034 要不要挪到 033 之后**：ADR 表按主题归组插入过，全表不严格单调；新 ADR 一律追加表末（047~052 已按此追加）。建议单独一个 `chore/` PR。
3. **ADR-044 是否认可**：本轮新增的 ADR-047/052 都**引用**了它（「不发明策略」「适配器不读不造」），但**仍未收到显式认可**——标为待确认，不以「被引用」当认可。

### 证据与记忆的差异（保留差异，不覆盖）

| 项 | 记忆 / 旧文档 | 实测证据 | 处置 |
|---|---|---|---|
| `main` 的位置 | 旧交接记 `main` = `210f26a`，且称「T6c 在未合 PR 上」 | 【源码】`git log` → `main` = `e33b654`，`#41` 已合 | **以证据为准**；差异记为本轮文档陈旧 |
| 摸底报告的「真实最新发布版本未核实」 | 标记为不确定 | 【registry】`0.15.0` | 已关闭 |
| 摸底报告的「T6c 分支合并状态（文件内部时态矛盾）」 | 标为待确认 | 【源码】`#41` 在 `main` | 已关闭 |

---

## 7. 关键文件

| 路径 | 内容 |
|---|---|
| [`dev-plan-v2.md`](dev-plan-v2.md) | **权威计划**。P5 段现已含任务拆分表（T0–T7）与评审前提；P4 段保留其历史表 |
| [`architecture/README.md`](architecture/README.md) | **ADR-001~052**（047~052 是本轮决策，追加在表尾；045/046 是上一轮的） |
| [`research/p5-tools.md`](research/p5-tools.md) | **本轮调研**：八个问题与决定草案、被否决方案、v1 工具全量归类（§13）、T0–T7 拆分（§14）、ADR 正文草案（§15）、待验证清单（§12） |
| [`research/p4-models.md`](research/p4-models.md) | P4 调研（前序）：证据边界、六项决定、§8 的 12 条断言、§10 待验证 |
| [`architecture/01-layers.md`](architecture/01-layers.md) | 分层与端口清单（**T2 要在这里给 `adapters` 加「工具实现」**） |
| [`architecture/02-kernel.md`](architecture/02-kernel.md) | 事件表、回合执行（**T1 要在这里把「工具串行 + 为什么不能简单并发」写实**） |
| [`architecture/03-policy-and-execution.md`](architecture/03-policy-and-execution.md) | 策略/端口/进程网关/沙箱（**T7 要更新端口表里 `ToolPort` 那行**） |
| `packages/cowcat/src/ports/index.ts` | `ToolSpec`（含 `inputSchema?` / `pathInput` / `commandInput`）、`ToolPort.run(input, signal)`（**T1 加第三参数**）、`ToolResult`（**T1 加 `truncation`**） |
| `packages/cowcat/src/kernel/events.ts` | `KernelEvent` 联合（**T1 给 `tool.finished` 加 `truncation` 与 `path`**）；`StreamDelta` 是唯一的 ephemeral 通道 |
| `packages/cowcat/src/kernel/run-turn.ts` | 回合主循环：`for (const call of calls)` **串行**、`actionFields` 生产 `path`/`command`、审批等待与超时 |
| `packages/cowcat/src/kernel/state.ts` | `reduce`（**T1 要在这里派生已读文件集合**）；`tool.finished` → `Message.tool` |
| `packages/cowcat/src/policy/decide.ts` | 规则语言与裁决优先级（工具要声明 `risk`/`pathInput`/`commandInput` 才能被规则收窄） |
| `packages/cowcat/src/adapters/sandbox/executor.ts` | 沙箱执行器；`:150-160` 是 `network: 'ask'` 那段（**ADR-051 的缺口出处**） |
| `packages/cowcat/src/adapters/output-tail.ts` | 截断的唯一算术（`dropped` 永远 = `total - kept`）；**T3 的截断事实要沿用它** |
| `packages/cowcat/src/adapters/fs.ts` / `ports/fs.ts` | 路径身份（`canonical`/`samePath`/`kindOf`/`exists`）——**它没有 read/write**，这正是 ADR-047 的论据 |
| `packages/cowcat/eslint.config.js` | `:54-83` 是分层禁令的实际形状（`src/**/*.ts` 禁 `node:fs`/`child_process`，`ignores` 四个目录） |
| `tools/p5-json-schema-probe.mjs` | **本轮新增**：zod → wire JSON Schema（31 条断言，`npm` 装好的 zod 4.6.7） |
| `tools/p5-glob-grep-probe.mjs` | **本轮新增**：Glob/Grep 性能（冷/热各一遍、3 棵树、与 `rg --files` 对比） |
| `tools/check-tarball.mjs` | 发布白名单守卫（每个非草稿 PR 都会跑；本轮本机通过） |
| `tools/lint-probe.mjs` | 7 条 lint 探针——**本轮未复跑** |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | 三条 `packages/cowcat` 腿 + macOS；**草稿 PR 不跑检查**（`:17-18`） |
