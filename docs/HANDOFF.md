# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾（或按用户要求做会话收尾）重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-21（删除 v1 合入；`cowcat setup` 接线与 v1 配置迁移写出）**。
> 交接时仓库状态：**`main` = `dbdc7b8`**（#85 合入）；当前分支 **`feat/p8-setup`**（未提交/未推送）。
>
> **证据分级**（沿用前几轮，逐条标注）：**【源码】**读代码/读装机类型；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（cowcat/cli 用系统 Node **24.18.0**；v2 的测试跑在 `dist/` 编译产物上）；**【本机命令】**本机跑的其他命令（`git`、`doctor`、探针脚本）；**【CI 远端】**GitHub Actions（**本次没有推送，未观察**）；**【上游】**厂商文档或实现；**【推断】**未实测的推论，不得作为决策依据。
> **本会话没有真实终端、没有模型端点、没有发布动作、没有平台设置变更。**

---

## 1. 本次会话实际做了什么

按用户指定的四步，把 MCP 从「调研草案」推进到「首版可运行」：

### 第 1 步：补读 2026-07-28 规范

读了 `basic/versioning`、`basic/transports/stdio`、`server/discover`、`server/tools`、`client/elicitation`、`basic`（`_meta`）。四条改变设计的结论：

1. **只发 `initialize` 的客户端连不上现代服务器**（兼容矩阵「Legacy / Modern = Fails」）。草案里的「先走 initialize 兼容路径」是错的，必须双时代探测。
2. **elicitation 不是服务器主动发请求**：它把响应变成 `resultType: "input_required"`，客户端带 `inputResponses` 重试。所以传输循环只有「响应 + 通知」两种入站消息。
3. **`tools/list` 就是全部工具**（可分页、可缓存）；没有第二套发现机制。「tool search」是客户端侧检索，不是协议层。
4. **`resultType` 缺失按 `complete` 处理**（旧版兼容）。

### 第 2 步：命名对照

- Claude Code：`mcp__<server>__<tool>`（插件是 `mcp__plugin_<plugin>_<server>__<tool>`）。
- opencode：服务器名 + `_` 前缀（`myname_*`）。
- 取 Claude Code 的双下划线形状；**不静默消毒**服务器名（ADR-084）。

### 第 3 步：ADR-083~087 落表

比草案多一条，因为实现预演时发现 `ProcessPort.run()` **承载不了长驻双向通道**（`stdin` 写一次就关闭，`ports/process.ts:96-97`）：

| ADR | 一句话 |
|---|---|
| 083 | 只做 stdio + tools；双时代探测（`server/discover` → 失败才 `initialize`）；`input_required` 报未支持 |
| 084 | `mcp__<server>__<tool>`；服务器名不合法或工具冲突就拒绝启动；`risk: exec` |
| 085 | 项目层服务器需受信；项目层 `env` 被忽略；env 由宿主组装并过 ADR-015 脱敏 |
| 086 | `ProcessPort` 增加 `open()` 长驻句柄；不新增 spawn 点；`run()` 不变 |
| 087 | 宿主构造时启动、关闭时终止、取消两层都停、崩溃不重启、结果走 `ToolResult` + `Truncation` |

### 第 4 步：T1 实现

- `ports/process.ts`：`ProcessHandle` / `ProcessExit` / `open()`。
- `adapters/process.ts`：`NodeProcess.open()`——与 `run()` 共用 `#prepare()`（沙箱解析、env 脱敏），stdout 按行切分、stderr 尾部、一次终止、abort 即终止。
- `adapters/mcp/client.ts`：双时代探测、`_meta`、JSON-RPC 关联、`tools/list`、`tools/call`、取消、关闭；结果映射 `ToolResult` + `truncation`。
- `adapters/mcp/tools.ts`：命名与 `risk: 'exec'`。
- `adapters/mcp/servers.ts`：启动、冲突拒绝、失败跳过、聚合关闭。
- `policy/config.ts` + `adapters/config.ts`：`mcp.servers` 与来源层（`SourcedMcpServer`）。
- `host/config.ts`：`selectMcpServers()`（信任闸门 + 项目层 env 丢弃）。
- `host/host.ts`：构造时启动、工具表合并、`close()` 关闭服务器、跳过原因进 `configWarnings`。
- `cli/doctor.ts`：`mcp` 行列出可运行的服务器与未受信跳过数（**不启动**服务器）。
- 测试：`test/mcp.test.ts` 7 项 + `test/host.test.ts` 1 项端到端（协议客户端 → 真正宿主 → 真正子进程）。

