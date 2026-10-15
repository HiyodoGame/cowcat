# CowCat changelog

## 0.12.0（2026-10-16）— P1–P5：思考链流式 / 工具增量 / 右侧面板 / 轻量沙箱 / 并行执行

- **稳定性修复（摸底深挖批次）**：`-p` 模式在所有 return 路径（含 `--max-turns` 超限、`--output-schema` 失败）经 try/finally 统一执行子进程清理——修复「模型开了 `run_in_background` 任务后 CLI 挂起直到任务超时」的 CI 静默挂起；新增 SIGTERM 处理器（原来只有 SIGINT，docker stop/CI runner 杀进程时留下孤儿）；MCP stdio server 与后台 registry 纳入信号清理范围（`bin/cowcat.mjs`）。
- **权限规则覆盖 MCP 工具**：`mcp__<server>__<tool>` 名跳过 knownTools 启动快照校验（工具在连接后才注册，预置规则此前全被跳过并告警），规则名允许 `-`/`.`（`get-issue` 这类 MCP 工具名原来连解析都过不了）；MCP 连接后重跑 applyRules，`/permissions add` 用实时工具列表（`src/perrules.js`、`bin/cowcat.mjs`）。
- **后台任务输出保留尾部**：TaskOutput 超 20000 字符时从尾部截断并标注丢弃量——此前保头截断丢掉的正是报错栈与测试汇总（`src/background.js`、`src/tools/taskoutput.js`）。
- **后台子代理可取消**：`startAsync` 向任务函数传入 AbortSignal 并经 Agent 工具 → spawnAgent → runLoop → provider.chat 贯通；修复 `/tasks kill` 对异步任务抛 TypeError 被吞、假成功的缺陷；已取消任务的迟到结果不再覆盖 killed 终态（`src/background.js`、`src/subagent.js`、`src/tools/agent.js`）。
- **cron 按会话隔离**：`takeDueCrons(now, { sessionId })`，A 会话创建的定时任务不再在 B 会话里作为用户消息触发；外来任务原样保留不删，无 sessionId 的历史任务保持全量触发（向后兼容）（`src/tools/cron.js`、`bin/cowcat.mjs`）。
- **文档诚实化**：`diagnostic` IDE 事件自 0.7.0 起只存在于文档/注释，代码从未发射——`USAGE.md` 与 `src/ide.js` 注释改为只承诺实际发射的 `file_edited`（`docs/USAGE.md`、`agent/src/ide.js`）。

### 第二轮（遗留事项）

- **MCP 协议加固**（`src/mcp.js`）：① Streamable HTTP 的 `mcp-session-id` 在 initialize 响应头捕获、后续请求回传（此前要求 session 的 server 在第二步必然失败）；② SSE 响应逐条解析所有 `data:` 帧并挑出响应帧（此前只取第一条 `data:`，遇到前置通知帧即误解析）；③ `notifications/initialized` 改为真正的 JSON-RPC 通知（无 id、不等结果），此前被当请求发且依赖服务端容忍未匹配 id；④ `tools/list` 跟随 `nextCursor` 拉全量（此前只拿第一页，服务端分页时后续工具对模型隐形）；⑤ `stop()` 增加 SIGTERM → 宽限期（默认 3s，`COWCAT_MCP_KILL_GRACE` 可调）→ SIGKILL 升级；⑥ server 退出后 `request()` 立即以明确错误拒绝，不再写已销毁的 stdin 管道；⑦ `mcpServers` 非普通对象（数组/字符串）时忽略，不再把索引/字符展开成伪 server；⑧ 连接阶段总预算 `COWCAT_MCP_CONNECT_BUDGET`（默认 120s），剩余预算下传到传输层钳制单次超时——单个挂死 server 不再独占 60s、N 个也不再累加。
- **`/mcp reconnect` 清理残留**：重连前先 `registry.unregister` 该 server 的旧适配器，失败时不再留下指向已停止 client 的 `mcp__server__tool`（`src/tools/registry.js` 新增 `unregister`、`bin/cowcat.mjs`）。
- **cron 支持一次性模式**：`-p` 在用户 prompt 之前执行 due 定时任务（每个是一次完整回合），提示走 stderr，stdout 仍只有用户 prompt 的答案——CI/无 REPL 场景此前永远无法触发定时任务（`bin/cowcat.mjs`）。
- **TUI cron 回合不再丢输入**：REPL 在 cron 扫描之前就打开 composer（TUI 的可打印键只在 read 激活时进编辑器，此前扫描期间敲的字被丢弃且随后 `readLine()` 重置编辑器）；行模式保持「先提示符后读」顺序（`bin/cowcat.mjs`）。
- **测试**：修复 `cards.test.mjs` 的 Windows 平台失败（`seq 1 30` → 跨平台 `node -e`，此前该用例在 Windows 上恒失败）；新增 `test/p4-mcp-hardening.test.mjs` 9 项（分页、session 头、SSE 多帧、通知语义、SIGKILL 升级、死管道请求、配置类型守卫、整对象覆盖、连接预算）、`test/tui.test.mjs` 1 项（提前 readLine 保输入）、`test/lifecycle.test.mjs` 1 项（`-p` 触发 cron 的 E2E）。全量 553 passed / 0 failed。

### 第三轮（真实第三方 server 联调）

用官方 `@modelcontextprotocol/server-filesystem` 与官方 SDK 起的真实 Streamable HTTP server 实测，脚本固化在 `agent/test/live/`（不在 `npm test` 内，见该目录 README）。

- **修复：Windows 下文档里的 `"command": "npx"` 完全起不来**（`src/mcp.js`）。Node 24 不能直接 spawn `.cmd`（`spawn npx` → `ENOENT`；`spawn npx.cmd` → 同步 `EINVAL`），而 USAGE 的示例正是 `npx`——Windows 用户照文档配置时 server 一个都连不上。现在直接启动失败后会自动经 `cmd.exe /c`（`windowsVerbatimArguments` 避免二次转义）重试一次；`.exe`/绝对路径仍走原路径，零影响。
- **修复：shim 启动下的进程树回收**（`src/mcp.js`）。`cmd → npx → node` 时 `child.kill()` 只杀 `cmd.exe`，真实 server 变孤儿；Windows 下 `stop()` 改用 `taskkill /T /F` 回收整棵树（POSIX 仍是 SIGTERM → 宽限期 → SIGKILL）。
- **改进：启动失败带上 server 最后一行 stderr**。此前 stderr 被丢弃，任何启动失败都只报 `server exited (code 1)`。
- **联调验证（真实 server，非 fixture）**：`"command": "npx"` 配置连上真实 filesystem server（14 工具）；真实读/写/stat、越界路径拒绝、`isError` 映射全部正确；真实 stateful Streamable HTTP server 下发 `mcp-session-id`（无该头直接 400），SSE 响应逐帧解析正确；真实分页 `tools/list`（7 工具 3/页）拉全量；CLI 端到端：项目 `.cowcat/mcp.json` → 模型调用 `mcp__filesystem__list_directory` → 真实目录列表回传模型。
- **联调更正**：修复 #3（`notifications/initialized` 按通知发）在真实 SDK server 上属**规范正确性**而非阻塞缺陷——该 server 容忍旧「带 id 当请求发」的写法（`agent/test/live/notify-negative.mjs` 记录了实测）。
- **测试**：新增 Windows shim 启动、孙进程无孤儿、stderr 诊断、缺失命令报错 3 项（`test/p4-mcp-hardening.test.mjs`）。全量 556 passed / 0 failed。

