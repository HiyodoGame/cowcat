# P6 调研：headless 协议与 TUI

> 依据 [`dev-plan-v2.md`](../dev-plan-v2.md)「工作规则 1」：每个阶段开始前先做调研，回答阶段内的开放问题，列出被否决的方案及理由。本文件回答 P6 的开放问题，并给出它们对 P6 四项范围的具体影响。
>
> 最后更新：**2026-10-19**。状态：**调研完成，决定草案待评审**。本文件只出决定草案与 ADR 清单（工作规则 2/3）；**ADR 表与源码都不在本 PR 里改**——ADR 由本阶段的 T0 落表，实现从 T1 起。
> 前置：[`dev-plan-v2.md`](../dev-plan-v2.md) 的 `## P6` 段、[`architecture/01-layers.md`](../architecture/01-layers.md)（分层与「前端只经协议」）、[`architecture/02-kernel.md`](../architecture/02-kernel.md)（事件表与 `SessionUpdate`）、[`HANDOFF.md`](../HANDOFF.md) §3（P5 交给 P6 的接线点清单）。
>
> **本文件的证据边界（必须先说清）**：
> - **没有真实终端证据**：本次会话的 stdout 不是 TTY（`stdinIsTTY: false`、`stdoutIsTTY: false`，见 §1），因此**刷新率、闪烁、图片协议的实际渲染效果全部未验证**。任何「看起来更快/更好看」的说法在本文件里都是【推断】。
> - **一次新增实测**：`tools/p6-tui-probe.mjs`（13 条断言通过 + 5 条 finding），测的是「非 TTY 进程能测的三件事」：环境自述、旧版宽度函数的一致性、单帧构建成本。开发期脚本，按 [`AGENTS.md`](../../AGENTS.md) 约定**不进 lint 门禁、不进发布包**。
> - 【上游】包括两类：opencode / opentui 的仓库源码（读了就是源码，但**不是本仓库的源码**，因此归入上游并给链接），以及 kitty / iTerm2 的协议文档。
> - 【推断】不得作为决策依据；【未验证】明确未核对。

## 证据标注约定

沿用 [`p1-kernel.md`](p1-kernel.md) … [`p5-tools.md`](p5-tools.md) 的约定：

- **【源码】** 本仓库的实现或数据，给 `文件:行号`
- **【实测】** 本次真跑出来的，给脚本名与用例
- **【上游】** 外部官方文档或开源仓库源码，给链接
- **【推断】** 未实测的推论
- **【未验证】** 明确未核对

---

## 0. 结论摘要

| # | 问题 | 决定草案（→ 建议 ADR） | 依据 |
|---|---|---|---|
| 一 | headless 协议形态 | **JSON-RPC 2.0 over stdio（换行分隔），版本化**；一个 `cowcat serve` 子进程持有内核，TUI 与未来的 IDE 都是它的客户端。**不做 HTTP/SSE/WebSocket** | §2；【上游】opencode 用 HTTP+SSE+SDK，因为它有 web/desktop/console 三个远程客户端；我们只有本机前端 |
| 二 | TUI 自研还是现成框架 | **自研渲染 + 组件分层**，沿用旧版 `screen.js` / `region.js` / `wcwidth.js` 作底座。**不引入 ink，也不引入 opentui** | §3；【上游】`@opentui/core` 的 `engines.node` 是 **>=26.4.0** 且带各平台原生二进制 |
| 三 | TUI 的组件与框架抽象 | 三层：`render/`（纯 cell 与 diff）→ `ui/`（无状态原语）→ `components/`（特性组件）；状态**单向**：`SessionUpdate` → view model → 帧；上行只发命令 | §4；【上游】opencode 的 `ui/` 与 `component/` 正是这两层，`routes/`+`context/` 是第三层 |
| 四 | 终端图像渲染 | **`ImageRenderable` 抽象 + 三级回退**（kitty / iTerm2 原生协议 → 半块/octant 降采样 → 只给元信息）；**P6 只在「图像预览」模态里渲染**，工具结果里保持文本 + 元信息 | §5；【上游】kitty 的 Unicode placeholder（U+10EEEE）能让图片跟着文本走，iTerm2 没有等价物 |
| 五 | CLI 入口与子命令 | `cowcat`（进 TUI）/ `cowcat serve`（headless）/ `cowcat doctor` / `cowcat sessions`；参数解析沿用旧版 `cliargs.js` 的「显式子命令表」 | §6；【源码】`agent/src/cliargs.js` |
| 六 | 怎么在没有终端的情况下测 | **协议层契约测试 + 帧快照测试**（同一套协议跑内存传输）；不启动真实终端 | §7；【上游】opencode 有 `packages/simulation` + `protocol/src/simulation.ts` |

**三条纠正前提的发现**（都是读源码／实测得出的）：

