# 03 策略、端口与执行

## 策略引擎

### 模型

策略是一个纯函数：`decide(request, rules) → Decision`。

- 请求（`ActionRequest`）目前只描述工具调用：名称、风险等级（`read` / `write` / `exec` / `network`）。P2 起扩展为进程、文件路径、网络域名等请求种类。
- 规则（`Rule`）包含名称、匹配函数、裁决（`allow` / `ask` / `deny`）与可选理由。
- 合并顺序：**deny 压过 ask，ask 压过 allow**，同一裁决内第一条命中的规则生效。顺序与规则书写顺序无关，这是有意的：不允许一条后写的 allow 悄悄覆盖前面的 deny。
- **没有命中任何规则时返回 `ask`**，规则名为 `no-rule-matched`。未知的动作永远不会被静默允许。

### 为什么不沿用旧版的 `classifyCommand`

旧版把风险分级（静态命令分类）、权限（用户批准）、沙箱（OS 隔离）三件事散在 `sandbox.js`、`permissions.js`、`loop.js` 里，loop 直接调用三者。v2 的做法是：

- 策略引擎只产出**裁决**，不执行任何东西；
- 执行由 ProcessPort 与沙箱执行器完成；
- 审批由前端完成，内核只发出 `ask` 并等待结果。

三者可以独立替换和测试。

### 默认规则

`policy/defaults.ts`：读操作直接允许；写、执行、网络操作要求询问。这是 P0 的最小集合。P3 会把它替换为可配置的规则集（用户级 / 项目级 / 会话级分层），并加入路径信任模型。

## 端口

端口是内核对外部世界的全部依赖，定义在 `src/ports/`。

| 端口 | 状态 | 说明 |
|---|---|---|
| `Clock` | 已实现（Node 适配器） | 时间戳，测试中用固定时钟 |
| `IdSource` | 已实现（Node 适配器） | 回合与调用 ID |
| `EventStore` | 已实现（JSONL 适配器） | 追加与读取会话日志 |
| `ModelPort` | 接口已定，适配器 P4 | 流式模型调用，带 `AbortSignal` |
| `ToolPort` | 接口已定，工具 P5 | 工具规格 + 执行 |
| `ProcessPort` | P2 | 进程启动网关（见下） |
| `FsPort` | P2 | 文件访问，路径规范化在这一层做 |
| `PlatformPort` | P2 | shell 解析、路径身份、进程树终止、沙箱执行器可用性 |

## 进程执行网关（P2）

旧版的问题：Bash 工具、后台任务、MCP stdio、hooks、子 agent 各自 `spawn`，沙箱只覆盖 Bash，所以 MCP 与 hooks 永远在沙箱之外。v2 的设计是：**所有子进程只能经过同一个 `ProcessPort`**。

```
ProcessPort.run(spec, signal)
  spec: { argv, cwd, env(已脱敏), stdin?, timeout, outputCap, sandbox: SandboxProfile }
  → 由当前平台的 SandboxExecutor 包装 argv
  → 启动（进程组 / Windows Job 或 taskkill /T）
  → 输出按上限截断并记录截断事实
  → 取消或超时：终止整棵进程树
  → 返回 { exitCode, signal, stdout, stderr, truncated }
```

要点：

- 脱敏环境变量（旧版 `secret 脱敏 env` 的规则）在 ProcessPort 统一做，而不是每个调用方各做一次。
- 进程树终止是必需能力：只杀父进程会留下孤儿，这在 Windows 上尤其常见。
- 没有任何模块可以绕过网关直接 `child_process.spawn`；这一条由 lint 规则在 P2 加入。

## 沙箱执行器（P2）

`SandboxExecutor` 是 ProcessPort 的一个包装策略，不是 Bash 的特例：

| 执行器 | 平台 | 来源 | 状态 |
|---|---|---|---|
| `light` | 全平台 | 无 OS 隔离，仅审计与脱敏 | P2 |
| `seatbelt` | macOS | 旧版 `backends/seatbelt.js`（已在 macOS CI 真实验证） | P2 迁移 |
| `bwrap` | Linux（含 WSL2） | 旧版 `backends/bwrap.js` | P2 迁移 |
| 无（`system` 档拒绝） | Windows 原生 | — | 见 [05-platforms.md](05-platforms.md) |

迁移时保留旧版的已知结论，不重新猜测：

- Seatbelt 的 profile 语义（last-match-wins、specific deny 压过 wildcard allow、根 inode 与 `/etc` `/var` 符号链接等）以旧版 `docs/fix-plan-2026-10-15.md` 第二十轮为准；
- macOS 的 `network: 'on'` 不可用且不可降级，这一结论来自真实 macOS 15 的夹逼实验，v2 保持相同的拒绝语义。

## 失败模式的设计原则

1. **不可用时拒绝，不降级到更宽松的模式**。旧版 `failOpen` 把「沙箱不可用」降级到 light，这意味着用户以为有隔离实际没有。v2 默认拒绝；若某次降级是安全上更宽松的（例如去掉隔离同时保留网络），则拒绝且不可被 failOpen 覆盖。
2. **任何被拒绝或降级的动作都进审计**，审计记录包含实际生效的模式与后端，而不是请求的模式。
3. **错误信息写给模型看**。拒绝原因说明是哪条规则、为什么，以及可以怎样改配置，而不是一句「not allowed」。
