# P7 调研：MCP（stdio 服务器、信任与凭证边界）

> **本文件只出决定草案与 ADR 清单，不改源码、不改 ADR 表**（工作规则 3）。
>
> 对应 `dev-plan-v2.md` P7 表的「MCP」行；排期在子 agent 之后（前沿调研 D1 → D2）。时效截至 **2026-10-20**。
>
> **本文件没有【实测】条目**：只读调研，没有写代码、没有连过任何 MCP 服务器。

## 证据标注

沿用 `AGENTS.md` 的约定：【源码】本仓库实现，给 `文件:行号`；【实测】本轮真跑出来的（**没有**）；【上游】上游规范或文档，给 URL；【推断】未实测的推论，**不得作为决策依据**。

---

## 0. 结论摘要

1. **2026-07-28 这一版把「连接会话」换成了「逐请求自带元数据」**：每个请求在 `_meta.io.modelcontextprotocol/*` 里带协议版本与客户端能力（【上游】transports 页「Request Metadata」），并对 `initialize` 时代的实现保留向后兼容矩阵。我们第一版实现应当**先走兼容路径**，把无状态形态作为第二个 ADR 的输入（见 §7 待验证）。
2. **stdio 是唯一需要先做的传输**，而且它的授权故事是「不要 OAuth」：规范明确写了 stdio **SHOULD NOT** 走授权流程，凭证由环境提供（【上游】authorization 页「Protocol Requirements」）。这正好落在 ADR-014/015 的地盘上——子进程的 env 由 `ProcessPort` 决定，不是调用方塞什么就是什么。
3. **前沿调研 D2 的措辞已过时**：它写的是「OAuth 2.1（PKCE + 动态客户端注册）」。2026-07-28 把 **Dynamic Client Registration 标为 deprecated**，首选 **Client ID Metadata Documents**；`resource` 参数（RFC 8707）在授权与令牌请求里都是 **MUST**（【上游】authorization 页「Client Registration」「Resource Parameter Implementation」）。这条只影响将来的 HTTP 传输。
4. **stdio 服务器天然被沙箱覆盖**，因为规范要求它由客户端启动子进程，而 v2 只允许经 `ProcessPort` 启动子进程（ADR-014 的注释里把「MCP stdio」列为旧实现的九处 spawn 之一，`ports/process.ts:3-8`）。这是本行最重要的一条架构事实：**不需要为 MCP 新开一条执行通路**。
5. **T1 只做 stdio + tools**。resources / prompts、HTTP 流式传输、Tasks / MCP Apps 扩展都不进第一版——它们各自有归属（见 §5 被否决）。

---

## 1. 取证方式与局限

| 项 | 做法 | 局限 |
|---|---|---|
| 上游规范 | 读 2026-07-28 的**总览**、**transports**、**authorization** 三页（一手） | **没有**逐节读 `client/elicitation`、`server/tools`、`tools/registry`/tool search、`extensions/tasks`——凡是依赖它们的论断都在 §7 |
| 本仓库 | 读 `ports/process.ts`、`host/host.ts`、`policy/config.ts` 的现状，以及 P2 文档对进程网关的约定 | 没跑任何测试 |
| v1 | `agent/src/mcp.js`（33 KB）、`mcpnotify.js`、`mcpsubs.js` 的体积与角色 | **没有逐行读**；按工作规则 4 只迁结论 |

---

## 2. 上游对照（本轮实际读到的）

### 2.1 协议形状（总览 + transports）

【上游】<https://modelcontextprotocol.io/specification/2026-07-28>、<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports>

- 服务器提供 **resources / prompts / tools** 三类能力；客户端提供 **elicitation**（服务器向用户要信息）。
- **JSON-RPC 2.0，UTF-8**；「每个请求自带协议版本与客户端能力」，放在 `_meta.io.modelcontextprotocol/*`。
- 传输是**绑定**：它决定分帧、元数据怎么带、取消怎么表示，不决定消息含义。
  - **stdio**：客户端启动的子进程，标准流上**换行分隔**的消息；取消用 `notifications/cancelled`。
  - **Streamable HTTP**：每条消息一个 POST，回复是 JSON 或请求作用域的 SSE。
- 该页明确写：**「服务器不发起 JSON-RPC 请求，客户端不发送响应」**。这与「elicitation 是服务器发起请求」的旧理解冲突——**本轮没有读 elicitation 页**，所以这条只记录、不据此设计（§7 待验证 1）。
- 扩展（可选、双方协商）：**Tasks**（长任务、轮询、飞行中输入、持久句柄）、**Skills over MCP**、**MCP Apps**（内联 UI）。

### 2.2 授权（只对 HTTP 传输）

【上游】<https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>

