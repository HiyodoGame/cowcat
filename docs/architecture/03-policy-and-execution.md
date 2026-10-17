# 03 策略、端口与执行

## 策略引擎

### 模型

策略是一个纯函数：`decide(request, rules) → Decision`。

- 请求（`ActionRequest`）目前只描述工具调用：名称、风险等级（`read` / `write` / `exec` / `network`）。**本文档曾写「P2 起扩展为进程、文件路径、网络域名等请求种类」，该扩展并未发生**——P2 的产出是三个端口而非请求种类。扩形状是 P3 的任务，见 ADR-027。
- 规则（`Rule`）包含名称、匹配函数、裁决（`allow` / `ask` / `deny`）与可选理由。**匹配函数在 P3 改为结构化字段**（配置无法表达函数，而 P3 的出口标准要求「全部裁决都能由配置表达」），见 ADR-027。
- 合并顺序：**deny 压过 ask，ask 压过 allow**，同一裁决内第一条命中的规则生效。顺序与规则书写顺序无关，这是有意的：不允许一条后写的 allow 悄悄覆盖前面的 deny。理由与外部对照见 ADR-023。
- **`deny` 永不被短路**：无人值守模式只改变 `ask` 的归宿，`deny` 在任何模式下都执行。这是**有意偏离旧版**——旧版 `permissions.js:58` 让 yolo 在一切规则之前一票放行，`deny` 一并失效。见 ADR-024。
- **没有命中任何规则时返回 `ask`**，规则名为 `no-rule-matched`。未知的动作永远不会被静默允许。

### 为什么不沿用旧版的 `classifyCommand`

旧版把风险分级（静态命令分类）、权限（用户批准）、沙箱（OS 隔离）三件事散在 `sandbox.js`、`permissions.js`、`loop.js` 里，loop 直接调用三者。v2 的做法是：

- 策略引擎只产出**裁决**，不执行任何东西；
- 执行由 ProcessPort 与沙箱执行器完成；
- 审批由前端完成，内核只发出 `ask` 并等待结果。

三者可以独立替换和测试。

### 默认规则

`policy/defaults.ts`：读操作直接允许；写、执行、网络操作要求询问。这是 P0 的最小集合，**两条规则里一条 `deny` 都没有**——所以 `deny > ask > allow` 的 deny 分支在生产里不可达，只被测试规则触发（实测见调研探针 P10）。P3 会把它替换为可配置的规则集（用户级 / 项目级 / 会话级分层），并加入路径信任模型。规则语言的决定、旧版 DSL 的表达力边界与外部对照见调研 [`../research/p3-policy.md`](../research/p3-policy.md) §4 与 ADR-027。

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
| `ProcessPort` | **已实现**（P2 T4，Node 适配器） | 唯一的子进程网关：脱敏、截断、终止都在里面；超时与取消走同一条终止路径（ADR-014、ADR-015）。沙箱执行器待做（T5），`system` 档在注入执行器前**显式拒绝**，不降级（ADR-016） |
| `FsPort` | **已实现**（P2 T3，Node 适配器） | 路径身份：canonical / samePath / kindOf / exists，**同步**；缓存挂实例且只在找到现存祖先时写入（ADR-017） |
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

## 沙箱执行器（P2 T5）

`system` 档由执行器决定**怎么跑**，生成器是纯函数，只有执行器本身不纯（要建目录、要问探测结果）。分层：`policy/` 决定策略的**含义**，`adapters/sandbox/backends/` 把策略变成命令行，`adapters/sandbox/executor.ts` 做后端选择与拒绝判定。

| 文件 | 职责 | 纯？ |
|---|---|---|
| `policy/sandbox-defaults.ts` | 默认拒绝/允许清单、私有 `/tmp` 上限 | 纯 |
| `policy/sandbox-paths.ts` | `~` / 相对 / glob 拒绝 / 规范化 | 纯（经 `FsPort` 问文件系统） |
| `adapters/sandbox/backends/bwrap.ts` | 策略 → `bwrap` argv | 纯（文件系统探针注入） |
| `adapters/sandbox/backends/seatbelt.ts` | 策略 → `sandbox-exec` argv + SBPL | 纯 |
| `adapters/sandbox/executor.ts` | 后端选择、拒绝、私有临时目录生命周期 | **不纯** |

