# CowCat

> 跑在你自己终端里的开源 CLI 编程 Agent。代码、密钥、终端都在你手里。

CowCat is an interactive CLI coding agent that talks to any Anthropic-compatible or
OpenAI-compatible model endpoint — including Kimi for Coding — and keeps your code, your
keys and your terminal under your own control. Zero runtime dependencies, Node.js >= 20.

完整功能清单见 [`agent/README.md`](agent/README.md)。

## 状态

| 形态 | 位置 | 状态 |
|---|---|---|
| **v1 CLI**（当前唯一可发布版本） | [`agent/`](agent/) | 已发布 `0.15.0`（npm `@corescense/cowcat`），MIT，零运行时依赖 |
| **v2 内核**（事件溯源会话运行时） | [`packages/cowcat/`](packages/cowcat/) | P0–P5 完成（内核、端口、执行网关、模型适配器、七个核心工具）；P6 的组合根与宿主已落地（ADR-063/064） |
| **v2 前端与可执行文件** | [`packages/protocol/`](packages/protocol/) · [`packages/tui/`](packages/tui/) · [`packages/cli/`](packages/cli/) | headless 协议 + `cowcat` 可执行文件（六个动词里五个可用，`setup` 未接线）；**TUI 已到卡片层**（对话流 / 工具卡 / 审批卡 / 待办 / 命令面板 + 帧快照），图片渲染见 T9 |

v1 与 v2 长期并存，v2 达到功能对等后才切换（计划中的 P8），在那之前 `agent/` 只接受安全修复。

## 快速开始

```bash
npm i -g @corescense/cowcat

cowcat setup     # 交互向导：provider / base URL / API key（不回显）/ 模型
cowcat doctor    # 逐项检查配置与 API 连通性
cowcat           # 进入 REPL
```

也可以全部走环境变量：

```bash
export COWCAT_PROVIDER=anthropic
export COWCAT_BASE_URL=https://api.kimi.com/coding
export COWCAT_API_KEY=sk-...
export COWCAT_MODEL=kimi-for-coding

cowcat "读一下 src/index.js，说清楚它做了什么"     # 一次性，写操作前会询问
cowcat -p "..."                                    # 非交互 print 模式：写操作自动拒绝（退出码 != 0）
cowcat -p --output-format stream-json "..."         # CI 用：纯 NDJSON 事件流
```

任何 Anthropic 兼容（`/v1/messages`）或 OpenAI 兼容（`/chat/completions`）端点都能接。

**CowCat 不附带任何 API key，也不内置任何模型端点。** 你自己带 key、自己带端点、自己带模型。

## 仓库结构

```
agent/            v1 CLI（可发布版本，零运行时依赖，Node >= 20）
packages/cowcat/     v2 内核 + 组合根（TypeScript strict，Node >= 22）
packages/protocol/   v2 headless 协议（JSON-RPC over stdio，无渲染器、无内核，Node >= 22）
packages/tui/        v2 渲染器（opentui，Node >= 26.4；协议客户端与组件见 T7）
packages/cli/        v2 可执行文件（bin + 子命令表 + doctor，Node >= 22）
docs/
  architecture/   v2 架构契约与 ADR 表（01 分层 / 02 内核 / 03 策略与执行 / 04 依赖 / 05 平台）
  research/       阶段调研记录（P1 内核、P2 端口）
  dev-plan-v2.md  v2 开发计划（阶段、调研问题、出口标准）
  sandbox-system-plan-2026-10-16.md  沙箱威胁模型与验收判据（G1–G8）
  USAGE.md        用法；CONTRIBUTING.md 见仓库根目录；PUBLISH.md 发布流程
tools/            打包白名单守卫、Seatbelt 冒烟工具、logging proxy（e2e 用）
bin/              全局启动 shim
```

## 沙箱

Bash 工具有三档隔离，策略与实测结论见 [`docs/sandbox-system-plan-2026-10-16.md`](docs/sandbox-system-plan-2026-10-16.md)：

| 档 | 平台 | 说明 |
|---|---|---|
| `light`（默认） | 全平台 | 环境变量脱敏 + 静态命令分级 + 审计。**护栏，不是安全边界** |
| `system` | Linux / WSL2（`bubblewrap`）、macOS（`sandbox-exec`） | OS 级隔离：读限项目与系统目录、写限项目、网络默认关、每次调用独立私有临时目录 |
| `system` | Windows 原生 | **不支持**，显式拒绝并引导 WSL2 / Docker Sandboxes |

## 参与开发

见 [CONTRIBUTING.md](CONTRIBUTING.md)：分支与 PR 流程、提交信息约定、CI 门禁、发布批次、本地 git 钩子。
安全问题请按 [SECURITY.md](SECURITY.md) 报告，**不要**开公开 issue。

## 许可

MIT — © 2026 心感科技（深圳）有限公司 (CoreScense)，见 [LICENSE](LICENSE)。