### 第四轮（shift+tab 未接线）

- **修复：`shift+tab` 生产从未接线**。`keybind.js:97` 把 `shift+tab` 绑到 `mode.switch`、`tui/ui.js:1027` 也正确地调 `this.onShiftTab?.()`，但 `onShiftTab` 全仓库只有声明（`src/ui.js:79`、`src/tui/ui.js:105`）**零处赋值**——按下去毫无反应，而 USAGE 与 ROADMAP P1-9 都写着「可用」。属「文档超前 / 测试绕开」的同类问题（此前 `diagnostic` 事件、`npx` 启动各一例）。
- 语义按文档兑现为 act ↔ plan，并把「上一个模式」保留：`yolo` 没有其他运行时入口，`-y` 会话看一眼 plan 再切回来必须仍是 yolo；`acceptEdits`（ExitPlanMode 的档位）同样不会被静默丢弃。未信任目录下不生效，保持只读锁（唯一出口是有确认弹窗的 `/act`）。判定逻辑抽成可测的纯函数 `shiftTabModes()`（`src/permissions.js`），bin 只做接线。
- **测试**：纯函数 5 项断言（`test/p3-planmode.test.mjs`）+ 接线回归（断言 bin 赋了 `tui.onShiftTab`、keybind 仍绑 shift+tab、dispatcher 仍路由 mode.switch）+ `\x1b[Z` 实际派发到回调（`test/tui.test.mjs`）。接线断言已用修复前的 bin 源验证过会失败（有牙）。全量 559 passed / 0 failed。

### 第五轮（接线通用检查，一次暴露三处）

起因是第四轮暴露出「声明了回调但没人接」这个类别，于是把 `TuiUI` 的 host 回调与 bin 的接线做成通用配对断言，一次跑出三处问题：

- **`ctrl+b` 的面板开关不持久化**：`TuiUI.togglePanel()` 通过 `onTogglePanel` 通知 host，但该回调从未赋值——`/panel` 会写 state.json、`ctrl+b` 不会，而文档承诺「切换状态持久化」。已接线（`tui.onTogglePanel` → `writeState`），并把 `/panel` 收敛到同一条路径（顺带删掉一个只写不读的 `sessionState.panel` 死赋值）。
- **`writeState` 在 bin 里根本没 import**（更严重：不是静默失效而是直接崩）。bin 在 `/panel`、`/sandbox` 两处调用它，import 列表里从来没有——`/sandbox off` 会抛 `ReferenceError` 并让 CLI 进程退出（已用 piped REPL 实测复现）。已补 import。
- **`src/ui.js` 的死声明**：`this.onShiftTab = null` 在 line 模式的 UI 里既无调用方也无接线（纯复制残留），删除。
- **新增通用断言**（`test/tui.test.mjs`）：扫描 `src/tui/ui.js` 与 `src/ui.js` 的 `this.onXxx =` 声明与调用点，要求每个回调 ① 被调用（否则是死声明）② 在 bin 里被接线（构造函数选项或 `tui.onXxx =` 赋值），除非列进 `OPTIONAL_BY_DESIGN` 并写明理由与降级行为；同时冻结回调清单（新增回调必须显式决定接线方式），并反向校验 bin 的赋值目标确实存在（防拼错名字）。实测对 `79db96e` 报 `[onShiftTab, onTogglePanel]`、对 `81297c6` 报 `[onTogglePanel]`、对当前树报空——两处历史缺陷都能抓到。
- **新增 REPL 斜杠命令冒烟测试**（`test/lifecycle.test.mjs`）：斜杠命令只能经 REPL 触达，此前单测全部绕开（这正是 `writeState` 漏网的原因）。用 piped stdin 跑一遍无网络依赖的 22 条命令，断言退出码 0、stderr 无 `ReferenceError/is not defined/TypeError`、且 `/sandbox light` 与 `/theme light` 真的落盘。
- 全量 561 passed / 0 failed。

### 第六轮（静态门禁：ESLint no-undef/no-unused-vars）

第五轮归纳出「文档/调用点与真实接线之间存在无人校验的间隙」，`writeState` 那类（**调用了未 import 的标识符**）用测试堵不干净——只有跑到那条路径才暴露。改为加静态门禁：最小 ESLint 配置只开两条规则，经 `pretest` 接入 `npm test`。

**门禁配置**（`agent/eslint.config.mjs`）：`no-undef` + `no-unused-vars`（`args: 'none'`、`caughtErrors: 'none'`、`ignoreRestSiblings`），只扫 `bin/**/*.mjs`、`src/**/*.js`、`test/**/*.mjs`；忽略 `test/live/**`（可选联调脚本，依赖未安装）与 `test/fixtures/**`。Node 内建全局手写列在白名单里（不引 `globals` 包，保持零运行时依赖；漏写会以 `no-undef` 失败，是安全方向）。

**首次运行即抓出 4 个 `no-undef` + 51 个 `no-unused-vars`**，其中两个是真 bug：

- **`Glob` 的 `path` 参数直接崩**（`src/tools/glob.js:88`）：`resolve(ctx.cwd, input.path)` 里的 `resolve` 从未从 `node:path` 导入 → 带 `path` 调用 Glob 抛 ReferenceError。此前测试只覆盖工具注册与 schema，没有一次真实调用（因此从未暴露）。修复：补 import。新增回归测试（相对路径/绝对路径/默认 cwd/目录不存在四条断言）。
- **`/output-style` 整个功能没接**（`bin/cowcat.mjs`）：命令体引用 `outputStyles`、`currentStyle` 两个不存在的标识符（列出与切换都会 ReferenceError 打死 CLI），而 `loadOutputStyles`、`styleSection` 被 import 却从未调用——即使不崩，样式也永远不会进 system prompt。修复：启动时 `loadOutputStyles(cwd)` + 打印 warnings，`system()` 每回合按 `activeStyle` 注入 `styleSection(body)`，命令体改为读写真实状态。新增 E2E（临时 output-styles 目录 → `/output-style terse` → 断言下一个请求体里出现样式正文）。

