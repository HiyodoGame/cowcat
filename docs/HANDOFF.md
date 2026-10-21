# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾（或用户要求做会话收尾）重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-21（会话收尾；`1.0.0-beta.2` 已发布）**。
> 交接时仓库状态：**`main` = `d220cf5`**（#90 合入），工作区干净；没有进行中的分支。
>
> **证据分级**（逐条标注）：**【源码】**读代码/读装机类型；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（系统 Node **24.18.0**；v2 测试跑 `dist/` 产物）；**【本机命令】**本机其他命令（`git`、`doctor`、探针、`npx`）；**【CI 远端】**GitHub Actions 的运行结果（只观察状态）；**【registry】**npm registry 查询；**【上游】**厂商文档；**【推断】**未实测的推论，不得作为决策依据。
>
> **归属**：本会话产出为 **#80–#90**；`main` 上 `1b03a42`（#79）及更早的提交属于前序会话，不计入本次工作。
> **平台设置**：分支保护的 required checks 由用户在本会话中修改；本次只通过 GitHub API 核对，未修改仓库设置。

---

## 1. 本次实际工作

### PR 一览（全部在本会话创建并合入）

| PR | 内容 | 结果 |
|---|---|---|
| **#80** | MCP T1：ADR-083~087 + `ProcessPort.open()` + stdio 客户端 + 动态工具表 | squash 合入 `01a5a59` |
| **#81** | MCP T2：分页 + `subscriptions/listen`/旧版 `list_changed` + 活工具表（ADR-088） | squash 合入 `b578f43` |
| **#82** | 修复 `run --yes` 早到审批答案丢失（真实端点实测发现） | squash 合入 `f4afe52` |
| **#83** | P8 v1 配置兼容读取（ADR-089） | squash 合入 `ea930c2` |
| **#84** | P8 包切换：CLI 改名 `@corescense/cowcat`，四包 `1.0.0-beta.1`，发布暂存脚本（ADR-090） | squash 合入 `b352684` |
| **#85** | 删除 `agent/`，CI 收敛，旧文档归档 | squash 合入 `dbdc7b8` |
| **#86** | `cowcat setup` 接线：v1 迁移写出 + `--preset` 新建（ADR-091） | squash 合入 `ff3afe4` |
| **#87** | beta.1 发布记录与文档修正 | squash 合入 `0477e76` |
| **#88** | TUI Node 门槛提示给出可复制命令 | squash 合入 `7ba1b99` |
| **#89** | `1.0.0-beta.2` 版本批次 | squash 合入 `6e5090e` |
| **#90** | beta.2 发布记录 | squash 合入 `d220cf5` |

### MCP 补读与 T1/T2

补读了 2026-07-28 规范的 `basic/versioning`、`stdio`、`server/discover`、`server/tools`、`client/elicitation`、`basic`（`_meta`）。改变设计的结论：

- **只发 `initialize` 的客户端连不上现代服务器**（兼容矩阵 Legacy/Modern = Fails）→ 客户端实现为**双时代**：先 `server/discover`，`-32022` 换版本重试，其他错误/无响应才回退 `initialize`；判据不写死错误码。
- **elicitation 是 MRTR**：服务器在响应里返回 `resultType: "input_required"`，客户端带 `inputResponses` 重试；不是服务器主动发 JSON-RPC 请求。首版声明不支持。
- **`tools/list` 就是全量发现**（分页 + 缓存）；没有第二套注册机制。
- 命名对照 Claude Code（`mcp__<server>__<tool>`）与 opencode（服务器名前缀），取双下划线形状，且不静默消毒服务器名。

T1 实现时发现 **`ProcessPort.run()` 的 `stdin` 写一次就关闭**，承载不了长驻双向通道 → ADR-086 增加 `open()` 返回 `ProcessHandle`，与 `run()` 共用沙箱解析、env 脱敏与终止路径。MCP 适配器仍不直接 `spawn`。

T2 增加了 `nextCursor` 分页（上限 100 页 / 5,000 工具）、现代 `subscriptions/listen` + 2 秒 ack、旧版直接推送、活工具表（只替换该服务器拥有的工具）、运行期冲突只跳过该工具。

**没有新增 `KernelEvent`**：工具名本身携带来源，避免再触发 `schema.ts` / transcript 的两处编译期守卫。

### 真实端点实测（2026-10-21）

