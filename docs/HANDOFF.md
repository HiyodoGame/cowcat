# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-18**（本次会话：T7 已合入 `main`；T6 的决策与 T6a 在未合 PR 上）
> 交接时仓库状态：`main` = `38acc3a`；未合分支 `feat/p4-t6a-reasoning-contract`（含 PR #36 与 #37 的提交）；本交接在 `docs/handoff-session-2026-10-18` 上
>
> **证据分级**（本文件只用这几档，逐条标注）：
> **【源码】**读代码 / 读装机类型（`node_modules` 里的 SDK 类型也算源码）；**【构建】**`tsc` 通过；**【本机测试】**Windows + Node 24.18.0 跑 `node:test`（跑在 `dist/` 编译产物上）；**【CI 远端】**GitHub Actions 的运行结果（**我只观察状态，未在本地复现**）；**【上游】**厂商文档，未经端点实测。
> **本次会话没有真机、模拟器或生产证据**：没有对任何模型端点发起请求（全部走夹具 + 注入 transport），也没有任何发布动作。

---

## 1. 本次会话实际做了什么

会话起点：`main` = `4a9e0a8`（P4 T1–T5 已合），外加一个未合分支 `docs/handoff-p4`（PR #33，**上一会话**写的 P4 交接快照）。

| 工作 | 产出 | 状态 |
|---|---|---|
| **T7 出口标准**（ADR-043） | `test/exit-criteria.test.ts`、配对夹具 `paired/final-text`、`fixtures.test.ts` 扩到两个 scenario | PR **#35**，已 squash 合入 `main`（`38acc3a`） |
| **合并上一会话的交接快照** | PR **#33** | 我只执行了合并动作，**内容不是我写的**（上一会话的 P4 T1–T5 快照，含其 8 个 PR 的记录） |
| **T6 决策**（ADR-045/046 + 拆成 T6a/b/c） | `architecture/README.md` 两条 ADR、`dev-plan-v2.md` 任务表、HANDOFF/research 状态 | PR **#36**，**OPEN**（docs-only） |
| **T6a 契约与类型**（推理内容进契约） | `ModelChunk.reasoning` / `Message.assistant.reasoning` / `model.message.reasoning` + 解码边界 + 等价断言 + 3 条测试 | PR **#37**，**OPEN**（base 叠在 #36 上） |

三件工作的细节：

1. **T7**：把 P4 的两条出口标准从「适配器层」钉到「内核层」。① 配对夹具过一次 `runTurn`，OpenAI 兼容与 Anthropic 两条路径对**同一份写死的 golden 事件序列**（不是两跑互比）；投影按 ADR-043：剥 `seq`/`ts`/`sessionId`/`turnId`、tool call id 归一成 `call_<index>`、只比 stopReason 的 `kind`、用量按「一次模型调用取最后一次」折叠。② 两个协议各一条「流中途取消」端到端断言：真实适配器 + 永不关闭的 transport，**等到文本已流出、且 `model.usage` 已入账**之后再 abort → 状态 `cancelled`、零 `model.message`、用量留痕（ADR-041）。**【本机测试】406 → 413**。
2. **T6 决策**：两个叉由用户拍板——推理内容**进契约并按预设声明回传**；「思考档位 → wire 参数」的映射**写进预设数据**。落成 **ADR-045/046**，T6 随之拆成 T6a（契约与类型）、T6b（两个适配器）、T6c（预设进内核）。
3. **T6a**：`ReasoningBlock = {type:'thinking';text;signature} | {type:'redacted';data}`；`ModelChunk` 增 `reasoning`（**整块**，不是 delta）；`Message.assistant` 增 `reasoning`；`model.message` 带上它；`state.ts` 归约进消息；`run-turn.ts` **原样累积、不做归一化**；`adapters/schema.ts` 增 `reasoningBlockSchema` 与两处解码（事件 + 快照里的消息）。**【本机测试】413 → 416**。

**本次会话没有改 `agent/` 一行**——【源码】已验证：`git diff 4a9e0a8 HEAD -- agent/` 为空（P8 前 v1 树只收安全修复）。

