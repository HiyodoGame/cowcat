# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-18**（P4 的 T1–T5 落地之后）
> 交接时仓库状态：`main` = `4a9e0a8`，工作区干净

---

## 1. 本次实际做了什么

**P4（模型层）推进到 T5**，另有两件顺带的事。共 8 个 PR：

| PR | 内容 |
|---|---|
| #25 | 修 P3 状态漂移（架构 README + 开发计划，4 处） |
| #26 | P4 调研 `docs/research/p4-models.md`（决定草案 + ADR 清单） |
| #27 | 落 **ADR-035~043** + 定下依赖上限口径 + 补 P4 任务拆分表 |
| #28 | **T1 契约与事件**（ADR-035/040/041） |
| #29 | **T2 OpenAI 兼容适配器** + 注入 transport（ADR-036/042） |
| #30 | **T3 Anthropic 适配器**（ADR-036/040） |
| #31 | **T4 录制-回放夹具与录制脚本**（ADR-042）+ **ADR-044** |
| #32 | **T5 重试、退避与取消边界**（ADR-039） |

**测试 347 → 406**（`fail` 全程为 0）。ADR 表到 **ADR-044**。运行时依赖 **3 / 6**（`zod`、`openai`、`@anthropic-ai/sdk`）。

### 三件值得单独记住的实测发现

1. **两家 SDK 都不把调用方的 signal 对象交给 `fetch`**，而是各自桥接一层，且**桥接在请求结束时拆除**。这否证了我在 T2 里写的一条断言（「请求完成后 `fetch` 手里的 signal 是 aborted」）——那**量的是拆除不是取消**。真实性质是行为：遵守 signal 的传输层上，中途 abort 必须让流停下。**适配器因此不需要自建取消管线**；唯一的例外是退避等待（T5）。
2. **Anthropic SDK 的 7 个依赖树成员里只有 4 个真进运行时**（`@opentelemetry/api`、`standardwebhooks`、`fast-sha256`、`@stablelib/base64`），**3 个是纯类型层**（`json-schema-to-ts`、`ts-algebra`、`@babel/runtime`）。取证用了解析钩子 + 源码扫描两种方法。`openai` 是零运行时依赖。
3. **一个必须知道的读法**：`APIError.status` 与 `.headers` 在两家 SDK 里都是 `any`。

---

## 2. 当前状态

### 已验证 —— CI 实跑

| 腿 | 结果 |
|---|---|
| `packages/cowcat · node 22 · ubuntu-latest` | pass |
| `packages/cowcat · node 22 · macos-15` | pass |
| `packages/cowcat · node 22 · windows-latest` | pass |
| `test · node 22 · ubuntu-latest` / `macos-15` | pass |

### 已验证 —— 本机（Windows，Node 24.18.0）

`npm test` **406 tests / 390 pass / 0 fail / 16 skipped**。另：`tools/lint-probe.mjs` **7 条探针全部按预期**（含 T2 新增的两条 SDK 边界探针）、`tools/check-tarball.mjs` 通过。

### 项目状态

- **P4 到 T5 落地**；`packages/cowcat` 仍是 `private: true` 的 `0.0.0`，**从未发布**，`schemaVersion` 仍是 **1**。
- **旧 `agent/` 树本次未改动一行**（P8 前只收安全修复）。
- `docs/architecture/README.md` 的状态行已同步为「P4 的 T1–T5 已合，T6/T7 未开始」。

### P4 六项范围的落地情况

| # | 范围 | 状态 |
|---|---|---|
| 1 | `ModelPort` 适配器（OpenAI 兼容 + Anthropic） | ✅ 两个都落了 |
| 2 | 流式归一化 → `ModelChunk` | ✅ 含用量与结束原因 |
| 3 | 重试与退避 | ✅ T5 |
| 4 | 录制-回放夹具 | ✅ T4（配对夹具 + 钉板 + 录制脚本） |
| 5 | 模型预设以数据形式存在 | ❌ **T6 未开始** |

### P4 两条出口标准的现状