用临时 `COWCAT_HOME`，没有改用户的配置：

| 链路 | 结果 |
|---|---|
| `bigmodel/glm-5.3-flash` + 仓库假 MCP 服务器 | 模型调用 `mcp__fake__echo` → `echo: hello`，退出 0 |
| `bigmodel/glm-5.3-flash` + `@modelcontextprotocol/server-everything@2.0.0` | 模型调用 `mcp__everything__echo` → `Echo: hello-real`，退出 0 |

- `zai/glm-5.3-flash`（OpenAI 协议）先试过：**429 Insufficient balance**；key 有效，账号无余额。`bigmodel`（Anthropic 协议）可用。
- 真实服务器用 npm 装到临时目录、`node dist/index.js stdio` 启动（没走 `npx`）。
- **抓到真 bug**：`run --yes` 看到 `approval.requested` 就回答，但内核先写事件、后调 `approve()`，答案在桥注册前到达 → `no approval is pending`，回合挂到 5 分钟超时。宿主改为按 `callId` 暂存早到答案（ADR-064 ⑧ 的修正）；回归测试在「回合开始前就回答」。
- 发现真实 `~/.cowcat/config.json` 是 **v1 形状**，v2 严格 schema 拒绝——推动 P8 配置兼容。

### P8：配置兼容、包切换、删除 v1、setup

- **v1 配置兼容（ADR-089）**：按形状识别（`model` 字符串 / 无 model 且 provider 带 `apiKey`），翻译 `model`、`providers`、`sandbox`；`permissions` 不迁移并警告；内联 `apiKey` 只在内存使用（环境变量优先，不写回/不记录）。补了 `zai-coding-plan`、`volcengine-coding-plan` 内置 provider 与 GLM preset。真实 home 的 `doctor` 与一次真实回合都已通过。
- **包切换（ADR-090）**：`packages/cli` 改名 **`@corescense/cowcat`**，四包 `1.0.0-beta.x`、去 `private`、加 README/LICENSE。`tools/pack-release.mjs` 复制到暂存目录、把内部 `file:` 依赖改写成精确版本、排除 `.map`/test，再打包；`--install` 安装 tarball 并跑 `cowcat --version`。本地开发继续用 `file:`（ADR-062 否决 workspaces）。
- **删除 `agent/`**：整棵树、v1 专用探针、legacy CI 作业；根 `bin/cowcat` 指向 `packages/cli/dist/src/cli/main.js`；旧文档归档到 `docs/archive/`；README/AGENTS/CONTRIBUTING/SECURITY/PUBLISH/changelog 改为 v2。
- **`cowcat setup`（ADR-091）**：`--migrate` 写 v2、备份原文件、不复制密钥；`--preset` 新建；`--api-key-env`/`--base-url`/`--force`/`--print`；`~/.cowcat/mcp.json` 的 `mcpServers` 迁移到 `mcp.servers`（`env` 不迁移并警告）；原子写 + `0600`。

### 发布

- **beta.1**（四包）与 **beta.2**（四包）都已发布到官方 registry。
- beta.2：`@corescense/cowcat` 的 `beta` → `1.0.0-beta.2`，`latest` 仍为 v1 `0.15.0`；三个 support 包的 `beta` → beta.2，`latest` 仍停在 beta.1。
- tarball SHA-1 与 registry `dist.shasum` 四包逐一相同；`npx --yes --registry=https://registry.npmjs.org @corescense/cowcat@beta --version` → `1.0.0-beta.2`。

---

## 2. 当前状态

### 已验证 —— 【本机测试】/【构建】/【CI 远端】/【registry】

- 【本机测试】`packages/cowcat` → **662 tests / 646 pass / 0 fail / 16 skipped**（`pretest` = `tsc` + ESLint）
- 【本机测试】`packages/protocol` → **42 / 42 pass**
- 【本机测试】`packages/cli` → **26 / 26 pass**
- 【本机测试】`packages/tui` → **48 / 48 pass**（`npx --yes node@26.12.0 --test "dist/test/**/*.test.js"`；系统 Node 24 不能跑 opentui）
- 【本机命令】`node tools/lint-probe.mjs` → 四包 21 条探针全部符合预期（删除 agent 后重跑）
- 【本机命令】`node tools/check-tarball.mjs --install` → 四包打包 + 临时安装 + `cowcat --version` = `1.0.0-beta.2`
- 【CI 远端】#90 的 8 项检查全绿（四包 Linux/Windows、macOS v2、`package whitelist`）
- 【registry】四包 `1.0.0-beta.2` 可见；dist-tags 与 shasum 见 §1
- 【本机命令】Git Bash 下 `bin/cowcat --version` = `1.0.0-beta.2`（本地 dist 与当前版本一致）
- 【本机命令】`cowcat doctor`（发布版 beta.2，空 `COWCAT_HOME`）通过；真实 home 的 v1 兼容 `doctor` 通过

