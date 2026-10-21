# CowCat

> 跑在你自己终端里的开源 CLI 编程 Agent。代码、密钥、终端都在你手里。

CowCat 是一个事件溯源的 CLI 编程 agent：会话日志只追加、回合状态可重放、策略与审批在内核里，前端（TUI / headless）只读协议。它支持 Anthropic 与 OpenAI 兼容的模型端点，也支持通过 stdio 接入 MCP 服务器。

**状态：`1.0.0-beta.1`（P8 发布切换）。** v1（`agent/`）已在 P8 删除；v1 的用户配置以兼容模式读取（ADR-089），不会重写文件。

## 要求

- Node.js **>= 22**（`cowcat tui` / `sessions resume` 需要 **>= 26.4**，因为 opentui）
- 一个 Anthropic 或 OpenAI 兼容的模型端点与 API key（CowCat 不附带 key）

## 快速开始（从源码）

```bash
# 四个包按依赖顺序构建（file: 依赖是链接，不会自动构建）
(cd packages/protocol && npm ci && npm run build)
(cd packages/cowcat && npm ci && npm run build)
(cd packages/tui && npm ci && npm run build)
(cd packages/cli && npm ci && npm run build)

node packages/cli/dist/src/cli/main.js doctor
```

配置用户层 `~/.cowcat/config.json`：

```json
{
  "model": { "preset": "anthropic/claude-sonnet-5-5" },
  "providers": { "anthropic": { "apiKeyEnv": "ANTHROPIC_API_KEY" } }
}
```

然后：

```bash
export ANTHROPIC_API_KEY=...
node packages/cli/dist/src/cli/main.js run "解释一下这个仓库的入口"
node packages/cli/dist/src/cli/main.js          # TUI（需要 Node >= 26.4）
```

发布到 npm 后（人工 2FA）可直接 `npm i -g @corescense/cowcat`。

## 命令

| 动词 | 作用 |
|---|---|
| `cowcat` / `cowcat tui` | 交互式 TUI（Node ≥ 26.4） |
| `cowcat run "<prompt>"` | 一次性回合；默认拒绝所有审批，`--yes` 放行 |
| `cowcat serve` | headless JSON-RPC over stdio |
| `cowcat sessions list\|resume <id>` | 会话列表 / 恢复 |
| `cowcat doctor` | 环境、配置、信任、指令链、沙箱、模型与 key 逐项检查 |
| `cowcat setup` | **尚未接线** |

## 配置

- 用户层：`~/.cowcat/config.json`
- 项目层：`<cwd>/cowcat.json`（`rules`、`mcp.servers` 受工作区信任约束）
- 会话层：`--config <path>`
- 密钥只从环境变量读取（`apiKeyEnv`）；v1 的内联 `apiKey` 仅在兼容模式下于内存中使用，不写回、不记录

MCP 服务器（stdio）：

```json
{
  "mcp": {
    "servers": {
      "everything": { "command": "node", "args": ["/path/to/server-everything/dist/index.js", "stdio"] }
    }
  }
}
```

## 包结构

| 包 | 内容 |
|---|---|
| `@corescense/cowcat` | 可执行文件（`packages/cli`） |
| `@corescense/cowcat-core` | 内核、策略、端口、工具与组合根（`packages/cowcat`） |
| `@corescense/cowcat-protocol` | headless JSON-RPC 协议（`packages/protocol`） |
| `@corescense/cowcat-tui` | 终端渲染器，动态加载（`packages/tui`） |

本地开发继续使用 `file:` 依赖（ADR-062）；发布由 `tools/pack-release.mjs` 改写为精确版本（ADR-090）。

## 文档

- [`docs/dev-plan-v2.md`](docs/dev-plan-v2.md)：阶段计划与出口标准
- [`docs/architecture/`](docs/architecture/)：ADR 表（001~090）与分层、内核、策略、平台契约
- [`docs/HANDOFF.md`](docs/HANDOFF.md)：最近一次交接快照
- [`docs/research/`](docs/research/)：各阶段调研（含 MCP 2026-07-28 对照与真实端点实测）
- [`docs/archive/`](docs/archive/)：v1 与旧架构的历史档案，不是现行规范

## 安全

- 所有子进程只经 `ProcessPort` 启动；env 脱敏、输出截断与进程树终止都在网关里（ADR-014/015）。
- `light` 档**不是** OS 级沙箱，只做脱敏与审计。
- 密钥不写日志、不进配置模板；`doctor` 只报告「是否设置」。

## 许可

MIT。见 [`LICENSE`](LICENSE)。
