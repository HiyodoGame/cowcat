# CowCat

> 跑在你自己终端里的开源 CLI 编程 Agent。代码、密钥、终端都在你手里。

CowCat 是一个事件溯源的 CLI 编程 agent：会话日志只追加、回合状态可重放、策略与审批在内核里，前端（TUI / headless）只读协议。它支持 Anthropic 与 OpenAI 兼容的模型端点，也支持通过 stdio 接入 MCP 服务器。

**状态：`1.0.0-beta.4`（P8 发布切换）。** v1（`agent/`）已在 P8 删除；v1 的用户配置以兼容模式读取（ADR-089），不会重写文件。`latest` 仍是 v1 的 `0.15.0`，beta 用 `@beta`。

## 要求

- 默认 `cowcat` / `cowcat tui` / `sessions resume`：Node.js **>= 26.4**（opentui 门槛）
- `serve` / `run` / `sessions list` / headless 诊断：Node.js **>= 22**
- 一个 Anthropic 或 OpenAI 兼容的模型端点与 API key（CowCat 不附带 key）

## 快速开始（npm）

先确认 `node --version` 满足默认 TUI 的 **>= 26.4** 要求。beta 版本发布在 `@beta` 标签上（`latest` 仍是 v1 的 `0.15.0`）：

```bash
npm i -g @corescense/cowcat@beta

cowcat doctor
cowcat setup --migrate      # 从 v1 升级：备份并迁移 ~/.cowcat/config.json，不复制密钥
cowcat trust                # 信任当前目录：项目层 cowcat.json 的 allow 与 AGENTS.md 才会生效
cowcat run "解释一下这个仓库的入口"
cowcat                      # TUI
```

`cowcat trust` 记录的是**目录本身**（精确匹配、不继承子目录，ADR-028）；`--list` 查看、`--remove` 撤销。未信任时 `AGENTS.md` 不会注入，`run` 会打印一行说明（ADR-092/093）。

配置用户层 `~/.cowcat/config.json`：

```json
{
  "model": {
    "preset": "anthropic/claude-sonnet-5-5",
    "providers": { "anthropic": { "apiKeyEnv": "ANTHROPIC_API_KEY" } }
  }
}
```

然后设置 key：

```bash
export ANTHROPIC_API_KEY=...
```

## 从源码

```bash
# 四个包按依赖顺序构建（file: 依赖是链接，不会自动构建）
(cd packages/protocol && npm ci && npm run build)
(cd packages/cowcat && npm ci && npm run build)
(cd packages/tui && npm ci && npm run build)
(cd packages/cli && npm ci && npm run build)

node packages/cli/dist/src/cli/main.js doctor
```

发布到 npm 后（人工 2FA）可直接 `npm i -g @corescense/cowcat`。

## 命令

| 动词 | 作用 |
|---|---|
| `cowcat` / `cowcat tui` | 交互式 TUI（Node ≥ 26.4） |
| `cowcat run "<prompt>"` | 一次性回合；默认拒绝所有审批，`--yes` 放行 |
| `cowcat serve` | headless JSON-RPC over stdio |
| `cowcat sessions list\|resume <id>` | 会话列表 / 恢复 |
| `cowcat doctor` | 环境、配置、信任、指令链、技能、沙箱、模型与 key 逐项检查 |
| `cowcat trust [dir] [--list] [--remove]` | 信任一个目录（项目层 `allow` 与 `AGENTS.md` 才会生效），或列出/撤销 |
| `cowcat setup --migrate` | 把现有 v1 配置翻译成 v2（备份原文件，不写密钥） |
| `cowcat setup --preset <provider/model>` | 新建 v2 配置（`--api-key-env` / `--base-url` / `--force` / `--print`） |

用 `cowcat <command> --help` 或 `cowcat help <command>` 查看单个命令的参数与选项；帮助只读命令表，不启动 TUI、不读取模型配置。

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

Skills（`SKILL.md`，兼容 Claude Code 的目录与 frontmatter）：

- 位置：`~/.cowcat/skills/<name>/`、`<项目>/.cowcat/skills/<name>/`，同时只读兼容 `~/.claude/skills/` 与 `<项目>/.claude/skills/`
- 首轮只注入 `name` + `description`（catalog），正文在模型调用 `Skill` 工具时才读取；`/skills` 查看本次会话的目录
- 项目层的技能受工作区信任约束（未受信不加载并提示）；同名时项目覆盖个人、`.cowcat` 覆盖 `.claude`
- frontmatter 的 `allowed-tools` **当前不生效**（技能不能给自己扩权），`doctor` 会列出被忽略的字段

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
- [`docs/beta-checklist.md`](docs/beta-checklist.md)：`1.0.0-beta.2` 反馈期验收清单与切换 `latest` 的门槛
- [`docs/research/`](docs/research/)：各阶段调研（含 MCP 2026-07-28 对照与真实端点实测）
- [`docs/archive/`](docs/archive/)：v1 与旧架构的历史档案，不是现行规范

## 安全

- 所有子进程只经 `ProcessPort` 启动；env 脱敏、输出截断与进程树终止都在网关里（ADR-014/015）。
- `light` 档**不是** OS 级沙箱，只做脱敏与审计。
- 密钥不写日志、不进配置模板；`doctor` 只报告「是否设置」。

## 许可

MIT。见 [`LICENSE`](LICENSE)。