- **「同一回合脚本在两种协议的录制夹具上得到相同的事件序列（归一化后）」**——**适配器层已经成立**：T4 的配对夹具有一条测试断言两个适配器从两种不同编码产出同样的归一结果。**内核层（`runTurn` 的事件序列）尚未断言**，那是 T7。
- **「取消在流式中途生效，且不产生半条 `model.message`」**——**结构上成立**（`run-turn.ts:109` 只在流结束后才写 `model.message`），两个适配器各有「中途 abort 让流停下」的测试，T1 另有一条 runTurn 层的「用量活过取消、零 `model.message`」。**两条合起来的一次端到端断言仍在 T7。**

---

## 3. 项目唯一下一步

**P4 的 T6 与 T7。** 范围见 [`dev-plan-v2.md`](dev-plan-v2.md) 的 `## P4` 任务表。

### T6：模型预设为数据（ADR-037/038）

1. `ModelPreset` 类型：形状沿用 `agent/assets/providers.json`（`protocol` / `api` / `env` + 每模型的 `limit` / `tool_call` / `reasoning_options` / `cost`）。**数据由组合根注入，内核只认类型**。
2. `tool_call: false` 的模型**不发 `tools`**，并把「该模型不支持工具」作为**可判定事实**上报。
3. 厂商扩展**不猜默认值**：只发预设声明过的档位，逃生口按协议分别映射（MiniMax 的 `reasoning_effort: 'none'` 与 `thinking.type: 'disabled'` 都会 **400**）。
4. **注意**：产出 catalog 的蒸馏脚本**不在仓库里**（`agent/src/llm/presets.js:2` 指向的 `tools/distill-providers.mjs` 不存在）。沿用「数据形状」可行，「怎么更新它」是遗留问题。
5. `thinking_delta` / `reasoning_content` **目前刻意不映射**（契约里没有推理内容的位置，T3 把它留给了 T6）——T6 要决定要不要加。

### T7：出口标准（ADR-043）

**这是整阶段的兑现点，也是最能出成果的一步**，因为夹具已经就位：

1. 把 T4 的**配对夹具**（`test/fixtures/{openai,anthropic}/paired/text-and-tool`）送进 **`runTurn`**，断言两条路径产生**同样的内核事件序列**。
2. 比对前必须按 **ADR-043** 做投影：剥掉 tool call id（用 `call_<index>` 归一）、`seq`、`ts`、`sessionId`、`turnId`、chunk 切分；**保留** text、`toolCalls[].name`/`input`、归一后的 stopReason、四项 usage。**比的是「已提交事实」而不是 delta**（chunk 边界是传输层偶然）。
3. 第二条出口标准：一条「流中途 abort」的端到端断言——**零 `model.message`**，且**拿到用量之后的取消仍留下用量**（ADR-041 的存在理由，T1 已有单测，T7 补 runTurn 层的）。

---

## 4. 关键决策（本轮新增 10 条）

| 决策 | 内容 | 出处 |
|---|---|---|
| **契约要补三类信息** | `ModelRequest` 增 `model`/`system`/`maxTokens`/厂商扩展逃生口；`ModelChunk` 增 `usage` 与 `stop`；**结束原因归一但保留厂商原值** | ADR-035 |
| **协议只做两种** | OpenAI 兼容（Chat Completions，**不用 Responses**）+ Anthropic 原生；数据 201 / 8 | ADR-036 |
| **预设是数据，内核只认类型** | 形状沿用 providers.json | ADR-037 |
| **厂商扩展不猜默认值** | 只发预设声明过的档位 | ADR-038 |
| **重试在适配器内** | 默认 2 次、尊重 `Retry-After`、**取消涵盖退避等待**、**不重试已开始输出的流** | ADR-039 |
| **用量归一四项，合并而非覆盖** | Anthropic 的 `message_delta` 会省略可选键 | ADR-040 |
| **用量进日志，独立事件** | `model.usage`（评审拍板）——取消时也留痕 | ADR-041 |
| **夹具录原始字节** | 注入 transport 使 CI 不访问网络；录制脚本不落请求头 | ADR-042 |
| **出口标准比对口径** | 一条 golden、两个协议、比已提交事实、配对夹具必须是同一逻辑回合的两种编码 | ADR-043 |
| **适配器不发明策略** | 契约没说的就拒绝或上报（`inputSchema` / 畸形 arguments 抛错 / 缺 `max_tokens` 拒绝） | ADR-044 |

