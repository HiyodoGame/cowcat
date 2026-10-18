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
│ adapters    Node 文件存储 · 系统时钟 · 随机 ID · 进程 · 沙箱执行器 · 工具实现 │  唯一允许 import node:* 的地方
└───────────────────────────────────────────────────────────────┘
```

## 包结构（`packages/cowcat`）

```
src/
  kernel/      events.ts  state.ts  turn.ts  messages.ts  session.ts  run-turn.ts
  policy/      decide.ts  defaults.ts
  ports/       index.ts                 # 全部端口接口集中定义
  adapters/    node.ts  platform.ts  shell.ts  fs.ts  process.ts        # 存储、时钟、ID、平台、路径、网关
               tools/    wire-schema.ts  define-tool.ts                 # 工具定义 API（P5 T2 起）
  index.ts                              # 公共 API（唯一对外入口）
test/
  support.ts                            # 测试替身：内存存储、假时钟、脚本化模型
  *.test.ts
```

P2 起新增 `ports/process.ts`、`ports/fs.ts`、`ports/platform.ts`（均已落地，见下）与 `adapters/` 下的各实现（`node.ts`、`platform.ts`、`shell.ts`、`sandbox-probe.ts`、`fs.ts`）；**P4 起新增 `ports/model.ts`**（协议词汇：`ModelUsage`、`StopReason`、`StopReasonKind`；放在自己文件里的理由是 `ports/index.ts` 与 `kernel/events.ts` 互相需要对方的名字，见 ADR-035），以及 `adapters/` 下的模型适配器（T2 落了 `adapters/model-openai.ts`，T3 落了 `adapters/model-anthropic.ts`，T5 落了共用的 `adapters/model-retry.ts`）。目录名随实现调整，但依赖规则不变。

## 工具住在 `adapters/tools/`（ADR-047）

核心工具的候选只有三个落点，结论是**放进 `adapters/tools/`**，并且**不给 lint 开第二个例外**：

- 新建 `src/tools/` 会落进第二个 lint block（`src/**/*.ts` 禁 `node:fs` / `node:child_process`），而「再开一个 `ignores`」等于削弱一条被 `tools/lint-probe.mjs` 钉住的规则；
- 只经 `FsPort` 访问文件系统做不到——它的职责被 ADR-017 定成**路径身份**（`canonical` / `samePath` / `kindOf` / `exists`），没有 read / write / list，扩成完整文件系统端口会把「谁拥有路径身份」这条唯一性稀释掉；
- `modules/` 的定义是「**不被内核认识**」，而核心工具必须被认识：`ToolSpec` 要发给模型，`risk` 要参与裁决。

工具的定义 API 沿用已有的 `ToolPort` / `ToolSpec`（`defineTool()` 只是把「声明 + 实现」装配成它们），**入参只写一次**：zod schema 是唯一来源，wire JSON Schema 由 `adapters/tools/wire-schema.ts` 用 `z.toJSONSchema({ io: 'input', target })` 机械派生、剥掉 `$schema`，并在同一处拒绝被禁词汇（联合 / nullable / `record` / `literal`）。理由与「转换器不该住在适配器里」一致：这份转换与协议无关，两个协议适配器只读 `ToolSpec.inputSchema`。

## 路径身份（ADR-017）

路径身份由 `FsPort` 独占：凡是拿路径当**键**的地方——信任记录、会话身份、白名单、沙箱策略条目——必须走同一实现，否则同一个目录会有两个身份。第 19 轮的 macOS 事故就是这个：`os.tmpdir()` 给符号链接写法而 `getcwd()` 给物理写法，精确字符串比较让 7 条互不相关的测试一起变红。

两个刻意的形态选择：

- **方法保持同步**。它们被用在纯 argv 生成里（沙箱后端把解析好的策略变成命令行）；做成异步会把策略解析也拖成异步，而策略→argv 的映射必须是纯函数——这正是旧版能在 Windows 上单测 bwrap/seatbelt 映射的原因。
- **内核需要的东西由组合根注入**。`cowcatVersion` 已是先例（ADR-012）；P2 起「实际使用的 shell」同样由组合根从 `PlatformPort` 取，再交给内核写进会话头（此时 `schemaVersion` **不升**——v2 的日志格式从未发布过，没有需要兼容的既有日志，该字段从一开始就是版本 1 的一部分）。

实现（`adapters/fs.ts`，P2 T3 迁自 `agent/src/canonical.js`）在旧版语义上只做了两处调整，都是为了让状态可归属：

- **缓存挂在实例上**，不是模块级 `Map`。隐藏的全局意味着两个适配器静默共享一份状态，且测试拿不到干净的缓存；实例字段让组合根拥有它，隔离是白送的。
- **只在真的找到了现存祖先时才缓存结果**。若整条链都不可解析（没有 Z: 盘的机器上的 `Z:\project\file.txt`），答案就是调用者自己的写法——把它缓存住等于在盘符出现之后仍然钉死错误答案。旧版会缓存，这个窗口是本次唯一的实质修正。

未处理且**故意不处理**：会话进行中被改指向的符号链接仍走缓存。它实际上观察不到（会话的 cwd、home 与策略根不会移动），而逃生口是 `clearCache()`——代价不该是每次查找一次 syscall。`test/fs.test.ts` 把这条行为钉成契约，而不是留在注释里当说法。

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
