# 05 平台策略

> 调研说明：Windows 部分的结论主要来自 2026 年的公开材料（产品官方文档、Codex 团队的设计文章、GitHub issue 与社区报告）。其中部分是二手资料，**动手实现前需回到官方文档与源码逐条核实**，本文档不把它们当作已验证事实。

## Windows

### 其他产品怎么做

**Claude Code**

- 原生 Windows 安装可用（PowerShell、CMD、WinGet 三种入口，装的是同一个二进制）。
- Bash 工具依赖 Git for Windows；没有 Git Bash 时回退到 PowerShell 执行 shell 命令。
- **沙箱只在 macOS、Linux、WSL2 上运行**。官方文档明确写道：原生 Windows 上命令不经沙箱执行，配置了 `failIfUnavailable` 时 Claude Code 会在启动时退出。
- 原生 Windows 沙箱是一个开放的功能请求（anthropics/claude-code #46740），没有排期。
- 官方给出的建议是：要在 Windows 上用沙箱，就在 WSL2 里运行 Claude Code。

**OpenAI Codex**

- 原生 Windows 沙箱分两种模式：
  - **非提权模式**：用 restricted token（`write_restricted`）运行子进程，不需要管理员权限。
  - **提权模式（elevated）**：安装沙箱时需要管理员权限，创建两个专用本地账户（`CodexSandboxOffline`、`CodexSandboxOnline`），子进程以这些账户的受限令牌运行，并通过防火墙规则控制网络。
- 在 PowerShell 中使用原生沙箱；在 WSL2 中使用 Linux 沙箱（bubblewrap）。
- 社区在 2026 年 6 月之后持续报告 setup helper 启动失败、ACL 文件占用等问题，说明这条路线的可靠性代价真实存在。

**共同结论**：两家都没有在原生 Windows 上提供与 macOS / Linux 同等强度、同样低摩擦的沙箱。Codex 做了真正的原生方案，但代价是管理员安装与专用账户；Claude Code 选择不做，把 WSL2 作为推荐路径。

### 对 CowCat 的含义

CowCat 是 npm 分发的产品。用户通过 `npm i -g` 安装，**不能要求用户以管理员身份安装，也不能在安装时创建系统账户**。这排除了 Codex 的提权模式作为默认方案。

因此 Windows 的分阶段决定如下：

| 阶段 | 决定 | 理由 |
|---|---|---|
| P2–P3 | Windows 原生的 `system` 沙箱档**不可用**，请求时显式拒绝，并给出两条替代路径：WSL2，或保持 `light` 档 | 不假装沙箱存在。与 ADR-007 一致 |
| P2 | Windows 上 shell 解析顺序：Git Bash → PowerShell；记录实际使用的 shell 到会话头 | 与 Claude Code 的做法对齐，且 Git Bash 的命令语义更接近 POSIX 工具链 |
| P2 | 进程树终止使用 `taskkill /T /F` | Windows 上父进程被杀后子进程常成为孤儿，这是必须解决的问题 |
| R1（P8 之后） | 调研非提权 restricted token 方案：能否满足「文件写只限项目」，网络不由它管 | 非提权是 npm 分发的前提，值得单独评估其强度上限 |
| R1 | 若 R1 的结论是强度不足，评估提权账户方案，但只作为**可选**增强，不作为默认 | 保持默认安装无需管理员 |

**绝对的红线**：在 Windows 原生上，`light` 档的文案不得暗示有 OS 隔离；`system` 档在不可用时不得降级到 `light` 后仍显示「沙箱已启用」。

## macOS

- 方案：Seatbelt（`sandbox-exec`），v2 P2 从旧版迁移，已在旧版 macOS CI 上真实验证。
- 已知限制（已实测，见旧版 fix-plan 第二十轮）：`network: 'on'` 不可用且不可降级；网络出口与按域名控制需要沙箱外代理，属于后续阶段。
- 临时目录：macOS 没有挂载命名空间，每次调用创建私有临时目录并把 `TMPDIR` 指过去，调用结束后删除。
- CI 验证：`macos-15`（pin 住，不用 `macos-latest`）。macOS 计费为 10 倍，按路径触发，不在 main 自动跑。

## Linux

- 方案：bubblewrap（`bwrap`）。WSL2 同样走这条路径。
- 注意：`bwrap` 在部分容器与受限内核中不可用，需要探测而不是假设；探测结果进入会话头与 `doctor` 输出。

## 鸿蒙（HarmonyOS）

- 目标：后续原生支持鸿蒙系统。
- **现状未核实**：本轮没有做鸿蒙侧的运行时调研。需要回答的问题包括：鸿蒙上 Node.js 的可用形态与版本；是否存在可承载命令行 agent 的运行环境；可用的进程与文件隔离原语是什么。这些必须有专项调研文档，本轮不下结论。
- **当前架构为鸿蒙预留的唯一约束**：内核、策略、端口层不依赖 `node:*`（ADR-003，由 lint 强制）。所有宿主相关能力收敛在端口与适配器里。这样即使宿主运行时变化，内核与策略不需要重写，只需提供新的适配器。
- 平台差异（shell、路径分隔符与身份、进程树、沙箱执行器）由 `PlatformPort` 统一提供，工具层不直接判断操作系统。

## 平台能力矩阵（目标态）

| 能力 | macOS | Linux | WSL2 | Windows 原生 | 鸿蒙 |
|---|---|---|---|---|---|
| OS 级沙箱（system 档） | Seatbelt | bwrap | bwrap | 不可用（拒绝） | 未调研 |
| 网络出口控制 | 需沙箱外代理（P后期） | 需沙箱外代理（P后期） | 同左 | — | 未调研 |
| shell | zsh / bash | bash | bash | Git Bash → PowerShell | 未调研 |
| 进程树终止 | 进程组 | 进程组 | 进程组 | `taskkill /T /F` | 未调研 |
| CI 验证 | `macos-15`（按需） | `ubuntu-24.04`（PR 必过） | 未覆盖 | `windows-latest`（main） | — |