### 前序会话留下的实测发现（保留，**不是**本次会话的产出）

1. 两家 SDK 都不把调用方的 signal 对象交给 `fetch`，而是各自桥接一层、且**桥接在请求结束时拆除**——所以「请求完成后看 signal 的 aborted」量的是拆除，不是取消。
2. Anthropic SDK 的 7 个依赖树成员只有 4 个真进运行时（`@opentelemetry/api`、`standardwebhooks`、`fast-sha256`、`@stablelib/base64`），3 个是纯类型层；`openai` 是零运行时依赖。
3. `APIError.status` 与 `.headers` 在两家 SDK 里都是 `any`，必须显式收窄。

---

## 2. 当前状态

### 已验证 —— 本机【本机测试】（Windows，Node 24.18.0）

- `cd packages/cowcat && npm test`（`pretest` = `tsc` 构建 + ESLint）→ **416 tests / 400 pass / 0 fail / 16 skipped**（T7 之前是 406，T6a 之前是 413）
- `node tools/lint-probe.mjs` **7 条探针全部按预期**；`node tools/check-tarball.mjs` 通过

### 已验证 —— CI 远端【CI 远端】（GitHub Actions，我只观察状态）

| 对象 | 腿 | 结果 |
|---|---|---|
| PR #35（T7） | `packages/cowcat` ubuntu-latest / macos-15 / windows-latest | 全 pass |
| PR #36（docs） | 同上三条 | 全 pass |
| PR #37（T6a） | 同上三条 | 全 pass |
| `main` 的 push（#33 之后） | `CI` + `CI (macOS)` | success |
| `main` 的 push（#35 之后） | `CI` + `CI (macOS)` | success |

> **我未在本地复现 ubuntu / macOS 的结果**：macOS 侧的行为（含 seatbelt 相关）只由 CI 覆盖。其余腿的 skipping 是 `ci.yml` 按路径/草稿规则的刻意设计。

### 项目状态

- `main` = `38acc3a`（含 P4 T1–T5 与 T7）；**T6 的决策与 T6a 尚未合入 `main`**（#36 / #37 仍 OPEN）。
- `packages/cowcat` 仍是 `private: true` 的 `0.0.0`，**从未发布**；`schemaVersion` 仍是 **1**（ADR-019：v2 日志格式从未发布，契约变更不升版本）。
- 运行时依赖 **3 / 6**（`zod`、`openai`、`@anthropic-ai/sdk`）——本次会话未增删任何依赖。
- **平台 / 工作区设置本次会话未变更**（未调用 `opencode_console` 的任何写操作）。若需确认，请单独核对工作区设置与模型开关。

### P4 六项范围的落地情况

| # | 范围 | 状态 |
|---|---|---|
| 1 | `ModelPort` 适配器（OpenAI 兼容 + Anthropic） | ✅ T2/T3 已合 |
| 2 | 流式归一化 → `ModelChunk` | ✅ 含用量与结束原因；**推理内容的契约见 T6a（未合）** |
| 3 | 重试与退避 | ✅ T5 已合 |
| 4 | 录制-回放夹具 | ✅ T4 已合（T7 又加了一对 `paired/final-text`） |
| 5 | 模型预设以数据形式存在 | ⚠️ 决策已落（ADR-045/046）、**T6a 已实现契约部分**；T6b/T6c 未开始 |

### P4 两条出口标准（ADR-043）—— 均已兑现（**已合入 `main`**）

- **「同一回合脚本在两种协议的录制夹具上得到相同的事件序列（归一化后）」**——成立：`test/exit-criteria.test.ts` 把配对夹具过一次 `runTurn`，两个协议对**同一份写死的 golden**；投影口径按 ADR-043（含其第 ⑤ 点：用量按「一次调用取最后一次」折叠后再比，报几次属传输层形态）。
- **「取消在流式中途生效，且不产生半条 `model.message`」**——成立：同文件两个协议各一条端到端断言（真实适配器 + 开而不闭的 transport，等到 `model.usage` 进日志再 abort）：状态 `cancelled`、零 `model.message`、**用量留痕**、日志尾部是取消转移。