### T2：分页与工具变更订阅（ADR-088）

- `client.ts`：`tools/list` 跟随 `nextCursor`（上限 100 页 / 5,000 工具，重名工具后来的忽略）；`watchTools()` 现代服务器发 `subscriptions/listen` 并等 2 秒 ack，旧版直接等推送；`onToolsChanged()` 分发 `notifications/tools/list_changed`，带 `subscriptionId` 时校验来源。
- `servers.ts`：工具表改为**活表**（内置工具从 `baseTools` 传入）；收到通知后只替换该服务器拥有的工具；刷新失败保留旧表；运行期新工具冲突只跳过该工具并警告。
- 测试从 7 项增加到 11 项：分页、旧版推送、现代订阅、活表刷新（`mcp__fake__change` → `mcp__fake__added`）。
- **`doctor` 仍然不连接服务器**（ADR-084 ⑤），所以「连接状态」这一项没有做——它与「诊断命令不执行项目代码」冲突。

### 真实端点实测（2026-10-21）

用临时 `COWCAT_HOME` 跑了两条完整链路（没有碰用户的 `~/.cowcat/config.json`）：

| 链路 | 结果 |
|---|---|
| `bigmodel/glm-5.3-flash` + 仓库假 MCP 服务器 | 模型调用 `mcp__fake__echo`，输出 `echo: hello`，退出 0 |
| `bigmodel/glm-5.3-flash` + `@modelcontextprotocol/server-everything@2.0.0` | 模型调用 `mcp__everything__echo`，输出 `Echo: hello-real`，退出 0 |

- `zai/glm-5.3-flash`（OpenAI 协议）先试过：**429 Insufficient balance**——key 有效，账号没有余额。`bigmodel`（Anthropic 协议）可用。
- 真服务器用 npm 装到临时目录、`node dist/index.js stdio` 启动；**没有走 `npx`**。
- **实测抓到一个真 bug**：`run --yes` 在 `approval.requested` 事件到达时立刻回答，但内核先写事件、后调 `approve()`，答案在桥注册前到达 → `no approval is pending`，回合挂到 5 分钟超时。已修：宿主按 `callId` 暂存早到的答案（ADR-064 ⑧ 的 T2 修正），并加了确定性回归测试。
- **另一个与 MCP 无关的发现**：真实 `~/.cowcat/config.json` 是 **v1 形状**（`model` 字符串 + `providers.*.apiKey`），v2 严格 schema 拒绝（`doctor` 两项 FAIL）。P8 切换前必须迁移或兼容读取。

### P8 第一步：v1 配置兼容（ADR-089）

真实配置不再被拒绝——`loadConfig` 按**形状**识别 v1 并翻译成 v2 的内存层，**不重写文件**：

- `model: "provider/model"` → `model.preset`；
- 顶层 `providers` → `model.providers`（`baseURL`/`api` → `baseUrl`，`apiKey` 只留在内存，`env[0]` → `apiKeyEnv`）；
- `sandbox: "off"|"light"`、`{ envDeny }` → `sandbox.mode` / `sandbox.env.deny`；
- `permissions` 明确**不迁移**（是另一套规则语言），未知键列出来；
- 内联 `apiKey`：环境变量优先，**不写回、不进日志、不进警告内容**；`doctor` 只报「有内联 key」。

补了两个 coding-plan 内置 provider（`zai-coding-plan`、`volcengine-coding-plan`），因为真实配置的模型是 `zai-coding-plan/glm-5.3-flash`，而 v2 原先只认识 `zai` 与 `bigmodel`。

**真实 home 验证**（没有改用户的文件）：

- `cowcat doctor` 从「2 项 FAIL」变成通过，模型解析为 `zai-coding-plan/glm-5.3-flash`（openai → `https://api.z.ai/api/coding/paas/v4`），key 行显示「v1 内联 apiKey」；
- `cowcat run "Reply with exactly one word: READY"` 用真实配置的内联 key 跑通，输出 `READY`，退出 0。

**未迁移**：v1 的项目 `.cowcat/config.json`、`mcp.json`、`state.json` 都没有自动读。`mcp.json` 是独立文件与独立信任模型，需要单独决定。

### P8 包切换（#84）与删除 v1（本分支）

**包切换**（ADR-090）：

