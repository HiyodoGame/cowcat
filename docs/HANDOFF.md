# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾（或按用户要求做会话收尾）重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-20（P7 子 agent 收口完成；MCP 专项调研出草案）**。
> 交接时仓库状态：**`main` = `e756a6a`**（#78 T4 合入）；当前分支 **`docs/p7-mcp-research`**（MCP 调研，工作区干净，PR 见 GitHub）。
>
> **证据分级**（沿用前几轮，逐条标注）：**【源码】**读代码/读装机类型；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（cowcat/cli 用系统 Node **24.18.0**，tui 用便携版 Node **26.12.0**；v2 的测试跑在 `dist/` 编译产物上）；**【本机命令】**本机跑的其他命令（`git`、`gh`、`npm`、探针脚本）；**【CI 远端】**GitHub Actions 的运行结果（**只观察状态，未在本地复现**）；**【上游】**厂商文档或实现；**【registry】**npm registry 查询；**【推断】**未实测的推论，不得作为决策依据。
> **本会话没有真实终端、没有模型端点、没有发布动作、没有平台设置变更**：stdout 不是 TTY；`ZHIPU_API_KEY` 在本机 shell 里不存在；未调用 `opencode_console` 的任何写操作。

---

## 1. 本次会话实际做了什么

### 归属（不要记错）

- `main` 上 `af8d4b3`（#71）及更早的提交都是前序会话的。
- 本次会话的产出：**#73 合入**、**#72 合入（含一个复审修复提交）**、**P7 子 agent 调研**（本分支）。

### 本次会话（2026-10-20）实际做了什么

**7 个 PR 合入 + 2 份专项调研 + 本分支的 MCP 调研**：

| PR | 内容 | 结果 |
|---|---|---|
| **#73** | P7 前沿调研与计划校准（`docs/research/p7-frontier-survey.md` + `dev-plan-v2.md` 的 P7 表） | 核对三处「文档落后于代码」的陈述后 **squash 合入**（`4828d39`），远端分支已删 |
| **#72** | `doctor` 报告指令链（ADR-078 T6）——`instr` 行 | **复审后修两处 P1 再合入**（`cad6e06`） |
| **#74** | P7 **子 agent** 专项调研（`docs/research/p7-subagents.md`）+ HANDOFF 重写 | **squash 合入**（`8129660`） |
| **#75** | 子 agent T1：ADR-079~082 + 内核契约（事件、`Task` 虚拟工具、`unattended`） | **squash 合入**（`be5c4f1`） |
| **#76** | 子 agent T2：组合根实现 `SubagentPort`、`parent` 头、角色工具/规则、`maxRounds`/`partial` | **squash 合入**（`d842bfd`） |
| **#77** | 子 agent T3：`SessionSummary.parentSessionId`、`sessions list` 折叠（`--all`）、TUI 摘要行 | **squash 合入**（`19349fd`） |
| **#78** | 子 agent T4：子会话协议重放、取消父回合后子会话 `cancelled` 且锁已释放 | **squash 合入**（`e756a6a`） |
| 本分支 | **MCP 专项调研**（`research/p7-mcp.md`）：2026-07-28 规范的三页一手对照、动态工具表、信任与凭证边界 | 待合 |

**开工第一件事是核对摸底报告**（`repo-explorer` 的只读报告把它交给主 Agent 的 4 项）：分支/PR 状态、`core.hooksPath`、Node 版本、`dist/` 新鲜度。结果：**报告依据的 HANDOFF 快照落后两个阶段**（还停在 P6 T10 / PR #65），仓库已到 P7（ADR-070~078）。已在本次交接重写。

**#72 复审发现的两处（都改了）**：

1. `doctor.ts` 的 `none` 分支原话是「这个目录往上没有 AGENTS.md / CLAUDE.md」，但 `decideInstruction()` 的 `none` 同时覆盖「链为空」与「文件存在但为空」（`FileInstructionSource` 在入口就把空文件滤掉）→ 改成「没有可注入的 AGENTS.md / CLAUDE.md：不存在或为空」。
2. 测试原本 `(（这个目录往上没有…|folder not trusted: skipped)` **两个分支都放过**，注释却声称校验了文件名与行数 → 钉成 `folder not trusted: skipped AGENTS\.md \(\d+ lines\)`，trust 行收到 `.*未受信`。
   顺带把全局文件名下沉成 `GLOBAL_INSTRUCTION_FILENAME`（`policy/instructions.ts`），`host`/`doctor` 不再各写一遍字面量；ADR-065 ⑤、ADR-078 状态与 `06-frontend.md` 动词表同 PR 更新。