1. **旧版 TUI 从来不渲染图片**。【源码】`agent/src/` 全目录 grep 只命中 `attach.js` 与 `imageinfo.js`——那是**给模型看的附件**（base64 + token 估算），终端侧一个转义序列都没有。所以「CLI 里显示图片」在 v2 里是**从零开始**的能力，不是迁移。
2. **旧版的宽度函数有一个真实的表缺陷**。【实测】`agent/src/tui/wcwidth.js:22-26` 的 `RANGES_EMOJI` **没有排序**（`0x2600`/`0x2700` 两个块排在 `0x1fa70` 之后），而查找是二分（`:30-39`）。于是 `charWidth('☀')` 返回 **1**，尽管 `[0x2600,0x26ff]` 就写在表里。这是**代码事实**，不需要终端就能证明。
3. **P6 的性能问题不是问题**。【实测】构建一帧 200×50 的带样式文本是 **0.39ms（首次）/ 0.68ms（热）**，与上一帧做行 diff 是 **0.06ms**。60fps 的预算是 16.7ms，差两个数量级——所以选型不该拿「性能」当理由（§3 也不拿它当理由）。

---

## 1. 验证环境

| 项 | 值 |
|---|---|
| 平台 | `win32`（Windows 11），shell 为 PowerShell |
| Node | `v24.18.0` |
| 仓库状态 | `main = 9abdbcd`（P5 T7 收口已合），工作区干净；本 PR 只新增本文件与 `tools/p6-tui-probe.mjs` |
| 本次新增实测 | **【实测】** `node tools/p6-tui-probe.mjs` → **13/13 断言通过**，另打印 5 条 finding（§4.2/§5.6） |
| 终端环境自述 | **【实测】** `TERM=xterm-256color`，**`COLORTERM` / `TERM_PROGRAM` / `WT_SESSION` / `KITTY_WINDOW_ID` 全部不存在**，`stdin`/`stdout` **都不是 TTY**（agent 进程的固有状态），`columns`/`rows` 为 `null` |
| 本次**未**做 | 没有在真实终端里跑过任何 TUI；没有测过任何图片协议的实际渲染；没有在 Linux/macOS 上跑过探针；没有跑 v1 的 `agent/` 套件 |

**一条方法说明**：§3 的帧构建计时**只报数、不断言**。同一次运行里「首次 0.39ms / 热 0.68ms」已经说明这个量级的数字是噪声主导的（与 [`p5-tools.md`](p5-tools.md) §1 的冷 I/O 教训同源）。拿它当「自研更快」的证据会是错的。

---

## 2. 问题一：headless 协议的形态

### 2.1 我们要解决的是什么【源码】

内核是一个**库**：`Session` / `runTurn` / `ToolPort` 都在 `packages/cowcat/src/` 里，组合根（P6）负责装配。P6 要加两样东西：一个**前端**（TUI）和一个**边界**——`dev-plan-v2.md:486-488` 把边界写成三条：

1. headless 协议：版本化，覆盖会话打开、发送输入、订阅更新、回应审批、取消
2. 协议层的契约测试（不启动真实终端）
3. TUI 只通过协议工作：渲染订阅到的事件，**不持有会话状态副本**

第 3 条是最强的一条约束：它把「TUI 直接 import 内核」这条捷径排除了。已有的两条通道正好够用：【源码】`Session.subscribe`（推 `KernelEvent` + `StreamDelta`，`kernel/events.ts:103`）与 `TurnDeps.approve`（拉一个回答，`run-turn.ts:274`）。

### 2.2 三种协议形态

| 形态 | 覆盖 | 代价 |
|---|---|---|
| **A. JSON-RPC 2.0 over stdio**（换行分隔） | 请求/响应 + 服务端通知，天然双向 | 需要自己定义方法名与事件信封；一个子进程的生命周期 |
| **B. HTTP + SSE** | 请求/响应（HTTP）+ 服务端推送（SSE） | 端口、鉴权、跨域、进程与端口生命周期；对「本机一个用户」是多余的一层 |
| **C. WebSocket** | 双向 | 同上，且要处理重连与心跳 |

### 2.3 上游：opencode 选了 B，为什么我们不能照抄【上游】

opencode 的仓库有 `packages/server`、`packages/client`、`packages/protocol`、`packages/sdk`、`packages/httpapi-codegen`、`packages/http-recorder`（<https://github.com/anomalyco/opencode/tree/dev/packages>）——**它必须走 HTTP**，因为它同时服务 TUI、桌面应用（`packages/desktop`）、Web（`packages/web`）与云端 console（`packages/console`）。它的 `packages/protocol/src/simulation.ts`（26 KB）说明协议层本身是可模拟的。

我们的客户端清单里**只有本机**：TUI 现在，IDE 插件以后（那也是本机进程）。为「以后可能有人从别的机器连」付出端口与鉴权的代价，是 ADR-016 那条纪律要防的形态（**为一个没有消费者的需求降级设计**）。

### 2.4 决定草案