### T6a 落地的契约点（**未合**，PR #37）

| 落点 | 内容 |
|---|---|
| `ModelChunk` | 增 `reasoning`，携带**整块**（`{type:'thinking';text;signature}` 或 `{type:'redacted';data}`），按既有 `tool_call` 的口径「一个 chunk = 一个已提交事实」 |
| `Message.assistant` | 增 `reasoning: readonly ReasoningBlock[]`（无推理时为空数组，与 `text`/`toolCalls` 同一取向） |
| `model.message` / `state.ts` / `run-turn.ts` | 事件带上它、归约进 assistant 消息、**原样累积不归一化**（改一个字节的块按 Anthropic 的规则就是 400） |
| `adapters/schema.ts` | `reasoningBlockSchema` + 两处解码；`test/schema.test.ts` 的编译期等价断言强制两边同步 |

三处「绊线」按设计响了：编译期等价断言、两个适配器测试的 `Message` 字面量、`snapshot.test.ts` 的一次 `emit` 全是**编译期**报错；**`exit-criteria` 的 golden 是运行时失败**（投影保留「未点名删除的全部字段」——这正是上一次审查里补的性质第一次真的抓到东西）。

---

## 3. 项目唯一下一步

**P4 的 T6b**，以及在它之前先把 #36 合掉并 rebase #37。

### 合并顺序（有前置，别弄反）

1. **先合 PR #36**（base 是 `main`，docs-only）。
2. 我随后把 `feat/p4-t6a-reasoning-contract` **rebase 到 `main`** 并**重开 PR**：#37 的 base 是 `docs/p4-t6-adrs`（#36 的分支），而**base 分支被删会让 GitHub 直接关闭 PR 且无法重开**（本次在 #34 上实测过）。重开时校验「树内容与 rebase 前一致」（`git diff <旧 tip> HEAD` 为空），本机验证结论因此继续成立。
3. 本交接（`docs/HANDOFF.md`）与 #36/#37 改过同一批文档行，合并时可能需要一次 rebase；**以本文件的版本为准**（它是最终状态的快照）。

### T6b：两个适配器的读写（ADR-038/045）

1. **读**：OpenAI 兼容侧取 `delta.reasoning_content ?? delta.reasoning`（v1 的取法见 `agent/src/llm/openai.js:6-12`）→ 发 `{type:'reasoning'}`，签名填空串；Anthropic 侧聚合 `thinking_delta` 并按 **`signature_delta`** 补齐签名（签名在 `content_block_stop` **之前**到达），脱敏块发 `{type:'redacted';data}`。
2. **写**：只在**预设声明时**把历史里的推理块回传；Anthropic 侧必须**原样、原顺序、签名完整**（改一个字节 = 400 `invalid_request_error`，SDK 类型文档写明）。
3. **`providerOptions` 序列化** + 两类适配器才知道的检查：**保留字**（不许覆盖 `model`/`messages`/`stream`/`max_tokens`）与**协议不变量**（如 `thinking.budget_tokens ≥ 1024 且 < max_tokens`）→ 违反就抛错，不硬发。
4. **`maxTokens` 接线**。
5. 顺带用夹具核一条**回放假设**：thinking 块在一个 assistant 回合里**恒在文本与工具调用之前**（契约不单独存块的位置，靠这条事实重构顺序）。

### T6c：预设进内核（ADR-046）

`ModelPreset` 类型与 `TurnOutcome.notes`；`TurnDeps.preset` **取代** `modelId`（单一事实源）；`maxTokens ← preset.limits.output`（**顺带闭掉 T7 记录的 Anthropic 必填缺口**）；`preset.toolCalls === false` → 不发 `tools` 并随 `notes` 上报；档位未声明则不发 + note；配对夹具补上推理内容、golden 随之更新。

---

## 4. 关键决策

### 本次会话新增（ADR-045/046，PR #36）