**用户拍板**：① 「先合 #73 并复审 #72」；② 「先修 P1+文档后合」；③ 「继续做 P7 下一行，每做完一个阶段更新 HANDOFF」；④ 「合 #74，继续 ADR+T1」；⑤ 「合 #75，继续 T2」；⑥ 「合 #76，继续 T3」；⑦ 「合 #77，继续 T4」；⑧ 「合 #78，开 MCP 调研」。

**子 agent 的 T1（本分支）**：先按工作规则 3 把 ADR-079~082 追加到 ADR 表末，再落内核契约：

- `kernel/subagent.ts`（新）：`Task` 的 spec（模型侧描述 + JSON Schema）、输入校验（拒绝时说出限值）、报告裁剪（2 万字符 + `truncation`）、结果文本；
- `ports/subagent.ts`（新）：`SubagentPort.spawn(request, signal)` 与 `SubagentOutcome`（含 `turns` / `partial` / `usage`）；
- `kernel/events.ts` + `state.ts`：`subagent.started` / `subagent.finished`，**不参与折叠**（与 `policy.decided` 同形——真正进 `messages` 的是随后的 `tool.finished`）；
- `kernel/run-turn.ts`：`TurnDeps.subagents?` / `unattended?`；有 port 时工具表才多一个 `Task`（子会话没有 port = 深度 0）；`runCall` 让 `Task` 走同一条策略与审批路径，再由 `runSubagentCall` 铸造子会话 id → `started` → spawn → `finished` → 裁剪回传。**spawn 失败是工具结果不是失败回合**，取消则两侧都记终结事实；
- `policy/approval.ts` + `adapters/schema.ts`：`ApprovalBy` 增加 `'unattended'`，zod 解码边界同步（`schema.test.ts` 的 `Equals` 守卫会强制这条，不补就编译不过）。

**子 agent 的 T2（本分支）**：把 `SubagentPort` 在组合根落地，并补上两个 T1 留空的口子：

- `host/host.ts` 的 `spawnSubagent`：建子会话（`finally` 释放锁）→ 用父预设计算模型 → 角色工具子集与规则 → `maxRounds: max_turns` → `unattended` 让子会话的 `ask` 立刻拒绝 → 汇总子日志的 `model.usage` → 取最后一条 assistant 文本作 `report`；
- `host/subagent-roles.ts`（新）：`explore` 三个只读工具；`general` = 父工具减 `Task`/`TodoWrite`；规则追加逐工具的 `deny`（规则语言没有否定，allowlist 只能这样表达）；
- `kernel/session.ts` 的 `create(..., { parent })` + `session.opened.parent`（可选字段，不升 `schemaVersion`）；
- **ADR-080 的一处修正**：`Task` 的 `risk` 不能写死 `exec`——规则只能看 `tool`/`risk`/`path`/`command`，看不到 `agent`，所以改成按角色取能力上限（`explore` = `read` ⇒ 现有基线免问；`general` = `exec` ⇒ 默认 `ask`）。ADR 正文已注明这是 T2 的修正；
- `TurnDeps.maxRounds` + `TurnOutcome.partial` + `TurnNote: 'rounds-exhausted'`：`max_turns` 到顶是**正常的 `completed` + `partial: true`**，不是失败。

**子 agent 的 T3（本分支）**：让子会话在前端可见，但不混进"我自己开的会话"。

- `protocol/methods.ts`：`SessionSummary.parentSessionId?`（可选，客户端忽略时行为与从前一致）；
- `adapters/session-index.ts`：从每份日志的**第一行**读 `parent.sessionId`（读坏了返回 `null`，不抛——一个损坏文件不该让整张列表消失）；
- `sessions list` 默认折叠子会话，`--all` 才列并标出父会话（选项进表，ADR-065 ③）；
- TUI：`subagent.finished` 渲染一行「子会话 sess_x（explore）完成：N 轮」，`started` **不单独成行**（一行出现又悬着比晚到更差）；**专用卡片延后**——`Task` 的工具卡已经承载报告与 `sessionId`，再画一张只是重复。

**子 agent 的 T4（本分支）**：端到端收口，两条都在 `host.test.ts` 里用真实协议客户端驱动。

- **重放**：父回合结束后 `session.open(<childId>)` 能重放子会话（`replayed >= 2`），且重放出的头事件带 `parent`——前端不需要读父日志就知道谁委派的。
- **取消**：`DelegatingHangingModel` 让父回合发出 `Task` 后**子会话**挂住；`turn.cancel` 之后父回合 `cancelled`、父日志的 `subagent.finished.state = 'cancelled'`、子日志有 `turn.transitioned → cancelled`，并且 **`.jsonl.lock` 已不存在**（`finally` 里的 `close()` 真的执行了）。

