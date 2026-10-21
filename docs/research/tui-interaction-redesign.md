# TUI 交互与显示重构调研（2026-10-21）

> 触发原因：beta 使用反馈五条——思考不流式、卡片不在固定位置、状态信息少且动画单一、滚轮显示异常、`/` 没有弹出提示。
> 本文只做调研与方案，**不改源码、不改 ADR**（工作规则 3）。

## 0. 证据约定

- 【上游】官方文档或上游源码（附链接）
- 【源码】本仓库实现（附文件:行号）
- 【实测】本机验证
- 【推断】未验证的设计判断，不作为决策依据

## 1. 参考对象

| 产品 | 主要参考 | 取到的材料 |
|---|---|---|
| Claude Code | 固定输入区、`/` 菜单、权限对话框、全屏滚动、鼠标 | `code.claude.com/docs/en/interactive-mode`、`/fullscreen`、`/permissions`【上游】 |
| Codex CLI | 思考流式、状态栏、审批键位、`/` 弹层 | Context7 `/openai/codex`，直接摘 `codex-rs/tui` 源码【上游】 |
| Gemini CLI | 快捷键体系、数字选项、TODO/后台面板、鼠标开关 | `geminicli.com/docs/reference/commands`、`/keyboard-shortcuts`【上游】 |
| OpenCode | `/thinking`、`/sessions`、命令面板、鼠标配置 | `opencode.ai/docs/tui`【上游】 |

## 2. 横向对比（只列与反馈相关的六项）

### 2.1 思考（reasoning）

- **Codex**：思考增量进来时，用最后一行非空文本更新**状态指示器的标题**（`latest_summary_line`），也就是思考期间屏幕上是「活的」；完成的思考块以 dim+italic、`• ` 前缀进入 transcript，且 `transcript_only` 让摘要**默认不进主视图**，只在 `Ctrl+T` 的 transcript 里可见；`/raw` 可切换原始思考【上游：`chatwidget/streaming.rs`、`history_cell/messages.rs`、`slash_command.rs`】。
- **OpenCode**：`/thinking` 只控制思考块**显示与否**，不改变模型是否思考【上游】。
- **Claude Code**：`Interactive mode` 有 `Option+T`（切换 extended thinking）与 `Ctrl+O`（transcript 里展开默认折叠的内容）【上游】。
- **Gemini CLI**：`Ctrl+O` 展开/折叠内容块；`Ctrl+T` 展开完整 TODO【上游】。

**结论**：成熟实现都区分「思考进行中」与「思考已完成」。进行中给实时反馈（一行摘要或流式文本），完成后折叠，展开是显式动作。

### 2.2 底部固定区

- **Claude Code** 全屏渲染：「input box stays fixed at the bottom of the screen instead of moving as output streams in」；权限提示、选择菜单、TODO 清单都在固定区域/对话框，不随 transcript 滚动【上游：fullscreen、permissions】。
- **Gemini CLI**：`?` 在空输入时打开**输入框上方**的快捷键面板；TODO 用 `Ctrl+T` 切换完整列表【上游】。
- **Codex**：审批是 modal；底部有 status indicator 与 composer【上游】。

**结论**：审批、待办、子 agent、命令菜单属于「当前决策所需」，必须固定在输入框上方；transcript 只放历史。

### 2.3 状态栏

- **Codex**：`/statusline` 让用户配置显示项；状态指示器有活标题（思考摘要/动作）【上游】。
- **Gemini CLI**：底部 footer 显示 vim 模式等；Todo/后台 shell 各有独立区域【上游】。
- **OpenCode**：主题、leader 键、滚动速度、鼠标开关可配【上游】。

**结论**：状态栏是可配置的「仪表盘」，不是一句话。

### 2.4 滚动

- **Claude Code**：`PgUp/PgDn` 半屏、`Ctrl+Home` 顶部、`Ctrl+End` 回到底部并**恢复 auto-follow**；向上滚会**暂停 auto-follow**，底部浮出 `Jump to bottom`，有新输出时显示 `N new messages`；顶部有一行 dim 的「最近滚出屏幕的 prompt」可点击跳回；鼠标滚轮一次几行，`CLAUDE_CODE_SCROLL_SPEED` 可调，另有加速开关；鼠标捕获可整体关闭以保留终端原生选择【上游：fullscreen】。

**结论**：滚动的核心不是「位移」，而是 **auto-follow 状态机**（跟随 / 暂停 / 恢复）与可见的回底入口。

### 2.5 `/` 命令