**清理**：51 个 `no-unused-vars` 全部处理——12 处 src/bin 死导入与冗余解构、13 处测试死导入、其余为测试里的未使用局部量。其中 5 处「`let body = ''` + data 监听」是**排空请求体让 `end` 触发**的载荷代码（删掉会让 handler 挂起），改用语义等价的 `req.resume()`；`p3-cron` 两处 `makeCtx()` 是纯副作用调用（建临时 COWCAT_HOME），保留调用并注明理由。`p0-wave2` 有个 `cyanBefore` 探针从未参与断言（作者原先想做切换前后对比），按现状删除并在此记录，不臆造断言。

**牙齿验证**：对 `c4edf8d` 的 pre-fix 源跑门禁 → 7 errors（4× `no-undef`：`outputStyles`/`currentStyle`×2/`resolve`；3× `no-unused-vars`）。

**代价（需知会）**：`npm test` 现在需要先 `npm install`（`agent/` 有了第一个 devDependency，锁定在 `package-lock.json`）。运行时依赖仍为零，发布 tarball 不含 devDependency。文档（`docs/PUBLISH.md` 发布清单、`docs/ROADMAP.md` 执行原则）已同步为 `cd agent && npm install && npm test`。

全量 563 passed / 0 failed（561 + Glob 1 + output-style 1）。

### 截图复核修正（并入 v0.12.0，未发布前）

用户运行 v0.12.0 的截图暴露两处界面与状态不一致，另修发布会话链路问题：

- **`/status` 在 `/act` 放行后仍称 read-only**：`folder trusted: no (read-only)` 只看持久信任（`isTrustedProject`），而 `/act` 在未信任目录下是**会话级放行**（`restricted = false`）——刚提示「unblocked for this session only」紧接着又报只读，自相矛盾。`formatStatus` 增加 `restricted` 参数，未信任时区分 `no (read-only)` 与 `no (unblocked for this session)`；bin 传入实时标志。测试补三种情形（未信任只读 / 本会话放行 / 持久信任）。
- **底栏提示写错键位含义**：状态栏右侧显示 `shift+tab agents`，但键位表里 `shift+tab` 是 `mode.switch`（act ↔ plan）——改成 `shift+tab act/plan`，注释同步。`test/footerbar.test.mjs` 此前把这个错文案断言了进去，一并改正（这正是「测试把错误固化下来」的例子）。
- **发布链路：`npm publish` 报 ENEEDAUTH**。本机默认 registry 是 `registry.npmmirror.com`（只读镜像，不提供发布），而包要发到官方 registry。新增 `agent/.npmrc` 把 `@corescense` scope 指向 `https://registry.npmjs.org/`（用户级默认镜像保持不变，只影响本 scope）；`docs/PUBLISH.md` 补登录命令与说明。`npm publish --dry-run` 实测已发往 npmjs。
- **未改代码**：截图里输入框 placeholder 显示成 `《? ress 》`，用 `buildInputBox` 在 40/80/120 列复现输出均正常（`▎ › Press ? for all keybindings`），判定为终端字体/宽度渲染，非代码问题。

### 第七轮（联调未覆盖面：keep-alive / resources / prompts）

- **修复（P1 互操作）：服务器保持 SSE 流打开时，每个请求都要卡到超时才失败**（`src/mcp.js`）。`HttpTransport` 原本先 `await res.text()` 把整个 body 缓冲完才解析，而 SSE 流**允许在应答后保持打开**（keep-alive 注释帧、后续通知——官方 SDK 的 `keepAliveMs` 与任何保持连接的代理都是这个行为），于是「等流结束」等于「等一个已经回答完的服务器」。实测：官方 web-standard transport 开 `keepAliveMs` 时不受影响（它在应答后关流）；但对手写「应答后不关流」的服务器，请求 **3005ms 后 abort**（`COWCAT_MCP_TIMEOUT` 默认 60s）。改为**增量读取**：拿到 `id` 匹配的帧即刻返回并 `reader.cancel()`。同一场景实测 **3ms** 返回。新增回归测试（ReadableStream 只应答不关闭，断言 <1s 内返回）。
- **resources 真实 server 侧验证通过**：官方 `@modelcontextprotocol/server-everything`（实现 tools/resources/templates/prompts/subscriptions）→ `resources/list` 返回 7 个资源、`resources/read` 返回真实内容（1604 字符）。此前这条只有 filesystem server 的 `Method not found` 错误路径。
- **修 `resources/list` 缺少 cursor 分页**（与 tools/list 同类缺陷）：`listResources()` 现在循环 `nextCursor`（上限 50 页防游标循环）；fixture 增加 resources 分页开关，新增测试。
- **实测出三个缺口（均有证据；属「未实现」而非「未验证」）**：① resource templates —— server 暴露 2 个 `demo://resource/dynamic/.../{resourceId}`，客户端只有 `resources/list`，模板资源对模型完全不可见；② prompts —— server 暴露 4 个 prompt，客户端**零处 `prompts/` 代码**，无 `prompts/list`/`prompts/get`；③ server→client 通道 —— 客户端只发 POST，从不打开 GET SSE 流，因此 `resources/subscribe`、`logging`、`*_list_changed` 永远收不到（`notifications/initialized` 是唯一的单向消息）。
- 联调脚本新增 `agent/test/live/everything.mjs`、`keepalive.mjs`；5 个脚本全部通过。全量 565 passed / 0 failed。

### 第八轮（把三个缺口里的两个补上）

按用户选择，先补 **prompts** 与 **resource templates**（server→client 通道仍留待评估）。

- **MCP prompts → 斜杠命令**：`/mcp__<server>__<prompt>`（与工具的命名空间一致，用户已熟悉的 `mcp__server__name` 形状）。客户端侧：`connect()` 现在从 initialize 结果取 capabilities（两个 transport 都回传 initialize 结果，此前 HTTP 路径丢弃），随后 `_listAllPrompts()` 发现 prompts（分页 + 容错：没这个 capability 的 server 回 `Method not found`，只是发现为空、绝不让连接失败）；`getPrompt()` 把返回的多条 message 展平成一条 user 消息，**非 user 角色加 `[assistant]` 标签**（不冒充模型说过的话）。bin 侧：启动与 `/mcp reconnect` 后重建 prompt→命令索引，派发时按声明顺序位置映射参数、缺必填参数本地报错（不发请求）、`/help` 列出带参数提示的命令、斜杠补全包含它们、连接横幅显示 `N tool(s), M prompt(s)`。
- **resource templates 可列出**：`listResourceTemplates()`（分页 + 容错）并在 `ListMcpResources` 输出里以 `template <uriTemplate>` 追加，工具描述同步说明「模板不可枚举，用具体 URI 交给 ReadMcpResource」。
- **测试**：fixture 新增 prompts（一个带必填参数、一个无参数）与 resource template、`prompts/list` 的错误路径（`FAKE_MCP_NO_PROMPTS`）；单测 3 项（发现+取值+角色标签、模板列出+进入 ListMcpResources、无 capability 不失败）；**piped REPL E2E 1 项**（`/mcp__fake__greet` 缺参报错、`/mcp__fake__greet World` 的文本真的进了模型请求、`/help` 列出命令）。联调脚本 `everything.mjs` 从「记录缺口」升级为断言：官方 server 的 2 个模板出现在 ListMcpResources、4 个 prompt 被发现、`prompts/get` 无参与带参（city/state）两条都取回内容。
- 全量 569 passed / 0 failed。

