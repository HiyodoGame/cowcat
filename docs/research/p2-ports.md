# P2 调研：端口与执行网关

> 依据 [dev-plan-v2.md](../dev-plan-v2.md)「工作规则 1」：每个阶段开始前先做调研，回答阶段内的开放问题，列出被否决的方案及理由。本文件回答 P2 的三个开放问题，并给出它们对 P2 六项范围的具体影响。
> 最后更新：2026-10-17。状态：**调研完成（含 §7 第 1、2 条的本机实测，见附录 B），待评审**。
> 前置：`docs/architecture/03-policy-and-execution.md`（端口与沙箱契约）、`docs/architecture/05-platforms.md`（平台矩阵）、`docs/sandbox-system-plan-2026-10-16.md`（威胁模型与 G1–G8）、`docs/sandbox-research-2026-10-16.md`（实证与坑清单）。

## 证据标注约定

沿用 [p1-kernel.md](p1-kernel.md) 的约定，并按本阶段的特点调整：

- **【源码】** 本次会话直接读到实现、配置或文档，给出 `文件:行号`
- **【既有实测】** 仓库里此前的会话留下的实测记录（fix-plan 回合叙述、CI 运行结果、测试断言）。**本次没有重跑任何实验**，引用时一律给出出处
- **【上游】** 来自上游官方文档或发布说明
- **【未验证】** 尚未实测，不得作为决策依据

> **本文件的证据边界（必须先说清）**：主体结论来自读源码与读既有的实测记录；此外，§7 的第 1、2 条在本机补做了**新增实测**（Windows 本机 + WSL2），环境、结果与复现方式见**附录 B**。凡未标注实测来源的判断，都来自源码或仓库里已有的记录，§7 列出仍需补做的验证。

---

## 0. 结论摘要

| 问题 | 结论 | 依据 |
|---|---|---|
| 进程树终止在 Windows 与 POSIX 上怎么做 | **POSIX 用进程组**（启动即 `detached` 自成组，`kill(-pid, SIGTERM)` → 宽限 → `SIGKILL`）；**Windows 用 `taskkill /T /F`，且必须在直接子进程还活着时调用**——它按父子关系枚举，父进程一死就再也找不到那棵树（实测：exit 128「没有找到进程」，孤儿存活）。taskkill 不可用时回退 `child.kill()`，并把「可能残留」作为**结果事实上报**。终止与超时走**同一条**路径 | §2、附录 B |
| 旧版 seatbelt / bwrap 哪些结论必须保留 | bwrap 的 9 条（mount 顺序即策略、私有 `/tmp` 不得被宿主 tmpdir 撤销、拒绝用「隐藏」实现、写拒绝回绑只读、网络必须命名空间、隔离参数集、系统读面是显式列表、worktree 同级目录、glob 显式暴露）+ seatbelt 的 6 条语义与 4 条实测缺陷 + 探测的「真跑而非版本检查」「不可用必须带 reason/detail/fix」 | §3 |
| 环境变量脱敏规则集是否与旧版一致 | **规则集沿用**（保留列表 + 形状正则 + 显式 deny），但**覆盖面必须扩大**：旧版只有 Bash 的 `light` 档在脱敏（`system` 档因分支写反而**不脱敏**，后台任务把被剥离的键**回灌**，MCP/hooks/statusline/git/`!` shell 全部不脱敏）。v2 在 ProcessPort 内统一做，`light`/`system` 都脱敏 | §4 |

四条纠正前提的发现（后两条来自本次实测，附录 B）：

1. **旧版不是「没有树杀」，而是「有两套互不相干的终止行为」**（§2.1）：后台任务与 MCP 走树杀，前台 Bash、`SIGINT`/`SIGTERM` 处理、探测与同步 git 调用都不走。P2 要做的不是「补上树杀」，而是**把终止收敛成一条路径**。
2. **旧版 `system` 档实际不脱敏**，而文档（`sandbox-system-plan §3.1`、`docs/USAGE.md`）声称「env 同 light」——这是实现与文档不一致，且**没有任何测试或注释承认过**（§4.2）。P2 修掉它，并把它记进偏差。
3. **`taskkill /T /F` 的边界已实测**：它在直接子进程**活着**时能走完整棵树（`cmd.exe → node → node` 实测全灭）；父进程一旦先死，它就 **exit 128「没有找到进程」**，而 `cmd.exe`/`Git Bash`/`PowerShell` 这类父进程的子进程**确实会存活**（实测 12/12 采样存活）。所以旧版两次真实逃逸的根因不是「taskkill 不好用」，而是**顺序**：先杀了父，才想起树杀。
4. **POSIX 侧的 `setsid()` 逃逸是结构性的，不是概率问题**：实测一个自行 `setsid()` 的后代在组杀后存活，而且父进程死后**按 ppid 遍历再也找不到它**——唯一的句柄是 spawn 时记录的 pid。含义：`kill(-pid)` 覆盖「普通后代」，不覆盖「自建会话的后代」。

---

## 1. 验证环境

| 项 | 值 |
|---|---|
| 平台 | `win32`（Windows 11），shell 为 PowerShell / Git Bash |
| Node | `v24.18.0` |
| 新增实测的环境（附录 B） | 实验 A 在**本机 Windows** 上跑；实验 B 在本机唯一的 WSL2 发行版 `docker-desktop` 里跑，内核 `6.18.33.2-microsoft-standard-WSL2`，**该发行版内没有 node/python**（只有 `setsid`/`ps`/`pgrep`/`sh`），所以 POSIX 侧测的是 `setsid`+`kill` 的**内核语义**，不是 Node 的 `detached` 实现 |
| 仓库状态 | `main = b8a8c6c`（与 `origin/main` 一致，无开放 PR）；`docs/HANDOFF.md` 未跟踪 |
| 本次新增的实验 | **无**。未跑测试、未跑探针；结论全部是源码与既有记录的阅读结果 |
| 证据主要来源 | 旧版实现 `agent/src/**`；既有实测记录 `docs/fix-plan-2026-10-15.md` 第十六至二十轮；CI 形状 `.github/workflows/ci.yml` |

**平台差异提示**：旧版的树杀与沙箱结论分别在 Linux（CI 真机）、macOS（CI 真机）与 Windows（本机）上产生过，但**没有任何一项在三平台都跑过**。P2 的出口标准正是要补上这个缺口，因此本文件不把任何单平台的旧结论外推到其他平台（§7）。

---

## 2. 问题一：进程树终止

### 2.1 先纠偏：旧版实际有九条启动路径、三种终止语义

**【源码】** 旧版 `agent/` 里没有统一的进程网关，启动点散在九个模块：

