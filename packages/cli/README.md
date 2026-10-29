# @corescense/cowcat

CowCat 的可执行文件：一个跑在本地终端里的事件溯源编程 Agent。代码、API Key 和会话都留在你的机器上。

## 安装

```bash
npm i -g @corescense/cowcat@beta --registry=https://registry.npmjs.org
cowcat doctor
cowcat
```

npm `latest` 目前仍是 v1 `0.15.0`；v2 请使用 **`@beta`**。

## 运行要求

- 默认 TUI / `sessions resume`：Node.js **>= 26.4**，推荐 **26.12+**
- `run` / `serve` / `sessions list` / `doctor`：Node.js **>= 22**
- 一个 Anthropic 或 OpenAI 兼容模型端点与 API Key

Node 26.4 需要 `--experimental-ffi`；Node 26.12 不需要。

## 配置模型

```bash
cowcat setup --preset anthropic/claude-sonnet-5-5
export ANTHROPIC_API_KEY=...
```

也可以在 TUI 中通过 `/model` 与 `/providers` 配置。API Key 只从环境变量读取，包内不附带密钥。v1 用户可执行 `cowcat setup --migrate` 备份并迁移配置。

## 常用命令

```bash
cowcat                      # 原生终端工作台
cowcat run "解释这个仓库"   # 一次性回合
cowcat serve                # JSON-RPC over stdio
cowcat sessions list        # 会话列表
cowcat sessions resume <id> # 恢复会话
cowcat trust                # 信任当前项目目录
cowcat doctor               # 环境与配置诊断
```

TUI 包含对话、待办、子代理、后台任务、上下文与文件变更分栏，以及黑白灰 Braille 点阵猫。完整三栏建议至少 160 列 × 32 行。

完整文档、架构与贡献指南：<https://github.com/HiyodoGame/cowcat>。
