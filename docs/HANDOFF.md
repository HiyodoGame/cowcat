# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾（或按用户要求做会话收尾）重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-20（P7 子 agent 专项调研；#73/#72 合入后的第一次交接重写）**。
> 交接时仓库状态：**`main` = `cad6e06`**（#72 合入）；当前分支 **`docs/p7-subagents`**（调研 + 交接，工作区干净，PR 见 GitHub）。
>
> **证据分级**（沿用前几轮，逐条标注）：**【源码】**读代码/读装机类型；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（cowcat/cli 用系统 Node **24.18.0**，tui 用便携版 Node **26.12.0**；v2 的测试跑在 `dist/` 编译产物上）；**【本机命令】**本机跑的其他命令（`git`、`gh`、`npm`、探针脚本）；**【CI 远端】**GitHub Actions 的运行结果（**只观察状态，未在本地复现**）；**【上游】**厂商文档或实现；**【registry】**npm registry 查询；**【推断】**未实测的推论，不得作为决策依据。
> **本会话没有真实终端、没有模型端点、没有发布动作、没有平台设置变更**：stdout 不是 TTY；`ZHIPU_API_KEY` 在本机 shell 里不存在；未调用 `opencode_console` 的任何写操作。

---

## 1. 本次会话实际做了什么

### 归属（不要记错）

- `main` 上 `af8d4b3`（#71）及更早的提交都是前序会话的。
- 本次会话的产出：**#73 合入**、**#72 合入（含一个复审修复提交）**、**P7 子 agent 调研**（本分支）。

### 本次会话（2026-10-20）实际做了什么

**2 个 PR 合入 + 1 份专项调研**：

| PR | 内容 | 结果 |
|---|---|---|
| **#73** | P7 前沿调研与计划校准（`docs/research/p7-frontier-survey.md` + `dev-plan-v2.md` 的 P7 表） | 核对三处「文档落后于代码」的陈述后 **squash 合入**（`4828d39`），远端分支已删 |
| **#72** | `doctor` 报告指令链（ADR-078 T6）——`instr` 行 | **复审后修两处 P1 再合入**（`cad6e06`） |
| 本分支 | P7 **子 agent** 专项调研（`docs/research/p7-subagents.md`）+ 本交接 | 待合 |

**开工第一件事是核对摸底报告**（`repo-explorer` 的只读报告把它交给主 Agent 的 4 项）：分支/PR 状态、`core.hooksPath`、Node 版本、`dist/` 新鲜度。结果：**报告依据的 HANDOFF 快照落后两个阶段**（还停在 P6 T10 / PR #65），仓库已到 P7（ADR-070~078）。已在本次交接重写。

**#72 复审发现的两处（都改了）**：

1. `doctor.ts` 的 `none` 分支原话是「这个目录往上没有 AGENTS.md / CLAUDE.md」，但 `decideInstruction()` 的 `none` 同时覆盖「链为空」与「文件存在但为空」（`FileInstructionSource` 在入口就把空文件滤掉）→ 改成「没有可注入的 AGENTS.md / CLAUDE.md：不存在或为空」。
2. 测试原本 `(（这个目录往上没有…|folder not trusted: skipped)` **两个分支都放过**，注释却声称校验了文件名与行数 → 钉成 `folder not trusted: skipped AGENTS\.md \(\d+ lines\)`，trust 行收到 `.*未受信`。
   顺带把全局文件名下沉成 `GLOBAL_INSTRUCTION_FILENAME`（`policy/instructions.ts`），`host`/`doctor` 不再各写一遍字面量；ADR-065 ⑤、ADR-078 状态与 `06-frontend.md` 动词表同 PR 更新。

**用户拍板**：① 「先合 #73 并复审 #72」；② 「先修 P1+文档后合」；③ 「继续做 P7 下一行，每做完一个阶段更新 HANDOFF」。

---

## 2. 当前状态

### 已验证 —— 【本机测试】/【本机命令】（Windows）

- 【本机测试】`packages/cowcat` → **631 tests / 615 pass / 0 fail / 16 skipped**（Node 24.18.0；`pretest` = `tsc` + ESLint 通过）
- 【本机测试】`packages/cli` → **20 / 20 pass**（含收紧后的 `doctor` 断言：链确实读到仓库根 `AGENTS.md` 且被信任闸门挡住）
- 【本机测试】`packages/tui` → 本会话未改该包、**未重跑**（上一轮 46 / 46；CI 两条 tui 腿通过）
- 【本机命令】`node tools/lint-probe.mjs` → 全部探针符合预期（四包 21 条）
- 【本机命令】`cowcat doctor` 实跑（`COWCAT_HOME` 指向临时目录）：`instr folder not trusted: skipped AGENTS.md (77 lines). Trust the folder to load it.`；在放了一个**空** `AGENTS.md` 的临时目录里 → `instr （没有可注入的 AGENTS.md / CLAUDE.md：不存在或为空）`
- 【本机命令】`core.hooksPath` = `.githooks`（钩子已启用）；系统 Node **24.18.0**、npm 11.16.0；`packages/cowcat/dist` 已构建
- 【registry】`@corescense/cowcat` 仍是 **0.15.0**（`agent/package.json` 已是 0.16.0，未发布）

