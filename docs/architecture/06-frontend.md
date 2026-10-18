# 06 前端：headless 协议、TUI 与终端图像

> 本文是 P6 的契约文档。决定见 [`README.md`](README.md) 的 ADR-055~060，调研与取舍见 [`../research/p6-frontend.md`](../research/p6-frontend.md)。
> **本文只写已决定且已落地或正在落地的形状**；尚未实现的部分标注「（T# 落地）」，不写成已完成。

## 为什么前端必须隔着协议

内核是一个库（`packages/cowcat/src/`），组合根负责装配。P6 加一个前端时最容易走的路是**直接 import 内核**——那样确实更快，但会同时失去两样东西：

1. **可测**：没有终端也能测的前提是「前端只是协议的客户端」，否则任何测试都要启动一个真 TUI；
2. **可换**：TUI 之后还会有别的客户端（IDE 插件、脚本），如果第一个客户端就与内核焊死，第二个客户端要么复制一遍装配，要么改内核。

`dev-plan-v2.md` 的 P6 出口标准把这条写成硬约束：**TUI 中删除任何直接访问内核内部的代码路径（lint 或测试保证）**。实现方式见 ADR-059。

## 协议（ADR-055）

**JSON-RPC 2.0 over stdio，一行一个 JSON 对象。** 不用 `Content-Length` 帧：我们的载荷里没有裸换行，而引入帧解析就等于引入一个必须两个实现同时正确的解析器。

```
请求（客户端 → 服务端）
  initialize          { protocolVersion }            必须第一个；不匹配则结构化报错并退出
  session.open        { sessionId }
  session.create      { sessionId? }
  session.list        {}
  turn.send           { sessionId, input }
  turn.cancel         { sessionId }
  approval.respond    { sessionId, callId, verdict }  once | always | reject
  attachment.read     { id, maxBytes? }               按需取附件字节（ADR-057）
  shutdown            {}

通知（服务端 → 客户端）
  event               KernelEvent（持久事实）
  delta               StreamDelta（瞬时，逐 token）
  log                 服务端自己的诊断（不是会话事实，不进日志）
```

三条纪律：

1. **协议与传输分开**。同一套方法与类型跑 **stdio**（子进程）与 **内存传输**（测试、单进程模式）。`cowcat serve` 只是「stdio 上的一个服务端」，不是协议本身。
2. **`event` 与 `delta` 分开**。前者是事实（会进日志、可重放），后者只用于实时渲染（`02-kernel.md` 的既有裁定：瞬时增量不落盘）。前端不得把 delta 当作状态来源。
3. **版本不匹配时拒绝，不降级**。`protocolVersion` 不是「尽力兼容」的协商，是一次握手：要么两端说同一个版本，要么明确失败（ADR-016 的纪律）。

### 前端不持有会话状态的副本

前端只有两种东西：**订阅到的更新**与**它自己的界面状态**（滚动位置、当前对话框、输入缓冲）。会话状态（消息、`readFiles`、`todos`、grants）的唯一权威在服务端；前端需要时通过协议问，不缓存一份「以防万一」。

这条不是洁癖：旧版 TUI 直接读内核状态，于是「屏幕上显示的」「日志里记录的」「模型下一轮看到的」三者可以不一致，而排错时无法判断哪一份是对的。

## 前端分层（ADR-056）

前端是**独立 workspace 包**（`packages/tui/`，`private: true`），它自己声明 `engines.node >=26.4.0`（opentui 的门槛），而内核包保持 Node ≥ 22 不变。（T1 已按此建成该包与它的两条 Node 26 CI 腿；实测见下文「T1 前提验证」。）

```
packages/tui/src/
  protocol/     客户端：stdio 与内存两种传输、方法类型（zod 解码边界在适配器一侧）
  app/          project()（KernelEvent → view model，纯函数）、命令、键位、屏幕表
  ui/           无状态原语：box / text / list / dialog / input / toast / status-bar / tabs / spinner
  components/   特性组件：session-frame / message / tool-card / approval-card / todo-panel / diff-card / image-preview
  theme/        颜色与样式（语义化 token，ADR-061 待落）
  image/        ImageRenderable 与能力探测（ADR-058）
```