| 决策 | 内容 | 出处 |
|---|---|---|
| **推理内容进契约，形状是带不透明签名的块序列** | Anthropic 的 thinking 块回传时**必须原样、原顺序、签名完整**（改一个字节 400）；块**整块**发出而非 delta；`signature: ''` 表示该协议没有签名概念；块相对 `text`/`toolCalls` 的**位置不存**（靠「thinking 恒前置」回放）；`ReasoningBlock` 是厂商块的**封闭子集**（厂商加字段会被解码 strip → 回放 400，须扩形状）；逐 delta 的实时渲染推迟到 P6 | ADR-045 |
| **预设进内核：`TurnDeps.preset` 单一事实源 + 「不猜」落在数据上** | `preset` 取代 `modelId`；`maxTokens ← limits.output`；`toolCalls:false` 不发 `tools` 且随 `TurnOutcome.notes` 上报（**不新增事件**——静态配置事实不是回合内观察到的事实）；厂商扩展 = **预设数据里的 wire 参数**，内核只校验「声明过吗」并透传，适配器只做序列化 + 保留字/协议不变量校验 | ADR-046 |

### 前一会话的 10 条（P4 T1–T5，保留）

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
| **适配器不发明策略** | 契约没说的就拒绝或上报（`inputSchema` / 畸形 arguments 抛错 / 缺 `max_tokens` 拒绝） | ADR-044 |

完整表见 [`architecture/README.md`](architecture/README.md)（ADR-001~046；045/046 已落表、实现分 T6a/b/c）。

---

## 5. 踩坑

### 本次会话真花时间的

1. **GitHub 会直接关闭「base 分支被删」的 PR，且无法重开。** 我先前判断「会自动 retarget 到 `main`」——**错的**：PR #34 的 base（`docs/handoff-p4`）被删后它当场 CLOSED，`gh pr reopen` 也失败（base 已不存在），只能重开一支（#34 → #35）。**叠放提交的代价就在这里**：本次会话已在 #34 上栽过一次，**#37 还会再遇到同一机制**（见 §3 的合并顺序）。合并后请核对 PR 状态，不要假定它转到了 `main`。
2. **PowerShell 5.1 把子进程写到 stderr 的正常输出当失败**：`git push` / `gh` 经 `2>&1 | Select-Object` 后 exit code 是 1，命令本身其实成功。**看输出内容，不要只看退出码**。
3. **`gh ... --jq '… > …'` 里的 `>` 会被 PowerShell 当重定向**（报 `unknown shorthand flag: '>'`）——换成不含 `>` 的表达式（如 `.[0].number, .[0].baseRefName`）。
4. **`Out-File -Encoding utf8` 落盘的中文 JSON 会被 node 读成非法 JSON**（编码/换行被改写），而 `Get-Content` 读回又是乱码。可靠做法：**node 的 `execFileSync('gh'|'git', …)` 直接抓输出写文件，再用 `read` 工具读**。
5. **审查抓到我两处事实性错误**：① ADR-045 把脱敏块写成「有签名」，而 SDK 类型里 `RedactedThinkingBlockParam` 只有 `data`（代码本来就是对的，错的是文档）；② replay 测试的注释声称做了「JSON 往返」，而 `MemoryEventStore` 存的是对象引用，其实没往返。**教训：注释里的每个「保证」都要能被测试真的证实。**
6. **我写错过一处引用**：初稿写「§3.5 的契约设想被取代」，核对后发现那条约束记在 **§3.3 第 3 条**。**先查再写**。
7. **ADR-043 的「投影保留未点名删除的全部字段」第一次真的抓到东西**：T6a 给 `model.message` 加字段后，`exit-criteria` 的 golden 当场运行时失败——正是这条性质存在的理由。

### 前序会话的（**未复现**，按记录保留）