- **P1 思考链流式（OpenAI 兼容 provider）**：`delta.reasoning_content`（DeepSeek/Moonshot 等）与 o-series `delta.reasoning` 逐 delta 聚合为本地 `thinking` 块并经 `onThinking` → `ui.thinkingChunk` 流式渲染；聚合出的思考块只进 transcript/UI、永不回传上游（`src/llm/openai.js`，非流式响应的顶层 `reasoning_content`/`reasoning` 字段同样识别）。
- **P2 工具调用增量**：流式 `tool_calls` delta 经 `onToolDelta` 实时透出（`{index, id?, name?, argsDelta}` + 每个工具完成时一次 `{argsComplete, done}`），TUI 上呈现为逐字生长的 pending 卡片、参数拼完后被正式工具卡原地取代（`src/llm/openai.js`、`src/llm/anthropic.js`、`src/loop.js`、`src/tui/ui.js`；print/line 模式维持原有一次性展示）。
- **P4 轻量 Bash 沙箱**：默认 `light` 档——secret 脱敏 env + 静态命令分级 + 审计追踪，`/sandbox off|light` 在线切换并持久化（state.json `sandbox` 键）；每次分级执行追加 JSON 行到 `~/.cowcat/audit.log`（ts/tool/cwd/risk/decision/command，best-effort 永不抛错）；TUI Bash 卡 light 档显示 dim `· sandboxed` 角标。**诚实威胁模型：这是护栏不是安全边界**——不提供系统级隔离，别用它抵御恶意命令（`src/sandbox.js`、`src/config.js`、`src/tools/bash.js`、`src/tui/ui.js`）。
- **P5 并行工具执行**：同一回合内无依赖的多个工具调用并发执行，并发上限 `maxParallelTools`（默认 4，config/env 可调），结果按调用顺序回拼、transcript 不乱序；usage 与错误逐工具聚合（`src/loop.js` executeToolUses）。
- **P5 启动模型引用校验**：启动时校验 `provider/model` 引用，未命中已知目录时 toast/行模式提示最接近的可用引用（`src/modelhint.js`，自定义 endpoint 跳过目录校验的场景同样兜底）。
- **右侧信息面板**：ctrl+b 或 `/panel` 开关，26 列右栏显示 Context 用量条（本地 estimateTokens + analyzeContext 估值，非网络探测）、模型 + effort、权限模式、MCP 服务器列表（带状态点）、当前 todos；<100 列终端自动隐藏回单列；切换状态持久化到 state.json（`panel` 键）并在会话内镜像。纯渲染在 `src/tui/sidebar.js`（renderSidebar/stitchSidebar/sidebarWidth），TuiUI 唯一收窄点 `_contentWidth()`，transcript/输入区/状态栏同步缩窄后拼接侧栏（`src/tui/ui.js`、`src/tui/keybind.js`、`bin/cowcat.mjs`、`src/config.js` STATE_KEYS）。
- **错误卡片化**：Bash 非零退出渲染红色错误卡（标题含失败命令、红色 `✗ exit N` 行、collapseToolOutput 折叠输出尾部，ctrl+o 展开全文），行模式非零退出同样走红色边框卡；`!` 本地 shell 失败路径不再 raw dump，改为同款错误卡；provider/API 错误经 `src/errfmt.js` 解析（HTTP 状态 + 内嵌 JSON 错误体如 `{"error":{"code":"1211","message":"Unknown Model..."}}`，容忍尾部脏数据），TUI 里渲染 `apiError` 红色卡片（ctrl+o 看 raw 响应体），行模式输出 summary + 可操作提示 + 原文；已知场景提示：unknown model → /model 切换、401/403 → 查 API key、429 → 稍后重试、5xx → 服务端错误、网络 → 查 base URL/代理。
- **审批卡升级**：卡片与 PermissionPrompt 显示将命中的权限规则（perrules.findMatch，deny>ask>allow 优先级），无匹配时显示「无匹配规则（默认：询问）」；新增 y/a/n 裸键快捷选择（pills ←→/enter/esc 不变），pill 标签带键位字母；loop.js 向 approve 透传 tool input。approve 异步契约与 plan 门不变。
- **测试**：新增 `test/panel.test.mjs` 14 项（sidebar 纯渲染/自动隐藏/拼接、布局缩窄与整帧宽度、错误解析与提示、bash/apiError 错误卡、审批规则展示与 y/a/n）；P1/P2 新增 `test/p1-wave{1-4}`、`test/p2*`、`tooldelta`、`msgstream`、`reasoning` 共 74 项（思考链聚合/流式回调、工具 delta 生命周期与 pending 卡取代）；P4/P5 新增 `test/sandbox.test.mjs` 12 项（脱敏/分级/审计/持久化）、`test/parallel.test.mjs` 6 项（并发上限/保序/错误聚合）、`test/modelhint.test.mjs` 7 项；全量 533 passed / 0 failed。
- **进程级 E2E 冒烟**：stub OpenAI 兼容 SSE server（`test/fixtures/stub-openai-server.mjs`）驱动 `cowcat -p -y` 全链路——reasoning_content delta → transcript thinking 块、Bash 执行、二次请求 tool_calls/tool 正确配对（思考块不回传）、audit.log 落审计行、模型引用警告提示，`-p` 与 `--output-format stream-json` 双模式 exit 0。
- **E2E 修复**：print/line 模式回合末折叠思考卡改为扫描本回合全部 assistant 消息（同回合早前迭代的思考不再丢失）；loop 的 usage 聚合兼容 OpenAI 字段名（`prompt_tokens`/`completion_tokens`/`prompt_cache_hit_tokens`），openai provider 的 /cost 与 stream-json usage 恢复真实数值（`test/loop.test.mjs` 新增用例）。

## 0.11.0（2026-10-15）— TUI 视觉改版：弹出式斜杠菜单、chips 状态栏、极简输入框、工具块新标题