1. **协议 = JSON-RPC 2.0 over stdio**，一行一个 JSON 对象（`\n` 分隔），`Content-Length` 帧**不采用**（那会引入一个需要两个实现同时正确的解析器，而我们的载荷里没有裸换行）。
2. **版本化**：`initialize` 是唯一允许的第一个请求，携带 `protocolVersion`；版本不匹配时服务端回一个**结构化错误**并退出，不猜、不降级。
3. **方法表**（草案，T1 落表）：`initialize` / `session.open` / `session.create` / `session.list` / `turn.send` / `turn.cancel` / `approval.respond` / `shutdown`；**通知**：`event`（`KernelEvent`）、`delta`（`StreamDelta`）、`log`。
4. **同一套协议跑内存传输**：测试与「单进程模式」用它，于是契约测试不需要子进程（§7）。
5. **不做 HTTP/SSE/WebSocket**；将来真有远程客户端时，加一个**传输**而不是改协议——这是把协议与传输分开的直接收益。

---

## 3. 问题二：TUI 自研还是现成框架

### 3.1 三个候选

| 候选 | 形态 | 关键代价 |
|---|---|---|
| **A. 自研 + 组件分层**（取） | 沿用旧版 `screen.js`（备用屏 + 行 diff + 绝对寻址）、`region.js`（区域刷新）、`wcwidth.js`（grapheme 宽度） | 组件要自己写；没有 flexbox |
| **B. ink**（React 渲染到终端） | 生态成熟、声明式 | 引入 React 运行时；图片协议要自己实现；与「事件→帧」的既有模型重叠 |
| **C. opentui**（opencode 用的） | Zig 原生核心 + TS 绑定 + React/Solid 渲染器；flexbox；**原生支持图片与 3D** | 【上游】`@opentui/core` 的 `engines`：`bun >=1.3.14`、**`node >=26.4.0`**；依赖 8 个平台原生二进制（`@opentui/core-win32-x64` 等）；依赖树含 `bun-ffi-structs` |

### 3.2 为什么不是 C（这是本次唯一一个「上游数字否决一个选项」的地方）

【上游】`@opentui/core@0.6.6` 的 `package.json`（<https://raw.githubusercontent.com/anomalyco/opentui/main/packages/core/package.json>）写着 `engines.node: ">=26.4.0"`。本仓库的 v2 包声明 **Node ≥ 22**（`packages/cowcat/package.json`），CI 跑 22 与 24。采纳 C 等于：

- 把 Node 门槛抬到 26.4（**用户的 Node 版本**变成硬约束，而不是我们的选择）；
- 把「零原生依赖」这条现有性质换成 8 个平台二进制；
- 为一个**只有本机一个消费者**的 TUI，接受 Zig 核心的 ABI 与升级节奏。

opentui 的 README 说它「can play sounds, show images, and render 3D graphics」，而我们要的只有「盒子、文本、滚动、输入、以及一个图片预览」。【推断】图片协议的**难点在协议本身**（§5），不在渲染框架；用 C 换不来这一块的知识，只换来它的实现。

### 3.3 为什么不是 B

ink 把「渲染」变成「React 组件的副作用」，而我们的输入已经是**事件流**（`KernelEvent`）。用 React 需要写一层 `event → state → JSX` 的适配，而我们要渲染的东西（会话帧、工具卡片、diff、todo 面板）都是**行式**的、以 cell 为单位对齐的——React 的收益（组件复用、声明式 diff）我们已经从「纯函数 view model + 行 diff」里拿到，且不引入运行时。

ink 也没有图片协议；它同样要靠自己写 ANSI 序列。**否决 B 的理由是「收益与我们的输入模型不匹配」，不是「它不好」。**

### 3.4 决定草案

1. **自研**，并把旧版拆成三层（§4）：`render/`（纯，可单测）、`ui/`（原语）、`components/`（特性）。
2. **宽度与切片必须只有一份实现**：旧版 `wcwidth.js` 是**正确方向**（grapheme-aware + 二分表），但**表有缺陷**（§0 发现 2），迁移时必须修：`RANGES_EMOJI` 排序，或改成排序后合并成一张表。**P6 的第一条实现任务就是给它补测试**（用 §1 的探针语料当种子）。
3. **性能不作为选型理由**：一帧 0.39/0.68ms、diff 0.06ms（§0 发现 3）。真要在真实终端里做「刷新率与闪烁」的测量（`dev-plan-v2.md:481` 的要求），那是 **T7 的验收动作**，不是选型依据；本文件不假装测过。
4. **依赖预算**：P6 的运行时依赖**目标仍是 0 新增**。若最终需要图片解码（§5），先评估「自写 PNG 降采样」与「引入一个纯 JS 解码器」的成本，作为一条独立 ADR 决策。

---

## 4. 问题三：TUI 的组件与框架抽象

> 本节是本次调研的重点，也是「让 TUI 可扩展」这条要求的落点。参考对象是 opencode 的 TUI（v2，`@opencode/tui`）。

### 4.1 上游：opencode 的分层【上游】

`packages/tui/src/`（<https://github.com/anomalyco/opencode/tree/dev/packages/tui/src>）的目录就是它的分层：