| 调用点 | 启动 | 终止 | 树杀 |
|---|---|---|---|
| 前台 Bash（普通命令） | `exec(command, { cwd, timeout, maxBuffer: 10MB, windowsHide, env })`（`agent/src/tools/bash.js:180-191`） | Node 内置 `timeout`（未设 `killSignal`、未设 `detached`） | **否** |
| 前台 Bash（system 档） | `execFile(bwrap/sandbox-exec, argv, opts)`（同上 `:189-190`） | 同上；bwrap 侧另有 `--die-with-parent` | **否**（靠后端参数兜底） |
| 后台任务 | `exec(..., { detached: process.platform !== 'win32' })`（`agent/src/background.js:35`） | 超时或 `stop()`：Windows `taskkill /pid N /T /F`（`:115`）；POSIX `process.kill(-pid, 'SIGKILL')`（`:117`），失败回退 `child.kill` | **是** |
| MCP stdio server | `spawn(command, args, { env, stdio })`（`agent/src/mcp.js:175,199`，**无** `detached`） | Windows `taskkill /pid N /t /f`（`:284`）+ 回退 `child.kill()`（`:286-288`）；POSIX `SIGTERM` → 宽限 3s → `SIGKILL`（`:292-299`，`KILL_GRACE_MS` 见 `:60`） | Windows **是** / POSIX **否**（无进程组，只杀单个进程） |
| hooks（command 型） | `exec(hook.command, { ..., env: process.env })`（`agent/src/hooks.js:53`） | 自定义 timer → `SIGKILL`（`:46-50`），随后 2.5s 强制 resolve | **否**（注释明说孙进程可能存活） |
| statusline | `exec(command, { ..., maxBuffer: 64KB, env: process.env })`（`agent/src/statusline.js:21`） | timer → `SIGKILL`（`:16-19`），300ms 后 resolve `null` | **否** |
| TUI `!` shell | `execFile(shell, ['/d','/s','/c', cmd], { timeout: 30000 })`（`agent/src/tui/ui.js:1237-1239`） | Node 内置 `timeout` | **否** |
| 进程退出时的清理 | —— | `SIGINT`/`SIGTERM` 对 `runningChildren` 逐个 `c.kill()`（`agent/bin/cowcat.mjs:416-427`，登记见 `:428`） | **否**（单进程 kill） |
| 其余（探测、同步 git、通知、`--background` 自派生） | `execFileSync`/`execFile`/`spawn(detached)`（`agent/src/sandbox/probe.js:43,54`、`agent/src/worktree.js:17`、`agent/src/prompts/system.js:9`、`agent/src/tui/ui.js:241`、`agent/src/notify.js:55`、`agent/bin/cowcat.mjs:191-195`） | 多数没有终止逻辑；`probe` 有 5s/15s 超时，其余同步调用无超时 | **否** |

**一处需要澄清的事实**：子 agent（`Agent` 工具的 `run_in_background`）**不是**操作系统子进程——它在同进程内调 `runLoop`（`agent/src/subagent.js:85`，`ctx.spawnAgent` 见 `:80`）。这意味着「子 agent 的隔离与终止」在旧版里根本不是进程问题，v2 也不该把它塞进 ProcessPort。

**结论**：旧版的终止语义是**三条彼此独立的规则**（前台交给 Node、后台自己树杀、MCP 自己树杀），加上「退出时只单杀」。P2 的价值不在于「旧版没有树杀」，而在于**把它收敛成一条**：启动 → 输出 → 终止全部经 ProcessPort，终止策略由 `PlatformPort` 决定。

### 2.2 有出处的逃逸与孤儿记录

以下每条都在仓库里有出处，且**都不是 taskkill 本身失败**：

| 记录 | 出处 |
|---|---|
| `child.kill()` 只终止直接子进程，shim 启动（`cmd.exe → npx.cmd → node`）会把 server 留成孤儿，所以 Windows 用 `taskkill /T` | `agent/src/mcp.js:278-280`【源码注释】 |
| 后台任务要「kill the whole tree: cmd wrapper + grandchildren」 | `agent/src/background.js:114`【源码注释】 |
| `/tasks kill` 看起来成功、子 agent 其实跑到底：`task.child.pid` 在 `child === null` 时抛 `TypeError`，被 `catch` 吞掉 | `agent/src/background.js:104-108`【源码注释，记录一次真实逃逸史】 |
| `-p` 模式下 `run_in_background` 的 `exec` 子进程让事件循环不退出 → CI 静默 hang，必须每个返回路径都跑清理 | `agent/bin/cowcat.mjs:784-786`【源码注释】 |
| `SIGTERM` 原本**没有** handler，Node 默认杀进程并留下 detached 子进程 | `agent/bin/cowcat.mjs:421-422`【源码注释】 |
| hooks/statusline：孙进程持有管道 → `EPIPE` 成为**未捕获异常**，整个 CLI 挂掉（CI 在 Linux 抓到两次，Windows 本地看不见） | `agent/src/hooks.js:56-60`、`agent/src/statusline.js:27-29`【源码注释】 |
| hooks 超时后「orphaned grandchildren can hold the pipes open — resolve anyway」 | `agent/src/hooks.js:48`【源码注释】 |
| 沙箱内的进程不会活过工具调用，靠 `--die-with-parent` | `agent/src/sandbox/backends/bwrap.js:89`【源码】 |

**关键点**：`--die-with-parent`（bwrap）是**唯一**「结构上保证不留孤儿」的机制，而它只在 `system` 档生效。`light`/`off` 与所有非 Bash 子进程都没有等价物。

### 2.3 决定：协议

**所有子进程只能经过 ProcessPort**（沿用 `03-policy-and-execution.md:47` 的设计），并在网关内做三件事：

1. **启动即建立终止能力**
   - POSIX：`detached: true` 让子进程自成进程组（旧版已在后台与可用的路径上这么做，`background.js:35`）。
   - Windows：**不假装有进程组**。启动时记录 pid，终止时用 `taskkill /pid <pid> /T /F`；taskkill 不可用（非 Windows 系统、精简镜像）时回退 `child.kill()`，**并把这次回退作为结果事实返回**。
   - **实测约束（附录 B）**：Windows 上必须**先 `taskkill /T`**，绝不能先杀直接子进程——`/T` 按父子关系枚举，父一死就 exit 128，那棵树再也够不着。同理，POSIX 上「先杀子再杀组」也会毁掉 `kill(-pid)` 的作用范围，所以终止路径内部不允许「先单杀、后树杀」这种两步写法。
2. **终止只有一条路径**：超时、取消（`AbortSignal`）、父进程退出、显式 stop 全部调用同一个 `terminate()`。
   - POSIX：`SIGTERM` → 宽限期（默认 3s，沿用旧版 MCP 的 `KILL_GRACE_MS`，可配置）→ `SIGKILL`。
   - Windows：`taskkill /T /F`（**没有优雅期**——实测：Windows 上 `SIGTERM` 不可捕获，带 `SIGTERM` handler 的子进程根本没跑到 handler 就退出了，与旧版 MCP 测试里的注释一致）。
   - **一条不能当保证的行为**：本机实测「杀掉一个 `node.exe` 父进程，它的子进程在 250ms 内也一起没了」；同样实验换成 `Git Bash` 或 `PowerShell` 父进程，子进程 **12/12 采样全部存活**。前者是某个与 `node` 相关的实现细节（机制未查证），**不能作为设计依据**——ProcessPort 仍必须显式树杀。
   - **顺序上先遍历再杀父**：这一点已被附录 B 的实测取代为更强的事实——**根本不存在「先遍历」这一步**，`taskkill /T` 在一次调用里完成枚举与终止，所以唯一的规则是「直接子进程还活着时调用它」。