### 拒绝有两种，消息必须不同

| 情形 | 错误类 | 例子 |
|---|---|---|
| 后端**跑不了** | `SandboxUnavailableError` | Windows 没有后端；bwrap 被 AppArmor 挡住 |
| 后端能跑，但**这个请求满足不了** | `SandboxRequestRefusedError` | macOS 的 `network: 'on'`——沙箱工作正常，但名字解析回不来 |

复用同一个错误类会对着一个沙箱完全正常的机器说「sandbox "system" is not available here」，把用户引向错误的方向。两者**都不可降级**（ADR-016）。

### 三条来自实测的规则

- **加固单独探测**：bwrap 的可用性（不带 flag）与加固能力（`--unshare-user --disable-userns --assert-userns-disabled`）是**两次**探测。内核拒绝加固只说明沙箱更弱，不说明它坏了；把它报成不可用会逼用户关掉沙箱，不加探测就发 flag 会让第一条真实命令失败。
- **不存在的写路径必须上报**：绑一个不存在的源会让整条命令失败，所以只能跳过——但跳过意味着沙箱永远建不出该路径，因此必须写进限制项。
- **私有 `/tmp` 有上限**：`--tmpfs /tmp` 默认拿到内存的一半且是 RAM 支撑，实测 19.5 GiB。固定 2 GiB 并 `--perms 1777`（真实 `/tmp` 的形状，默认 tmpfs 是 0755）。上限是**实测生效**的，不是写进 `df` 的装饰。

### bwrap 的挂载顺序是承重的

挂载按命令行顺序生效、**后者覆盖前者**。两个读 profile 因此要求**相反**的顺序：

| profile | 顺序 | 为什么 |
|---|---|---|
| `workspace` | 私有 tmpfs → 读绑定 → 拒绝覆盖 → 写绑定 | tmpfs 在前，策略自己的绑定才能把该暴露的重新暴露出来。**放在后面会静默吃掉宿主 `/tmp` 下的每一个读授权**（实测：允许的 `$HOME/notes.txt` 变成 GONE） |
| `hide` | `--ro-bind / /` → 拒绝覆盖 → 私有 tmpfs → 写绑定 | 根绑定把宿主的 `/tmp` 也绑进来了，tmpfs 必须在它之后，否则沙箱重新继承宿主临时目录——旧版 CI 第一次跑就因为这个半真半假而失败 |

### G1/G2/G3 测试证明到什么等级

借用 arXiv:2610.04504 的 Verification Autonomy Levels（见 [research/p2-sandbox-literature.md](../research/p2-sandbox-literature.md)）——「zero is an outcome, not a guarantee」：

我们的强制测试证明的是 **L2（客观事实）**：在我们实际跑过的那批用例、实际跑过的那台机器上成立。它**不是** L3/L4（可判定完备），**也不是安全保证**。内核变了、加了新的挂载选项、某个平台没跑到，都能让这个断言失效而**没有一个测试变红**。

因此 `system` 档在文案与文档里都**不得**被表述为安全保证；它是纵深防御的一层（Red-Teaming the Agentic Red-Team 指出，即使在沙箱容器内，agent 工具仍可能被攻陷操作者机器）。

### Seatbelt 的符号链接遍历是承重的

macOS 上 `/var`、`/etc`、`/tmp` 本身是符号链接。解析一条路径从**调用方写的那个拼写**开始，于是走 `/var/folders/…` 就必须先读 `/var` 这个 SYMLINK vnode。profile 只授了 `file-read-metadata (vnode-type DIRECTORY)`，所以缺的就是这一条。

实测（macOS 15，同一个 profile、同一个文件）：

```
read /private/var/folders/…/n.txt   OK
read /var/folders/…/n.txt          EPERM   ← 没有 SYMLINK 规则
read /var/folders/…/n.txt          OK      ← 有
readlink /var                      EPERM / OK:private/var
```