### 已验证 —— 【CI 远端】（只观察状态，未在本地复现）

- #73 与 #72 的每一轮都是 **11 项 pass + 2 项 skipping**（skipping 是 `scope` 过滤的 legacy 腿，按设计如此），Linux / macOS / Windows 与 node 26 的 tui 腿全绿
- #72 第一次合并尝试被拒：**`head branch is not up to date with the base branch`**（#73 合入让 main 前移）→ 把 `main` 并进分支、重跑 CI、再合

### 项目状态

- **P6 完成**（含用户人眼验收；#66 修掉「不可读附件让会话永久失败」，ADR-069）
- **P7 进行中**：上下文压缩（ADR-070~074）、记忆与项目指令（ADR-075~078）已落地；**子 agent 已出专项调研草案**，ADR 079~082 待落表；其余 14 行候选未开工
- 四个包：`packages/protocol`（Node ≥22）、`packages/cowcat`（Node ≥22，内核 + 组合根）、`packages/tui`（Node ≥26.4，渲染器）、`packages/cli`（Node ≥22，可执行文件）；`protocol` 被另外三个以 `file:` 依赖（**junction：不装依赖、不构建**）
- 四个包都是 `private: true`、`0.0.0`，**从未发布**；`schemaVersion` 仍是 **1**（ADR-019）
- **运行时依赖 3 / 6 不变**（`zod`、`openai`、`@anthropic-ai/sdk`）；`packages/cli` 的唯一第三方依赖是 `zod`
- `cowcat` 六个动词：`tui` / `serve` / `run` / `sessions list|resume` / `doctor` **可用**；**`setup` 未接线**

---

## 3. 项目唯一下一步

**把子 agent 的四个决定落成 ADR（079~082 顺延当时的表尾编号），再按 `research/p7-subagents.md` §7 的 T1~T5 实现。**

- **先落 ADR 再写代码**（工作规则 3）：ADR-079 独立子会话、ADR-080 内核注入的 `Task` 虚拟工具、ADR-081 权限只收不放（含「子会话的 ask 一律拒绝」）、ADR-082 结果预算与记账。
- **T1 的验收可以完全离线**：假 `SubagentPort` + `ScriptedModel`，证明「子会话是独立日志 / 父日志两条 `subagent.*` / 子会话拿不到 `Task` / ask 被拒且理由进工具结果 / 取消后两侧终结且锁释放」。
- **仍未做的事**：真实终端人眼验收已由用户完成（P6），但**一次真实模型请求仍未跑过**（§6），子 agent 的收益类判断全部待实测。

---

## 4. 关键决策

P7 已落地的 ADR 见 [`architecture/README.md`](architecture/README.md)（**ADR-001~078**）。本阶段相关的六条：

| ADR | 一句话 |
|---|---|
| **070/071** | 上下文用量的估算与锚；压缩成为**可重放的替换事实**（按 `seq` 水位线遮蔽，不删日志） |
| **072/073/074** | 摘要调用**不是回合**；阈值接线；前端一条压缩行 |
| **075** | 指令注入单元是**一条链**（全局 `~/.cowcat/AGENTS.md` → 项目根到 cwd 每层 → `*.local.md`），不是「最近的一个文件」 |
| **076** | 指令渲染成一段带框架的文本；预算 **65,536 字节**（按 UTF-8 字节，不按字符），超预算先丢宽的文件 |
| **077** | 信任仍是注入前置；**跳过要说出来**（文件 + 行数） |
| **078** | 会话开始注入一次、**压缩后必须重注入**；判重在折叠里（`instructionsSeq`）；`doctor` 报告加载/跳过（T6） |

**本次调研的决定草案**（尚未落表，细节与证据见 [`research/p7-subagents.md`](research/p7-subagents.md)）：子会话独立会话 + 父日志两条事件；`Task` 是内核注入的虚拟工具（不是 `ToolPort`）；权限只收不放且子会话 ask 一律拒绝；结果只有最终文本 + 用量，子 usage 不进父 `model.usage`。

---

## 5. 踩坑（真花时间的，跨会话仍然成立）