- **Claude Code**：输入 `/` 打开列表；列表打开时**默认不高亮**，所以 Enter 仍然是发送；`Tab` 插入第一条；方向键选中后 Enter 接受。输入中途（空格后）也补全【上游：interactive-mode#commands】。
- **Codex**：`/` 打开 command popup，`Tab` 自动补全【上游：tooltips】。
- **Gemini CLI**：补全有 `suggest.accept`（Tab/Enter）、`suggest.focusPrevious/Next`（↑↓/Ctrl+P/N）【上游】。
- **OpenCode**：`/` 加命令名执行；`Ctrl+P` 命令面板【上游】。

**结论**：必须是**可选中列表**，不是 placeholder 文案；Enter 的语义要明确（列表未选中时仍发送原文本）。

### 2.6 审批与鼠标

- **Claude Code**：权限提示列出多个选项（Yes / Yes, and don't ask again for: `<命令>` / Yes, switch to auto / No），`Tab` 可加备注，`Esc` 取消；全屏模式支持点击选项、滚轮滚动列表；鼠标捕获会**牺牲终端原生选择**，可用环境变量关闭【上游：permissions、fullscreen】。
- **Codex**：审批 modal 键位 `y`(approve) / `a`(session) / `p`(prefix) / `d`(deny) / `n`(decline) / `c`(cancel)【上游：keymap.rs】。
- **Gemini CLI**：选择对话框支持**数字键 1–9 直接跳选并确认**；`Ctrl+S` 切换鼠标模式【上游】。

**结论**：审批是「多选项 + 明确作用域 + 键盘/鼠标都可用」，数字键是低成本的加分项。

## 3. 我们的现状与根因

### 3.1 思考不流式

- **内核已经收到 reasoning 分片**：`run-turn.ts:407` 的 `case 'reasoning'` 只把它们累进数组，等到 `model.message` 才落盘【源码】。
- OpenAI 适配器已按段 yield `type: 'reasoning'`（`model-openai.ts:320`）【源码】。
- TUI 只能从最终事件里拿到 reasoning，所以「完成后才出现」是必然结果。

### 3.2 卡片位置

- `session-frame.ts` 把待办面板、命令面板**追加进 body（transcript 流）**；审批卡也由 `transcript.ts` 追加在流末尾【源码】。
- 于是滚动时它们会移出屏幕，且出现顺序受历史长度影响。

### 3.3 状态信息

- `status-bar.ts` 只拼「会话 id · 状态词 · 待办 · 用量」；文件顶部注释明确写着**模型名没有来源**（日志不记）【源码】。
- 动画只有一个 braille 循环，所有运行态共用一句话。

### 3.4 滚轮的根因（最确定的一条）

- `run.ts:420` 的 `createCliRenderer({...})` **没有传 `useMouse`**；opentui 的 `CliRendererConfig` 里 `useMouse?: boolean`，未开启时鼠标事件不会被派发【源码 + 上游类型定义 `renderer.d.ts:52`】。
- 也就是说之前实现的 `onMouseScroll` / `onMouseDown` **从未被触发**，不是坐标算错。
- 另外滚动只有 `scrollOffset` 位移，没有 auto-follow 状态，也没有「回到底部」入口。

### 3.5 `/` 提示

- `session-frame.ts` 的 `slashHint()` 只是把匹配命令拼进 **input placeholder**；既不可选，也不接管 Enter【源码】。

## 4. 目标布局

```
┌─ CowCat ─────────────────────────────────────────────┐
│ transcript（可滚动，auto-follow）                     │
│                                                      │
│                                                      │
├─ dock（固定，最高 40% 高度）──────────────────────────┤
│ 审批卡 / 命令菜单 / 子 agent 列表 / 待办（折叠一行）    │
├─ status（一行可配置仪表盘）───────────────────────────┤
│ ⠋ 执行 Bash · glm-5.3 · ctx 42% · 12s · 子 agent 1    │
├─ composer ───────────────────────────────────────────┤
│ › 输入…                                              │
└──────────────────────────────────────────────────────┘
```

dock 的优先级（同一时刻只显示最高优先级的一组）：

1. 审批（必须回答才能继续）
2. `/` 命令菜单（正在输入）
3. 子 agent（运行中）
4. 待办（折叠成一行，`/todos` 展开）

## 5. 设计决策草案