3. **「无法证明已终止」是事实，不是错误码**：`run()` 返回 `{ exitCode, signal, stdout, stderr, truncated, termination }`，`termination` 说明用了哪条路径、是否回退、是否可能存在残留。旧版把回退静默掉（`mcp.js:285-288`），v2 不允许。

**与沙箱执行器的分工**：执行器只负责把请求包装成 `{ file, args, env }`（旧版的 `backends/*.js` 是纯函数，这个形态要保留），**终止是 ProcessPort 的职责**。混在一起会让 `light` 档失去终止能力。

**输出截断**（P2 范围第 1 项要求「输出截断」）：旧版是分散的——后台保留**尾部**并写明丢了多少（`agent/src/background.js:142`），MCP 保留**头部**加 `[truncated]`（`agent/src/mcp.js:659`）。决定统一为：**保留尾部 + 标记 + 丢掉的字符数 + `truncated` 布尔**。理由是旧版后台那条注释已经给出结论：「截断头部丢掉的正是调用方要看的东西」（`background.js:135-137`）。

### 2.4 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 只杀直接子进程（`child.kill()`） | 旧版已有两处真实孤儿记录（`mcp.js:278-280`、`background.js:114`），Windows 上 shim 启动必然留下孙进程 |
| Windows 用 Job Object（`CreateJobObject` + `AssignProcessToJobObject`） | 这是 Windows 上**唯一**结构性的树杀机制，但 Node 没有内置 API，需要 native 依赖，与「运行时依赖 ≤ 6 个」的额度及旧版零依赖的现状冲突（`04-dependencies.md`）。列入 R1，不作为 P2 方案 |
| 引入 `tree-kill` / `windows-kill` 之类第三方包 | Windows 分支本质仍是包一层 `taskkill`，多一个依赖却没换来更强保证；`tree-kill` 在 POSIX 上用 `ps` 枚举子孙，比进程组更慢也更不可靠 |
| 「跨平台统一写法」：`detached: false` + `process.kill(-pid)` | Windows 没有进程组语义，负 pid 无效。这会给出「写法统一、其实一半不生效」的假象——正是旧版那三条独立规则的问题换了个位置 |
| 保持现状：各调用点自己树杀 | 缺口正是散落造成的（§2.1 对比表）。同一个策略写四遍，必然出现「三条有、九条没有」 |
| 让 `SandboxExecutor` 承担终止 | 执行器在 `light` 档不存在，终止能力会随之消失 |
| 用 `--die-with-parent` 覆盖所有路径 | 只有 bwrap 有；`sandbox-exec` 无等价参数（`seatbelt.js` 全文无对应项），`light`/`off` 根本没有包装层 |

### 2.5 本节实测的结论与仍待验证的项

**已由附录 B 实测结清的两条**：Windows 上 `taskkill /T` 在父进程已退出时**够不着那棵树**（exit 128，而 `cmd.exe`/`Git Bash`/`PowerShell` 的子进程确实存活）；POSIX 上自行 `setsid()` 的后代**能逃出 `kill(-pid)`**，且父死后无法按 ppid 找回。

**两条对契约的直接含义**（写进 ProcessPort 的注释与测试）：

- 能保证的：「直接子进程」一定被终止；它创建的、**留在同一进程组 / 父子链内**的后代一定被终止。
- 不能保证的：自行 `setsid()`（或 `setpgid`）的后代——典型形态是守护进程化（`nohup`、`screen`/`tmux` 服务端一类）。**这一类没有实测样本，属推断**；真要覆盖只能 spawn 时逐个记录 pid，成本与收益另算。
- 沙箱路径是例外：`bwrap --die-with-parent` 由内核用 pidfd 兜底，语义强于进程组（`bwrap.js:89`）。

**仍待验证**：

1. ~~Windows：`taskkill /T /F` 在**父进程已退出**时的遍历范围~~ **已实测**（附录 B）：父一死即 exit 128「没有找到进程」，孤儿存活；`cmd.exe → node → node` 三层在父存活时一次 `/T` 全灭；`detached: true` 不隐藏子进程；Windows 上 `SIGTERM` 不可捕获（handler 没跑到）。
2. ~~POSIX：子进程自行 `setsid()` 之后能否逃出 `kill(-pid)`~~ **已实测**（附录 B）：能。`pgrp`/`sid` 变为自身 pid，组杀后存活，ppid 被 reparent，之后按 ppid 遍历找不到它，只有 spawn 时记录的 pid 或它自己的 pgid 能命中。
3. WSL2：**Linux 侧进程组语义**是否与原生 Linux 一致——本次只在 WSL2 的 `docker-desktop` 发行版（内核 `6.18.33.2-microsoft-standard-WSL2`）里测了 `setsid`/`kill`，未在原生 Linux 或 Ubuntu CI 上复测。相邻事实：从 Windows 对 `wsl.exe` 执行 `taskkill /T`，它启动的 Linux 进程**确实被杀掉了**（实测 `LINUX-ALIVE → LINUX-GONE`）——WSL2 的 Linux 进程出现在 Windows 父子链上；但我们检测到 WSL 时走 POSIX 进程组，方向仍然正确。
4. 前台 Bash 超时**是否真能杀掉孙进程**：旧版没有断言覆盖（`lifecycle.test.mjs` 只测后台路径），这是 P2 必须用测试证明而不是推断的第一条。
5. 「杀掉 `node.exe` 父进程会连带杀掉它的子进程」这一现象的**机制未查证**（本次只测出现象：250ms 内全灭；换成 Git Bash / PowerShell 父进程则 12/12 采样存活）。不作为设计依据，但不要在文档里把它写成能力。
6. **服务化进程**（不同会话创建、或以 SYSTEM 运行）是否在 `/T` 的可达范围内——本次样本全部在同一用户会话内。

---

## 3. 问题二：旧版 seatbelt / bwrap 必须保留的结论

### 3.1 bwrap（Linux / WSL2）：9 条【源码】