| 层 | 规则 |
|---|---|
| `protocol/` | 只做传输与解码；不认识任何界面概念 |
| `app/` | **唯一**持有界面状态的地方；`project()` 是纯函数（同一段日志 → 同一屏） |
| `ui/` | 原语**不认识业务**：出现 `session` / `tool` / `approval` 这些词就是分层被破坏的信号 |
| `components/` | 只读 view model，不订阅协议、不发命令 |
| `image/` | 能力探测与协议细节（kitty / iTerm2 / 半块）只在这里；组件只说「这里有一张图」 |

**依赖方向**：`components → ui → image/theme`，`app → protocol`；**没有任何一层 import `packages/cowcat/src/kernel/*` 或 `adapters/*`**（ADR-059 的 lint）。

**为什么用 opentui 而不自研**：用户裁定采纳 `@opentui/core`（flexbox、原生图片支持），代价是 Node 门槛与原生二进制（ADR-056）。旧版的宽度实现与能力探测仍然保留——**模型侧与工具输出侧的对齐不归 opentui 管**。

## 附件与图像（ADR-057、ADR-058）

### 附件通路

```
工具（Read / 未来的 NotebookEdit）
  → ToolResult.attachments          形状沿用旧版 attach.js：{ type, mediaType, path, bytes, width?, height?, pages? }
  → tool.finished.attachments       进日志（可空）——「这次回答里有一张图」是可重放的事实
  → Message 携带附件【引用】         日志是 JSON，字节不进日志
  → ModelRequest 内容部件            两个协议各自映射（否则图片只是给人看的装饰）
  → 协议 attachment.read(id)         前端与内核是两个进程，前端不能直接读内核侧的路径
```

**大小与类型**沿用 P5 的口径（`READ_LARGE_LIMIT` = 5MB 软限、20MB 硬顶），超限时**拒绝并说明**，不截断字节。

### 图像协议矩阵