**MCP 专项调研（本分支，`docs/research/p7-mcp.md`）**：只读调研，读的是 2026-07-28 规范的**总览 / transports / authorization** 三页（一手）与本仓库的进程网关、工具表、配置层。

- **规范这版的形状变了**：连接态 `initialize` 换成**逐请求 `_meta.io.modelcontextprotocol/*`**，并为旧实现保留兼容矩阵——T1 先走兼容路径。
- **stdio 的授权故事是「不要 OAuth」**：规范明确 stdio **SHOULD NOT** 走授权，凭证从环境取。这正好落在 ADR-014/015：子进程的 env 与沙箱由 `ProcessPort` 决定。
- **修正前沿调研 D2**：它写的「PKCE + 动态客户端注册」已过时——2026-07-28 把 **DCR 标为 deprecated**，首选 Client ID Metadata Documents；`resource` 参数（RFC 8707）是 MUST。只影响将来的 HTTP 传输。
- **首版只做 stdio + tools**（ADR 草案 083~086）：动态工具表 `mcp__<server>__<tool>`、项目层定义需受信、凭证不进项目配置、崩溃不自动重启。
- **没读到的不写进决定**：`client/elicitation`、tool search / registry、`basic/versioning` 的兼容矩阵都没逐节读，全部进 §7 待验证。

---

## 2. 当前状态

### 已验证 —— 【本机测试】/【本机命令】（Windows）

- 【本机测试】`packages/cowcat` → **643 tests / 627 pass / 0 fail / 16 skipped**（Node 24.18.0；`pretest` = `tsc` + ESLint 通过）
- 【本机测试】`packages/cli` → **21 / 21 pass**（新增一条 `sessions list` 折叠子会话的用例）
- 【本机测试】`packages/tui` → **48 / 48 pass**（用 `npx --yes node@26.12.0 --test "dist/test/**/*.test.js"` 跑；本机系统 Node 24 加载不了 opentui）；`npm run build` + `npm run lint` 通过
- **本分支只改 `docs/`**：没有重跑测试；上面三行是 #78（T4）时点的结果
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
- **P7 进行中**：上下文压缩（ADR-070~074）、记忆与项目指令（ADR-075~078）、**子 agent（ADR-079~082，T1~T4）已完成**；**MCP 调研出草案**（ADR-083~086 待落表）；其余 14 行候选未开工
- 四个包：`packages/protocol`（Node ≥22）、`packages/cowcat`（Node ≥22，内核 + 组合根）、`packages/tui`（Node ≥26.4，渲染器）、`packages/cli`（Node ≥22，可执行文件）；`protocol` 被另外三个以 `file:` 依赖（**junction：不装依赖、不构建**）
- 四个包都是 `private: true`、`0.0.0`，**从未发布**；`schemaVersion` 仍是 **1**（ADR-019）
- **运行时依赖 3 / 6 不变**（`zod`、`openai`、`@anthropic-ai/sdk`）；`packages/cli` 的唯一第三方依赖是 `zod`
- `cowcat` 六个动词：`tui` / `serve` / `run` / `sessions list|resume` / `doctor` **可用**；**`setup` 未接线**

---

## 3. 项目唯一下一步

**合入 MCP 调研，然后把 ADR-083~086 落表并做 T1（stdio + tools）。**

