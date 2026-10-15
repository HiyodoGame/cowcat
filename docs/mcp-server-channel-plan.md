# MCP server→client 通道 实施方案（第九轮）

> 状态：**已完成**（2026-10-16）。按下方「实施顺序」逐块落地；实际实现与两处偏差记在 `docs/fix-plan-2026-10-15.md` 第九轮（退避计数重置、订阅登记竞态）。

## 1. 现状与缺口

| 项 | 现状 |
|---|---|
| 请求-响应 | stdio（JSON-RPC 行协议）与 Streamable HTTP（POST + SSE 响应体）都已加固（分页、session、保持流、超时、预算） |
| 无 `id` 的入站消息 | **被丢弃**：`StdioTransport._onData` 只匹配 `pending`，其余静默丢弃；`HttpTransport._readResult` 注释「server notification: nothing to hand back, keep reading」 |
| server→client 长连接 | 无（只发 POST，从不 `GET`） |
| `resources/subscribe` | 无；`docs/tools/tool-catalog.md` 15/16 已规定 `SubscribeMcpResource`/`UnsubscribeMcpResource`，**代码缺失** |
| server 发起的请求（sampling / elicitation / roots） | 无回应——规范要求客户端回 error，否则 server 一直等 |

后果：`notifications/message`（logging）、`*/list_changed`、`resources/updated` 永远收不到；文件类 server 刚新建的文件、工具集变化、server 的日志，客户端全都不知道。

## 2. 目标 / 非目标

**做**：
1. 传输层统一入站分发（stdio + POST 流 + GET 长连接）。
2. Streamable HTTP 的 `GET` SSE 长连接：增量解析、断线重连（退避 + `last-event-id` 复播）、405 不重连、`stop()` 中止。
3. server 发起的请求统一回 `-32601`（`ping` 回空结果），不让 server 悬挂。
4. `resources/subscribe` / `unsubscribe` 客户端方法 + `SubscribeMcpResource` / `UnsubscribeMcpResource` 工具（按 catalog 15/16 的形状）+ 订阅登记表。
5. 通知呈现（bin）：logging 打一行、`*/list_changed` 刷新该 server 的工具/prompt/resources、`resources/updated` 仅对已订阅 URI 提示一行。

**不做（明确记录，避免日后当成 bug）**：
- **不把通知注入模型上下文**（需要回合队列与「何时注入」策略，且会污染缓存前缀）。
- sampling / elicitation / roots（server 反向调用模型或终端）——只回 error。
- `SubscribePolling` / `UnsubscribePolling`（catalog 17/18，客户端定时轮询，独立特性）。
- 不自动订阅服务器上的全部资源（订阅是模型/用户的显式动作）。

## 3. 设计

### 3.1 SSE 解析器（先抽出来，两处共用）

现在 `_readResult` 手写行扫描，只处理**单行 `data:`**；SSE 规范允许多行 `data:` 拼接，且 `id:`/`retry:` 字段当前完全被忽略。抽 `src/sse.js`：

```js
export class SseParser {
  feed(chunk)        // 返回本块解析出的完整事件数组
  // 事件形如 { data, id?, retry?, event? }；按空行分帧，多行 data 用 \n 拼接
}
```
`HttpTransport._readResult` 改为用它（找到 `id` 匹配的结果帧即返回，保持「流可以一直开着」的既有行为——已有回归测试）；GET 长连接也用它。

### 3.2 入站分发（传输层不认识 UI）

```js
transport.onMessage   // (msg) => void   // 无 id 的通知，或 server→client 请求
```
- `StdioTransport._onData`：`msg.id == null` 且有 `method` → `onMessage(msg)`；有 `id` 走 `pending` 匹配（不变）。
- `HttpTransport._readResult`：帧无 `id` → `onMessage(msg)`（不再丢弃）。
- `HttpTransport.startStream()`：GET 流上的帧 → `onMessage(msg)`。
- `McpClient` 转发给外部回调：`client.onNotification = (method, params) => ...`（在 `connect()` 之前设置；bin 在 `connectMcp` 之前装配）。