完整表见 [`architecture/README.md`](architecture/README.md)（ADR-001~044）。

---

## 5. 踩坑（都是这次真花时间换来的）

**关于证据**

1. **`process.moduleLoadList` 不跟踪 ESM。** 我用它查「哪些传递依赖真进运行时」，两家 SDK 自己都没出现在表里——**这个工具在这个用途上是假阴性**。改用 `registerHooks` 的解析钩子才拿到真答案。
2. **「请求完成后看 signal 的 aborted」量的是拆除，不是取消。** 见 §1 第 1 条。**同一件事我错了两次**：先写了断言，又在发现 Anthropic 侧是 `false` 时一度以为那是 SDK 缺陷。
3. **我的探针第一版是错的**：stub transport 忽略了 `init.signal`，于是「Anthropic 不响应取消」看起来像缺陷，其实是我的 stub 不遵守 signal。**公平的探针要模拟真实传输层的行为**。
4. **两处测试期望是我写错的**（T5）：已 aborted 的信号走提前返回、压根不注册监听器；以及「流中途断时半截输出被保留」依赖 SDK 缓冲行为、不可靠。**改的是测试不是代码**，但两次都值得先怀疑自己的理解。

**关于工具（Windows / 本机）**

5. **`execFileSync` 包一层时子进程会挂住**（`spawnSync ETIMEDOUT`），同一个脚本**直接跑正常**。T4 的录制脚本端到端验证因此改成直接调用；**子进程那条路径至今未查明**。
6. **`edit` 工具里 oldString 结尾带上 `\n` 就等于要删掉那个换行。** 我犯了两次，把两行注释和一行代码分别接到了下一行——**改完要读回来确认**，这次两次都是靠读回来发现的。
7. 目录名影响命令能否找到文件：`tools/` 在**仓库根**，在 `packages/cowcat` 里跑 `node tools/...` 会报「找不到模块」而不是「脚本失败」。
8. 早先几条仍然有效：`git commit -m` 带引号会被截断（用 `-F`）；`Get-Content`/`Select-String` 在中文 UTF-8 上数行号不可靠（用 `read`/`rg`/`node -e`）；`node -e` 里嵌套引号在 PowerShell 下必坏（写脚本文件）。

**关于 gh / 分支**

9. **`gh pr merge --delete-branch` 会自己切分支并尝试 `git pull`**；若当时有未提交改动，它会 `Aborting`，于是你以为合并流程走完了，实际本地 main 还落后一个提交、而改动留在旧树上。**合并后请显式核对 `git log` 与 `git status`**（这次我因此把依赖装到了错的树上，靠 `git checkout --` + `pull --ff-only` 恢复）。

**关于 TypeScript / lint**

10. `APIError.status` / `.headers` 是 `any` → `no-unsafe-argument` 会拦，**显式收窄**而不是断言。
11. `Partial<T>` 上的 `x === null` 会被 `no-unnecessary-condition` 判为「无重叠」——但运行时的 `null` 恰恰不是 `undefined`，**守卫会漏掉它存在的理由**。用 `Record<string, unknown>` 之类的宽类型 + 运行时检查。
12. Promise executor 里「先声明 `let timer` 再在闭包里读」会触发 `prefer-const`；**调整声明顺序**（提前 `if (aborted) return`）比改成对象容器更干净。
13. 测试里 `assert.ok(x)` 能收窄判别联合；日志解码的**编译期等价断言**在这一轮又按设计报红两次（T1 的 `stopReason`、新事件），**那是对的**。

---

## 6. 未验证 / 待确认

### 三个**未回答的小问题**（不阻塞，但记着）

1. **macOS flake 要不要开 issue**：`agent/test/chrome.test.mjs:47` 用固定 `await sleep(15)` 等一次真实屏幕渲染，`:49` 就断言光标序列已写出。它**真的卡过 #26**（同一 commit 重跑即绿，`main` 同镜像 10 分钟前也是绿的）。**它是一条会随机卡住任何 PR 的必过检查**，且在冻结的 `agent/` 树里（修它要先定「算不算安全修复」的口径）。已问三轮未答。
2. **ADR-034 要不要挪到 033 之后**：ADR 表里 034 排在 023 之后（P3 期间按主题归组插入），全表不严格单调。新 ADR 一律追加在表末。建议单独一个 `chore/` PR。
3. **ADR-044 是否认可**：T2/T3 的三处「只在代码注释里」的决定已收成一条 ADR（内容见 §4）；若认为该拆成三条，改它。