- **弹出式斜杠命令菜单**：替换原单行候选——输入框下方整宽弹出，每行 `  → /name` + 固定 18 列命令名 + dim 说明列；选中行箭头与命令名为 brand 色，底部 `(n/m)` 计数器，最多 8 行、超出滚动且选中项始终可见。菜单内 ↑↓ 移动选中（不再走历史记录）、Enter 直接提交选中命令、Tab 填入并补尾部空格后关闭、Esc 关闭、继续打字实时过滤并复位到第 0 项；选中索引存 TuiUI（`src/tui/ui.js`）。与 @-mention 文件补全 Tab 循环共存：非 `/` 前缀不弹菜单，菜单优先。
- **命令说明数据**：`slashCommandDocs()` 导出 31 条 `{name, zh, en}`，覆盖 `slashCommandList()` 全部命令的中英文单行说明；TuiUI 新增可选构造参数 `commandDocs`，bin/cowcat.mjs 已接线（`src/slashlist.js`、`bin/cowcat.mjs`）。
- **chips 状态栏**：`renderStatus` 重写为 chips 风格——cost(dim) → 权限模式 chip（theme.warning 琥珀，default/acceptEdits/yolo/plan 四档 zh/en 文案，取自 getMode()）→ 模式 chip（act=theme.success 绿 / plan=brand）→ 模型 chip（config.thinking 存在时追加 dim `thinking: level`）→ 右侧 cwd(dim 右对齐)；权限信息缺失时降级省略权限/模式 chip（`src/tui/render.js`）。
- **输入框上方上下文行**：`› {branch} · {mode} · {hint}`——`›` brand 色、分支粗体、`·` dim 分隔、hint dim（原状态栏 hint 移至此处；有审批挂起时清空）。git 分支经 `git rev-parse --abbrev-ref HEAD` 异步获取并缓存（取不到显示 `-`），仅备用屏激活时每 30s 异步刷新，不阻塞渲染（`src/tui/ui.js`）。
- **极简输入框**：去掉圆角 ╭╮╰╯ 与左右 │ 边框——permission 色满宽上规则线 + brand 粗体 `> ` 前缀（空态接 dim placeholder）+ 下规则线；多行续行以 2 空格缩进并保留 spare 行；硬件光标列公式同步更新（bodyW = width-2，body 行偏移 = inputStart+2）（`src/tui/render.js`、`src/tui/ui.js`）。
- **工具块标题重做**：完成态 `● Used {ToolName}`（粗体名）、Bash 特殊 `● Ran a command · $ {command}`（截断 ~60 列，dim）；`●` 随状态着色（success 绿 / error 红），运行态为 permission 青色 spinner 无 `●`；折叠提示改 `⌄ (N more lines, ctrl+o to expand)`，内容预览 `│` 前缀风格不变（`src/tui/render.js`、`src/tui/ui.js`）。
- **测试**：新增 9 项（菜单交互/滚动窗口/渲染、状态栏 chips 与降级、上下文行、输入框新结构、工具标题），重写 12 项失效旧断言；非 TTY degrade 字节一致性测试未动。全量 331 → 340 passed / 0 failed。

## 0.10.1（2026-10-15）— TUI 热修复：光标、斜杠菜单、幽灵行

- **输入框硬件光标**：`Screen.draw` 改为绝对寻址重绘（每行 `\x1b[{n};1H`，不再写裸 `'\n'`），帧末按 0 基 `{row, col}` 定位并显示硬件光标——编辑时光标真实落在输入框 caret 处，流式输出期间保持隐藏（src/tui/screen.js、src/tui/ui.js）。
- **修复幽灵重叠行**：根因是帧绘制用相对移动 + 裸 `'\n'`，画完整帧后硬件光标停在终端末行，`_finishRead` 再写一个裸 `'\n'` 使备用屏整体上滚一行，此后逐消息累积漂移、旧行残留。绝对寻址 + `_finishRead` 守卫（alt-screen 内严禁裸写）后从机制上免疫（src/tui/screen.js、src/tui/ui.js）。
- **自动斜杠菜单**：输入 `/` 即弹出可用命令候选（不高亮、无计数器），继续输入实时过滤；Esc 关闭菜单但不中断任务，任意编辑后菜单自动重现；Tab 循环补全行为不变（src/tui/ui.js，配合 LineEditor 新增 `rev` 变更计数器 src/lineeditor.js）。
- **测试**：tui.test.mjs 新增 4 组回归（斜杠菜单、光标定位、绝对寻址绘制、submit 无裸换行泄漏），全量 326 → 331 passed / 0 failed。

## 0.10.0（2026-10-14）— P4：TUI 全面翻新

- **字素宽度测量**：基于 Intl.Segmenter 的 grapheme 遍历 + CJK/emoji 宽度表，东亚文字与 emoji 在表格、边框、对齐场景下不再错位（src/tui/wcwidth.js）。
- **终端能力探测**：启动探测 COLORTERM/TERM/NO_COLOR 与 cursor-style 支持，能力矩阵驱动渲染降级（truecolor → 256 → 16 色），未知终端安全回退（src/tui/capabilities.js）。
- **语义色 token 系统**：全套语义色 token（brand/permission/success/error/warning/cyan/userBubbleBg 等）定义 dark/light 双主题，`/theme dark|light` 切换在 TUI 全界面即时生效（src/tui/theme.js）。
- **帧 diff 渲染 + 条目缓存**：transcript 改为结构化条目缓存，渲染时帧 diff 只重绘变化行，替代原 10fps 全量重绘的渲染循环（条目管线在 src/tui/ui.js）。
- **流式 markdown 渲染**：模型输出流式解析渲染——标题、无序/有序列表、引用块、表格、行内粗体/斜体/行内码（src/tui/markdown.js）。
- **语法高亮**：六种语言（js/ts/python/sh/json/md）的终端语法高亮，用于代码块渲染（src/tui/highlight.js）。
- **消息气泡与工具块三态**：用户消息左侧气泡样式；工具块 ⏺ 三态（running/done/error）+ 回合页脚 ✻ 分隔线。
- **审批卡 diff 预览**：审批请求内联卡片附 Edit/Write 变更的 diff 摘要预览，y/n/a 应答前可见改动内容。
- **圆角输入框 + placeholder + 状态栏提示**：底部输入框圆角描边、空态 placeholder 提示、状态栏上下文操作提示。
- **LineEditor 编辑键**：光标移动/删除/行首行尾等完整编辑键位（Ctrl+A/E/K/U/W、左右方向键等）。
- **Tab/@ 补全增强**：Tab 循环补全斜杠命令，@ 触发项目文件模糊补全，候选高亮与循环切换。
- **修复/测试**：全量测试 199 → 318 passed / 0 failed。

## 0.9.0（2026-10-14）— P3：长任务与规划基础设施

