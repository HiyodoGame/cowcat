# 接入 Hindsight：跨会话记忆（MCP 路径）

> 状态：零内核改动的接入路径，本文即全部所需。内核级的**主动记忆**（会话启动自动注入、回合结束自动沉淀）是规划中的特性，见 ADR 草案 [`docs/architecture/adr-memory-port-draft.md`](../architecture/adr-memory-port-draft.md)。

CowCat 的会话之间互相失忆：`sessions resume` 能回到旧上下文，新会话却从零开始。[Hindsight](https://github.com/vectorize-io/hindsight)（MIT，可完全本地运行）给 Agent 提供会学习的长期记忆：项目事实、踩过的坑、对工作方式的理解。本文把它的 MCP 端点接入 CowCat——模型在会话中自主调用 `retain` / `recall` / `reflect` 三个工具，跨会话积累记忆。

| 工具 | 模型用它做什么 |
|---|---|
| `recall` | 查询记忆库：「这个项目测试怎么跑」「上次这个错误怎么修的」 |
| `retain` | 写入事实与经验：「用户偏好 pnpm」「方案 A 在模块 X 上失败过」 |
| `reflect` | 整理记忆库：去重、消解冲突、固化长期记忆（低频调用） |

## 前提

- 跑 CowCat 的既有环境（Node ≥ 22）；
- **Docker**，或 Python 3.10+（二选一，用来跑 Hindsight 服务）；
- 一个给 Hindsight 内部用的 LLM key——它需要一个模型做事实提取，支持 OpenAI / Anthropic / DeepSeek / Ollama 等 25+ 提供商，也可以直接用 ChatGPT Plus / Claude Pro 订阅（见 [supported models](https://hindsight.vectorize.io/developer/models)）。

## 第一步：启动 Hindsight 服务（本地）

Docker（推荐；API 在 8888，管理界面在 9999）：

```bash
export OPENAI_API_KEY=sk-xxx        # 或 DeepSeek 等其他提供商

docker run -d --pull always --name hindsight --restart unless-stopped \
  -p 8888:8888 -p 9999:9999 \
  -e HINDSIGHT_API_LLM_API_KEY=$OPENAI_API_KEY \
  -v hindsight-data:/home/hindsight/.pg0 \
  ghcr.io/vectorize-io/hindsight:latest
```

换提供商只需加 `HINDSIGHT_API_LLM_PROVIDER`，例如 DeepSeek：

```bash
  -e HINDSIGHT_API_LLM_PROVIDER=deepseek \
  -e HINDSIGHT_API_LLM_API_KEY=$DEEPSEEK_API_KEY \
```

**全本地零成本**：`HINDSIGHT_API_LLM_PROVIDER=ollama`（本地 Ollama，不出网、零 token 费用，模型选择见上游文档）。

不用 Docker 也可以：`pip install hindsight-api && hindsight-api`。

验证：浏览器打开 `http://localhost:9999` 看到 UI 即启动成功。

## 第二步：命名一个 bank（记忆库）

bank 是记忆的隔离单元，首次写入时自动创建，不需要提前建库。**建议一个仓库一个 bank**，命名如 `cowcat-myapp`——同仓库的所有会话共享记忆，不同仓库互不干扰。

## 第三步：桥接进 CowCat

Hindsight 的 MCP 端点是 **HTTP** 形式（`http://localhost:8888/mcp/<bank>/`），而 CowCat 目前只接受 **stdio** MCP 服务器——用 [`mcp-remote`](https://github.com/geelen/mcp-remote) 做桥接（`npx` 免安装）。

用户层 `~/.cowcat/config.json`（所有项目生效）：

```json
{
  "mcp": {
    "servers": {
      "hindsight": {
        "command": "npx",
        "args": ["-y", "mcp-remote", "http://localhost:8888/mcp/cowcat-myapp/"]
      }
    }
  }
}
```

也可以放在项目层 `<cwd>/cowcat.json`——注意**项目层的 `mcp.servers` 受工作区信任约束**：先 `cowcat trust` 信任该目录，未受信时不会加载并提示。

每个仓库用不同 bank 的话，把 bank 名写进各自项目层的 URL 即可。

## 第四步：验证

`cowcat doctor` 目前不检查 MCP 服务器（它覆盖环境/配置/信任/指令链/技能/沙箱/模型），直接开会话验证：

1. 在目标仓库启动 `cowcat`，让它干一个小任务，然后说「把这个项目的一个关键约定用 hindsight 的 retain 记下来：测试跑 vitest，不是 jest」；
2. 退出，**新开一个会话**，问「这个项目怎么跑测试？」——模型应调用 `recall` 答出 vitest；
3. 也可以打开 `http://localhost:9999` 直接查看 bank 里的记忆内容。

## 能与不能（诚实清单）

**能**：

- 模型自主决定何时存取——大多数情况下它会主动 recall 项目问题、retain 重要发现；
- 跨会话、跨天累积；Experiences 类记忆让 Agent 避开踩过的坑；
- 与 AGENTS.md 互补并存：AGENTS.md 是你**显式写下的规则**（每次必注入、受信任约束），Hindsight 是**积累出来的经验**（按需检索）。

**不能（当前 MCP 路径的固有限制）**：

- 不保证每回合都存/取——模型自主，可能忘；想要保证，等 ADR-148 的内核主动路径；
- `retain` / `reflect` 有 LLM 成本（在 Hindsight 侧、用你给它的 key 计费，**不进 CowCat 的 usage 统计**——CowCat 看不到这笔钱）；
- CowCat 的 `Remember` 工具与本方案分工明确：Remember 写**项目/用户文件**（AGENTS.md、SKILL.md，人可读可审），Hindsight 写**外部记忆库**。沉淀「团队规范」用前者，积累「这个项目的坑」用后者。

## 隐私

- 默认全程本地：Hindsight 容器 + 你的 key + 本地数据卷 `hindsight-data`；
- 若把 URL 指向远程服务器（自建或 Hindsight Cloud），记忆数据会离开本机，自行评估；
- 记忆内容进入未来会话的上下文时，与 AGENTS.md 同样按**不可信内容**对待（外部文本可能混入记忆库）——模型对记忆里的「指令」应保持批判，这一立场与 ADR-030/136 一致。

## 故障排查

| 症状 | 处理 |
|---|---|
| `mcp-remote` 连接失败 | Hindsight 没起：`docker ps` 看容器，`docker logs hindsight` 看原因（常见是 key 无效） |
| 模型说没有 hindsight 工具 | 项目层配置未受信（`cowcat trust`）；或 JSON 里 `mcp` 键拼错 |
| 模型从不主动调用 | 正常（被动路径）。在 AGENTS.md 里写一句「重要项目发现请用 hindsight retain 记忆」可显著提高频率 |
| 想清空记忆 | 删 bank：UI（9999）里操作，或 `docker rm -f hindsight && docker volume rm hindsight-data` 全部重来 |
| Windows 下 `npx` 卡在确认 | 保留 `-y` 参数 |

## 参考

- [Hindsight 仓库](https://github.com/vectorize-io/hindsight) · [MCP server 文档](https://hindsight.vectorize.io/developer/mcp-server) · [支持的模型](https://hindsight.vectorize.io/developer/models)
- 上游另有 `npx @vectorize-io/hindsight-coding-agents install all` 一键接入（支持 Claude Code / Codex / Cursor 等，暂不支持 CowCat——本页的 MCP 路径是等效的手动方式）。