- `packages/cli` 改名为 **`@corescense/cowcat`**，四包统一 `1.0.0-beta.1`、去掉 `private`；
- `tools/pack-release.mjs` 把四包复制到暂存目录，内部 `file:` 依赖改写成精确版本，排除 `.map` 与 test，再 `npm pack`；
- `--install` 会把四个 tarball 装进临时项目并跑 `cowcat --version`，本机已通过；
- CI 的 `package whitelist` 腿改为构建四包后打包并安装。

**删除 v1**（本分支）：

- `agent/` 整棵树删除，仓库只剩 `packages/*`；
- 根目录 `bin/cowcat` 指向 `packages/cli/dist/src/cli/main.js`；
- 旧 CI 的 `scope`、`test`、`test-windows`、`test node 24` 与 macOS legacy 作业全部删除；
- v1 专用探针删除（`legacy-config-probe`、`legacy-trust-probe`、`probe-guards`、`p5-glob-grep-probe`、`p6-tui-probe`、`run-ccagent-kimi`）；
- 旧文档归档到 `docs/archive/`（ROADMAP、sandbox 研究/计划、fix-plan、MCP channel、read-multimodal、v1 USAGE、TUI redesign）；
- README / AGENTS / CONTRIBUTING / SECURITY / PUBLISH / changelog 改成 v2 口径。

### P8：`cowcat setup` 接线（ADR-091）

- `--migrate`：读 v1 用户配置，经 ADR-089 翻译后写 v2；原文件备份为 `config.json.bak`；内联 `apiKey` **不写入**，只提示应该设置的环境变量名。
- `--preset <provider/model>`：新建 v2 配置；`--api-key-env` / `--base-url` 覆盖；`--print` 只输出；已有 v2 配置需要 `--force`（覆盖前备份）。
- `~/.cowcat/mcp.json` 的 `{ mcpServers }` 迁移到 `mcp.servers`；`env` 不迁移并警告（可能含密钥）。
- 写文件：先写临时文件再 rename，权限 `0600`。
- 5 项 CLI 测试：迁移不复制密钥、`--print` 不落盘、无 `--force` 拒绝覆盖、未知 preset、缺失 v1 文件。

---

## 2. 当前状态

### 已验证 —— 【本机测试】/【构建】/【本机命令】

- 【本机测试】`packages/cowcat` → **662 tests / 646 pass / 0 fail / 16 skipped**（`pretest` = `tsc` + ESLint 通过）
- 【本机测试】`packages/protocol` → **42 / 42 pass**
- 【本机测试】`packages/cli` → **26 / 26 pass**
- 【本机测试】`packages/tui` → **48 / 48 pass**（`npx --yes node@26.12.0 --test "dist/test/**/*.test.js"`）
- 【本机测试】`packages/tui` → 本会话未改该包、**未重跑**（上一轮 48 / 48；CI 两条腿当时通过）
- 【本机命令】`node tools/lint-probe.mjs` → 未重跑（本会话没加分层规则；`npm run lint` 已过）
- 【本机命令】`cowcat doctor` 实跑：新增 `mcp 未配置服务器` 行；其余行不变

### 已验证 —— MCP 的具体行为（`test/mcp.test.ts`）