| 目录 | 内容 | 我们的对应物 |
|---|---|---|
| `ui/` | **无状态原语**：`dialog.tsx`（对话框框架）、`dialog-select.tsx`（31 KB 的列表选择）、`dialog-confirm`、`dialog-prompt`、`dialog-help`、`dialog-alert`、`toast.tsx`、`layout.ts`、`border.ts`、`link.tsx`、`file-path.tsx`、`spinner.ts`、`animation.ts`、`pane-resize*.ts`、`subcell.ts` | `ui/`（同一层） |
| `component/` | **特性组件**：`session-frame.tsx`（15 KB）、`session-tabs.tsx`（**75 KB**）、`patch-diff.tsx`、`terminal-pane.tsx`、`dialog-model/mcp/session-list/theme-list/workspaces/...`、`error-component.tsx`、`logo.tsx`、`spinner`、`shimmer-text`、`fade-in-text` | `components/` |
| `routes/` | 路由（屏幕） | `app/` 的屏幕表 |
| `context/` | 状态上下文（keymap / theme / dialog 等） | `app/` 的 store + 依赖注入 |
| `simulation/` | **无终端测试**（`semantics.ts`；另有 `packages/simulation` 与 `protocol/src/simulation.ts`） | `test/` 的帧快照 + 协议回放 |
| `theme/`、`config/`、`plugin/`、`feature-plugins/`、`mini/`、`util/`、`devtools/` | 主题、键位与配置、插件、精简模式、工具函数、开发者面板 | `theme/`、`keymap/`、`devtools/`（可选） |

三条值得抄的**结构性**事实：

1. **`ui/` 与 `component/` 是分开的两个目录**，而且 `ui/` 里没有业务名词（没有 session、没有 tool）。这条边界让原语可以被别的界面复用，也让「一个 82 KB 的 `ui.js`」这种旧版形态不再出现（【源码】`agent/src/tui/ui.js` 是 **82103 字节**，`render.js` 16141 字节——一个文件同时管布局、键位、渲染与会话展示）。
2. **对话框是框架，不是控件**：`ui/dialog.tsx` 提供 `DialogLayout` / `DialogHeader` / `useDialog()` / `setSize()` / `setCentered()`，具体对话框只声明头部、正文与底部动作（见下）。
3. **插件与实验是注册表**：`feature-plugins/`、`component/dialog-experiments.tsx`，且其 `AGENTS.md` 明确写着「Experiments 框架是永久基础设施，即使注册表为空也不要删」。

### 4.2 上游：图片预览对话框长什么样【上游】

`packages/tui/src/component/dialog-image-preview.tsx`（2.9 KB，全文读过）：

```tsx
<DialogLayout id="prompt-image-viewer" header={<DialogHeader title={`Image ${index()+1} of ${images.length}`} />}
  footer={{ actions: { primary: [ { title: "previous", key: "←", onTrigger: () => move(-1) }, ... ] } }}>
  <image id="prompt-image-viewer-image" source={current().uri} fit="fit" protocol="auto"
         width="100%" height={imageHeight()} onError={() => setFailed(true)} />
</DialogLayout>
```

三个可直接借用的设计点：

- **图片是一个 renderable**（`<image>` 带 `protocol="auto"`），不是「一段要手动拼的转义序列」——协议选择在组件之下。
- **尺寸来自终端尺寸**（`useTerminalDimensions()`，`height = max(3, rows - 8)`），且 `fit="fit"`（保持纵横比）。
- **失败是一个状态**（`onError → "No preview"`），不是一个静默的黑洞；键位用 `Keymap.createLayer({ mode: "modal" })` 注册，与主界面互斥。

### 4.3 决定草案：我们的三层与单向数据流

```
SessionUpdate（事件/增量）──► view model（纯函数）──► 帧（cell 数组）──► diff ──► stdout
        ▲                                                                              │
        └──────────────── 命令（send / cancel / approval.respond） ◄───────────────────┘
```

| 层 | 位置（草案） | 规则 |
|---|---|---|
| **render** | `frontends/tui/render/`：`cells.ts`（cell 缓冲）、`width.ts`（宽度与切片，唯一一份）、`diff.ts`（行 diff + 绝对寻址）、`screen.ts`（备用屏、光标、SIGINT 恢复） | **纯函数优先**：`cells/width/diff` 不碰 `process`，可单测；只有 `screen.ts` 写 stdout |
| **ui** | `frontends/tui/ui/`：`box`（边框与内边距）、`text`（样式段）、`list`（可滚动选择）、`dialog`（框架）、`input`（行编辑）、`toast`、`status-bar`、`tabs`、`spinner` | **不认识会话与工具**：原语只接收字符串与样式 |
| **components** | `frontends/tui/components/`：`session-frame`（会话帧）、`message`（用户/助手/推理）、`tool-card`（工具调用与其结果，含 `truncation` 提示）、`diff-card`（Edit 的 diff）、`approval-card`（审批）、`todo-panel`（`SessionState.todos`）、`image-preview`（模态）、`command-palette`、`error-card` | **只读 view model**，不订阅内核、不发命令 |
| **app** | `frontends/tui/app/`：`projection.ts`（`KernelEvent` → view model）、`commands.ts`（上行命令）、`keymap.ts`、`screens.ts` | 唯一持有「界面状态」的地方；**没有会话状态的副本**（会话状态只在服务端） |