### 项目状态

- **P1–P7 完成**（内核/端口、策略、模型、工具、前端、压缩/指令/子 agent/MCP）。
- **P8 基本完成**：配置兼容、包切换、删除 `agent/`、CI 收敛、旧文档归档、`setup` 接线、两轮 beta 发布均已完成。
- 四个包版本 **`1.0.0-beta.2`**、可发布；CLI 的 `latest` 仍是 v1 **`0.15.0`**，beta 用 `@beta`。
- `cowcat` 六个动词：`tui` / `serve` / `run` / `sessions list|resume` / `doctor` / `setup` 均已接线；TUI 需 Node ≥ 26.4。
- 分支保护 required checks 已由用户更新，当前 8 项均为新包腿（本次用 API 核对）。

---

## 3. 项目唯一下一步

**进入 beta 反馈期；先做真实用户路径验证，再决定 `latest` 是否切到 1.0.0。**

具体建议顺序：

1. **真实配置路径**：在真实 home 上执行 `cowcat setup --migrate`（先确认备份），再 `doctor`、`run`、`serve`；观察 v1 配置兼容与迁移后的实际行为。
2. **TUI**：Node 26 下跑 `cowcat tui` 与 `sessions resume`，确认门槛提示、渲染与审批卡。
3. **`latest` 决策**：beta 稳定后再把 `latest` 指到 1.0.0；这一步会改变现有 v1 用户的默认安装，需要单独决定。
4. **P8 残留**：v1 项目 `.cowcat/config.json`、`state.json` 未自动迁移；`setup` 仍是非交互。
5. **MCP 剩余**：真实服务器的 `list_changed`/分页、Windows `.cmd`/`npx` 入口、macOS/Linux 的 `light` 档。

---

## 4. 关键决策

P7 已落地的 ADR 见 [`architecture/README.md`](architecture/README.md)（**ADR-001~091**）。

| ADR | 一句话 |
|---|---|
| **083** | MCP 首版只做 stdio + tools；双时代探测；`input_required` 报未支持 |
| **084** | 动态工具表 `mcp__<server>__<tool>`；服务器名不合法或工具冲突就拒绝启动；`risk: exec` |
| **085** | 项目层服务器需受信；项目层 `env` 被忽略；env 由宿主组装并过 ADR-015 脱敏 |
| **086** | `ProcessPort.open()` 长驻句柄；不新增 spawn 点；`run()` 不变 |
| **087** | 构造时启动、关闭时终止、取消两层都停、崩溃不重启、结果走 `ToolResult` + `Truncation` |
| **088** | T2：分页上限、`subscriptions/listen` + ack、旧版推送、活表刷新、运行期冲突只跳过该工具 |
| **089** | v1 配置按形状兼容读取；内联 `apiKey` 只内存使用；不重写文件 |
| **090** | CLI 接管 `@corescense/cowcat`；发布暂存重写 `file:`；四包同版本 |
| **091** | `cowcat setup`：迁移 v1 / 新建 v2；不读不写密钥值；`mcp.json` 的 env 不迁移 |

**发布策略**：beta 期只动 `beta` dist-tag，不动 `latest`；`latest` 切换是独立决定。

---

## 5. 踩坑（跨会话仍然成立）