- 现代服务器：`server/discover` 成功 → `era = modern`、版本 `2026-07-28`；`tools/list` 六个工具；`tools/call` 回文本。
- 旧版服务器：`server/discover` 回 `-32601` → 回退 `initialize`，`era = legacy`，工具仍可用。
- 崩溃：调用中进程退出 → `ok: false`，理由含 `exited`；**没有重启**。
- 取消：`AbortController.abort()` → 先发 `notifications/cancelled`，再终止进程；调用返回 `ok: false`。
- env 脱敏：`light` 档下 `MCP_TEST_TOKEN` 被剥离（服务器看到 `missing`）；`off` 档不剥离（对照）。
- 冲突/非法名：与内置工具同名 → 该服务器拒绝启动并点名；`bad name` → 不启动并报告。
- 宿主端到端：项目层 `cowcat.json` 声明服务器 + 工作区受信 → 模型能在回合里调用 `mcp__fake__echo`，`tool.finished.ok = true`，且没有触发审批（用户层 allow 规则匹配）。
- T2 分页：`paginated` 模式两页合并，warning 记 `2 pages`。
- T2 变更：旧版推送、现代 `subscriptions/listen` + ack 均能触发刷新；活表从 6 个工具变成 7 个（`mcp__fake__added`），内置 `TodoWrite` 不受影响。
- **真实端点**（非注入模型）：`bigmodel/glm-5.3-flash` 两次真实回合都成功；一次对假服务器，一次对 `server-everything@2.0.0`（§1）。
- **审批竞态**：回合开始前就回答 `respondApproval`，答案被暂存并在 `approve()` 到达时消费，Write 真正执行（回归测试）。
- **v1 配置**：真实 `~/.cowcat/config.json` 被翻译后 `doctor` 通过，且一次真实回合用内联 key 成功；v2 文档带 `apiKey` 仍被严格 schema 拒绝（形状门控测试）。
- **发布包**：`node tools/check-tarball.mjs --install` 四包打包通过；临时安装后 `cowcat --version` = `1.0.0-beta.1`，`--help` 正常；tarball 无 test/src/.map/file:。
- **删除 agent 后**：四包测试分别 646 / 42 / 26 / 48 全过。
- **setup**：临时 home 里 v1 配置 + `mcp.json` → `setup --migrate` 写出 v2（无 `apiKey`、无 mcp `env`、有 `.bak`），随后 `doctor` 通过；`--print` 不落盘；无 `--force` 拒绝覆盖。

### 项目状态

- **P6 完成**；**P7 完成**（压缩、指令、子 agent、MCP）；**P8 进行中**：v1 配置兼容（089）、包切换（090）、删除 `agent/` 已完成；发布、CHANGELOG、`setup` 未完成。
- 四个包版本 `1.0.0-beta.1`，`private` 已去掉，但**尚未发布**（registry 仍是 v1 `0.15.0`）。
- 运行时依赖不变（3 / 6）。
- `cowcat` 六个动词：`tui` / `serve` / `run` / `sessions list|resume` / `doctor` 可用；`setup` 未接线。

---

## 3. 项目唯一下一步

**先提交并推送删除 `agent/` 的 PR；然后是发布批次。**

P8 还没做的：

1. **发布批次**：四个 `package.json` 与 `tools/pack-release.mjs` 的 `VERSION` 已是 `1.0.0-beta.1`；需要人工 2FA 从暂存目录按 protocol → core → tui → cli 发布（`docs/PUBLISH.md`）。
2. **分支保护 contexts**：旧 `scope` / `test · node 22` 等 required checks 已从 CI 删除，仓库设置里要同步移除，否则 PR 会等一个永不上报的检查（仓库设置，不由代码完成）。
3. **v1 残留迁移**：项目 `.cowcat/config.json`、`state.json` 未自动读；`~/.cowcat/mcp.json` 已由 `setup --migrate` 迁移（env 除外）。
4. **CHANGELOG 发布标记**：`docs/changelog.md` 的 `1.0.0-beta.1` 段落仍带「未发布」，发布时摘掉。

MCP 剩余项（`.cmd`/`npx` 入口、真实 `list_changed`、macOS `light` 档）排在发布之后。

---

## 4. 关键决策

P7 已落地的 ADR 见 [`architecture/README.md`](architecture/README.md)（**ADR-001~091**）。MCP 六条：083~087 是首版，088 是 T2；P8 三条：089 v1 配置兼容、090 发布包切换、091 setup 写配置。与子 agent 的边界一致：**新事实用新事件 + 可选字段**，但 MCP 没有新增事件——工具名本身携带来源，避免再触发一次 `schema.ts` / transcript 的编译期守卫。

---

## 5. 踩坑（真花时间的，跨会话仍然成立）