四条硬规则（写成 ADR 的候选条文）：

1. **TUI 不 import `packages/cowcat/src/kernel/*`**（只 import 协议类型）——由 lint 强制（`01-layers.md` 的 frontends 行已经这么写了，P6 把它变成 `no-restricted-imports` 的一条，与 ADR-009 同一种做法）。
2. **投影是纯函数**：`project(event, previousView) → nextView`。它让「重放一段日志 → 得到同一屏」变成可测的性质，也让 TUI 的重建与内核的 `reduce` 用同一种方式思考。
3. **一帧只有一处写 stdout**（`screen.draw(lines, cursor)`），沿用旧版「绝对寻址、不靠相对移动」的做法（【源码】`agent/src/tui/screen.js:40-62`），理由是整宽行会触发 pending-wrap 滚动、把整帧顶歪。
4. **原语不认识业务**：`ui/` 里出现 `session` / `tool` / `approval` 这些词就是分层被破坏的信号（可加一条 grep 级测试）。

### 4.4 被否决的方案

- **照搬 React/ink 的组件模型**：见 §3.3。
- **一个大 `ui.js` 继续长**：旧版已经长到 82 KB（【源码】），P5 的教训（契约先于实现、一处定义）在这里同样适用——但代价是必须先把 `ui/` 与 `components/` 的边界画出来，否则「三层」只是三个文件。
- **让 TUI 直接 import 内核**（省掉协议）：违反 P6 出口标准第 2 条，且会让「无终端测试」退化成「启动一个真 TUI」。
- **把 view model 放进内核**：内核不该知道「一行有多宽」（`02-kernel.md` 的分层原则；`StreamDelta` 已经是「渲染归前端」的既有裁定）。

---

## 5. 问题四：终端里的图像渲染

### 5.1 三个协议，一个回退

| 协议 | 转义序列 | 关键能力 | 限制 |
|---|---|---|---|
| **kitty graphics** | APC：`ESC _ G <key=value,...>;<base64 payload> ESC \` | `f=32`（RGBA，默认）/`f=24`（RGB）/`f=100`（PNG）；`a=T` 传输+显示、`a=p` 只放置；`i=`/`p=` 图像与放置 id；**Unicode placeholder**（`U=1`）；查询支持用 `a=q` + DA1 | 需要 kitty/支持它的终端（iTerm2 也支持）；远程传输要分块 |
| **iTerm2 inline images** | OSC：`ESC ] 1337 ; File=<key=value,...>:<base64> BEL` | `inline=1`；`width`/`height` 支持 `N`（字符格）/`Npx`/`N%`/`auto`；`preserveAspectRatio`；大图可用 `MultipartFile`/`FilePart`/`FileEnd`（≤1 MB） | **图片不参与文本重排**：终端把它画在屏幕坐标上，滚动/重绘后位置会错 |
| **sixel** | DCS（`ESC P … q`） | 老终端（xterm、mlterm、部分 Windows 终端）也支持 | 尺寸与颜色受限；tmux 下常被吞；【未验证】本机终端是否支持 |

**回退**（没有上述协议时）：把图片降采样成**块元素字符**。opencode 的做法是 `ui/subcell.ts`：一张 **2×4 网格（8 个「子像素」）→ 一个字符**的映射表，用 Unicode 的 octant 码位（`U+1CEA0`…、`U+1FB82`…）与旧的四分之一/半块字符，找不到对应码位时按 `0x1CD00 + mask - 已用个数` 回退。

【实测】本机探针把 `U+1CD00` 这个码位喂给旧版宽度函数，得到 **width=1 / graphemes=1**——即**旧版没有任何 subcell 概念**。同时这也提示一个真实风险：Unicode 16 的 octant 码位**未必有终端字体**（【未验证】，本机无法判断），所以回退方案应当**优先用半块/四分之一块**（`U+2580`…，字体覆盖广），octant 作为「探测到字体支持后」的增强。

### 5.2 kitty 的两个细节值得单独记下来【上游】

1. **分块传输**：base64 后每块 **≤4096 字节**，除最后一块外必须是 4 的倍数；`m=1` 表示「还有」，`m=0` 表示最后一块；**只有第一块带完整控制数据**，后续块只带 `m`（与可选的 `q`）。发送期间**必须**把一张图的所有块发完，否则终端会拒绝。显示位置以**最后一块**到达时的光标位置为准。
2. **Unicode placeholder（`U=1`）**：先用 `a=p,U=1,i=<id>,c=<cols>,r=<rows>` 建一个**虚拟放置**，再用普通文本字符 `U+10EEEE` + 组合变音符编码行列与 id（`U+0305`=0、`U+030D`=1、`U+030E`=2…），前景色编码 image id。**因为占位符就是普通文本**，任何「不认识图片协议」的 TUI 在重绘、滚动、resize 时都会自动把图片搬对位置——这是唯一一个「图片跟随文本布局」的方案。

**这一条直接决定了我们的架构选择**：P6 是**行式重绘**的 TUI（每帧按行写绝对坐标）。iTerm2 的图片挂在屏幕坐标上，一滚动就错位；kitty 的 placeholder 能跟上，但要求终端支持且要求我们把图片渲染成**一段文本**（占位符），而不是一次性的转义序列。于是「图片渲染」在我们的架构里应该是：

```
ImageRenderable：{ source, fit, width, height }
   ├─ kitty 可用 → 传输（分块、q=2 静默）+ 打印 placeholder 文本（参与行布局）
   ├─ iTerm2 可用 → 只在「不滚动」的模态里直接发 OSC 1337（并说明它不参与滚动）
   └─ 都没有     → 半块/四分之一块降采样成文本行（本身就是普通文本）