修法是在 DIRECTORY 那条规则旁边补一条 `file-read-metadata (vnode-type SYMLINK)`，同理由、同位置（读拒绝之后）。**代价**：`readlink()` 全局可用，会暴露符号链接的目标——那是一个路径字符串，不含文件内容，与 note 7 已经接受的目录 metadata 属于同一类披露。这是让一个正常文件系统可被遍历的最小代价。

它之所以难被发现，是因为 `subpath` 匹配的是**内核解析后**的路径，所以 profile 看起来完全正确；又因为**相对路径不受影响**，所以一套用相对路径的测试会全绿，而一个用绝对路径的模型撞墙。

**一次走错的修法，留作记录**：中途我判定「`subpath` 匹配字面路径」，于是让每条路径发两种拼写。实测它**不解决问题**（双拼写 + 无 SYMLINK 规则仍然 EPERM），而代价是真实的——每条 deny 都要手工复制两份，漏一处就是把凭据拒绝变成两个字符的绕过。为了零收益把拒绝面扩大一倍，比不做更糟。这条结论现在由一条测试钉住。

### macOS 上存在性可以被观察，内容不行【实测限制】

补上 SYMLINK 规则后，「宿主临时文件不可见」那条断言翻成可见。查下去是断言错了：`existsSync` 在 `statSync` 与 `readFileSync` 都返回 EPERM 的路径上返回 **true**。内容隔离自始至终是好的（`file-read-data` 仍被正确拒绝）。

所以 macOS 上的准确表述是：**读面之外路径的存在性可被观察，内容不可**。这是一个可用的侧信道——agent 能探测某路径下有没有文件——不影响内容机密性，但要写进限制项，不能含糊成「读面外完全不可达」。测的是 Node 的 `existsSync`；未单独测裸 `access(2)`，不宣称更多。

这条同时是一条通用规则：**隔离测试不能拿 `existsSync` 当探针**。它在两个不同的失败原因下都给出误导性的答案。

### 沙箱不能阻止范围内的破坏

范围扩张（agent 在良性任务上删除无关文件、擦掉陈旧凭据备份）与逃逸是**并列的第四类**授权问题（arXiv:2605.18583 实测：仅移除 prompt 里的授权声明，越界率从 0.0% 升到 17.1%）。我们的写策略是 allow-only，所以项目目录内的 `rm` **在沙箱里会成功**。

这不是缺陷，是边界：**沙箱管「能碰哪些路径」，审批门禁管「这次操作该不该做」**（P3/P5）。这条边界由 `test/sandbox-enforcement.test.ts` 钉成测试——它断言范围内的破坏**确实能发生**，以防日后被过度声称，或被「顺手修好」而 deny 掉 `rm`。

### 沙箱不是它自己调用者的权限边界

实测：调用者是 root 时 bwrap 根本不建 user namespace（恒等映射 `0 0 4294967295`），沙箱内进程在内核层面就是 root，`/etc` 里的 root 属主文件照样能读；调用者非特权时同一文件被拒绝。

架构文档已写明 CowCat 是 npm 分发、不要求管理员安装，所以**推荐部署下这条不成立**。但在 root 容器里跑 CowCat 的用户拿到的隔离比看上去弱，所以这类运行必须把这件事写进限制项上报——不拒绝（root 容器里往往是唯一能用的环境），但**必须让用户知道**。

调研与实测见 `research/p2-sandbox.md`。

## 失败模式的设计原则

1. **不可用时拒绝，不降级到更宽松的模式**。旧版 `failOpen` 把「沙箱不可用」降级到 light，这意味着用户以为有隔离实际没有。v2 默认拒绝；若某次降级是安全上更宽松的（例如去掉隔离同时保留网络），则拒绝且不可被 failOpen 覆盖。
2. **任何被拒绝或降级的动作都进审计**，审计记录包含实际生效的模式与后端，而不是请求的模式。
3. **错误信息写给模型看**。拒绝原因说明是哪条规则、为什么，以及可以怎样改配置，而不是一句「not allowed」。
