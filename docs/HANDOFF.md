# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾（或按用户要求做会话收尾）重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-21（MCP T1 合入；T2 分页与变更订阅）**。
> 交接时仓库状态：**`main` = `01a5a59`**（#80 MCP T1 合入）；当前分支 **`feat/p7-mcp-t2`**（MCP T2，未提交/未推送）。
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

---

## 2. 当前状态

### 已验证 —— 【本机测试】/【构建】/【本机命令】

- 【本机测试】`packages/cowcat` → **655 tests / 639 pass / 0 fail / 16 skipped**（`pretest` = `tsc` + ESLint 通过）
- 【本机测试】`packages/cli` → **21 / 21 pass**
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

### 项目状态

- **P6 完成**；**P7 进行中**：压缩（ADR-070~074）、指令（075~078）、子 agent（079~082）已完成；**MCP T1 已合（083~087），T2 已完成（088，待提交）**。
- 四个包仍全部 `private: true`、`0.0.0`，从未发布；`schemaVersion` 仍是 **1**（本次没有新事件类型）。
- 运行时依赖不变（3 / 6）。
- `cowcat` 六个动词：`tui` / `serve` / `run` / `sessions list|resume` / `doctor` 可用；`setup` 未接线。

---

## 3. 项目唯一下一步

**先提交并推送 MCP T2 的 PR；然后补真实端点实测，或继续 MCP T3。**

T2 之后的已知缺口（都不阻塞合并）：

1. **`light` 档在 macOS/Linux 是否挡得住真实服务器**：本次只在 Windows 上跑了 `node` 假服务器（Windows 的 `light` 只做脱敏）。bwrap/seatbelt 的路径白名单是否挡住 `npx` 缓存，仍未验证。
2. **`tools/call` 的 `input_required`**：报未支持，不实现 elicitation。
3. **真实服务器**：`npx -y @modelcontextprotocol/server-*` 未跑过（本机没有网络授权）；真实服务器的订阅 ack 行为也未知。
4. **`doctor` 连接状态**：与「诊断命令不执行项目代码」冲突，T2 明确不做；工具数只在宿主启动后进 `configWarnings`。
5. **`mcp.servers` 的用户文档**：目前只有 ADR 与研究文档，没有面向用户的配置示例。

**仍未做的事**：真实模型请求仍是零实测（§6.1）。MCP 的验证是「协议形状 + 进程边界」，不是「模型会用这些工具」。

---

## 4. 关键决策

P7 已落地的 ADR 见 [`architecture/README.md`](architecture/README.md)（**ADR-001~088**）。MCP 六条：083~087 是首版，088 是 T2 的分页与变更订阅。与子 agent 的边界一致：**新事实用新事件 + 可选字段**，但 MCP 没有新增事件——工具名本身携带来源，避免再触发一次 `schema.ts` / transcript 的编译期守卫。

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

---

## 6. 未验证 / 待确认

1. **一次真实模型请求都没跑过**（跨会话未变）：所有回合行为都在宿主层用注入模型验证。`ZHIPU_API_KEY` 不在本机 shell 里。
2. **MCP 只在 Windows 上验证**：`light` 档的 macOS/Linux 路径未测；`system` 档被显式拒绝（没有执行器）也未测。
3. **真实 MCP 服务器未连接**：只用了仓库内假服务器（`test/fixtures/fake-mcp-server.ts`）。
4. **真实服务器未连接**：只用了仓库内假服务器（`test/fixtures/fake-mcp-server.ts`）；分页与 `list_changed` 的触发也是假服务器模拟的，真实服务器的 ack 行为未知。
5. **`doctor` 不连接服务器**：配置层的名字与受信结论可见，工具数不可见。
6. **子 agent 的收益仍是推断**（研究型任务的 15× / 90.2% 不必然适用于编码）。
7. **前序遗留、未复现**：`agent/` 的两个 macOS flake；`agent/src/llm/presets.js:2` 指向的 `tools/distill-providers.mjs` 不在仓库里；v1 套件（762 项）本会话未跑。
8. **`packages/cli` 与 `packages/protocol` 尚未进分支保护 required 列表**（改仓库设置是用户的事）。
9. **`cowcat setup` 未接线**；滚动回看、预览模态、Plan/Act 双模式仍未做。
10. **本次未推送**：分支只在本地，CI 未跑。

---

## 7. 关键文件

| 路径 | 内容 |
|---|---|
| [`dev-plan-v2.md`](dev-plan-v2.md) | **权威计划**：P0–P8 阶段表、P7 的模块表、R3~R8 远期项 |
| [`architecture/README.md`](architecture/README.md) | **ADR-001~088**（070~074 压缩；075~078 指令；079~082 子 agent；083~088 MCP） |
| [`architecture/03-policy-and-execution.md`](architecture/03-policy-and-execution.md) | 进程网关：`run()` 与 `open()` 两种形状、脱敏、终止 |
| [`research/p7-mcp.md`](research/p7-mcp.md) | 本次产出：上游对照（含补读后的修正）、决定、ADR 清单、待验证 |
| `packages/cowcat/src/ports/process.ts` | `ProcessSpec` / `ProcessResult` / `ProcessHandle` / `open()` 契约 |
| `packages/cowcat/src/adapters/process.ts` | `NodeProcess.open()`：按行切分、stderr 尾部、一次终止 |
| `packages/cowcat/src/adapters/mcp/` | `client.ts`（双时代 + JSON-RPC + 分页/订阅）、`tools.ts`（命名/risk）、`servers.ts`（启动/冲突/活表刷新/关闭） |
| `packages/cowcat/src/host/config.ts` | `selectMcpServers()`：受信闸门 + 项目层 env 丢弃 |
| `packages/cowcat/src/host/host.ts` | 构造时启动 MCP、合并工具表、`close()` 关闭 |
| `packages/cowcat/test/mcp.test.ts` | 协议与进程边界（现代/旧版/崩溃/取消/脱敏/冲突/分页/变更订阅/活表） |
| `packages/cowcat/test/fixtures/fake-mcp-server.ts` | 假服务器（stdio、换行分隔 JSON-RPC） |
| `docs/HANDOFF.md` | 本文件 |