```

### 5.3 决定草案

1. **P6 只在一处渲染图片：「图像预览」模态**（opencode 的 `dialog-image-preview` 是同一个形态）。理由：工具结果里的内联图片要先把「附件」变成 v2 契约的一部分，而那是 **P7 的契约工作**（P5 的 `Read` 已经因为同一原因显式拒绝了图像/PDF/notebook）。**P6 提前做内联图片会与 P7 冲突。**
2. **抽象先行**：`ui/` 提供 `ImageRenderable` 与能力探测；组件不直接写转义序列（与 §4.2 的 `<image protocol="auto">` 同一种分工）。
3. **探测顺序**：环境变量（`KITTY_WINDOW_ID`、`TERM_PROGRAM=iTerm.app`、`WEZTERM_*`）→ 主动查询（kitty 的 `a=q` + DA1）→ 回退。**查询必须静默**（`q=2`），否则终端的应答会混进输入流，被我们的按键解析当成用户输入——这是本任务最容易踩的一个坑。
4. **降采样用纯 JS**：把 PNG 解到 RGBA 需要解码器。**这是 P6 唯一一个可能需要新依赖的地方**，因此单列一条 ADR：优先「自写一个只支持 PNG 的最小解码器」（PNG 是 deflate + 过滤，Node 自带 `zlib`，**零依赖可做**），若成本过高再评估引入纯 JS 解码器；**不引入原生依赖**（与 §3.2 同一条纪律）。
5. **不做的事**：不做动画 GIF、不做 3D、不做音频（opentui 有，我们不需要）。

### 5.4 安全与稳定

- 图片数据来自用户自己的磁盘（P6 的预览对象是本地文件），**不经网络**；大小上限沿用 P5 的 5 MB 口径（`READ_LARGE_LIMIT`）。
- **写入量要设上限**：一张大图会让一次 `stdout.write` 达到几 MB。分块发送 + 上限（例如 2 MB 原始字节）+ 超过时降级为文本预览。
- **退出时必须清理**：备用屏退出前删除已放置的图片（kitty 有 `a=d` 删除动作），否则图片会留在滚动缓冲里。

### 5.5 被否决的方案

- **所有地方都内联渲染图片**：与 P7 的附件契约冲突（§5.3 第 1 条），且 iTerm2 下会随滚动错位。
- **只做 sixel**：覆盖面最广的假设**未验证**，且尺寸/颜色受限；把它作为回退链的一环而不是唯一方案。
- **依赖 opentui 的 `<image>`**：见 §3.2（Node ≥26.4 + 原生二进制）。
- **把图片转成 ASCII art（纯字符密度）**：颜色全丢；半块/octant 方案用**每个字符两/三个颜色**，信息量高一档，代价只是同一张字符表。

### 5.6 待验证（本文件最重的一项）

1. **本机终端支持哪个协议**：本次 stdout 不是 TTY，`TERM_PROGRAM`/`WT_SESSION`/`KITTY_WINDOW_ID` 全缺（§1），所以**一个都没测**。Windows Terminal 对 sixel/kitty 的支持状况【未验证】。
2. **octant 码位的字体覆盖**：`U+1CD00` 那一块是否在常见等宽字体里有字形——【未验证】，回退方案因此以半块为主。
3. **闪烁与刷新率**：`dev-plan-v2.md:481` 要求的实测没有做（需要真实终端 + 人眼）。
4. **iTerm2 图片与滚动的交互**：协议文档没有承诺图片跟随文本，我们的假设（会错位）是【推断】，需要在 macOS 上确认。

---

## 6. 问题五：CLI 入口与子命令

【源码】旧版 `agent/src/cliargs.js` 的做法是**一张显式的子命令表**，而不是「解析 flag 后到处 `if`」。P6 沿用这个形状：

| 命令 | 作用 | 备注 |
|---|---|---|
| `cowcat` | 进 TUI（默认） | 无参时的行为 |
| `cowcat serve` | headless 协议服务（stdio） | TUI 与 IDE 都连它；也是无终端测试的入口 |
| `cowcat run "<prompt>"` | 一次性回合（非交互） | 脚本与 CI 用；等价于「serve + send + 读事件到结束」 |
| `cowcat doctor` | 逐项检查配置、模型连通性、沙箱后端 | 沿用 v1 的 `doctor.js` 口径（【源码】`agent/src/doctor.js`） |
| `cowcat sessions list / resume <id>` | 会话管理 | 与 `~/.cowcat/` 的日志布局一致 |
| `cowcat setup` | 交互式配置向导 | 沿用 v1 |

决定草案：**子命令是数据**（一张表：名字、摘要、参数 schema、处理函数），帮助文本与补全从表里生成；**不做**嵌套子命令（`cowcat session list` 这种），因为一个只有六个动词的 CLI 不需要两层。

---

## 7. 问题六：没有终端怎么测（P6 出口标准的实现方式）

出口标准有两条：① 用 headless 协议完整跑通一个带工具与审批的回合（**测试中**）；② TUI 中删除任何直接访问内核内部的代码路径（**lint 或测试保证**）。

决定草案（→ ADR）：

1. **协议契约测试**：用内存传输把 `serve` 的处理器与一个测试客户端接起来，跑「打开会话 → 发送输入 → 收到事件 → 回应审批 → 取消」全流程。**不 spawn 子进程**（那是另一条测试：一条就够了，测进程启动与退出码）。
2. **帧快照测试**：`project(event, previous) → view` 是纯函数，于是「喂一段写死的日志 → 得到一屏确定的文本」可以逐字节比对。这是本仓库既有的「golden 比已提交事实」口径（ADR-043）在前端的对应物。
3. **lint 保证第 2 条**：`frontends/**` 禁止 import `packages/cowcat/src/kernel/*` 与 `adapters/*`，只允许协议包；做法与 ADR-009（zod 只在 adapters）完全一致，且用 `tools/lint-probe.mjs` 的同款手法验证「它真的会报错」。
4. **一个可选的开发者工具**：`cowcat serve --replay <log>` 把一份日志按事件时序喂给前端——【上游】opencode 的 `packages/simulation` 与 `protocol/src/simulation.ts` 是同一个思路，我们可以只做「重放」，不做完整模拟器。

---

## 8. 对 P6 四项范围的具体影响

| 范围（`dev-plan-v2.md:486-489`） | 本文件的影响 |
|---|---|
| 1. headless 协议：版本化，覆盖打开/输入/订阅/审批/取消 | 形态定为 JSON-RPC over stdio（§2.4）；方法表在 T1 落表；**协议与传输分开**，为将来的远程客户端留门而不现在开 |
| 2. 协议层的契约测试（不启动真实终端） | 内存传输 + 帧快照（§7）；**帧快照是本阶段新增的测试形态**，需要一条 ADR 说明它比「启动真 TUI」更可靠 |
| 3. TUI 只通过协议工作，不持有会话状态副本 | 三层 + 单向流（§4.3）；`project` 是纯函数；lint 禁止直接 import 内核（§7 第 3 条） |
| 4. `cowcat` 命令行入口 | 子命令表（§6）；`serve` 是协议的服务端，也是测试入口 |

**图片渲染不在 P6 的四项范围里**，是本次调研额外提出的、用户明确要的（「TUI 内的图像渲染你也要调研一下」）。因此它**不阻塞出口标准**，落成一条**独立任务**（见 §9 的 T6），并且**只在预览模态里**实现（§5.3）。

---

## 9. 需要落的文档与 ADR（清单）

| 编号（建议） | 内容 | 落在哪 |
|---|---|---|
| **ADR-055** | headless 协议 = JSON-RPC 2.0 over stdio、`initialize` 版本化、协议与传输分离；**不做 HTTP/SSE/WebSocket** | `architecture/README.md` 表尾 + 新增 `06-frontend.md` |
| **ADR-056** | TUI 自研渲染 + 三层分层（`render/` / `ui/` / `components/`）+ 单向投影；不引入 ink/opentui（含 Node 门槛与原生依赖的理由） | 同上 |
| **ADR-057** | 终端图像渲染：`ImageRenderable` + 三级回退；**P6 只在预览模态渲染**；PNG 解码优先自写（零依赖） | 同上 |
| **ADR-058** | 无终端测试：协议契约测试 + 帧快照；`frontends/` 禁 import 内核的 lint 保证 | 同上 + `tools/lint-probe.mjs` 加一条探针 |
| **ADR-059** | CLI 子命令表是数据；六个动词，不做嵌套 | 同上 |
| **ADR-060**（可选） | 主题与设计 token：颜色语义化（success/warn/danger/muted）、不硬编码色值；`NO_COLOR` 与 256/24bit 降级 | 同上 |

另外要落的文档：**`architecture/06-frontend.md`**（新文件：协议表、前端分层、图像协议矩阵）、`01-layers.md` 的 frontends 行补「只经协议」的实际形状、`dev-plan-v2.md` 的 P6 段补任务表。

---

## 10. 任务拆分（草案，T0 落表时定稿）

| 任务 | 内容 | 依赖 |
|---|---|---|
| T0 | 决定落表：ADR-055~059（+060）进 ADR 表；新增 `06-frontend.md`；P6 段补任务表 | 本文件评审通过 |
| T1 | **协议**：方法表 + 类型（zod 解码边界）+ 内存传输 + 契约测试（打开/输入/事件/审批/取消） | T0 |
| T2 | **`serve` 子进程**：stdio 传输、生命周期、`initialize` 版本协商、一条 spawn 测试 | T1 |
| T3 | **CLI 入口**：子命令表、帮助文本、`doctor` 的最小版本（复用 P5 的配置与 profile 解析） | T1 |
| T4 | **渲染底座**：`render/`（cells/width/diff/screen），修 `RANGES_EMOJI` 排序缺陷，宽度语料测试；备用屏与 SIGINT 恢复 | T0 |
| T5 | **`ui/` 原语**：box / text / list / dialog / input / toast / status-bar / tabs / spinner | T4 |
| T6 | **`components/` 与投影**：`project()` 纯函数 + session-frame / message / tool-card / approval-card / todo-panel / diff-card；帧快照测试 | T5 |
| T7 | **图像预览（模态）**：能力探测 + kitty 分块与 placeholder + iTerm2 直发 + 半块回退 + PNG 最小解码器 | T6 |
| T8 | 收口：出口标准复核（协议回合测试 + lint 禁 import 的探针）、真实终端上的刷新率/闪烁记录（**需要人眼**）、`06-frontend.md` 定稿 | T1–T7 |

---

## 11. 附录 A：opencode TUI 的证据（体积与清单）

【上游】`packages/tui/src/`（`dev` 分支，2026-10-19 读取）：

- 顶层：`app.tsx`（**52 KB**）、`attention.ts`、`audio.ts`、`clipboard.ts`、`editor.ts`、`logo.ts`、`model-preference.ts`、`parsers-config.ts`（16 KB）、`runtime.tsx`
- `component/`（**51 个条目**，含一个 `prompt/` 子目录）里与本任务直接相关的：`session-frame.tsx`（15 KB）、`session-tabs.tsx`（**75 KB**）、`patch-diff.tsx`（9 KB）、`terminal-pane.tsx`（13 KB）、`dialog-image-preview.tsx`（2.9 KB）、`error-component.tsx`（9.5 KB）、`spinner.tsx`、`shimmer-text.tsx`、`fade-in-text.tsx`、`one-cell-spinner.tsx`、`panel-host.tsx`
- `ui/`（**21 个文件**）：`dialog.tsx`（15 KB）、`dialog-select.tsx`（31 KB）、`dialog-confirm/prompt/help/alert`、`toast.tsx`、`layout.ts`、`border.ts`、`link.tsx`、`file-path.tsx`、`spinner.ts`（12 KB）、`animation.ts`、`subcell.ts`、`pane-resize*.ts`、`select-controller.ts`、`one-cell-motion.ts`、`working-directory-actions.tsx`、`dialog-export-*`
- 依赖（`package.json`）：`@opentui/core`、`@opentui/keymap`、`@opentui/solid`、`solid-js`、`effect`、`fuzzysort`、`get-east-asian-width`、`string-width`、`strip-ansi`、`uqr`、`opentui-spinner`、`@solid-primitives/event-bus`、`remeda`

**读出来的取舍**：它愿意为「一个 75 KB 的会话标签组件」与「native 渲染核心」付出体积与依赖，因为它要同时支撑 TUI / 桌面 / Web。我们的对应选择见 §3.4。

## 12. 附录 B：本仓库相关文件的现状

| 文件 | 体积 | 现状 |
|---|---|---|
| `agent/src/tui/ui.js` | 82 KB | 单文件包含布局、键位、渲染与会话展示（分层理由的反面教材） |
| `agent/src/tui/render.js` | 16 KB | 渲染 |
| `agent/src/tui/region.js` | 8.4 KB | 区域刷新 |
| `agent/src/tui/screen.js` | 2.6 KB | 备用屏 + 行 diff + 绝对寻址（**直接可迁移**） |
| `agent/src/tui/wcwidth.js` | 2.7 KB | grapheme-aware（方向正确，**表有缺陷**，见 §0 发现 2） |
| `agent/src/tui/capabilities.js` | 1.1 KB | 纯函数能力探测（**直接可迁移**，P6 需要扩展成含图片协议探测） |
| `agent/src/tui/` 其余 15 个文件 | — | 键位、补全、对话框、主题、侧栏、toast、markdown、高亮等，逐个评估复用 |

## 13. 附录 C：上游链接

- opencode TUI：<https://github.com/anomalyco/opencode/tree/dev/packages/tui>（`AGENTS.md`、`package.json`、`src/component`、`src/ui`、`src/simulation`）
- opencode 协议与模拟：`packages/protocol/src/{api,client,errors,simulation}.ts`、`packages/simulation`
- opentui：<https://github.com/anomalyco/opentui>（`packages/core/package.json` 的 `engines` 与 `optionalDependencies`）
- kitty graphics protocol：<https://sw.kovidgoyal.net/kitty/graphics-protocol/>（分块、`f=`、`a=`、Unicode placeholder、查询）
- iTerm2 inline images：<https://iterm2.com/documentation-images.html>（`OSC 1337`、`width/height` 单位、`inline`、分片、Feature Reporting）