### 3.3 GET SSE 长连接（Streamable HTTP）

```
GET <url>
  accept: text/event-stream
  mcp-session-id: <sid>            # 与 POST 同源
  last-event-id: <lastEventId>     # 仅重连且有值时
```
- 非 2xx：**405/404 → 不重连**（SDK 同判据：405 表示该端点不提供 SSE 流），记录一次「该 server 无 server→client 通道」，不刷屏；其它错误走退避重试。
- 解析：`SseParser`；`id:` → 记 `lastEventId`；`retry:` → 覆盖退避基准（规范字段，SDK 同）。
- 重连：`delay = min(initial * factor^attempt, max)`，默认 `1000 / 2 / 30000`，最多 5 次；成功后 attempt 归零。
- `stop()`：`AbortController.abort()` + 清定时器，之后不再重连。
- 证书/代理类错误（fetch reject）：同样走退避，不区分（HTTP 状态码才区分 405）。

### 3.4 server 发起的请求

`{ id, method }` 且无 `result`/`error`：
- `ping` → 回 `{}`；
- 其余（`sampling/createMessage`、`elicitation/create`、`roots/list`）→ 回 `{ code: -32601, message: 'Method not found' }`。
- 回法：HTTP → 再 POST 一条 `{jsonrpc:'2.0', id, error}`（规范：客户端把对 server 请求的响应 POST 回端点）；stdio → 直接写回 stdin 那条流。

### 3.5 订阅：客户端方法 + 工具 + 登记表

- `client.subscribe(uri)` / `client.unsubscribe(uri)`：先查 `capabilities.resources?.subscribe`，不支持则抛清晰错误（`<server> does not support resources/subscribe`）。
- 新文件 `src/mcpsubs.js`（纯逻辑，可单测）：
  ```js
  subscribeTo(registry, { server, uri, reason, client }) // -> {subscribed, subscriptionId}
  unsubscribeBy(registry, { server, uri, subscriptionId }) // -> {unsubscribed}
  isSubscribed(registry, uri) -> entry | undefined      // 给 resources/updated 用
  ```
  - `subscriptionId` 形如 `mcp:<server>:<uri>`（可读、可推断、天然去重）。
  - 退订按 server / uri / subscriptionId 任一维度（catalog 要求）。
- 工具：`SubscribeMcpResource`（`{server?, uri?, reason?}` → `{subscribed, subscriptionId}`）、`UnsubscribeMcpResource`（`{server?, uri?, subscriptionId?}` → `{unsubscribed}`）。注册进 `src/tools/index`（与 `ListMcpResources` 同处，走 `ctx.mcpSubs`）。

### 3.6 通知呈现（bin）

新文件 `src/mcpnotify.js`（纯函数，便于单测，不依赖 UI）：

```js
classifyMcpNotification(method, params)
  -> { kind: 'log',            level, text }
   | { kind: 'list-changed',   what: 'tools'|'prompts'|'resources' }
   | { kind: 'resource-updated', uri }
   | { kind: 'ignore', why }         // progress / cancelled / 未知
```
bin 的处理：
- `log` → 一行 `ⓘ [server] info 消息`（TUI 走 toast 或系统行，行模式 `ui.print`）。
- `list-changed` → 重新 `tools/list`（+ `prompts/list`、`resources/list`），**先 `registry.unregister('mcp__<server>__*')` 再注册**（复用 `/mcp reconnect` 的既有做法，避免删掉的工具残留、改了的 schema 不生效），并重建 prompt 命令索引。
- `resource-updated` → 若在订阅表里，打印一行（带上 `reason`），否则忽略；不拉取内容（避免每次变更都读文件）。

## 4. 测试计划

