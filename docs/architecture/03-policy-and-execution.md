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
| `LockPort` | 已实现（Node 文件锁） | 会话单写者锁，见 [02-kernel.md](02-kernel.md#单写者锁) |
| `SnapshotPort` | 已实现（JSON 文件快照） | 回放加速；缺失或损坏一律回退全量回放，见 [02-kernel.md](02-kernel.md#快照) |
| `ModelPort` | 接口已定，适配器 P4 | 流式模型调用，带 `AbortSignal` |
| `ToolPort` | 接口已定，工具 P5 | 工具规格 + 执行 |
| `ProcessPort` | **契约已定**（P2 T1），适配器待做 | 唯一的子进程网关：脱敏、截断、终止都在里面（ADR-014、ADR-015） |
| `FsPort` | **契约已定**（P2 T1），适配器待做 | 路径身份：canonical / samePath / kindOf / exists，**同步**（ADR-017） |
| `PlatformPort` | **已实现**（P2 T2，Node 适配器） | shell 解析（绝对路径 + 真跑验证）、进程树终止策略、沙箱后端**真跑**探测；结果按会话记忆一次（ADR-018） |

## 进程执行网关（ADR-014）

旧版的问题：Bash 工具、后台任务、MCP stdio、hooks、子 agent 各自 `spawn`，沙箱只覆盖 Bash，所以 MCP 与 hooks 永远在沙箱之外。v2 的设计是：**所有子进程只能经过同一个 `ProcessPort`**。

```
ProcessPort.run(spec, signal)
  spec: { argv, cwd, env(未脱敏的输入), stdin?, timeout, outputCap, sandbox }
  → 网关按 sandbox 档脱敏 env、截断输出（保留尾部 + 丢弃计数 + truncated 布尔）
  → 启动（POSIX：detached 自成进程组；Windows：taskkill /T /F 的对象）
  → 取消或超时：终止整棵进程树（与超时同一条路径）
  → 返回 { exitCode, signal, stdout, stderr, truncated, termination }
```

**契约里的三条边界**，每条都来自实测（[调研 §2 与附录 B](../research/p2-ports.md)），不是推断：

1. **Windows 必须「一次 `/T` 解决」**。`taskkill /T` 按父子关系枚举，直接子进程一旦先死，它就 exit 128（`没有找到进程`），那棵树永久够不着。所以终止路径内部禁止「先单杀、再树杀」这种两步写法。
2. **回退必须上报**。taskkill 不可用时回退 `child.kill()` 可以，但结果里的 `termination.residuePossible` 必须为真——「我们请求过」不等于「它没了」。
3. **自建会话的后代不在保证范围内**。一个自行 `setsid()` 的后代能逃出 `kill(-pgid)`，且父进程死后连按 ppid 都找不到它。契约写明这条边界，而不是暗示「全杀干净」。沙箱路径是例外：`bwrap --die-with-parent` 由内核 pidfd 兜底。

`termination` 区分两件事：平台**能**做什么（`TerminationStrategy`，来自 `PlatformPort`）与某一次运行**实际**做了什么（`TerminationMethod`）。Windows 上 `supportsGraceful: false`——实测 SIGTERM 不可捕获，没有优雅期可用。

没有任何模块可以绕过网关直接 `child_process.spawn`：这条由 `packages/cowcat/eslint.config.js` 里一条独立 pattern 强制（`src/adapters/` 之外禁 `node:child_process` / `node:fs` / `node:os`），并由 `tools/lint-probe.mjs` 验证它真的会报错。

## 环境变量脱敏（ADR-015）

脱敏在网关内做，且按**执行档位**而不是按调用方：`light` 与 `system` 都脱敏，`off` 明确不脱敏。调用方传「想要什么环境」，不传「拼好的环境」——旧版 `background.js` 那种把已剥离的键回灌的做法，在结构上不再可能发生。

规则集**沿用旧版三项**（保留列表、形状正则 `(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|PRIVATE)`、显式 `deny` 的精确名与 `/regex/` 两种形式），因为它们有测试、每条都有理由；**变的是覆盖面与汇报**：

| | 旧版 | v2 |
|---|---|---|
| 覆盖路径 | 9 条子进程路径里只有 Bash 的 `light` 档 | 全部（都经 `ProcessPort`） |
| `system` 档 | 因 `mode !== 'light'` 的分支写反而**不脱敏**（与文档矛盾） | 脱敏 |
| 后台任务 | `{ ...process.env, ...env }` 把剥离的键**回灌** | 结构上不可能发生 |
| 汇报 | 只有 UI 文案 | 返回 `removed`（只记名字不记值）与 `ignoredDeny`（坏正则不再静默忽略） |

规则集是纯函数，放在 `src/policy/env.ts`：它决定子进程环境**允许**有什么，是策略问题而不是运行时问题；适配器只负责把它应用上去。

脱敏**不是安全边界**：它减少误发。`light` 档不提供 OS 级隔离，凭据文件在 `light` 档完全可读，MCP server 以完整权限运行。这条定位同时写进 `SECURITY.md`，避免把「env 干净」读成「凭据安全」。

## 沙箱执行器（P2，ADR-016）

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
