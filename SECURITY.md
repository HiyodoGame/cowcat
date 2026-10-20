# 安全策略

## 报告漏洞

**请不要用公开 issue 报告安全问题。** 公开 issue 会让漏洞细节与利用方式立刻可见。

用 GitHub 的私密通道（Security Advisory）提交：

> https://github.com/HiyodoGame/cowcat/security/advisories/new

如果该入口不可用，请开一个**不含利用细节**的 issue，只说明「有一个安全问题想私下沟通」并留下联系方式。

请尽量包含：受影响的版本（`packages/cli/package.json` 的版本号）、平台（OS / Node 版本）、复现步骤、影响面（读越权 / 写越权 / 命令执行 / 凭据泄漏 / 拒绝服务）。

## 我们会怎么回应

| 阶段 | 动作 |
|---|---|
| 确认收到 | 3 个工作日内 |
| 初步判断与分级 | 7 个工作日内 |
| 修复 | 分级确定后给出版本与时间；已在公开渠道披露的漏洞按披露时间压缩 |
| 公开 | 修复发布后在 `docs/changelog.md` 记录；若你愿意，可公开致谢 |

当前没有正式的漏洞赏金计划。

## 请一并理解的前提：沙箱是护栏，不是安全边界

`light` 档（默认）只做三件事：**环境变量脱敏、静态命令分级、审计日志**。它不提供 OS 级隔离——命令以当前用户权限运行，可以写该用户能写的任何位置。详见 [`docs/archive/sandbox-system-plan-2026-10-16.md`](docs/archive/sandbox-system-plan-2026-10-16.md) 的威胁模型。

`system` 档在 Linux 用 `bubblewrap`、macOS 用 `sandbox-exec`，是真正的 OS 级边界；**Windows 原生不支持**，该档在 Windows 上会被显式拒绝而不是降级。

另外三条本来就常驻边界之外，不要依赖它们兜底：

- **MCP server 与 Bash 一样经 `ProcessPort` 启动，但在 `light` 档仍以当前用户权限运行**（`light` 不是 OS 级边界）；
- **凭据文件在 `light` 档完全可读**，沙箱不是密钥保险箱；
- **「读一次就进了模型上下文」**：任何能读到的私有文档都应按会被发到模型服务商对待。

用 CowCat 处理私有代码前，请先读上面这份威胁模型。