**单测（仓库内，无依赖）**
1. `SseParser`：单帧/多帧/一次块切在中间/多行 `data:`/`id:`/`retry:`/注释帧（`: keepalive`）/CRLF。
2. `_readResult` 回归：保持流的服务器仍 3ms 返回（已有测试）+ 通知帧被分发而不是丢弃。
3. stdio：无 `id` 的通知 → `onNotification`；`pending` 匹配不受影响。
4. GET 长连接（手写 `node:http` fixture，无 SDK）：发通知 → 分发；服务器主动断流 → 客户端重连且**带 `last-event-id`**（fixture 记录请求头断言）；退避生效；超上限后停止并回调一次错误；**405 → 只 GET 一次**。
5. server→client 请求：`sampling/createMessage` → fixture 断言收到 `{id, error:{code:-32601}}`；`ping` → `{}`。
6. `stop()` 后不再重连。
7. `mcpsubs`：订阅/按三维度退订/重复订阅幂等；工具层：不支持 `subscribe` 的 server → 明确错误。
8. `mcpnotify.classify`：四类 + 忽略类。

**E2E（piped REPL，stub 模型）**
9. fixture 在 `resources/subscribe` 后发 `notifications/resources/updated`（+ 启动时发一条 logging）→ CLI stdout 出现该行；`/mcp__...` 命令索引在 `list_changed` 后更新（fixture 变更工具集 → 再 `tools/list` 拿到新工具）。

**真实 server 联调（`agent/test/live/`，新脚本 `stream-channel.mjs`）**
10. 用官方 SDK 的 `StreamableHTTPServerTransport`（`enableJsonResponse:false`）起 server：
    - `server.sendLoggingMessage()` → 走 GET 流 → 我们的 `onNotification` 收到；
    - 连接后 `registerTool` 新增工具 → SDK 发 `notifications/tools/list_changed` → 我们收到；
    - `resources/subscribe` + `sendResourceUpdated` → 我们收到 `resources/updated`；
    - 断言 GET 请求带着 `mcp-session-id`；
    - 主动杀掉 TCP 连接（server 侧结束流）→ 断言我们重连并带 `last-event-id`（SDK server 有 in-memory event store，可复播）。

## 5. 风险与边界

- **共享解析器回归**：`_readResult` 是已加固的热路径，改用它必须跑既有「流保持打开」「SSE 多帧」「保持流 + keepalive」三组测试。
- **通知风暴**：logging 可能很密 → 单条一行、不落盘、TUI 复用 toast 的节流；`list-changed` 刷新加最小间隔（500ms 合并）防止 server 抖动导致反复重注册。
- **重连风暴**：退避 + 上限 + 405 不重连 + `stop()` 中止；重连失败只记一次错误回调。
- **不注入上下文**：若日后要「通知进模型上下文」，需要单独设计回合队列（不在本轮）。
- **只读分类（已决）**：`ListMcpResources`/`ReadMcpResource` 不在 `permissions.js` 的 `READ_ONLY` 里，plan 模式与未信任目录的 `-p` 会被拒——与 `Read` 被允许不一致。**决策：只把这两个纯读取工具加入 `READ_ONLY`**；`SubscribeMcpResource`/`UnsubscribeMcpResource` 保持需授权（它们会改 server 侧订阅状态）。

## 7. 已确认的决策

1. **只读分类**：只加 `ListMcpResources` + `ReadMcpResource`（本轮一并修）。
2. **通知呈现**：只走 UI + `*/list_changed` 自动刷新工具（不注入模型上下文；`.mcpnotify.js` 只产出行/toast 指令，刷新由 bin 执行）。

## 6. 实施顺序（提交粒度）

1. `src/sse.js` 抽取 + `_readResult` 改用它（含多行 data 修复）→ commit
2. 传输层 `onMessage` + stdio/POST 通知分发 → commit
3. GET 长连接 + 重连/复播 + server 请求回 error → commit
4. `client.subscribe/unsubscribe` + `src/mcpsubs.js` + 两个工具 → commit
5. `src/mcpnotify.js` + bin 呈现与刷新 + E2E → commit
6. 联调脚本 `stream-channel.mjs` + 文档（USAGE/changelog/fix-plan/ROADMAP）+ push