1. **Windows 的 `git commit -m "…"` 带引号会被截断** → 用 `git commit -F <文件>`。
2. **PowerShell 把 git/gh 的 stderr 当成错误**：`git push`、`gh pr merge` 输出 "Exited with code 1" 是假警报，看有没有 `abc..def branch -> branch` / 合并成功即可。
3. **`gh pr merge` 会因分支落后被拒**：先把 `main` 并进分支、重跑 CI 再合；不要用 `--admin` 绕。
4. **控制台把 UTF-8 显示成乱码不等于文件坏了**：判据是**字节**——用 `read` 工具读回、或落盘后比对。
5. **`websearch` 本机不可用（HTTP 402）**，`webfetch` 直连官方文档可用。
6. **`edit` 的 `oldString` 以整行开头时可能吃掉下一行**（历史上踩过三次）：改完**读回来**，ADR 表用脚本校验行数与重复 id。
7. **删源文件必须清 `dist/`**；v2 测试跑在 `dist/` 上，`pretest` 才会重新 build。
8. **期望帧/快照不能放在 `dist/` 里**（会被 build 清掉），要编译进产物（`test/frames.ts`）。
9. **`file:` 依赖是 junction，npm 不装也不构建**：消费者腿要自己构建 `../protocol`（cli 腿是 protocol → cowcat → tui 三步）。
10. **探针全过 ≠ 包级 lint 过**：加规则后必须跑 `npm run lint`。
11. **`assert.equal` 会窄化类型**，随后的 `?.`/`??` 被 `no-unnecessary-condition` 判多余；`no-non-null-assertion` 全仓禁用。
12. **测试里连着调两次「隔离 home」的 helper**：第二个覆盖第一个的 `COWCAT_HOME`，断言会去错目录找文件。
13. **`cowcat` 的 bin 指向 `dist/src/cli/main.js`**（不是 `dist/cli/main.js`）。
14. **`.githooks` 要每克隆手动启用**（`git config core.hooksPath .githooks`）。
15. **新增事件类型会撞两处编译期守卫**（`schema.test.ts` 的 `Equals`、`exit-criteria.test.ts` 的 `never` 分支）；本次 MCP **刻意不加事件**，所以没撞。
16. **`assert.deepEqual(x?.y, …)` 会窄化 `x`**：后面再写 `x?.z` 就被判多余。先取局部变量。
17. **不要用 PowerShell 的 `Get-Content` / `Set-Content` 批量改源码**：会按 ANSI 码页解码 UTF-8。批量替换用 `edit` 或 Node 脚本（本次 `Add-Content` 追加还引入了 1 个 CRLF，已用 Node 归一化）。
18. **`packages/tui` 的测试要 Node ≥26.4**（opentui）；本机系统 Node 24 跑不了。
19. **`ProcessPort.run()` 的 `stdin` 是「写一次就关」**：MCP stdio 需要的双向通道不存在，必须用 `open()`（ADR-086）。「所有子进程都经网关」是结论，「网关能承载长驻通道」不是。
20. **Windows 上子进程的 cwd 锁住目录**：测试清理临时目录时必须**先关宿主（终止服务器）再 `rmSync`**，否则 EPERM。`t.after` 的注册顺序不可依赖，本次改成单个 after 里顺序执行。
21. **`server/discover` 的探测不能写死错误码**：旧版服务器回 `-32601`/`-32602` 或干脆不回；只有 `DiscoverResult` 与 `-32022` 才说明它是现代服务器。
22. **现代 MCP 的 `list_changed` 要先订阅**：不发 `subscriptions/listen` 就不会收到；确认信号是 `notifications/subscriptions/acknowledged`（通知，不是请求的 result），所以等 result 会一直等下去。旧版服务器则直接推通知。两种都要处理。
23. **`approval.requested` 先写、`approve()` 后调**：任何「看到事件就立刻回答」的前端都会撞上这个窗口（`run --yes` 实测）。宿主必须暂存早到的答案，不能直接报 `no approval is pending`。
24. **真实 `~/.cowcat/config.json` 是 v1 形状**：`model` 是字符串、`providers.*.apiKey` 是内联密钥；v2 的严格 schema 会拒绝。跑任何 v2 真实端点测试都要用 `COWCAT_HOME` 指向临时目录，别拿用户配置做实验。
25. **Windows 上 `npx` 是 `.cmd`**：`ProcessPort` 用 `shell:false`，不能直接 spawn `.cmd`。真实 MCP 服务器测试要指向包内的 `dist/index.js` 并用 `node` 启动，或另做 `.cmd` 解析（尚未做）。
26. **删除 `agent/` 不会删除历史引用**：源码注释、调研文档里仍有 `agent/src/...:行号`，它们是迁移依据的历史证据，不要当成活路径去读。根目录 `bin/cowcat`、README、AGENTS、CI 必须一起改。
27. **required check 按 job name 匹配**：删掉 legacy job 后，仓库分支保护里的旧 contexts 仍会等一个永不上报的检查。这是仓库设置，代码改完要人工同步。
28. **发布 tarball 里的 `file:` 依赖必须改写**：本地 `npm pack` 直接发出去，消费者装不上。用 `tools/pack-release.mjs`，并跑 `--install` 演练。

---

## 6. 未验证 / 待确认