- **plan mode 工具对**：EnterPlanMode（切入 plan 权限档，只读规划）+ ExitPlanMode（提交计划文本走审批卡；批准后会话切 `acceptEdits` 档——Write/Edit 免审批、Bash 仍走规则，allowedPrompts 转为会话内临时 allow 规则；拒绝则保持 plan 模式让模型修订）。新增权限档 `acceptEdits`，与 default/plan/yolo 并列（src/tools/planmode.js、permissions.js）。
- **结构化任务工具**：TaskCreate/TaskGet/TaskUpdate/TaskList，多任务并存、status 五态（pending/in_progress/completed/failed/deleted）、blocks/blockedBy 依赖双向镜像、metadata 合并（src/tools/tasktools.js）。
- **定时唤醒**：CronCreate/CronDelete/CronList + ScheduleWakeup——自研 5 字段 cron 解析器（*/n、列表、区间、步进、dom/dow OR 语义），持久化 `~/.cowcat/crons.json`，REPL 空闲时到期 prompt 自动注入为新回合；ScheduleWakeup 为一次性唤醒（上限 24h）（src/tools/cron.js）。
- **MCP resources**：ListMcpResources/ReadMcpResource，在现有 stdio+http 传输上补 resources/list + resources/read（文本直返、base64 标注、单 server 故障隔离）（src/tools/mcpresources.js、mcp.js）。
- **Agent 异步与思考档位**：`effort` 五档（low/medium/high/xhigh/max）透传子代理 LLM 调用（Anthropic 映射 thinking.budget_tokens、OpenAI 映射 reasoning_effort）；`run_in_background` 真后台——子代理包装为后台任务，TaskOutput/TaskStop 直接取回/终止（src/tools/agent.js、subagent.js、background.js startAsync）。
- **Bash 后台超时分层**：后台默认 1800s、上限 7200s（前台 60s/600s 不变）（src/tools/bash.js、background.js）。
- **Read allow_large**：5–20MB 文件显式 opt-in 直读（跳过分页），>20MB 仍拒（src/tools/read.js）。
- 内置工具 15 → 25；全量测试 198 passed / 0 failed。
- **修复**：TUI 模式秒退（`tui.start()` 接线缺失导致事件循环无活句柄、进程打印提示符后直接退出）；补充进程异常退出时的终端恢复兜底；UI 提示语中的猫比喻文案全部中性化。

## 0.8.0（2026-10-14）— 全屏 TUI（P2-9）

- **alternate screen 四区全屏布局**：顶部 header（精简 banner 行 + context 用量条绿/黄/红 + model/mode）、中部 transcript（工具调用原地更新卡片：running spinner → ✓/✗ 折叠结果卡；流式文本逐字渲染；审批内联卡片 y/n/a 键）、底部输入框（多行 Ctrl+J、↑ 历史、Tab 补全、@-mention、shift+tab 切模式、光标可见）、状态栏（版本/cwd + 奶牛猫动画帧）。
- **交互**：Esc 中断当前任务（AbortController 全链路：UI → runLoop → provider → fetch，返回 `[interrupted]`）；shift+↑/↓ 与 PgUp/PgDn 滚动 transcript；10fps 渲染循环，渲染核心为纯函数模块（src/tui/render.js）单测覆盖。
- **降级保证**：非 TTY（管道/CI）、`-p`、`--output-format stream-json`、`NO_COLOR` 自动走原线性模式且行为不变；`COWCAT_TUI=off` 强制关闭。spawn 级测试断言管道输出零 alternate-screen 转义序列。
- 模块：src/tui/render.js（纯渲染）、src/tui/screen.js（alternate screen + 帧绘制）、src/tui/ui.js（鸭子接口 TuiUI，复用 lineeditor/animator 帧/contextviz）。

## 0.7.0（2026-10-14）— P2 第二波：集成/系统

- **IDE 集成（最小实现）**：终端环境检测（VS Code/Cursor/JetBrains，`detectIde`）；Edit/Write 产生的 diff 以 `file_edited` 事件、工具失败以 `diagnostic` 事件写入 JSONL 通道（`COWCAT_IDE_PIPE` 指定路径，未配置则只计数不落盘）；`/ide` 查看检测状态/通道/事件数（src/ide.js）。
- **worktree 隔离**：`/worktree [名]` 创建 `../<repo>-cowcat-<名>`（分支 `cowcat/<名>`）并把会话 cwd 切入；`/worktree list` 查看；Agent 工具新增 `isolation: "worktree"` 参数让子代理在独立 worktree 执行并在报告尾部标注路径（src/worktree.js）。
- **团队/lead 模式等效**：内建角色增至 5——新增 `lead`（编排 prompt：按 scout/plan/general/verify 分工、整合报告、对结果负责），可在子代理内再嵌套一层 Agent 调用（深度上限 1），其它角色不可嵌套；`/agents` 自动列出。
- **后台执行 + 系统通知**：`cowcat -p --background "任务"` 分离子进程运行，日志/元数据/结果落盘 `~/.cowcat/background/<id>/`（meta.json/output.log/result.json），完成时 Windows PowerShell 气球通知（无 GUI/非 Windows 静默降级）；父进程立即返回任务 id。
- P2 全部完成：ROADMAP P2 八行全 ✅。

## 0.6.0（2026-10-14）— P2 第一波：可视化/交互

- **/context 上下文可视化**：token 占用（chars/4 估算）、角色占比条、按消息段（同角色连续合并）网格、最大 5 条消息清单、70%/90% 阈值预警（src/contextviz.js）。
- **思考链可折叠展示**：thinking 块不回传上游约定不变；每回合结束渲染折叠卡片（摘要 + 字符数），`/thinking` 展开最近思考全文（src/thinking.js）。
- **@-mention 文件补全**：输入 `@<前缀>` 后 Tab 循环补全项目文件路径（模糊子串、大小写不敏感、上限 20），候选基于原始前缀循环（src/mention.js + LineEditor 扩展）。
- **doctor 三形态**：`cowcat doctor` 默认检查；`cowcat doctor inspect` 深度报告（脱敏配置/规则/hooks/状态分区）；`cowcat doctor fix` 自动修复（补 config.json、修 permissions/hooks 形态、清除坏规则）；`--json` 机器可读输出（src/doctor.js 扩展）。

## 0.5.0（2026-10-14）— P1 第一波：记忆系统完整版 + 权限规则引擎

- **记忆系统**（多级加载，启动时注入 system prompt 并标注来源层级）：
  - user 级 `~/.cowcat/CLAUDE.md`；项目级从 cwd 向上逐级（止于 home/盘符根）收集 `CLAUDE.md`、`.cowcat/CLAUDE.md`、`.cowcat/rules/*.md`（按文件名排序）；与既有 COWCAT.md→AGENTS.md→CLAUDE.md 项目指令合并去重（同一文件只注入一次）。
  - 单文件超 10000 字符截断；`COWCAT_DISABLE_MEMORY=1` 整体跳过；文件不存在一律跳过、不自动创建。
  - `/memory`：选 user/project 层级，不存在则创建带原创模板头的文件，打印路径+内容引导外部编辑器编辑；`/memory add <一行>` 直接追加到 project 级（走审批）。