| 事实 | 对我们的含义 |
|---|---|
| 授权是 **OPTIONAL**；HTTP 传输 **SHOULD** 遵循，**stdio SHOULD NOT**，凭证从环境取 | T1 不做 OAuth；凭证问题变成「子进程 env 怎么组装」 |
| OAuth **2.1** + RFC 6750 / 8414 / 7591 / 8707 / 9728 / 9207 | 将来做 HTTP 时的底座 |
| **DCR（RFC 7591）已 deprecated**，首选 **Client ID Metadata Documents**；预注册其次 | 修正 D2 的措辞；将来实现顺序也要改 |
| `resource` 参数（RFC 8707）在**授权请求与令牌请求**里都必须带；令牌只发给签发它的那个服务器 | 防 confused deputy 的硬要求 |
| 无状态、每请求 `_meta` 意味着授权令牌要**按请求携带**，而不是靠连接态 | 【推断】对将来 HTTP 客户端的设计有影响，未验证 |

---

## 3. 本仓库现状（【源码】）

### 3.1 子进程只有一个门

- 所有子进程只经 `ProcessPort`（ADR-014）；该文件的头注释把旧实现的九处 spawn 一一列出，**「MCP stdio」是第二处**（`ports/process.ts:3-8`）。
- env 脱敏、输出截断、进程树终止都在端口内部（ADR-015），调用方只说想要什么（`ports/process.ts:27-29`）。
- 沙箱档位（`off`/`light`/`system`，网络 `off`/`ask`/`on`）是 `SandboxProfile` 的一部分（`ports/process.ts:31-80`），由组合根按配置解析后传给每一次运行。
- **结论**：MCP 的 stdio 服务器如果在 v2 里启动，它**自动**是一个被沙箱与 env 策略覆盖的子进程。这不是设计，是既有纪律的推论。

### 3.2 工具面是静态表

- 宿主在构造时组装 `ReadonlyMap<string, ToolPort>`（`host/host.ts:194` 的 `createTools(...)`），回合把它整张表交给模型（`kernel/run-turn.ts` 的 `wireTools`）。
- 工具的 wire schema 由 P5 的 `defineTool()`/`wire-schema` 产出（`adapters/tools/`），风险等级、`pathInput`/`commandInput` 是数据（`ports/index.ts:89-114`）。
- **MCP 工具是运行期才出现的**：服务器在 `initialize` 后才告诉你有哪几个工具。这与「静态表」是一个结构性差异——`tools` 从常量变成「会话级动态表」，是本行最需要 ADR 的地方。

### 3.3 配置与信任

- 三层配置（用户 → 项目 → `--config`，ADR-064）；项目层的内容受信任闸门约束（ADR-028），指令链的对称规则是「未受信不注入」（ADR-077）。
- v2 **目前没有任何 `mcp` 配置键**（`policy/config.ts`/`host/config.ts` 里零命中）。
- 结论：MCP 服务器定义是**项目可以提供的可执行入口**，必须是受信才启动——否则一个克隆下来的仓库就能让宿主替它起进程。

### 3.4 协议面

- 协议方法表 9 个（`protocol/src/methods.ts:11-21`）；MCP 工具一旦动态注册，前端要能看见「哪些工具来自哪个服务器」，否则「工具名变了」无法解释。
- 前端只吃事件与列表；子 agent 的经验（ADR-079）说明「新事实用新事件 + 可选字段」是可行的加法路径。

---

## 4. 决定草案

### 4.1 范围：T1 只做 stdio + tools（→ ADR 草案）

**决定**：第一版只支持 **stdio 传输**与 **tools** 能力；resources / prompts 不做，HTTP 传输不做，Tasks / MCP Apps / Skills over MCP 不做。

**理由**：

- stdio 与 v2 的进程纪律完全同构（§3.1），是唯一「不需要新架构」的部分。
- HTTP 传输要处理授权、重连、SSE——那是另一条独立的调研线（R3 的 ACP 与将来的远程 MCP 一起看）。
- 工具是编码代理的刚需；resources/prompts 对编码场景的边际价值低，且各有更便宜的替代（Read / AGENTS.md）。

### 4.2 注册：MCP 工具是会话级动态表

**决定**：工具表从「宿主常量」变成「宿主常量 + 每个服务器的动态部分」；命名 **`mcp__<server>__<tool>`**（与上游生态的惯例一致【推断】，需在实现前对照 Claude Code/opencode 的实际命名确认）。名字冲突时**拒绝启动该服务器并报告冲突的两方**，不静默改名。

**理由**：静默改名会让日志里的历史工具名再也对不上；而拒绝启动是可解释的失败。

### 4.3 信任：项目层的服务器定义要受信才启动

**决定**：`mcp.servers` 只在**用户层**或**受信工作区**生效；未受信时整段配置被忽略，并用一行说明跳过了几个服务器（沿用 ADR-077 的「跳过要说出来」）。

**理由**：服务器定义是 `command + args`，等于项目自带的可执行入口——比 `allow` 规则更直接。信任闸门对它是**必须**，不是对齐。

### 4.4 凭证：不进项目配置，也不物化进 `process.env`

**决定**：stdio 服务器的环境变量由宿主按「用户层配置 + 用户 shell 的既有变量 + ADR-015 脱敏规则」组装；**项目层不能声明凭证**（只能声明引用名）。HTTP 的 OAuth 留到传输落地时再设计。