- **MCP 的下一步**（工作规则 3 先决策后实现）：四个 ADR——范围与传输（只 stdio + tools，先走 `initialize` 兼容）、动态工具表与 `mcp__server__tool` 命名、信任与凭证边界（项目层需受信、凭证不进项目配置）、生命周期与错误（按需启动、取消即终止、崩溃不重启）。
- **T1 的验收可以离线**：用一条**假 MCP 服务器脚本**（stdio、换行分隔 JSON-RPC）驱动——工具列表进动态表、工具调用经 `ProcessPort`（可断言沙箱档位与 env 脱敏）、服务器崩溃 → 工具结果失败且不重启、`turn.cancel` 后进程树被终止。
- **开工前必须补读**：`client/elicitation`、tool search / registry 与 `basic/versioning` 的兼容矩阵——调研 §7 第 1~3 条；没读到之前不要按「服务器不发起请求」设计。
- **仍未做的事**：真实模型请求仍是零实测（§6）。

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
| **079** | **子会话是独立会话**：独立日志/锁/seq；父日志只记 `subagent.started` / `subagent.finished`；`session.opened` 加可选 `parent`、`SessionSummary` 加可选 `parentSessionId`，不升 `schemaVersion` |
| **080** | **`Task` 是内核注入的虚拟工具**（不是 `ToolPort`）：`risk: exec`、`description` 只用于展示、子会话 id 由内核先铸造、只有 `TurnDeps.subagents` 存在时才上线（= 深度 0） |
| **081** | **权限只收不放**：角色工具子集、父规则 + `Task` deny + 角色 allowlist、**子会话的 `ask` 一律拒绝**（`TurnDeps.unattended` + `ApprovalBy: 'unattended'`）、取消沿 signal |
| **082** | **结果与记账**：只回传最终文本（2 万字符 + `truncation`）、子 usage 不进父 `model.usage`、模型与指令链继承父会话 |

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
15. **新增事件类型会撞两处编译期守卫**，这是设计：`test/schema.test.ts` 的 `Equals<z.infer<schema>, KernelEvent>` 逼你同步 zod 解码边界，`test/exit-criteria.test.ts` 的 `never` 分支逼你决定它进不进 transcript。两处都补，别加 `default`。
16. **`assert.deepEqual(x?.y, …)` 会窄化 `x`**：后面再写 `x?.z` 就被 `no-unnecessary-condition` 判为多余。把可选链的结果先取到局部变量，再断言。
17. **不要用 PowerShell 的 `Get-Content` / `Set-Content` 批量改源码**：它会按 ANSI 码页解码 UTF-8，**把中文注释里的破折号写成 `�?`**，一次 `-replace` 就能污染整块文件（本会话真踩，`git checkout --` 回滚后才用 `edit` 工具重做）。批量替换要么用 `edit`，要么写 Node 脚本。
18. **`packages/tui` 的测试要 Node ≥26.4**（opentui）。本机系统 Node 24 跑不了，但 `npx --yes node@26.12.0 --test "dist/test/**/*.test.js"` 在 `packages/tui` 下可用（首次下载后走缓存）；CI 的两条 tui 腿也是 26。

---

## 6. 未验证 / 待确认

1. **一次真实模型请求都没跑过**（跨会话未变）：所有回合行为都在宿主层用注入模型验证。`ZHIPU_API_KEY` 不在本机 shell 里。
2. **子 agent 已完成 T1~T4，但收益仍是推断**：调研里的 15× token / 90.2% 提升来自**研究型**任务，不必然适用于编码；我们的验证只到「形状与边界正确」（`research/p7-subagents.md` §8 的 6 条待验证）。
3. **MCP 只读了三页**：elicitation、tool search / registry、`basic/versioning` 均未逐节读；「服务器不发起 JSON-RPC 请求」这句与 elicitation 的旧理解冲突，**在补读之前不得据此设计**。另外 `light` 档沙箱是否会挡住 `npx` 缓存之类的服务器依赖目录，未实测。
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
| [`architecture/README.md`](architecture/README.md) | **ADR-001~082**（070~074 压缩；075~078 记忆与指令；079~082 子 agent） |
| [`architecture/06-frontend.md`](architecture/06-frontend.md) | P6 契约文档：协议方法表、包结构、分层规则、附件与图片通路 |
| [`research/p7-subagents.md`](research/p7-subagents.md) | **本次产出**：子 agent 的上游对照、本仓库现状、四个决定草案、任务拆分、待验证 |
| [`research/p7-frontier-survey.md`](research/p7-frontier-survey.md) | P7 排期校准（D1~D12）、R3~R8 的依据 |
| `packages/cowcat/src/kernel/` | `run-turn.ts`（回合循环、策略/审批/读后写闸门）、`session.ts`（单写者 + 回合机）、`state.ts`（折叠）、`events.ts`（16 种事件）、`compact.ts`（压缩）、`subagent.ts`（`Task` 的 spec/校验/裁剪） |
| `packages/cowcat/src/ports/subagent.ts` | `SubagentPort` 与 `SubagentOutcome`（组合根已实现，见 `host.ts` 的 `spawnSubagent`） |
| `packages/cowcat/src/host/subagent-roles.ts` | 角色 → 工具子集、规则只收不放（逐工具 `deny`） |
| `packages/cowcat/src/host/` | 组合根：`host.ts`（`ProtocolHost` 实现）、`config.ts`（三层配置 + 基线规则）、`paths.ts` |
| `packages/cowcat/src/policy/` | `decide.ts`（裁决矩阵）、`instructions.ts`（链渲染与预算）、`trust.ts` |
| `packages/protocol/src/methods.ts` | 9 个协议方法 + 参数 schema + 结果表 |
| `packages/cli/src/cli/` | `spec.ts`（命令表 + 选项）、`run.ts`、`host.ts`、`serve/oneshot/sessions/tui/doctor.ts` |
| `packages/tui/src/{app,components,ui,text,theme,image}/` | `project()` 纯函数、六个卡片组件、宽度表/wrap/diff、主题 token |
| `tools/` | `lint-probe.mjs`（分层禁令 21 条）、`check-tarball.mjs`、`tui-api-probe.mjs`、`tui-smoke.mjs`、`glm-smoke.mjs`（需 key） |
