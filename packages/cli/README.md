# @corescense/cowcat

CowCat 的可执行文件：`cowcat` 命令、子命令表、headless `serve`、一次性 `run`、会话管理与 `doctor`。

```bash
npm i -g @corescense/cowcat
cowcat doctor
cowcat run "解释一下这个仓库的入口"
```

- Node.js **>= 22**；`cowcat tui` 需要 Node.js **>= 26.4**（opentui）。
- 模型与密钥由配置或环境变量提供，包内不附带任何 key。
- v1 配置（`model` 字符串 + `providers.*.apiKey`）以兼容模式读取，不重写文件（ADR-089）。

完整文档见仓库：<https://github.com/HiyodoGame/cowcat>。

## 包结构

| 包 | 作用 |
|---|---|
| `@corescense/cowcat` | 本包：可执行文件 |
| `@corescense/cowcat-core` | 内核、策略、端口与组合根 |
| `@corescense/cowcat-protocol` | headless JSON-RPC 协议 |
| `@corescense/cowcat-tui` | 终端渲染器（按需动态加载） |