1. **mount 顺序就是策略**：后出现的操作覆盖先出现的。默认写集里含宿主临时目录、又在私有 `--tmpfs /tmp` 之后绑回去，会**静默撤销**私有 tmpfs（第 17 轮 CI 首跑实测两个 G1/G2 失败都出在这里，`fix-plan-2026-10-15.md:997`）。因此默认写集**不含**宿主 tmpdir（`agent/src/sandbox/policy.js:118-123`）。
2. **workspace 读档从空根开始，只 bind 允许面**（读不到就是不存在）；`hide` 档才 `--ro-bind / /` 再隐藏（`bwrap.js:101-123`）。
3. **拒绝用「隐藏」实现，不是「拒绝」**：目录 `--tmpfs`、文件 `--ro-bind /dev/null`（`bwrap.js:53-57`）。
4. **写拒绝用回绑只读，保留内容**：隐藏一个写拒绝的**文件**会把它变成 `/dev/null`，那不是写规则的意思（`bwrap.js:59-61,77-80`）。
5. **网络控制必须是命名空间**（`--unshare-net`），不能是代理环境变量——Node 的 `fetch` 会绕过代理（调研 §2.5 的实测，`bwrap.js:93-96`）。
6. **隔离参数集**：`--die-with-parent --new-session --unshare-pid --unshare-ipc --unshare-uts`（`bwrap.js:89-92`）。
7. **系统读面是显式列表**（`WORKSPACE_READ_PATHS`，`bwrap.js:26-29`）：加宽是一条可评审的决定，不是一个默认行为。
8. **worktree 同级目录必须在默认写集里**：旧版把 worktree 建在项目同级 `<name>-cowcat-<slug>`，不加这条，`system` 档下 worktree 会话直接不可用（`policy.js:79-96`，读码结论）。
9. **v1 只支持字面路径，glob 进 `unsupported` 并显式暴露**，不静默丢弃——「假装拒绝 `**/.env` 其实什么都没做，比没有策略更糟」（`policy.js:18-22,67-77`）。

### 3.2 seatbelt（macOS）：6 条语义 + 4 条实测缺陷

**语义**（`agent/src/sandbox/backends/seatbelt.js:7-33` 的头部注释，来源是 srt 参考实现）：

1. **last match wins**：凭据 `(deny …)` 必须排在所有读 `(allow …)` **之后**。
2. **specific deny 压过 wildcard allow**：这就是「项目里 `rm` 不能用」的根因（见缺陷 4）。
3. **`(deny default)` 会在 exec 前杀掉 dyld**：runtime floor（sysctl、mach services、`ipc-posix-*`、设备文件 ioctl）不是装饰（`seatbelt.js:101-180`）。
4. **`realpath()` 需要目录 metadata**：`(allow file-read-metadata (vnode-type DIRECTORY))`，且必须排在被拒路径之后（`seatbelt.js:243`）。
5. **`mv` 能绕过路径 deny**：必须对被拒路径**及其祖先**封锁 `file-write-unlink/create`（`seatbelt.js:251-258`）。
6. **SBPL 字符串字面量超过 1025 字节会让整个 profile 失效**，所以路径要合成列表而不是一条规则一个路径（`seatbelt.js:31-32`）。

**四条由真实 macOS 实测抓出的缺陷**（第二十轮，`fix-plan-2026-10-15.md:1122-1145`）：

1. **根 inode 必须显式放行**：`(allow file-read* (literal "/"))`，位置在读 deny 之后。否则 dyld 在 exec 前 SIGABRT，没有任何 stderr（`seatbelt.js:232-241`）。
2. **`/etc`、`/var`、`/tmp` 都是符号链接**：Seatbelt 的 `(subpath …)` 匹配内核报告的路径，友好拼写等于什么都没授权。必须写 `/private/...`，且**有断言锁住 `SEATBELT_READ_PATHS` 不得出现旧拼写**（`seatbelt.js:186-199`）。
3. **`mv` 绕过** → move blocking（同上）。
4. **「安全过头」也是 bug**：specific deny 让项目内 `rm` 全废，必须为写根**显式重放** `unlink/create`（`seatbelt.js:266-269`），末尾还要把落在写根内部的被拒路径再拒一次（`:276-291`）。

**另两条必须保留的行为**：

- **私有临时目录**：macOS 没有 mount namespace，所以由调用方创建私有目录并把 `TMPDIR` 指过去（`agent/src/sandbox/exec.js:53-56,113-116`），且它必须**同时可读**，否则构建工具读不回自己刚写的东西（`seatbelt.js:325-329`）。
- **`network: 'on'` 在 macOS 上不可用、且不可降级**：夹逼实验（`exec.js:73-92` 与 `fix-plan:1147-1162`）证明放行 `network*`、mDNSResponder socket、全部 mach-lookup、全部 unix socket 之后，连**字面量 IP** 仍返回 ENOTFOUND。因此拒绝时带 `degradable: false`——退回 `light` 会丢文件系统隔离却保留网络，比用户要的更宽松（`exec.js:88-103`）。另有一条：`sandbox-exec` 已废弃但仍是 macOS 唯一的 per-process 原语（`seatbelt.js:347`）。

### 3.3 探测与失败语义（`agent/src/sandbox/probe.js`）

必须保留的形态：

- **真跑而不是版本检查**：`bwrap --unshare-all --ro-bind / / true`（`:79-81`）；seatbelt 用宽松 profile 跑 `/usr/bin/true`，只问「能否施加 profile」（`:95-98`）。
- **失败必须分类并可操作**：`missing` / `userns-blocked` / `error`，各带 `reason`、`detail`（底层错误首行）与可复制的 `fix`（`:71-88`）。`userns-blocked` 是 Ubuntu 24.04+ AppArmor 的默认行为，修复命令抄进 `FIX_USERNS`（`:72`）。
- **单平台只探一个后端**，Windows 直接 `unsupported-platform` + 两条替代路径（WSL2 / Docker Sandboxes）（`:110-119`）。
- **`command -v` 而不是 `which`**（`:39-40`）；WSL 用 `WSL_DISTRO_NAME`/`WSL_INTEROP`/`WSLENV` 识别（`:29-37`）；探测结果缓存且**无 TTL**（`:132-136`）。
- **探测要在热路径之外**：旧版把 Bash 角标改成 probe-free，正是因为在帧渲染里同步 spawn 会卡住 TUI（第 17 轮教训 2）。

### 3.4 与 v2 契约的**有意偏离**（要写进 ADR，不是「照搬」）

| 旧版 | v2 | 理由与出处 |
|---|---|---|
| `failOpen` 默认 `true`：后端不可用 → 降级 `light` 并在 UI 标注 | **默认拒绝，不降级** | `03-policy-and-execution.md:83`：旧版的降级让用户以为有隔离而实际没有 |
| `network: 'on'` 在 seatbelt 上可被 `failOpen` 退成 `light` | 这类拒绝**不可被配置覆盖**（旧版的 `degradable:false` 提升为默认语义） | 同上；`exec.js:88-103` |
| env 脱敏只在 `light` 档生效 | 网关内统一，`light`/`system` 都脱敏 | §4.2（旧版实现与文档不一致） |
| Windows 上 shell 实际是 `ComSpec`/`cmd.exe`，会话头只记 `cwd` | Git Bash → PowerShell，并把**实际 shell 记进会话头** | `dev-plan-v2.md:117`、`05-platforms.md:36` |
| 审计写 `~/.cowcat/audit.log`（JSONL，逐行，`agent/src/sandbox.js:160-181`） | 审计成为事件的消费者 | `dev-plan-v2.md:144` |