| 编号 | 决策 | 依据 |
|---|---|---|
| D1 | 思考增量走**ephemeral** `reasoning.delta`，不落盘；完成时由 `model.message` 提供最终块 | 与 `model.delta` 同构，日志仍然只有事实【源码：SessionUpdate 已有 ephemeral 先例】 |
| D2 | 思考进行中在 transcript 末尾显示最近 N 行（默认 6），完成后**自动折叠**为 `▸ 思考 · 12s · 3 段` | Codex 的活标题 + 完成后折叠【上游】 |
| D3 | 审批/待办/子 agent/命令菜单进 dock，不追加进 transcript | Claude Code 固定底部区【上游】 |
| D4 | 状态栏分段：`动作 · 模型 · 上下文 · 用时 · 子 agent`，可配置显示项 | Codex `/statusline`【上游】 |
| D5 | 模型名进日志：`turn.opened` 增加 `model` 字段（契约变更，需 ADR） | 现在没有来源，只能造假【源码】 |
| D6 | 滚动实现 auto-follow 状态机：向上滚暂停、新输出累计、`Ctrl+End` 或点击回底恢复 | Claude Code【上游】 |
| D7 | 鼠标默认开启 `useMouse: true`，`COWCAT_MOUSE=off` 关闭以保留终端原生选择 | OpenCode 默认 true、Claude Code 可关【上游】 |
| D8 | `/` 菜单在 dock 里渲染，`↑↓` 选择、`Tab`/`Enter` 接受、`Esc` 关闭；未选中时 Enter 仍发送文本 | Claude Code/Codex/Gemini 一致行为【上游】 |
| D9 | 审批选项加数字前缀（1–4），数字键直接提交 | Gemini 数字选择【上游】 |
| D10 | 动画按阶段区分（思考/输出/工具/审批），空闲不重绘 | 现有 spinner 例外沿用 ADR-096 |

## 6. 实施计划（按依赖排序）

**PR 1｜先修「不生效」**
- `createCliRenderer({ useMouse: true })` + `COWCAT_MOUSE=off`
- 验证：Windows Terminal 里滚轮与点击真的触发（当前完全没触发）

**PR 2｜思考流式 + 自动折叠**
- 协议：`delta` 通知容忍 `reasoning.delta`
- 内核：`Session.reasoningDelta()`；`run-turn` 在 `case 'reasoning'` 里发出
- TUI：`view.reasoningStream`，进行中显示尾部；`model.message` 到达时清空并折叠
- 测试：内核事件顺序、TUI 投影与折叠

**PR 3｜dock 布局**
- `frameOf` 拆成 `body/dock/status/composer` 四段；dock 有最大高度与优先级
- 审批卡、待办、子 agent 面板从 transcript 移到 dock
- golden frames 全量重做（这次是预期内的布局变更）
- 需同步 ADR-097（原「追加进流」的决定被推翻）

**PR 4｜`/` 菜单与状态栏**
- 命令菜单进 dock：过滤、`↑↓`、`Tab`/`Enter`、`Esc`、鼠标点击
- 状态栏分段：动作、模型（依赖 D5）、上下文百分比、用时、子 agent 数
- `turn.opened` 增加 `model`（ADR），或退一步由 host 在 `session.open` 返回模型

**PR 5｜滚动状态机与打磨**
- auto-follow 暂停/恢复、`Jump to bottom` 与「N 条新输出」
- `PgUp/PgDn` 半屏、`Ctrl+End`、`Ctrl+Home`
- 滚动速度配置；dock 出现时 transcript 自动让位

## 7. 验收

- 五项反馈逐条对照：思考可见流式且结束自动折叠；四类卡片固定；状态栏有模型/上下文/用时；滚轮可用且有回底入口；`/` 是可选列表
- 至少两个终端人眼验证：Windows Terminal、iTerm2/Terminal.app
- 单元与 golden frame 覆盖布局与折叠，不替代人眼

## 8. 风险与未决- **鼠标捕获 vs 原生选择**：默认开启会破坏终端复制；需要 `COWCAT_MOUSE=off` 并在 README 写明（Claude Code 同样取舍）。
- **dock 挤压 transcript**：小终端（24 行）下审批卡 + 待办 + composer 可能占满；需要最大高度与「审批优先」策略。
- **模型名来源**（D5）是契约变更，必须先定 ADR，不能前端猜。
- **思考流式的成本**：ephemeral 不落盘，断线重连后只能看到最终块；这与「日志是事实」一致，但要在文档里说清。
- 本文没有实测任何上游产品，只读文档与源码；截图类结论需人眼确认。

## 9. 决策结果（2026-10-21）

用户确认：

- **D5 模型名**：选 A——`turn.opened` 增加 `model` 字段（需要 ADR，随 PR 4 落地）。
- **D7 鼠标默认**：选 A——默认开启，`COWCAT_MOUSE=off` 关闭。

已按此顺序开工：PR 1（鼠标生效）与 PR 2（思考流式）合并为 ADR-098；dock 布局、`/` 菜单与状态栏、滚动状态机仍按 §6 推进。