- **权限规则引擎**（`~/.cowcat/config.json` 的 `permissions: {allow, deny, ask}`）：
  - 语法 `Tool` / `Tool(模式)`；`:*` 结尾为前缀匹配（Bash 按命令串，边界为空格/冒号/斜杠——`Bash(npm run test:*)` 命中 `npm run test` 与 `npm run test:unit`，不命中 `npm run testing`）；路径工具可用 glob（`Edit(src/**)`）。
  - 优先级 deny > ask > allow > 默认；**yolo 模式下规则一律不生效**（文档明示）。
  - 加载时逐条校验（工具已注册/括号配对/模式非空/`*` 合法），坏规则跳过并以中文告警（`permissions.deny 第 2 条被跳过：…`），不阻断启动。
  - deny 命中时模型收到含规则原文的拒绝 tool_result；`/permissions` 查看三列+语法说明，`/permissions add|remove` 在线增删并立即持久化生效。
- **hooks 核心子集**（8 事件：PreToolUse/PostToolUse/PostToolUseFailure/UserPromptSubmit/Stop/SessionStart/SessionEnd/PreCompact）：
  - 配置在 config.json `hooks` 字段；`command` 类型经 shell 执行、stdin 收 JSON 事件载荷，stdout 非空或非 0 退出对 PreToolUse 视为 deny（首行原因回灌模型，对齐原版 ExitCode 2 语义），超时默认 60s SIGKILL（孤儿管道有兜底强结），`once` 执行后自动从配置移除，`async` 不阻塞只进日志；`http` 类型 POST JSON（默认 30s），2xx 放行、4xx deny（body 首行）、网络错误放行+警告。
  - hook 执行不弹审批；SessionStart 打印"已加载 N 个 hooks"；`COWCAT_DISABLE_HOOKS=1` 全关；`/hooks` 列表 + `disable|enable <事件> <序号>` + `test <事件>` 手动触发（打印 JSON 载荷与结果）。
- **MCP 客户端**（OAuth 不做）：
  - stdio（JSON-RPC 2.0 over NDJSON，initialize→tools/list→动态注册 `mcp__<server>__<tool>`，inputSchema 直转）+ http（POST JSON-RPC，SSE/JSON 响应解析）；配置 `~/.cowcat/mcp.json` 与项目 `.cowcat/mcp.json`（项目级同名覆盖）；启动并发连接、单失败隔离（✗+原因）、退出统一杀进程（`COWCAT_MCP_TIMEOUT` 控超时，默认 60s，输出截断 20k）。
  - 首次连接新 server 交互询问并记忆到 config.json `mcpTrusted`；`/mcp` 列出 servers（✓/✗+工具数）、`/mcp reconnect <名>` 重连。
- **自定义 commands/agents/skills 加载**（user 级 `~/.cowcat/`、项目级 `.cowcat/`，项目覆盖同名）：
  - `commands/<名>.md`（frontmatter: description/allowed-tools?/model?/argument-hint?，正文 `$ARGUMENTS` 模板）注册为 `/<名> [参数]`，执行=展开后作为 user 消息送入当前会话；与内建重名时内建优先；`/help` 单列自定义组。
  - `agents/<名>.md`（frontmatter: description/tools?/model?）= 子代理角色；Agent 工具新增 `subagent_type`（先查自定义再查内建）/`skill`/`resume` 参数。
  - `skills/<名>/SKILL.md` 按需加载：启动仅注入"索引"（名字+一句话），Agent 工具 `skill` 参数触发正文注入子代理；`/skills` 列出。
  - 全部惰性+容错：坏 frontmatter 跳过并 SessionStart 告警，不炸启动。
- **后台任务**：Bash `run_in_background: true` 立即返回 task id；新工具 TaskOutput（非阻塞快照 / `block:true`+timeout 等待，截断 20k）与 TaskStop（SIGKILL+输出摘要）；`/tasks` 列表 + `/tasks kill <id>`；超时仍限 600s 到期强杀；CLI 退出统一清理（Windows taskkill /T 杀整树，无孤儿）。
- **子代理体系扩展**：内建角色 4 个（scout 只读侦察 / plan 只读出方案 / general 全工具 / verify 只读核对，全部原创 prompt）；Agent 工具 `resume: <sessionFile>` 用原子代理 transcript 初始化消息续跑；`subagent_type` 自定义优先、内建兜底。
- **输出样式 + statusline**：
  - output-styles：`~/.cowcat/output-styles/<名>.md` + 项目 `.cowcat/output-styles/`（项目覆盖同名），frontmatter 仅 `description`，正文为追加到 system prompt 尾部的风格指令；`/output-style` 列出/切换，经 system() 闭包**热生效**；默认无样式=现有行为。
  - statusline 自定义：config.json `statusLine: {command}`，命令经 shell 执行、stdin 收一行 JSON（`{"model","mode","ctx_pct","cwd"}`）、2s 硬超时静默跳过、首行输出渲染在状态栏右侧；`/statusline` 查看/set/clear（清除恢复默认）。
- **TUI 键位增强**（LineEditor 纯逻辑 + UI 集成；非 TTY 全部静默禁用）：↑/↓ 召回会话级输入历史（编辑中内容暂存）；Tab 在 `/` 前缀下循环补全内建+自定义斜杠命令（其它位置插入两空格）；shift+tab 逐档轮换 default↔plan 并即时刷新状态栏；Windows TTY raw 模式单键可读，跨 PowerShell/Windows Terminal/Git Bash。
- **结构化输出**（`-p` 模式，人类可读路径不受影响）：
  - `--output-format stream-json`：纯 NDJSON 事件流（`system`/`assistant`(delta)/`tool_use`/`tool_result`/`result`/`error`），与 banner/动画/状态栏等一切装饰互斥。
  - `--output-schema '<JSON Schema>'`：mini 校验器（type/object/required/properties/items/enum/string length/pattern/number bounds）；prompt 约束 + 本地校验，失败把校验错误回喂模型重试一次，两次失败 exit 3。
  - `--max-turns N`：回合上限，超限 exit 4；权限受阻仍 exit 2。
- 版本 0.5.0（P1 全部完成：ROADMAP P1 十行全 ✅）。

## 0.4.0（2026-10-14）— P0 第一波：接线修复 + WebFetch/WebSearch + 描述扩写 + OpenAI countTokens

- 修 5 个接线 bug：
  - TodoWrite 持久化断裂：`sessionId` 接入 CLI baseCtx，真实 CLI 路径回归测试钉住（不再写 `todos/undefined.json`）。
  - Agent 工具 `model` 参数透传：subagent runner → runLoop → 双 provider 请求体全链路生效。
  - `npm test` 脚本改为 `node --test test/*.test.mjs`（Node 24 目录写法会误报 1 fail）。
  - 死代码清理：`smallModel` 由 compact summarizer 消费、`config.animation` 统一由 config 读取（bin 不再直读 env）、`trackProcess` 落实为 Ctrl-C 转发杀 Bash 子进程、`envReminder`/`extractSummary`/compact 未用导入/`void keepRecent` 删除。
  - Grep 补参：`-B`/`-A` 定向上下文（`-C` 仍双向）、`type` 语言过滤（js/ts/py/rs/go/java/c/cpp/json/md 等 20+ 枚举）、`multiline`（dotall 跨行匹配）。
