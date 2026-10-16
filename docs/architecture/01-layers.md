# 01 分层与边界

## 为什么要分层

旧版 `loop.js`（450 行）同时 import 了权限、沙箱分类、沙箱参数、diff 渲染、卡片模型、检查点、钩子与笔记本。结果是「跑一轮模型对话」与「怎么展示、怎么审批、怎么落盘、怎么隔离」被焊在同一个函数里，任何一处改动都牵动全局，也无法在没有终端的情况下测试。

v2 的分层规则只有一条：**依赖只能指向更稳定的一层**。

```
┌───────────────────────────────────────────────────────────────┐
│ frontends   TUI · headless（JSON-RPC over stdio） · 测试 harness │  订阅事件、发送命令；不改内核状态
├───────────────────────────────────────────────────────────────┤
│ modules     子 agent · MCP · 记忆 · 压缩 · skills · hooks · cron │  以能力形式注册，不被内核认识
├───────────────────────────────────────────────────────────────┤
│ kernel      Session · 事件 · 日志 · Turn 状态机 · runTurn         │  纯逻辑，只依赖 ports 的类型
│ policy      decide() · 规则 · 默认策略                            │  纯函数
├───────────────────────────────────────────────────────────────┤
│ ports       Clock · IdSource · EventStore · ModelPort · ToolPort  │  接口定义，无实现
├───────────────────────────────────────────────────────────────┤
│ adapters    Node 文件存储 · 系统时钟 · 随机 ID · 进程 · 沙箱执行器   │  唯一允许 import node:* 的地方
└───────────────────────────────────────────────────────────────┘
```

## 包结构（`packages/cowcat`）

```
src/
  kernel/      events.ts  state.ts  turn.ts  messages.ts  session.ts  run-turn.ts
  policy/      decide.ts  defaults.ts
  ports/       index.ts                 # 全部端口接口集中定义
  adapters/    node.ts                  # 当前：JSONL 存储、系统时钟、随机 ID
  index.ts                              # 公共 API（唯一对外入口）
test/
  support.ts                            # 测试替身：内存存储、假时钟、脚本化模型
  *.test.ts
```

P2 起会增加 `ports/process.ts`、`ports/fs.ts`、`ports/platform.ts` 与 `adapters/node/` 下的各实现；目录名随实现调整，但依赖规则不变。

## 依赖规则

| 从 | 允许依赖 | 禁止依赖 |
|---|---|---|
| `kernel/` | `ports/`（仅类型）、`policy/` | `adapters/`、`node:*`、任何前端 |
| `policy/` | `ports/`（仅类型） | `kernel/` 的实现、`node:*` |
| `ports/` | `kernel/` 的类型 | 实现、`node:*` |
| `adapters/` | `ports/`、`kernel/` 类型 | 前端 |
| `modules/` | `kernel/` 公共 API、`ports/` | 其他模块的内部文件 |
| `frontends/` | `index.ts` 公共 API | `kernel/` 内部文件；直接写 `Session.#state` |

`kernel/`、`policy/`、`ports/` 的 `node:*` 禁令由 `packages/cowcat/eslint.config.js` 的 `no-restricted-imports` 强制，已用探针文件验证会报错。

`kernel/` 对 `ports/` 只依赖**类型**，这样 `ports/` 不会反过来拖着运行时代码；这一点由 `verbatimModuleSyntax` 保证。

## 为什么前端不能直接改状态

前端只能通过两个通道与内核交互：订阅 `SessionUpdate`（事实事件与流式增量），以及调用 `Session` / `runTurn` 的公共方法。`Session` 的状态字段是私有的（`#state`），只能经由 `emit` 追加事件后归约得到。这使得「TUI 上看到的」「日志里记录的」「模型下一轮看到的」三者必然一致，不会出现旧版那种 UI 状态与会话状态分叉的问题。