### 3.5 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 沿用旧版 `failOpen` 默认 `true` | 会把「用户以为有沙箱」这个已经踩过的坑带进 v2 |
| 重新推导 Seatbelt 语义（而不是照搬旧版结论） | 第二十轮的四个缺陷全部是「猜就出货」的产物；旧版结论有真实内核断言背书，重推一次只是重付一次代价 |
| 在 Windows 上「降级到 light 但仍显示沙箱已启用」 | `05-platforms.md:41` 的红线 |
| macOS 把私有 TMPDIR 换成共享可写目录 | 私有临时目录是 G-系列断言之一（存在/可写/不越界/调用后已删除），换共享等于删掉这条断言 |
| 支持 glob 规则（静默忽略不支持的条目） | `policy.js:18-22` 的立场：假装限制比不限制更糟 |

### 3.6 待验证

- **迁移后的 G1/G2/G3 必须在 v2 的测试形态下重跑**，不能只搬断言文本：旧版断言依赖 `BashTool` 与 `~/.cowcat/audit.log` 的形态，v2 里这些属性和事件取代。
- `/private/var/db`、根 inode 两条结论是否随 macOS 版本变化：第二十轮记录过「实验装置本身错两次」，重放工具（`tools/seatbelt-smoke.mjs`）要一起搬过去。
- CI 侧：`packages/cowcat` 的 Linux 腿**目前不装 bubblewrap**（只有 `agent/` 的两条腿装了，`ci.yml:131,200`）。不补这一步，v2 的 G1/G2/G3 会变成 skip——而「skip 的测试等于没有测试」是本项目已经吃过三次的教训。

---

## 4. 问题三：环境变量脱敏

### 4.1 旧版规则集【源码】

`agent/src/sandbox.js:42-91`，三部分：

- **保留列表 `ENV_ALWAYS_KEEP`**（精确名匹配，区分大小写）：`PATH`/`PATHEXT`/`COMSPEC`；`SystemRoot`/`SYSTEMROOT`/`WINDIR`/`windir`/`SYSTEMDRIVE`/`SystemDrive`；`HOME`/`USERPROFILE`/`HOMEDRIVE`/`HOMEPATH`；`TEMP`/`TMP`；`LANG`/`LC_ALL`/`LC_MESSAGES`/`TERM`。每条都带理由（Windows loader、home 目录假设、构建工具临时目录、输出可解码）。
- **敏感形状正则**：`/(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|PRIVATE)/i`（`:67`）。仅作用于**变量名**，值从不检查。
- **显式 deny**：`config.sandbox.envDeny`（或扁平键 `sandboxEnvDeny`），每项是精确名或 `/regex/` 形式；坏正则静默忽略（`:76-81`）。

判定顺序：保留列表 → 精确 deny → deny 正则 → 形状正则（`:83-89`）；返回**新对象**，不改原 env。测试覆盖在 `agent/test/sandbox.test.mjs:31,55` 与 `agent/test/sandbox-system.test.mjs:49`。

### 4.2 覆盖范围：只有一条路径在脱敏（这是最需要修的地方）

| 执行路径 | 是否脱敏 | 出处 |
|---|---|---|
| Bash（`light` 档） | **是** | `agent/src/tools/bash.js:125` → `sandbox.js:206-209` |
| Bash（`off` 档） | 否（原样） | `sandbox.js:208` |
| Bash（**`system` 档**） | **否** —— `sandboxEnv` 在 `mode !== 'light'` 时直接返回原 env | `sandbox.js:208`；与 `sandbox-system-plan §3.1:122`「env 同 light」、`docs/USAGE.md:41` 矛盾，且**无任何测试或注释承认** |
| 后台任务 | **否，且会回灌**：`env: { ...process.env, ...(env || {}) }` 把 Bash 剥离掉的键重新加回 | `agent/src/background.js:35`（Bash 侧确实传了脱敏后的 env：`tools/bash.js:135`） |
| MCP stdio server | 否 | `agent/src/mcp.js:199` |
| hooks（command 型） | 否 | `agent/src/hooks.js:53` |
| statusline | 否 | `agent/src/statusline.js:21` |
| TUI `!` shell | 否（未传 `env`，继承完整 `process.env`） | `agent/src/tui/ui.js:1239` |
| git（worktree / system prompt 探测 / TUI 分支） | 否 | `agent/src/worktree.js:17`、`agent/src/prompts/system.js:9`、`agent/src/tui/ui.js:241` |
| 通知（PowerShell）、`--background` 自派生、沙箱探测自身 | 否 | `agent/src/notify.js:55`、`agent/bin/cowcat.mjs:191-192`、`agent/src/sandbox/probe.js:43,54` |

调研文档自己已经把这条列为遗留风险：「env 里的 token… `sanitizeEnv` 已剥离，但**这是唯一被覆盖的一项**」（`docs/sandbox-system-plan-2026-10-16.md:38-39`、`docs/sandbox-research-2026-10-16.md:241`）。

### 4.3 决定

1. **脱敏在 ProcessPort 内做，且按「执行档位」而不是按调用方**：`light` 与 `system` 都脱敏，`off` 明确不脱敏（沿用旧版语义，但写进契约而不是靠一个 `if`）。调用方传「想要什么环境」，不传「拼好的环境」——`background.js:35` 那种回灌在结构上不再可能发生。
2. **规则集沿用旧版三项**（保留列表、形状正则、显式 deny）：它们有测试、有逐条理由，且**没有证据表明它们失效**。P2 不重写规则，只改**覆盖面**。
3. **「本次剥离了哪些变量名」作为事实进结果与审计**（只记名字，不记值）。旧版只有 UI 文案，没有可核对的事实。
4. **不改变定位**：脱敏是减少误发的**护栏**，不是安全边界（`sandbox.js:5-7` 的威胁模型原话）。这条要写进 v2 文档，避免把「env 干净」读成「凭据安全」。

### 4.4 建议补充的规则（**未实测，需评审逐条拍板**）

1. **注入型变量**：`NODE_OPTIONS`、`BASH_ENV`、`ENV`、`SHELLOPTS`、`PROMPT_COMMAND`、`PS4`、`PERL5OPT`、`RUBYOPT`、`PYTHONSTARTUP`、`GIT_SSH_COMMAND`、`GIT_EXTERNAL_DIFF`、`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`。它们的名字不含凭据形状，但能让子进程加载任意代码或改 git 行为——`.git/config` 注入那条 CVE（`CVE-2026-19593`）属于同一类面。旧版注释其实**知道**这个缺口（「strip 只看名字，所以 `NODE_OPTIONS` 会存活」，`sandbox.js:53-55`），只是没把它当成要处理的项。
2. **`SSH_AUTH_SOCK`**：指向 ssh-agent 的 unix socket。即使 `~/.ssh` 读不到，拿到 agent 就能用私钥；逃逸回归集把 unix socket 单列为一条（`sandbox-system-plan-2026-10-16.md:338`，§8.2-i）。
3. **显式 deny 的语法只保留对象形式**（`sandbox.envDeny`），扁平键 `sandboxEnvDeny` 不迁移（ADR-004 已定不保留旧配置兼容）。
4. **不做值级启发式扫描**（名字不像凭据但值像，例如 `DATABASE_URL=postgres://user:pass@host`）。旧版本来就没做；引入启发式会带来误伤与「已经扫过了」的假安全感。真要覆盖，走显式 deny 清单。