**理由**：规范说 stdio 从环境取凭证（§2.2），而我们的进程边界已经有 env 脱敏（ADR-015）。把密钥写进可提交的配置文件，是这个仓库明确反对的形状（ADR-063 的 `apiKeyEnv` 同理）。

### 4.5 生命周期与取消

**决定**：服务器进程在**会话首次需要其工具时**启动，随会话结束或 `turn.cancel` 终止；取消沿 `signal` → `notifications/cancelled` → 超时后 `ProcessPort.terminate`。服务器崩溃时工具调用失败并报告原因，**不自动重启**（T1）。

**理由**：自动重启会掩盖「它一直崩」这个用户应该知道的事实；重启策略属于后台任务/可观测性行。

### 4.6 结果与错误

**决定**：MCP 工具结果走既有的 `ToolResult` + `Truncation`（ADR-048）；超限截断要说出来。协议错误（服务器返回 JSON-RPC error）映射成 `ok:false` + 原文，不猜测语义。

---

## 5. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| **T1 同时做 HTTP 传输** | 授权（OAuth 2.1 + 元数据发现 + resource 参数）本身就是一条独立工作线；stdio 已经覆盖本地服务器 |
| **把 MCP 工具塞进 `adapters/tools/` 的七件套** | 七件套是静态的、有 `spec` 常量的；MCP 工具运行期才知道名字与 schema |
| **在 MCP 适配器里自己 `spawn`** | 违反 ADR-014；而且绕开沙箱与 env 脱敏，正是这一行要避免的 |
| **复用 v1 的 `agent/src/mcp.js`** | 旧规范实现（工作规则 4：只迁结论）；且 v1 的 spawn 就是 ADR-014 要修的那九处之一 |
| **未受信也启动项目声明的服务器** | 等于让克隆下来的仓库执行任意命令，ADR-028 的信任闸门失去意义 |
| **静默重命名冲突工具** | 日志与配置的历史都对不上；失败要可解释 |
| **自动重启崩溃的服务器** | 掩盖问题；重启属于后台任务/可观测性行的策略 |

---

## 6. ADR 清单（草案，从 083 起）

> ADR 表现有最大编号 **082**。实际落表时按当时最大编号顺延。

| 草案号 | 一句话 |
|---|---|
| ADR-083 | **MCP 首版范围与传输**：只做 stdio + tools；resources/prompts/HTTP/Tasks 不做；与服务器的协议版本协商先走 `initialize` 兼容路径 |
| ADR-084 | **动态工具表与命名**：`mcp__<server>__<tool>`；冲突拒绝启动；工具来源进事件/诊断 |
| ADR-085 | **信任与凭证边界**：项目层 `mcp.servers` 需受信；凭证不进项目配置；子进程 env 由宿主组装并过 ADR-015 脱敏 |
| ADR-086 | **生命周期与错误**：按需启动、随会话/取消终止、崩溃不重启、结果走 `ToolResult` + `Truncation` |

---

## 7. 待验证（不得作为决策依据）

1. **「服务器不发起 JSON-RPC 请求」与 elicitation 的关系**：transports 页这么写，但总览把 elicitation 列为客户端能力。**本轮没有读 `client/elicitation`**，不能据此设计。开工前必须逐节读该页与 `basic/patterns`。
2. **tool search / registry**：前沿调研 D2 提到，本轮未取得对应页面；若 2026-07-28 已把它并入 tools 的发现机制，T1 的「列出全部工具」可能过时。
3. **无状态形态的实际握手**：`initialize` 兼容矩阵的具体判据未读（`basic/versioning`），T1 先按旧路径实现，需要对照该页确认降级行为。
4. **上游命名惯例**：`mcp__server__tool` 来自生态惯例（【推断】），实现前对照 Claude Code / opencode 的真实命名。
5. **v1 结论**：`agent/src/mcp.js`（33 KB）本轮没有逐行读；它的重连、通知订阅、工具缓存策略需要单独过一遍才能说「迁哪些结论」。
6. **沙箱与 stdio 服务器的兼容性**【推断】：`light` 档的读写白名单是否会挡住服务器自己的二进制与依赖目录（例如 `npx` 的缓存）——需要实测，否则「天然被沙箱覆盖」会变成「天然起不来」。

---

## 8. 来源清单

**一手（本轮实际读过）**

- MCP 规范 2026-07-28 总览：<https://modelcontextprotocol.io/specification/2026-07-28>
- Transports：<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports>
- Authorization：<https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>

**本仓库**

- `packages/cowcat/src/ports/process.ts`（单一进程网关、沙箱档位、env 脱敏）
- `packages/cowcat/src/host/host.ts`（静态工具表、组合根）
- `packages/cowcat/src/policy/config.ts`、`host/config.ts`（三层配置，无 `mcp` 键）
- `packages/protocol/src/methods.ts`（9 个方法）
- `agent/src/mcp.js`、`mcpnotify.js`、`mcpsubs.js`（v1 旧规范实现，只迁结论）
- `docs/research/p7-frontier-survey.md` D2、`docs/architecture/README.md`（ADR-014/015/016/028/077）