### 已知缺口（**不声称已解决**）

1. **`architecture/README.md` 的状态行滞后**（见 §2）——实现到 T5 了，状态行还写着「实现未开始」。
2. **两条旧版缺口在 v2 里封不了**：`subagent.js:58` 从 `tools === null` 推断 yolo、`tools/planmode.js:121-124` 的 `allowedPrompts` 绕过 `validateRule`。v2 没有这两个功能，**没有可封的代码**。
3. **配置文件与信任记录放哪里仍未定**（组合根的职责，等 P6 的 CLI）。
4. **永久化规则机制不存在**（ADR-031 把 `always` 限在会话内）。
5. **`execFileSync` 下的子进程挂起**（§5 第 5 条）未查明。
6. **推理内容没有归宿**：`thinking_delta` / `reasoning_content` 刻意不映射，留给 T6 决定。

### 厂商差异：哪些有出处、哪些还没有

**有出处（【上游】）**：DeepSeek 同时提供 OpenAI 与 Anthropic 端点并带 `thinking`/`reasoning_effort` 扩展；MiniMax 的 OpenAI 兼容端点、`reasoning_content`、`thinking.type='disabled'` 与 `reasoning_effort='none'` 的 **400** 行为、被静默忽略的参数、多轮必须保留完整 assistant 消息。

**未验证**：其余 200 家端点的流式细节**一律未取到样例**——`websearch` 本轮不可用（HTTP 402），只用了 `webfetch` 与 Context7，**没有做跨来源交叉验证**。`Retry-After` 在国产端点的存在率也未验证。**这些都只能靠 T4 的录制脚本逐家覆盖**，不能推断。

---

## 7. 关键文件

| 路径 | 内容 |
|---|---|
| [`dev-plan-v2.md`](dev-plan-v2.md) | **权威计划**。P4 的任务拆分表（T1–T7）与两条出口标准 |
| [`architecture/README.md`](architecture/README.md) | **ADR-001~044** |
| [`research/p4-models.md`](research/p4-models.md) | P4 调研：证据边界、六项决定、§8 的 12 条 T1 断言、§10 待验证清单 |
| `packages/cowcat/src/ports/model.ts` | `ModelUsage` / `StopReason` / `StopReasonKind`（放在自己文件里是为了打断 `index.ts` ↔ `events.ts` 的循环） |
| `packages/cowcat/src/ports/index.ts` | `ModelRequest` / `ModelChunk` / `ToolSpec`（含 `inputSchema?`） |
| `packages/cowcat/src/kernel/run-turn.ts` | 回合主循环：消费 chunk、**拿到 usage 立刻 emit**、chunk 分派的 `default: never` 绊线 |
| `packages/cowcat/src/kernel/events.ts` | `model.message`（含 `stopReason`）与 `model.usage` |
| `packages/cowcat/src/adapters/model-openai.ts` | OpenAI 兼容适配器（Chat Completions） |
| `packages/cowcat/src/adapters/model-anthropic.ts` | Anthropic 适配器（连续工具结果合并进一条 user 消息） |
| `packages/cowcat/src/adapters/model-retry.ts` | 重试/退避/`sleepAbortably`；分类器留在各适配器 |
| `packages/cowcat/test/fixtures.ts` | 夹具定位（**从包根解析**，因为夹具不进 `dist/`）与加载 |
| `packages/cowcat/test/fixtures/` | `paired/`（跨协议配对）+ `synthetic/`（钉板） |
| `packages/cowcat/test/support.ts` | `turnDeps` / `ScriptedModel` / `replayTransport` / `openEndedTransport` / `sequenceTransport` / `settlesWithin`（**新增依赖只改这里**） |
| `tools/record-fixture.mjs` | 录制脚本：不写请求头；`logical` 留空由人填写 |
| `tools/lint-probe.mjs` | 7 条 lint 探针（含 SDK 边界禁令）——**规则真的会报错** |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | 三条 `packages/cowcat` 腿；草稿 PR 不跑检查 |