### 4.5 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 保持「各调用方自己脱敏」 | §4.2 的表格就是反例：九条路径里只有一条做了，且唯一做的那条还能被后台任务回灌撤销 |
| 只对 Bash 脱敏 | MCP server、hooks、statusline 同样是子进程，且它们拿的是**完整** `process.env` |
| 按值扫描敏感内容 | 误伤严重，且做不到——「哪些值算秘密」无法判定；会给出错误的安全感 |
| 把脱敏当安全边界 | `sandbox.js:5-7` 与调研 §7.9 都明确否定 |
| 默认剥离 `PATH`/`HOME`/`TEMP`/`SystemRoot` 等 | 会直接把子进程弄死；旧版逐条写了理由（`sandbox.js:45-55`） |
| 在 `system` 档额外清空代理变量（旧版计划里的一条） | 网络已由命名空间控制（bwrap `--unshare-net`），清代理变量只是文案层的补丁，且会与「沙箱外代理」的 Phase 3 路线冲突；暂不做 |

### 4.6 待验证

- 旧版的 MCP/hooks 子进程未脱敏**是否实际泄漏过**：仓库里没有记录，只有泛指（`sandbox-research §7.9`）。不得声称「已经发生」。
- §4.4 的四条补充项需要逐条评审（尤其注入型变量列表的边界，剥离过多会破坏正常开发，这正是 G7 类风险）。
- 脱敏后的 env 是否满足 Windows 上 `cmd.exe`/PowerShell 启动的最低要求（旧版保留列表给了答案，但 v2 的 shell 策略变了：Git Bash → PowerShell）。

---

## 5. 对 P2 六项范围的具体影响

| P2 范围 | 调研带来的具体决定 |
|---|---|
| 1. `ProcessPort` | `run(spec, signal)`，`spec = { argv, cwd, env(未脱敏的输入), stdin?, timeout, outputCap, sandbox }`；脱敏、截断（保留尾部 + `truncated` + 丢弃计数）、终止（§2.3 的单一 `terminate()`）都在端口内完成；返回 `{ exitCode, signal, stdout, stderr, truncated, termination }`。旧版那三条独立终止规则收敛成一条，且终止的**顺序约束**（Windows 一次 `/T`、POSIX 一次组杀，不许先单杀）来自附录 B 的实测边界 |
| 2. `FsPort` | 迁移 `agent/src/canonical.js` 的语义：`realpathSync.native` 解析符号链接、路径不存在时退到「最深的已存在祖先」，**永不抛**，缓存上限 256 满则整表清空（`canonical.js:40-84`）。凡拿路径当**键**的地方（信任、session 身份、白名单、策略条目）一律走同一实现——第 19 轮 7 条 macOS 失败全是这一处的后果 |
| 3. `PlatformPort` | shell 解析（Windows：Git Bash → PowerShell；旧版**没有**任何探测逻辑，`prompts/system.js:20` 那句是硬编码文案）；会话头记录**实际** shell（需要动 ADR-012 的会话头 → 是否升 `schemaVersion` 是本阶段要拍板的一点，见 §6）；进程树终止策略按平台选择；平台能力矩阵（含 WSL 识别） |
| 4. `SandboxExecutor` | 执行器接口按后端抽象，argv 生成**保持纯函数**（这是旧版能在 Windows 上单测 bwrap/seatbelt 映射的原因，`bwrap.js:38-45`）；`light` 全平台；`seatbelt`/`bwrap` 迁移；`system` 在不支持的平台拒绝并给替代路径（ADR-007） |
| 5. 测试迁移 | G1/G2/G3 语义（`agent/test/sandbox-linux.test.mjs:53,68,79,90`）+「项目里 `rm` 可用」+「私有临时目录存在/可写/不越界/调用后已删除」+「拒绝被解释成沙箱」（`[sandbox] system mode` 那类文案）+ Phase 0 的 `off` vs `light` 对照基线。**CI 必须给 `packages/cowcat` 的 Linux 腿装 bubblewrap**（现在只有 `agent/` 腿装，`ci.yml:131,200`）；macOS 走既有的路径过滤触发 |
| 6. lint 规则 | 现有 `no-restricted-imports` **只覆盖 `src/kernel/`、`src/policy/`、`src/ports/`**（`packages/cowcat/eslint.config.js:21-44`）。P2 要新增一条覆盖 `src/modules/`、`src/frontends/` 及后续新目录的 `node:child_process`/`node:fs` 禁令，message 指向 ProcessPort/FsPort。**不要并进现有的 `node:*` group**——报错文案会指错原因，这个教训已有先例（zod 那条单独 pattern，`eslint.config.js:31-39`） |

---

## 6. 需要落的文档与 ADR

| 动作 | 内容 |
|---|---|
| 新增 ADR-014 | ProcessPort 是唯一的子进程网关；进程树终止协议（POSIX 进程组 + Windows `taskkill /T /F` + 回退必须上报）；**「一次 `/T` 解决，不得先单杀再树杀」**（附录 B-A 实测的边界）；超时与取消走同一条终止路径；**明确写出「自建会话的后代不在保证范围内」**（附录 B-B） |
| 新增 ADR-015 | 环境脱敏在网关内统一做：规则集沿用旧版三项，`light`/`system` 都脱敏；修正旧版 `system` 档不脱敏与后台回灌两处不一致 |
| 新增 ADR-016 | 沙箱执行器的失败语义：**默认拒绝、不降级**（推翻旧版 `failOpen` 默认 `true`）；不可降级类拒绝不可被配置覆盖 |
| 新增 ADR-017 | `FsPort` 承担路径身份：`canonicalPath` 语义（realpath + 祖先回退 + 永不抛 + 缓存）迁移，路径比较一律收敛到一处 |
| 待拍板 | 会话头增加「实际 shell」字段：算**向后兼容的字段增补**（沿用 ADR-012 的「适配器做结构校验、内核做版本兼容判定」，`schemaVersion` 不升），还是**升 `schemaVersion`**。建议前者，但要有明写的理由 |
| 更新 03-policy-and-execution.md | 端口表把 ProcessPort / FsPort / PlatformPort 从「P2」改为落地状态；补 `ProcessPort.run` 的结果字段与终止语义 |
| 更新 05-platforms.md | shell 解析、tree-kill、`system` 档拒绝从「决定」变成「实现状态 + 验证结果」 |
| 更新 01-layers.md | `ports/` 下新增文件；lint 规则覆盖范围 |
| 更新 04-dependencies.md | 预计**不新增运行时依赖**（进程与文件走 Node 内置）；若最终选 Job Object 或第三方树杀，必须回到这里并配 ADR |
| 更新 dev-plan-v2.md | P2 状态、交付、出口标准与已知缺口 |
| 本文件 | 随 P2 实现 PR 补「实现后的偏差记录」（§8） |