1. **真实模型只验证了两种形状**：`bigmodel/glm-5.3-flash` 的临时配置、以及真实 home 的 `zai-coding-plan/glm-5.3-flash`（v1 兼容层）；都是单轮、单工具、`--yes`。多轮工具、拒绝路径、压缩后继续、子 agent 的真实端点都没跑。
2. **MCP 只在 Windows 上验证**：`light` 档的 macOS/Linux 路径未测；`system` 档被显式拒绝（没有执行器）也未测。
3. **`npx`/`.cmd` 入口未验证**：Windows 的 `.cmd` 不能 `shell:false` 直启；真实服务器测试用的是包内 `dist/index.js` + `node`。
4. **真实服务器的 `list_changed`/分页未触发**：`server-everything` 只做了 `tools/list` + `tools/call`；订阅 ack 行为仍是未知。
5. **`doctor` 不连接服务器**：配置层的名字与受信结论可见，工具数不可见。
6. **v1 配置兼容已做（ADR-089），但不是全量迁移**：`permissions`、v1 项目 `.cowcat/config.json`、`~/.cowcat/mcp.json`、`state.json` 都没有读；内联 `apiKey` 仍留在旧文件里（只在内存使用）。
7. **子 agent 的收益仍是推断**（研究型任务的 15× / 90.2% 不必然适用于编码）。
8. **前序遗留随 `agent/` 一起删除**：两个 macOS flake、`distill-providers.mjs` 缺失、v1 套件都不再适用。
9. **分支保护 contexts**：删除 legacy jobs 后，仓库设置里的旧 required checks 仍存在；需要人工移除，并把新的包腿加进去。
10. **`cowcat setup` 已接线（ADR-091）**，但仍是**非交互**的：向导式问答没有做；滚动回看、预览模态、Plan/Act 双模式仍未做。
11. **本次改动未推送**：分支只在本地，CI 未跑；四个包**尚未发布**。

---

## 7. 关键文件

| 路径 | 内容 |
|---|---|
| [`dev-plan-v2.md`](dev-plan-v2.md) | **权威计划**：P0–P8 阶段表、P7 的模块表、R3~R8 远期项 |
| [`architecture/README.md`](architecture/README.md) | **ADR-001~091**（070~074 压缩；075~078 指令；079~082 子 agent；083~088 MCP；089 v1 配置兼容；090 发布包切换；091 setup） |
| [`architecture/03-policy-and-execution.md`](architecture/03-policy-and-execution.md) | 进程网关：`run()` 与 `open()` 两种形状、脱敏、终止 |
| [`research/p7-mcp.md`](research/p7-mcp.md) | 本次产出：上游对照（含补读后的修正）、决定、ADR 清单、待验证 |
| `packages/cowcat/src/ports/process.ts` | `ProcessSpec` / `ProcessResult` / `ProcessHandle` / `open()` 契约 |
| `packages/cowcat/src/adapters/process.ts` | `NodeProcess.open()`：按行切分、stderr 尾部、一次终止 |
| `packages/cowcat/src/adapters/mcp/` | `client.ts`（双时代 + JSON-RPC + 分页/订阅）、`tools.ts`（命名/risk）、`servers.ts`（启动/冲突/活表刷新/关闭） |
| `packages/cowcat/src/host/config.ts` | `selectMcpServers()`：受信闸门 + 项目层 env 丢弃 |
| `packages/cowcat/src/adapters/config.ts` | v2 严格解码 + v1 兼容翻译（`isV1Document` / `translateV1`） |
| `packages/cli/src/cli/setup.ts` | `cowcat setup`：迁移 v1、新建 v2、迁移 `mcp.json`（不写密钥） |
| `packages/cowcat/src/host/presets.ts` | 内置 provider/preset（含 `zai-coding-plan`、`volcengine-coding-plan`） |
| `packages/cowcat/src/host/model.ts` | 选择与建端口；环境变量优先，v1 内联 key 仅作回退 |
| `packages/cowcat/src/host/host.ts` | 构造时启动 MCP、合并工具表、`close()` 关闭 |
| `packages/cowcat/test/mcp.test.ts` | 协议与进程边界（现代/旧版/崩溃/取消/脱敏/冲突/分页/变更订阅/活表） |
| `packages/cowcat/test/fixtures/fake-mcp-server.ts` | 假服务器（stdio、换行分隔 JSON-RPC） |
| `docs/HANDOFF.md` | 本文件 |