1. **Windows 的 `git commit -m "…"` 带引号会被截断** → 用 `git commit -F <文件>`。
2. **PowerShell 把 git/gh 的 stderr 当成错误**：`git push`、`gh pr merge` 的 "Exited with code 1" 是假警报，看分支行/合并结果。
3. **`gh pr merge` 会因分支落后被拒**：先把 main 并进分支、重跑 CI 再合；不要用 `--admin` 绕。
4. **控制台把 UTF-8 显示成乱码不等于文件坏了**：判据是字节——用 `read` 工具读回或落盘比对。
5. **`websearch` 本机不可用（HTTP 402）**，`webfetch` 直连官方文档可用。
6. **`edit` 的 `oldString` 以整行开头时可能吃掉下一行**：改完读回来；ADR 表用脚本校验行数与重复 id。
7. **删源文件必须清 `dist/`**；v2 测试跑 `dist/`，`pretest` 才会重新 build。
8. **期望帧/快照不能放在 `dist/`**（会被 build 清掉），要编译进产物。
9. **`file:` 依赖是 junction，npm 不装也不构建**：消费者腿要按 protocol → cowcat → tui → cli 自己构建。
10. **探针全过 ≠ 包级 lint 过**：加规则后必须跑 `npm run lint`。
11. **`assert.equal` 会窄化类型**，随后的 `?.`/`??` 被 `no-unnecessary-condition` 判多余；`no-non-null-assertion` 全仓禁用。
12. **测试里连着调两次「隔离 home」的 helper**：第二个覆盖第一个的 `COWCAT_HOME`。
13. **`cowcat` 的 bin 指向 `dist/src/cli/main.js`**（不是 `dist/cli/main.js`）。
14. **`.githooks` 要每克隆手动启用**（`git config core.hooksPath .githooks`）。
15. **新增事件类型会撞两处编译期守卫**（`schema.test.ts` 的 `Equals`、`exit-criteria.test.ts` 的 `never` 分支）；MCP 刻意没有新增事件。
16. **`assert.deepEqual(x?.y, …)` 会窄化 `x`**：先取局部变量。
17. **不要用 PowerShell 的 `Get-Content` / `Set-Content` 批量改源码**：会按 ANSI 码页解码 UTF-8；批量替换用 `edit` 或 Node 脚本。
18. **`packages/tui` 的测试要 Node ≥26.4**（opentui）；本机系统 Node 24 用 `npx node@26.12.0`。
19. **`ProcessPort.run()` 的 `stdin` 是「写一次就关」**：MCP stdio 需要 `open()`（ADR-086）。
20. **Windows 上子进程的 cwd 锁住目录**：测试清理临时目录必须先关宿主再 `rmSync`，否则 EPERM；`t.after` 顺序不可依赖。
21. **`server/discover` 的探测不能写死错误码**：旧版可能回 `-32601`/`-32602` 或不回；只有 `DiscoverResult` 与 `-32022` 说明它是现代服务器。
22. **现代 MCP 的 `list_changed` 要先订阅**：确认信号是 `notifications/subscriptions/acknowledged`（通知，不是请求 result）；旧版直接推。
23. **`approval.requested` 先写、`approve()` 后调**：任何「看到事件就回答」的前端都会撞窗口；宿主必须暂存早到答案。
24. **真实 `~/.cowcat/config.json` 是 v1 形状**：跑真实端点测试用 `COWCAT_HOME` 隔离，别拿用户配置做实验。
25. **Windows 上 `npx` 是 `.cmd`**：`ProcessPort` 用 `shell:false`，不能直接 spawn；真实 MCP 服务器测试用包内 `dist/index.js` + `node`。
26. **删除 `agent/` 不会删除历史引用**：注释与调研里的 `agent/src/...` 是历史证据，不是活路径；根 `bin/cowcat`、README、AGENTS、CI 必须一起改。
27. **required check 按 job name 匹配**：删掉 legacy job 后，分支保护的旧 contexts 会等一个永不上报的检查（本次由用户更新，API 核对）。
28. **发布 tarball 里的 `file:` 依赖必须改写**：用 `tools/pack-release.mjs`，并跑 `--install` 演练。
29. **发布顺序**：protocol → core → tui → cli。只发 CLI 会让安装去取不存在的 support 包版本，报 E404；CLI 本身不需要重发。
30. **npmmirror 有同步延迟**：本机默认 registry 是镜像，`npx @beta` 可能仍解析到上一版；验证/安装用 `--registry=https://registry.npmjs.org`。
31. **support 包的 `latest` 不会随 `--tag beta` 前进**：CLI 用精确版本依赖，不影响安装；要一致性就手动 `npm dist-tag add ... latest`。

---

## 6. 未验证 / 待确认