---

## 7. 待验证清单（汇总）

1. ~~**Windows**：`taskkill /T /F` 在父进程已退出时的遍历范围~~ → **已实测**（附录 B-A）：父一死即 exit 128，够不着那棵树；`cmd.exe`/`Git Bash`/`PowerShell` 的子进程在父死后确实存活。结论已写进 §2.3。
2. ~~**POSIX**：`setsid()` 逃逸~~ → **已实测**（附录 B-B）：能逃，且父死后无法按 ppid 找回。剩余未验证的是「前台超时孤儿」这一条（旧版从未断言覆盖，§2.5-4）。
3. **WSL2**：进程组语义与原生 Linux 是否一致——本次只在 WSL2 的 `docker-desktop` 发行版内核上测得，**未在原生 Linux / Ubuntu CI 上复测**（§2.5-3）。
4. **迁移后的 G1/G2/G3** 在 v2 测试形态下逐条通过；`packages/cowcat` 的 Linux 腿装上 bubblewrap（§3.6）。
5. **macOS** 的 G1/G2/G3 与 `rm`/私有临时目录断言：按需触发 `macos-15`，未触发前标「未验证」（`05-platforms.md:48` 的计费约束不变）。
6. **Windows 上 `system` 档被拒绝**且拒绝信息含替代路径（P2 出口标准的第三条）。
7. **§4.4 的四条脱敏补充项**逐条评审；补剥离后要复跑 G7 类（项目内 `npm test`/`git commit` 仍可用）。
8. ~~**shell 解析**的实际探测方式~~ **已调研**（[p2-shell-detection.md](p2-shell-detection.md)）：Windows 上唯一奏效的来源是「跟着 `git.exe` 找」→ `<git 根>\bin\bash.exe`；PATH 上的裸名 `bash` 是 WSL 启动器或 OpenSSH 的 shim，注册表与 `C:\Program Files\Git` 在本机双双失效；并且已实测两条影子劫持路径，因此契约要求**只 spawn 绝对路径**。POSIX 侧仍未验证。
9. **会话头加字段**是否升 `schemaVersion`（§6 的待拍板项）。

---

## 8. 实现后的偏差记录

> 工作规则 6：区分「已验证」与「推测」。本节记录实现落地时与本文档结论不一致的地方及原因，随每个 P2 任务的 PR 追加。

| 任务 | 偏差 | 原因 |
|---|---|---|
| T1 端口契约 | 脱敏规则集放在 `src/policy/env.ts`（纯函数），而不是 §5 里暗示的「在 ProcessPort 内做」 | 它决定子进程环境**允许**有什么，是策略问题不是运行时问题；放在策略层才能在没有 node 的情况下被测试覆盖，而「应用」的那一步留在适配器 |
| T1 端口契约 | `FsPort` 的方法**同步**（§5 只说「路径规范化在这一层做」，未定同步性） | 这些调用位于纯 argv 生成里；做成异步会把策略解析拖成异步，而策略→argv 必须保持纯函数——这正是旧版能在 Windows 上单测后端映射的原因 |
| T1 端口契约 | 新增 `TerminationMethod` 与平台侧 `TerminationStrategy` 分成两个类型 | 「平台能做什么」与「某次运行实际做了什么」不是一回事：后者可能因为树杀不可用而退化成 `single-process`，也可能因为子进程自己先退出而是 `none`。合成一个类型会逼调用方去解析不存在的取值 |
| T1 端口契约 | `redactEnv` 返回 `ignoredDeny`（坏正则被上报），而不是像旧版那样静默忽略 | 与本项目对 glob 的既有立场一致（§3.1 第 9 条）：假装生效/假装忽略都比暴露问题更糟 |
| T1 端口契约 | 会话头的「实际 shell」字段**不升 `schemaVersion`**（§6 标为待拍板） | v2 的日志格式**从未发布过**（包是 `private 0.0.0`），没有需要兼容的既有日志，因此该字段从一开始就是版本 1 的组成部分；升版本只会制造一个从未存在过的兼容问题 |
| T1 lint 门禁 | lint 的第二条 block 用 `ignores` **排除** kernel/policy/ports，而不是简单地 `files: ['src/**/*.ts']` | 两个 block 配置**同一个规则时后者整体覆盖前者、不做合并**。第一版就是这么写的，结果把 zod 那条门禁（ADR-009）静默丢掉了，kernel 的报错文案也变了。是 `tools/lint-probe.mjs` 抓到的——这也是把探针入库的理由 |
| T1 lint 门禁 | `tools/lint-probe.mjs` 入库 | P1 的教训是「没人亲眼见过它失败的 lint 规则等于没有」。探针同时抓到了它自己的两处仪器错误（stylish 输出里没有 `message:` 前缀；Windows 上不经 shell 无法 spawn `.cmd`，Node 因 CVE-2024-27980 拒绝） |

---

## 附录 A：本次研究用到的旧版证据索引

按「结论 → 出处」组织，方便实现时逐条复核（`文件:行号` 均以 `main = b8a8c6c` 为准）。

| 结论 | 出处 |
|---|---|
| 沙箱后端只产出 argv，从不 spawn | `agent/src/sandbox/exec.js:105`、`bwrap.js:87-135`、`seatbelt.js:298-333` |
| 后台任务：detached + 树杀 | `agent/src/background.js:35,113-118` |
| 后台任务输出保留尾部 | `agent/src/background.js:135-142` |
| 前台 Bash：无 detached、无 killSignal、timeout 交给 Node | `agent/src/tools/bash.js:139-197` |
| 前台 Bash 的超时/上限常量 | `agent/src/tools/bash.js:16-26` |
| MCP：Windows taskkill /T + POSIX SIGTERM→SIGKILL | `agent/src/mcp.js:275-301`（`KILL_GRACE_MS` 见 `:60`） |
| MCP 工具结果保留头部截断 | `agent/src/mcp.js:659` |
| hooks / statusline：`env: process.env`，超时 SIGKILL | `agent/src/hooks.js:46-53`、`agent/src/statusline.js:16-21` |
| 退出时只单杀子进程（`runningChildren`） | `agent/bin/cowcat.mjs:414-428` |
| 子 agent 不是子进程（同进程 runLoop） | `agent/src/subagent.js:80,85` |
| env 脱敏规则与保留列表 | `agent/src/sandbox.js:42-91` |
| 脱敏只在 light 档生效 | `agent/src/sandbox.js:206-213`；调用点 `agent/src/tools/bash.js:125` |
| 后台任务 env 回灌 | `agent/src/background.js:35` |
| `envDeny` 的两种配置形态 | `agent/src/sandbox/policy.js:107-109` |
| 策略默认读写集与 worktree 同级目录 | `agent/src/sandbox/policy.js:39-56,79-127` |
| 探测：真跑、分类、fix 文案、缓存、WSL 识别 | `agent/src/sandbox/probe.js:29-136` |
| 路径身份（canonical）语义 | `agent/src/canonical.js:40-84` |
| 会话头只有 cwd，无 shell | `agent/src/session.js:32` |
| Windows 上 shell 实际是 ComSpec | `agent/src/tui/ui.js:1237-1239`、`agent/src/mcp.js:203` |
| 系统提示里的 shell 是硬编码文案 | `agent/src/prompts/system.js:20` |
| G1/G2/G3 的旧断言形态 | `agent/test/sandbox-linux.test.mjs:46-94` |
| 第 16–20 轮的实测记录（沙箱 Phase 0/1/2、路径身份、Seatbelt） | `docs/fix-plan-2026-10-15.md:913-1197` |
| G1–G8 的定义与验证计划 | `docs/sandbox-system-plan-2026-10-16.md:95-106,311-339` |
| CI：bubblewrap 只装在 `agent/` 的两条 Linux 腿 | `.github/workflows/ci.yml:126-139,200-207` |
| 现有 lint 的覆盖范围 | `packages/cowcat/eslint.config.js:18-44` |