8. `process.moduleLoadList` 不跟踪 ESM，在「哪些传递依赖真进运行时」这个用途上**假阴性**；要不带 signal 的 stub transport 才公平地测取消。
9. `execFileSync` 包一层时子进程会挂住（`spawnSync ETIMEDOUT`），直接跑同一脚本正常——**根因至今未查明**。
10. `edit` 工具的 `oldString` 结尾带上 `\n` 等于要删掉那个换行（改完要读回来确认）；`tools/` 在仓库根，在 `packages/cowcat` 里跑 `node tools/...` 会报「找不到模块」。
11. `APIError.status`/`.headers` 是 `any` → `no-unsafe-argument` 会拦，**显式收窄**；`Partial<T>` 上的 `x === null` 会被 `no-unnecessary-condition` 判为无重叠，但运行时 `null` 确实存在——用 `Record<string, unknown>` 之类的宽类型 + 运行时检查。
12. `gh pr merge --delete-branch` 会自己切分支并尝试 `git pull`；若有未提交改动它会 `Aborting`，于是**合并没走完而你以为是走完了**——合并后显式核对 `git log` 与 `git status`。

---

## 6. 未验证 / 待确认

### 合并与流程（**当下就要处理**）

1. **#36 与 #37 都未合**；#37 的 base 是 #36 的分支，**先合 #36**（详见 §3 的合并顺序）。
2. **本交接文件与 #36/#37 改过同一批文档行**，合并时可能需要 rebase，以本文件为准。

### 厂商行为：有出处但**未实测**

**【上游】有出处**：DeepSeek 同时提供 OpenAI 与 Anthropic 端点并带 `thinking`/`reasoning_effort` 扩展；MiniMax 的 OpenAI 兼容端点、`reasoning_content`、`thinking.type='disabled'` 与 `reasoning_effort='none'` 的 **400** 行为、被静默忽略的参数、多轮 function call 必须带回完整 assistant 消息。

**【源码】已核实的只有「形状」**：Anthropic thinking 块与 `signature_delta` 的字段与到达时机、脱敏块只有 `data`、`budget_tokens ≥ 1024 且 < max_tokens`——这些读的是**装机 SDK 类型**（`packages/cowcat/node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`），不是端点行为。

**【未验证】本次会话对任何模型端点零请求**：`reasoning` 该回传到哪个字段（OpenAI 兼容侧）、MiniMax 的 400 是否真的会发生、其余 200 家端点的流式细节——**一律只能靠 T4 的录制脚本逐家覆盖，不能推断**。

### 已知缺口（**不声称已解决**）

1. **「thinking 块恒在文本与工具调用之前」**：契约不单独存块的位置，回放靠这条协议事实——**待 T6b 用夹具核**；若某家交错出现，要扩契约。
2. **`ReasoningBlock` 是厂商块的封闭子集**：厂商将来在块里加字段时，解码边界（zod 默认 strip 未知键，方向本身对）会静默丢掉 → 回放即「被修改过的块」→ 400。已记档（ADR-045），**未处理**。
3. **产出 catalog 的蒸馏脚本不在仓库里**（`agent/src/llm/presets.js:2` 指向的 `tools/distill-providers.mjs` 不存在）→ **「预设怎么更新」仍未定**（ADR-037/046 都记为遗留）。
4. **`README.md` 的状态行滞后**——【源码】已核实两处：`README.md:15` 写「已发布 `0.15.0`」而 `agent/package.json` 是 `0.16.0`；`README.md:16` 的 v2 状态还写着「P2『端口与执行网关』起继续推进」，实际已到 P4 T6。**哪个是最近一次真实发布未核实**（需要查 npm registry）。
5. **`withPreset` 接缝**（T7 的测试侧包装器，把 `maxTokens` 补进 `ModelRequest`）：由 T6c 的 `TurnDeps.preset` 收口；目前是**已知接缝，不是缺陷**。
6. **两条旧版缺口在 v2 里封不了**：`agent/src/subagent.js:58` 从 `tools === null` 推断 yolo、`agent/src/tools/planmode.js:121-124` 的 `allowedPrompts` 绕过 `validateRule`——v2 没有这两个功能，没有可封的代码。
7. **配置文件与信任记录放哪里仍未定**（组合根职责，等 P6 的 CLI）；**永久化规则机制不存在**（ADR-031 把 `always` 限在会话内）。

### 来自前序记录、**本次未复现**的

