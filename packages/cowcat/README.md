# @corescense/cowcat-core

CowCat 的内核：事件溯源会话、回合状态机、策略与审批、端口定义、工具适配器与组合根。

它不包含 `bin`，通常由 `@corescense/cowcat` 依赖；单独安装只对需要嵌入宿主的调用方有意义。

- Node.js **>= 22**
- 运行时依赖：`zod`、`openai`、`@anthropic-ai/sdk`
- 分层由 ESLint 强制：`kernel/`、`policy/`、`ports/` 不 import `node:*`

文档见仓库：<https://github.com/HiyodoGame/cowcat>。