---

## 附录 B：本次新增的实测（Windows 边界 / POSIX 逃逸）

**环境**：Windows 11 本机 + Node `v24.18.0`；POSIX 侧跑在本机唯一的 WSL2 发行版 `docker-desktop`（内核 `6.18.33.2-microsoft-standard-WSL2`，root，**发行版内没有 node/python**，只有 `setsid`/`ps`/`pgrep`/`sh`），所以测的是 `setsid`+`kill` 的**内核语义**，不是 Node 的 `detached` 实现。

**脚本**（`%TEMP%\opencode\`，未入库）：`taskkill-tree2/3/5/6/7/8/9/10.mjs`、`setsid-escape2.sh`、`wsl-probe.sh`。复现方式：Windows 侧 `node <脚本>`；WSL 侧 `cmd /c "type <脚本> | wsl.exe -e sh -s"`（该发行版没有挂 `/mnt/c`）。

**过程中我的实验装置错了五次**（比结论更值得记，因为它就是 P2 要防的那类 bug）：

1. `ROOT_EXIT_MS: String(0)`——`"0"` 是非空字符串，truthy，导致 root 立刻退出；第一版整组用例静默失效。
2. chain 的子进程代码只改了 env 没改 `argv`，`mid` 因此不再 spawn `leaf`，用例在等一个永远不会出现的 pid 文件。
3. `tasklist`/`taskkill` 的输出是 OEM 代码页 936，按 UTF-8 解全是乱码（本仓库 `HANDOFF.md` §5 记过同源问题）；必须 `new TextDecoder('gbk')`。
4. PowerShell 的 `ConvertTo-Csv` 被命令行里的逗号与换行打爆；改 `ConvertTo-Json`。
5. 这台 WSL 的 `ps -p` 对本会话之外的进程一律报「不存在」（**连活着的进程也报**），第一版 POSIX 实验因此把活着的 leader 标成 GONE；进程身份必须读 `/proc/<pid>/stat` 的 ppid/pgrp/sid。

### B-A：Windows 上 `taskkill /T /F` 的边界

| 场景 | 实测结果 |
|---|---|
| 直接子进程活着时 `/T /F`，`node → node → node` | 三层全灭，exit 0 |
| 同上，三层为 `cmd.exe → node → node`（shim 形态） | 三层全灭，exit 0；taskkill 逐条列出被终止的 pid 及其父 |
| 先 `child.kill()` 杀根，再 `/T <该 pid>` | **exit 128，`错误: 没有找到进程 "<pid>"`** |
| 父进程自然退出后再 `/T <该 pid>` | **exit 128，同上** |
| 单独 `/F` 杀父（父为 `cmd.exe`），子为 `node → node` | 子与孙**都存活**（cmd 不连带杀） |
| 单独 `/F` 杀父（父为 `node.exe`） | 子进程 250ms 内一起死——**机制未查证，不作为设计依据** |
| 单独 `/F` 杀父（父为 Git Bash / PowerShell） | 子进程 **12/12 采样全部存活**（3 秒，每 250ms 一次） |
| 父死后留下真孤儿（`cmd start` 自带控制台后 cmd 退出） | 孤儿存活；`/T <已死的 cmd pid>` exit 128 |
| 从幸存的孤儿 `taskkill /T <孤儿的 pid>` | **能**——一次带走孤儿与孤儿的孩子（exit 0） |
| `detached: true` 的子进程是否被 `/T` 隐藏 | 不隐藏，仍被终止 |
| 目标 pid 不存在 | exit 128 + `错误: 没有找到进程 "<pid>"`——这是「回退必须上报」的用户可见文案依据 |
| Windows 上 `SIGTERM` 是否可捕获 | **不可捕获**：装了 handler 的子进程没执行 handler 就退出了 |
| 从 Windows 对 `wsl.exe` 执行 `/T` | 它启动的 Linux 进程确实被杀（`LINUX-ALIVE → LINUX-GONE`），两次独立运行一致 |

**由此得到的可执行规则**：`/T` 只对**活着的**目标有效，且可以从剩余链条上的**任意一端**起走；目标一旦死亡，那条路径永久消失。所以终止路径必须是「一次 `/T` 解决」，不能是「先单杀、再树杀」。

### B-B：POSIX 上 `setsid()` 的逃逸

结构：`leader`（`setsid` 起的进程组组长）→ `mid`（普通子进程）→ `leaf`（`setsid sleep 300`，自建会话）。

| 测试 | 实测结果 |
|---|---|
| T1 基线（leaf 留在同组） | 三层的 pgrp/sid 全等于 leader pid；`kill -KILL -<pgid>` → **三层全死**，`/proc` 条目消失 |
| T2 逃逸 | leaf 的 pgrp=sid=**自身 pid**（2213302），与 leader 的组（2213299）不同；`kill -KILL -<leader pgid>` → leader 死、mid 死、**leaf 存活**；leaf 的 ppid 被 reparent，pgrp/sid 不变 |
| T3 父死后还能不能找到它 | 遍历 `/proc` 找 ppid 等于已死的 mid / leader 的进程 → **一个都没有** |
| T4 它自己的组能不能杀 | `kill -KILL -<leaf 自己的 pgid>` → 死（它确实是独立会话的组长） |

**由此得到的边界**：进程组覆盖「留在同一进程组的后代」，**不覆盖**自建会话的后代；后者唯一的句柄是 spawn 时记录的 pid。守护进程化（`nohup`、`screen`/`tmux` 服务端一类）属于这一类——**本条属推断，没有实测样本**。沙箱路径不受影响：`bwrap --die-with-parent` 由内核 pidfd 兜底。