| 协议 | 序列 | 是否参与文本重排 | 用途 |
|---|---|---|---|
| kitty graphics | APC `ESC _ G <k=v,…>;base64 ESC \` | **是**（`U=1` + `U+10EEEE` 占位符） | 工具结果内联、预览模态 |
| iTerm2 | OSC `1337;File=<k=v,…>:base64 BEL` | 否（挂在屏幕坐标上） | 只用于不滚动的模态 |
| sixel | DCS | 否 | 回退链的一环（覆盖范围未验证） |
| 半块 / octant | 普通文本 | **是**（就是文本） | 没有协议时；octant 需字体支持（未验证） |

**能力探测顺序**：环境变量 → 主动查询（kitty `a=q` + DA1，**必须 `q=2` 静默**）→ 半块 → 元信息。

**为什么「是否参与重排」是这条链的判据**：我们是行式重绘（每帧按行写绝对坐标）。图片若挂在屏幕坐标上，滚动一次就错位；只有作为文本（占位符或块字符）参与布局的图片才能跟着内容走。

## 测试（ADR-059）

| 形态 | 做法 | 覆盖 |
|---|---|---|
| 协议契约测试 | 内存传输 + 测试客户端，跑完整回合（打开 → 输入 → 事件 → 审批 → 取消） | 协议形状、顺序、错误路径 |
| 帧快照测试 | `project()` 纯函数 + 写死的日志 → 逐字节比对一屏文本 | 渲染逻辑，不需要终端 |
| lint 探针 | 前端包禁止 import 内核与适配器；`tools/lint-probe.mjs` 验证它真的会报错 | 出口标准第 2 条 |
| 子进程测试 | 一条：`serve` 能启动、能握手、能干净退出 | 传输与生命周期 |
| 人工验收 | 真实终端上的刷新率、闪烁、图片协议 | **CI 覆盖不到**，记在 T10 |

## CLI（ADR-060）

| 命令 | 作用 |
|---|---|
| `cowcat` | 进 TUI（默认） |
| `cowcat serve` | headless 协议服务（stdio）——TUI 与 IDE 都连它，也是无终端测试的入口 |
| `cowcat run "<prompt>"` | 一次性回合（非交互） |
| `cowcat doctor` | 配置、模型连通性、沙箱后端逐项检查 |
| `cowcat sessions list \| resume <id>` | 会话管理 |
| `cowcat setup` | 交互式配置向导 |

子命令表是**数据**（名字、摘要、参数 schema、处理函数），帮助文本与补全从表生成；不做嵌套子命令。

## T1 前提验证（2026-10-19）

T1 只问一件事：这套东西能不能真的装起来、跑起来。**答案是可以，ADR-056 的兜底（降级为「本机开发 + 手动验收」）不触发**；但「怎么跑起来」与 opentui 自己的 README 写的不完全一样，下面第 1 条是执行这活时最容易踩的坑。

| 验证项 | 结果 | 证据 |
|---|---|---|
| Node 门槛 | `nodejs.org` 的 26 线当前是 **v26.12.0**，与本地装的一致 | 【上游】`dist/latest-v26.x/SHASUMS256.txt`；【实测】本地解压后 `node -v` |
| 安装与原生核心 | `npm install @opentui/core@0.6.6` → 12 个包 / 8 秒；`@opentui/core-win32-x64` 随 `optionalDependencies` 落下，内含 `opentui.dll`（5.06 MB） | 【实测】`packages/tui/package-lock.json` 与本地安装 |
| 一帧渲染 | 40×6 一帧 12 ms、`cellsUpdated` 240；捕获到的字符帧是正确 UTF-8，框线与文本按列对齐，每行恰好 40 个字符 | 【实测】`packages/tui/test/render.test.ts`（Windows x64 / Node 26.12.0） |
| `node:ffi` | **26.12.0 不需要 `--experimental-ffi`**（只把 `ExperimentalWarning` 写到 **stderr**）；显式传该 flag 也无害；**Node 24 上它是启动期硬错误**（`bad option: --experimental-ffi`） | 【实测】三条命令行用例 |
| 非 TTY | `createCliRenderer` 在 `isTTY: false` 下照样创建、照样输出 ANSI（含 kitty `a=q` 静默查询与 DA1）；帧走 **stdout**，诊断走 stderr | 【实测】探针，stdout 992 B / stderr 166 B |
| CI 两条腿 | 本 PR 加入 `packages/tui · node 26 · ubuntu-latest` 与 `windows-latest` | 【推断】干净 runner 上的结果以该 PR 的 checks 为准 |

三条要记住的：

1. **不要把 `--experimental-ffi` 写进脚本或 `NODE_OPTIONS`**。opentui 的 README 说 Node 需要它，26.12.0 实测不需要；而一旦写进去，同一个脚本在 Node 24 上是**启动期崩溃**而不是降级——「门槛」就此从 `engines` 的提示变成硬失败。升级 Node 前先看这条 CI 腿。
2. **`packages/tui/test/render.test.ts` 是这条前提的可重复形式**，不是一次性探针：原生二进制没解析到、没加载起来、或帧的列错位，它都会失败。因此 CI 不会在「TUI 静默不可用」时保持绿灯。
3. **真实终端仍然没有证据**：刷新率、闪烁、图片协议的实际渲染全部未测，仍是 T10 的活（本节只证明「能装、能编帧」）。

## 待办与未验证

- 主题与设计 token 的 ADR 尚未落（实现主题时再落，不提前占号）
- **没有任何真实终端证据**：刷新率、闪烁、图片协议的实际渲染效果全部未测（调研 §5.6）
- **T1 已验证**：Node ≥26.4 与 Windows 原生二进制可用，ADR-056 的 CI 部分**不需要**降级（见「T1 前提验证」）