- 新工具 **WebFetch**：fetch + 10s 超时 + 5MB 上限；HTML→markdown 轻转换（去 script/style，保留标题/列表/链接/段落）、纯文本直出、二进制拒绝、20k 截断；`ctx.fetch` 可注入便于测试。
- 新工具 **WebSearch**：默认 DuckDuckGo HTML 端点（免费无 key），title/url/snippet 格式对齐原版，`allowed_domains`/`blocked_domains`/`count` 过滤；引擎接口可换付费 provider；`ctx.searchEngine` 可注入。
- 工具描述扩写：Read/Edit/Write/Bash/Glob/Grep 优先 + TodoWrite/AskUserQuestion/Agent，全部补"何时用/何时不用/约束/失败模式"（原创改写，schema 不变），描述长度 ≥400 字符有测试钉住。
- OpenAI provider `countTokens`：纯 JS 校准启发式 tokenizer（`src/llm/tokapprox.js`，英文/中文/代码三类文本量级校准，±20% 内）；doctor 对 openai 改用极小 generate 调用做真实连通探测。
- **文件 checkpoint + `/rewind`**：Edit/Write 执行前把被改文件快照到 `~/.cowcat/checkpoints/<sessionId>/<N>/`（序号单调递增，会话结束后保留），session JSONL 记 `{type:"checkpoint"}` 条目；`/rewind` 时间倒序列出检查点（文件数+触发工具），确认后回写文件（走审批）并把对话截断到检查点位置——代码和对话一起回滚。
- **compact 增强**：双模板——历史 >2×KEEP_RECENT(6) 时走"近期比例"模板（仅压缩更早部分，最近 6 条原文保留，消息少仍全量）；压缩完成后向 session JSONL 写 `{type:"compact_boundary", summary}` + `{type:"compacted", count}` 折叠条目，resume 用摘要替代被压缩原文；`/compact [指令]` 支持自定义压缩指令透传 summarizer。
- **斜杠命令第一波 6 个**：`/cost`（轮数/工具数/input/output/cache_read/cache_creation 真实 usage 累计 + 额度消耗参考·标注估算）、`/status`（版本/provider/脱敏 baseURL/模型/权限/信任状态/上下文占用%/会话时长）、`/export [文件]`（markdown 导出，走审批）、`/fork [名称]`（会话分叉，原会话不动）、`/todos`（查看 todo）、`/theme dark|light`（两套 ANSI 配色即时生效并持久化到 config.json）。

## 0.3.3（2026-10-13）— /exit 挂起修复 + 目录信任 + /setup 热生效

- 修复 `/exit` 后进程不退出：UI 新增 `close()`（移除 stdin data/end 监听器并 `pause()`），REPL 正常退出（/exit、/quit、EOF）均调用 `animator.stop() + ui.close()`，干净退出 code 0；stdin EOF 现在也会主动关闭 REPL 而不是干等。
- 目录信任机制（对齐 trust dialog）：未信任 cwd 交互启动询问 `Trust the files in <cwd>? [y/N]`；y 持久化进 `trustedProjects`（保留 installId 等字段），n/回车进入只读 plan 模式（状态栏 `[受限]`），`/act` 需二次确认（仅本次放行）；`-p` 不提问、未信任一律只读，`-y` 不覆盖信任。
- REPL 新增 `/setup`：复用 setup 向导，完成后热生效——就地更新 config、重建 provider 与子代理 runner，下一次对话即用新 key/模型，并打印 doctor 风格逐项 ✓/✗。

## 0.3.2（2026-10-13）— 首次启动体验修复

- 未配置 API key 时（交互模式）：跳过启动 count_tokens 探针（不再向默认端点刷 403 噪音），打印简洁双语 onboarding 引导（setup/环境变量/kimi 推荐配置一句），状态栏 model 显示"未配置"；已配 key 行为不变，`-p` 模式保持现有错误路径。
- 横幅选择：新增 `COWCAT_BANNER=pixel|ascii` 强制覆盖；自动逻辑改为"真彩 **且** 终端宽 ≥100 列"才用像素横幅，否则回退 ASCII 盒式，避免弱终端/粘贴时的纯色块墙。

## 0.3.1（2026-10-13）— 非交互模式修复 + 企业化发布准备

- 修复 `-p/--print` 模式两个问题：
  - 需要审批的工具不再挂起等待 stdin——非交互模式下自动判为"拒绝"，模型收到明确消息（"Non-interactive mode: … rerun with -y to auto-approve"）可改走只读路径继续；若回合中发生权限拒绝，退出码为 2。
  - 最终输出不再重复打印（流式与最终消息二合一，仅保留一份）。
- 企业化发布准备（心感科技（深圳）有限公司 / CoreScense）：package.json 补 author/keywords/files、新增 LICENSE（MIT）与 README（发布页）、内部发布手册见 `docs/PUBLISH.md`。

## 0.3.0（2026-10-13）— 体验对齐批次（发布前 P1）

- 全局启动：`bin/cowcat`（POSIX sh）+ `bin/cowcat.cmd`（Windows），按脚本自身位置解析仓库路径；`<repo>/bin` 加 PATH 即可全局 `cowcat`；`agent/` 支持 `npm link`。
- 项目上下文：启动时从 cwd 向上查找 `COWCAT.md` → `AGENTS.md` → `CLAUDE.md`（首个命中），以独立 section 注入 system prompt；`/clear` 后保留。
- 会话续接增强：session 文件头部写入 cwd（meta 记录，旧文件按现状兜底）；`-c/--continue` 恢复本项目最近一次会话；`--resume` 不带参数列出会话（时间倒序编号）交互选择；无会话友好提示。
- `cowcat setup`：交互配置向导（apiKey 静默输入不回显），写入 `~/.cowcat/config.json` 并保留已有字段（含 installId）。
- `cowcat doctor`：配置完整性 + count_tokens 连通性逐项 ✓/✗，退出码反映结果。
- `--version`：打印 `cowcat/<version>`。
- `/init`：一次只读 LLM 调用探索项目、起草 COWCAT.md，确认后写入 cwd（写文件走审批/确认）。

## 0.2.0（2026-10-13）— 品牌 P0/P1 + 能力 P0/P1/P2

- 更名 ccagent → CowCat：`COWCAT_*` 环境变量（`CC_*` 过渡兼容）、`~/.cowcat/` 目录、CLI/包名/文案全量品牌化。
- ASCII banner 随机斑块系统 + S0–S7 状态猫帧动画（`COWCAT_ANIMATION=off` 降级）。
- Plan/Act 模式、逐动作审批卡、diff 折叠卡、终端输出折叠卡。
- system prompt 分层重写（~10k 字符）、cache_control 断点、`max_tokens` 32000。
- count_tokens 预检、reminder 位置对齐、子代理角色化、compact 对齐实测结构。
- metadata.user_id + anthropic-beta 声明头（不冒充 claude-cli 身份）。
