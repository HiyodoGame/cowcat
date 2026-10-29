# CowCat

> 跑在你自己终端里的开源 CLI 编程 Agent。代码、密钥、终端都在你手里。

CowCat 是一个事件溯源的终端编程 Agent：会话日志只追加、回合状态可重放，策略与审批在内核，TUI 与 headless 前端只通过协议读取会话。支持 Anthropic 和 OpenAI 兼容端点，以及 stdio MCP 服务器。

**当前渠道：v2 `1.0.0-beta` 系列。** npm `latest` 仍是 v1 `0.15.0`，新版请使用 `@beta` 安装。v1 配置可以兼容读取，不会被静默重写。

## 特性

- **原生终端工作台**：对话、待办、子代理、后台任务、上下文与文件变更分栏显示；空数据也有明确空态。
- **灰阶点阵奶牛猫**：64×40 Braille 点阵、六种眼神状态，支持关闭动画。
- **可回放的 Agent 内核**：事件溯源会话、工具审批、权限授予、Plan / 接受编辑模式。
- **完整的开发工具**：Read / Write / Edit / Bash / Glob / Grep、后台任务、子代理、Cron、Git worktree。
- **配置与恢复**：模型和服务商向导、会话恢复、上下文压缩、断线重连、Write/Edit undo/redo。
- **密钥留在本机**：只从环境变量读取 API Key，不写日志、不进配置模板。

## 运行要求

| 使用方式 | Node.js |
|---|---|
| 默认 `cowcat`、`cowcat tui`、`sessions resume` | **>= 26.4**，推荐 **26.12+** |
| `run`、`serve`、`sessions list`、`doctor` 等 headless 命令 | **>= 22** |
| 模型 | 一个 Anthropic 或 OpenAI 兼容端点及 API Key |

> Node 26.4 需要显式 `--experimental-ffi` 才能加载 OpenTUI；Node 26.12 不需要。日常运行推荐使用 Node 26.12 或更新版本。

## 安装与启动

```bash
npm i -g @corescense/cowcat@beta --registry=https://registry.npmjs.org

cowcat doctor
cowcat                      # 启动 TUI
```

首次使用时配置模型：

```bash
cowcat setup --preset anthropic/claude-sonnet-5-5
export ANTHROPIC_API_KEY=...
```

也可以在 TUI 中使用 `/model` 和 `/providers` 完成服务商与模型配置。密钥只通过环境变量提供。

从 v1 升级：

```bash
cowcat setup --migrate      # 备份并迁移配置，不复制密钥
```

在项目目录中启用项目级指令与配置：

```bash
cowcat trust                # 只信任当前目录，不继承子目录
cowcat run "解释一下这个仓库的入口"
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `cowcat` / `cowcat tui` | 启动交互式 TUI |
| `cowcat run "<prompt>"` | 执行一次性回合；默认拒绝审批，`--yes` 放行 |
| `cowcat serve` | 启动 JSON-RPC over stdio |
| `cowcat sessions list` | 列出会话 |
| `cowcat sessions resume <id>` | 恢复会话 |
| `cowcat doctor` | 检查运行时、配置、信任、技能、沙箱、模型与 Key |
| `cowcat trust [dir]` | 信任目录；`--list` 查看、`--remove` 撤销 |
| `cowcat setup --preset <provider/model>` | 新建模型配置 |
| `cowcat setup --migrate` | 迁移 v1 配置并保留备份 |

使用 `cowcat <command> --help` 查看参数。帮助命令不启动 TUI，也不读取模型配置。

## 配置

用户层配置位于 `~/.cowcat/config.json`：

```json
{
  "model": {
    "preset": "anthropic/claude-sonnet-5-5",
    "providers": {
      "anthropic": { "apiKeyEnv": "ANTHROPIC_API_KEY" }
    }
  }
}
```

配置分为用户层、项目层 `<cwd>/cowcat.json` 和会话层 `--config <path>`。项目层的规则与 MCP 受工作区信任约束。

MCP stdio 示例：

```json
{
  "mcp": {
    "servers": {
      "everything": {
        "command": "node",
        "args": ["/path/to/server-everything/dist/index.js", "stdio"]
      }
    }
  }
}
```

Skills 支持 `~/.cowcat/skills/<name>/SKILL.md` 和项目 `.cowcat/skills/`；同时只读兼容 `.claude/skills/`。项目技能需要工作区信任。

## 从源码运行

```bash
git clone https://github.com/HiyodoGame/cowcat.git
cd cowcat

(cd packages/protocol && npm ci && npm run build)
(cd packages/cowcat && npm ci && npm run build)
(cd packages/tui && npm ci && npm run build)
(cd packages/cli && npm ci && npm run build)

node packages/cli/dist/src/cli/main.js doctor
node packages/cli/dist/src/cli/main.js
```

Windows / Git Bash 可临时使用 Node 26.12，不修改系统默认版本：

```bash
npx -y node@26.12.0 packages/cli/dist/src/cli/main.js
```

完整三栏建议终端至少 **160 列 × 32 行**；104–159 列保留信息栏，更窄或更矮时回退到单栏 dock。

## 包结构

| 包 | 内容 |
|---|---|
| `@corescense/cowcat` | 可执行文件与命令行入口（`packages/cli`） |
| `@corescense/cowcat-core` | 事件溯源内核、策略、端口、工具与组合根 |
| `@corescense/cowcat-protocol` | headless JSON-RPC 协议与传输 |
| `@corescense/cowcat-tui` | OpenTUI 终端渲染器，按需动态加载 |

## 文档与贡献

- [架构与 ADR](docs/architecture/)
- [变更记录](docs/changelog.md)
- [Beta 验收清单](docs/beta-checklist.md)
- [贡献指南](CONTRIBUTING.md)
- [发布手册](docs/PUBLISH.md)
- [安全政策](SECURITY.md)

`docs/archive/` 是历史档案，不是现行规范。

## 许可

MIT。见 [LICENSE](LICENSE)。