1. **Windows 的 `git commit -m "…"` 带引号会被截断** → 用 `git commit -F <文件>`。
2. **PowerShell 把 git/gh 的 stderr 当成错误**：`git push`、`gh pr merge` 输出 "Exited with code 1" 是假警报，看有没有 `abc..def branch -> branch` / 合并成功即可。
3. **`gh pr merge` 会因分支落后被拒**（`not mergeable: the head branch is not up to date`）：先把 `main` 并进分支、重跑 CI 再合；不要用 `--admin` 绕。
4. **控制台把 UTF-8 显示成乱码不等于文件坏了**：判据是**字节**——用 `read` 工具读回、或落盘后比对。
5. **`websearch` 本机不可用（HTTP 402）**，`webfetch` 直连官方文档可用；上游证据尽量取一手 URL 并写进调研文档。
6. **`edit` 的 `oldString` 以整行开头时可能吃掉下一行**（历史上踩过三次）：改完**读回来**，ADR 表用脚本校验行数与重复 id。
7. **删源文件必须清 `dist/`**；v2 测试跑在 `dist/` 上，`pretest` 才会重新 build。
8. **期望帧/快照不能放在 `dist/` 里**（会被 build 清掉），要编译进产物（`test/frames.ts`）。
9. **`file:` 依赖是 junction，npm 不装也不构建**：消费者腿要自己构建 `../protocol`（cli 腿是 protocol → cowcat → tui 三步）。
10. **探针全过 ≠ 包级 lint 过**：加规则后必须跑 `npm run lint`。
11. **`assert.equal` 会窄化类型**，随后的 `?.`/`??` 被 `no-unnecessary-condition` 判多余；`no-non-null-assertion` 全仓禁用。
12. **测试里连着调两次「隔离 home」的 helper**：第二个覆盖第一个的 `COWCAT_HOME`，断言会去错目录找文件。
13. **`cowcat` 的 bin 指向 `dist/src/cli/main.js`**（不是 `dist/cli/main.js`）；直接 `node` 跑 doctor 时别猜错路径。
14. **`.githooks` 要每克隆手动启用**（`git config core.hooksPath .githooks`）；本机已启用，未启用时守卫**静默失效**。

---

## 6. 未验证 / 待确认

1. **一次真实模型请求都没跑过**（跨会话未变）：所有回合行为都在宿主层用注入模型验证。`ZHIPU_API_KEY` 不在本机 shell 里。
2. **子 agent 的一切都还没实现**：调研里的收益判断（15× token / 90.2% 提升）来自**研究型**任务，不必然适用于编码；`research/p7-subagents.md` §8 列了 6 条待验证。
3. **子会话未测**：父子两个锁文件在 Windows 上同时持有的行为、父取消后子会话的残留清理，都要等 T1/T2 才谈得上。
4. **`session.list` 目前没有父子字段**：子会话一旦落地就会混进顶层列表，T2/T3 必须处理。
5. **帧快照刻意不含宽字符**：CJK 字宽跨平台一致性没实测过，CJK 宽度用「按 cell 数断言」单独测。
6. **`packages/tui` 本会话未跑**：上一轮 46/46，CI 两条 tui 腿通过；本会话没有改动它。
7. **前序遗留、未复现**：`agent/` 的两个 macOS flake（`agent/test/chrome.test.mjs:47`、`agent/test/toast.test.mjs:34`，同一病根：用真实时间等）；`agent/src/llm/presets.js:2` 指向的 `tools/distill-providers.mjs` 不在仓库里；v1 套件（762 项）本会话未跑。
8. **`packages/cli` 与 `packages/protocol` 尚未进分支保护 required 列表**（改仓库设置是用户的事）。
9. **`cowcat setup` 未接线**；滚动回看、预览模态、Plan/Act 双模式仍未做（Plan 模式在 P7 表里另有行）。
10. **平台 / 工作区设置未变更、未核对**（未调用 `opencode_console` 的写操作）。

---

## 7. 关键文件

| 路径 | 内容 |
|---|---|
| [`dev-plan-v2.md`](dev-plan-v2.md) | **权威计划**：P0–P8 阶段表、P7 的 16 行模块表、R3~R8 远期项 |
| [`architecture/README.md`](architecture/README.md) | **ADR-001~078**（070~074 压缩；075~078 记忆与指令） |
| [`architecture/06-frontend.md`](architecture/06-frontend.md) | P6 契约文档：协议方法表、包结构、分层规则、附件与图片通路 |
| [`research/p7-subagents.md`](research/p7-subagents.md) | **本次产出**：子 agent 的上游对照、本仓库现状、四个决定草案、任务拆分、待验证 |
| [`research/p7-frontier-survey.md`](research/p7-frontier-survey.md) | P7 排期校准（D1~D12）、R3~R8 的依据 |
| `packages/cowcat/src/kernel/` | `run-turn.ts`（回合循环、策略/审批/读后写闸门）、`session.ts`（单写者 + 回合机）、`state.ts`（折叠）、`events.ts`（14 种事件）、`compact.ts`（压缩） |
| `packages/cowcat/src/host/` | 组合根：`host.ts`（`ProtocolHost` 实现）、`config.ts`（三层配置 + 基线规则）、`paths.ts` |
| `packages/cowcat/src/policy/` | `decide.ts`（裁决矩阵）、`instructions.ts`（链渲染与预算）、`trust.ts` |
| `packages/protocol/src/methods.ts` | 9 个协议方法 + 参数 schema + 结果表 |
| `packages/cli/src/cli/` | `spec.ts`（命令表 + 选项）、`run.ts`、`host.ts`、`serve/oneshot/sessions/tui/doctor.ts` |
| `packages/tui/src/{app,components,ui,text,theme,image}/` | `project()` 纯函数、六个卡片组件、宽度表/wrap/diff、主题 token |
| `tools/` | `lint-probe.mjs`（分层禁令 21 条）、`check-tarball.mjs`、`tui-api-probe.mjs`、`tui-smoke.mjs`、`glm-smoke.mjs`（需 key） |
