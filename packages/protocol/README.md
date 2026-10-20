# @corescense/cowcat-protocol

CowCat 的 headless 协议：JSON-RPC over stdio、内存传输、`serve()` 生命周期与宿主端口。

它既不知道渲染器，也不知道内核；`@corescense/cowcat-core` 与 `@corescense/cowcat-tui` 都依赖它。

- Node.js **>= 22**
- 运行时依赖：`zod`

文档见仓库：<https://github.com/HiyodoGame/cowcat>。