1. **macOS flake**：`agent/test/chrome.test.mjs:47` 固定 `sleep(15)` 后断言光标序列，**会随机卡住任何 PR**（它真的卡过 #26）；因 `agent/` 树冻结，「算不算安全修复」的口径问了三轮未答。
2. **`execFileSync` 子进程挂起**的根因（§5 第 9 条）。

### 三个未答的小问题（不阻塞）

1. **macOS flake 要不要开 issue**（同上）。
2. **ADR-034 要不要挪到 033 之后**：ADR 表按主题归组插入过，全表不严格单调；新 ADR 一律追加表末。建议单独一个 `chore/` PR。
3. **ADR-044 是否认可**：T2/T3 的三处「只在代码注释里」的决定已收成一条 ADR；若认为该拆成三条，改它。

### 证据与记忆的差异

- 本次唯一一处是「base 分支被删后 PR 会自动 retarget」——**按实测纠正**（§5 第 1 条），不留差异。
- 其余条目：本文件凡标【上游】/【未验证】的，都是**证据不足**而不是「已否决」；不要把「未验证」读成「不成立」。

---

## 7. 关键文件

| 路径 | 内容 |
|---|---|
| [`dev-plan-v2.md`](dev-plan-v2.md) | **权威计划**。P4 任务拆分表（T1–T7，T6 已拆成 T6a/b/c）与两条出口标准 |
| [`architecture/README.md`](architecture/README.md) | **ADR-001~046**（045/046 是本次决策） |
| [`research/p4-models.md`](research/p4-models.md) | P4 调研：证据边界、六项决定、§7.6（T6 后续决策）、§8 的 12 条断言、§10 待验证清单 |
| [`architecture/01-layers.md`](architecture/01-layers.md) | 分层与端口清单（P4 新增 `ports/model.ts` 与 `adapters/model-*.ts` 已同步） |
| `packages/cowcat/src/kernel/messages.ts` | `Message` / `ToolCall` / **`ReasoningBlock`**（推理块：text+签名 或 脱敏 data） |
| `packages/cowcat/src/ports/index.ts` | `ModelRequest` / `ModelChunk`（**含 `reasoning` 整块**）/ `ToolSpec`（含 `inputSchema?`） |
| `packages/cowcat/src/kernel/run-turn.ts` | 回合主循环：消费 chunk、**usage 随到随记**、**推理原样累积**、chunk 分派的 `default: never` 绊线 |
| `packages/cowcat/src/kernel/events.ts` | `model.message`（含 `stopReason` 与 `reasoning`）与 `model.usage` |
| `packages/cowcat/src/adapters/schema.ts` | 解码边界：`kernelEventSchema` / `sessionSnapshotSchema` / **`reasoningBlockSchema`** |
| `packages/cowcat/src/adapters/model-openai.ts` | OpenAI 兼容适配器（Chat Completions）；`reasoning` 的读写是 T6b |
| `packages/cowcat/src/adapters/model-anthropic.ts` | Anthropic 适配器（连续工具结果合并进一条 user 消息）；`thinking_delta`/`signature_delta` 的读写是 T6b |
| `packages/cowcat/src/adapters/model-retry.ts` | 重试/退避/`sleepAbortably`；分类器留在各适配器 |
| `packages/cowcat/test/exit-criteria.test.ts` | **P4 出口标准**：配对夹具 → `runTurn` → 同一 golden；两个协议的取消端到端断言 |
| `packages/cowcat/test/fixtures.ts` | 夹具定位（**从包根解析**，因为夹具不进 `dist/`）与加载 |
| `packages/cowcat/test/fixtures/` | `paired/`（跨协议配对：`text-and-tool` + `final-text`）+ `synthetic/`（钉板） |
| `packages/cowcat/test/support.ts` | `turnDeps` / `ScriptedModel` / `replayTransport` / `openEndedTransport` / `sequenceTransport` / `settlesWithin`（**新增依赖只改这里**） |
| `tools/record-fixture.mjs` | 录制脚本：不写请求头；`logical` 留空由人填写 |
| `tools/lint-probe.mjs` | 7 条 lint 探针（含 SDK 边界禁令）——**规则真的会报错** |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | 三条 `packages/cowcat` 腿；草稿 PR 不跑检查 |