1. **真实模型只验证了两种形状**：`bigmodel/glm-5.3-flash`（临时配置）与真实 home 的 `zai-coding-plan/glm-5.3-flash`（v1 兼容层）；都是单轮、单工具、`--yes`。多轮工具、拒绝路径、压缩后继续、子 agent 的真实端点都没跑。
2. **MCP 只在 Windows 上验证**：`light` 档的 macOS/Linux 路径未测；`system` 档被显式拒绝（没有执行器）也未测。
3. **`npx`/`.cmd` 入口未验证**：真实服务器测试用包内 `dist/index.js` + `node`。
4. **真实服务器的 `list_changed`/分页未触发**：`server-everything` 只做了 `tools/list` + `tools/call`；订阅 ack 行为未知。
5. **`doctor` 不连接服务器**：配置层的名字与受信结论可见，工具数不可见。
6. **v1 兼容不是全量迁移**：`permissions`、v1 项目 `.cowcat/config.json`、`state.json` 未读；`~/.cowcat/mcp.json` 由 `setup --migrate` 迁移（`env` 除外）；内联 `apiKey` 仍留在旧文件里（只在内存使用）。
7. **`setup --migrate` 没有在用户真实 home 上执行**：只在临时 home 验证；真实配置迁移由用户决定。
8. **子 agent 的收益仍是推断**（研究型任务的 15× / 90.2% 不必然适用于编码）。
9. **`setup` 仍是非交互**：向导式问答未做；滚动回看、预览模态、Plan/Act 双模式仍未做。
10. **`latest` 仍是 v1 `0.15.0`**：现有用户默认安装不会切到 v2；这是待决策项，不是遗漏。
11. **`packages/tui` 的 Node 26 行为**：本机只在测试运行器下验证，真实终端的人眼验收仍未做。
12. **本会话没有修改平台设置**：分支保护由用户更新；本次只用 API 核对，未做其他仓库/工作区设置变更。

---

## 7. 关键文件

| 路径 | 内容 |
|---|---|
| [`dev-plan-v2.md`](dev-plan-v2.md) | **权威计划**：P0–P8 阶段表、P7 模块表、R3~R8 远期项 |
| [`architecture/README.md`](architecture/README.md) | **ADR-001~091**（070~074 压缩；075~078 指令；079~082 子 agent；083~088 MCP；089 配置兼容；090 包切换；091 setup） |
| [`architecture/03-policy-and-execution.md`](architecture/03-policy-and-execution.md) | 进程网关：`run()` 与 `open()` 两种形状、脱敏、终止 |
| [`research/p7-mcp.md`](research/p7-mcp.md) | MCP 上游对照（含补读修正）、决定、ADR 清单、待验证 |
| `packages/cowcat/src/ports/process.ts` | `ProcessSpec` / `ProcessResult` / `ProcessHandle` / `open()` 契约 |
| `packages/cowcat/src/adapters/process.ts` | `NodeProcess.open()`：按行切分、stderr 尾部、一次终止 |
| `packages/cowcat/src/adapters/mcp/` | `client.ts`（双时代 + JSON-RPC + 分页/订阅）、`tools.ts`（命名/risk）、`servers.ts`（启动/冲突/活表/关闭） |
| `packages/cowcat/src/host/config.ts` | `selectMcpServers()`：受信闸门 + 项目层 env 丢弃 |
| `packages/cowcat/src/adapters/config.ts` | v2 严格解码 + v1 兼容翻译（`isV1Document` / `translateV1`） |
| `packages/cli/src/cli/setup.ts` | `cowcat setup`：迁移 v1、新建 v2、迁移 `mcp.json`（不写密钥） |
| `packages/cowcat/src/host/presets.ts` | 内置 provider/preset（含 `zai-coding-plan`、`volcengine-coding-plan`） |
| `packages/cowcat/src/host/model.ts` | 选择与建端口；环境变量优先，v1 内联 key 仅作回退 |
| `packages/cowcat/src/host/host.ts` | 构造时启动 MCP、合并工具表、`close()` 关闭；早到审批答案暂存 |
| `tools/pack-release.mjs` | 发布暂存、`file:` 改写、tarball 白名单、`--install` 演练 |
| `packages/cowcat/test/mcp.test.ts` | 协议与进程边界（现代/旧版/崩溃/取消/脱敏/冲突/分页/变更订阅/活表） |
| `packages/cowcat/test/fixtures/fake-mcp-server.ts` | 假服务器（stdio、换行分隔 JSON-RPC） |
| `docs/archive/` | v1 与旧架构历史档案，不是现行规范 |
