# CowCat TUI 全面升级设计方案（对标 Claude Code 质感）

日期：2026-10-14 · 状态：待审批 · 依据：三路调研（Claude Code 逆向规格书 / CowCat 现状审计 / 主流 CLI 网络调研）

## 1. 意图与为什么

用户要求把 CowCat 的全屏 TUI 从"能用"提升到 Claude Code 的观感水准。调研确认差距不是单一功能点，而是四层叠加：转录区无 markdown 渲染/代码高亮、工具卡片与审批流信息缺失、配色碎片化无主题系统、输入交互缺失基础键位与补全；同时底层渲染架构（10fps 全量重绘、无宽度测量、无帧 diff）会在视觉升级后直接暴露性能问题。

**为什么值得做**：TUI 是用户与 agent 相处 90% 时间的界面；Claude Code 的界面质感来自统一设计 token + 成熟渲染管线，这套设计语言已被逆向确认为可实现、可原创复刻（不照抄代码，只复刻设计规格）。

## 2. 目标 / 非目标 / 反目标

**目标**
1. 转录区：markdown 块渲染（标题/加粗/斜体/列表/引用/表格/分隔线/行内代码/链接）+ 围栏代码块语法高亮（js/ts/py/sh/json/md 六语言正则词法），流式宽容解析 + 纯文本快路径。
2. 视觉语言对齐 Claude Code：用户消息气泡（底色块 + `›` 指针）、工具块 `⏺` 符号列（运行 dim/成功绿/失败红）、回合时长页脚 `✻ for 2m`、审批卡圆角框 permission 蓝。
3. 统一语义色 token 系统（dark/light 两套，单一来源），TUI 与行模式共用，`/theme` 在 TUI 生效。
4. 审批卡补齐 diff 预览（当前 TuiUI 丢弃 preview 参数，是全屏模式最大能力缺口）。
5. 输入交互：光标移动（←→/Home/End）、Ctrl+W/U/K、TUI 内 Tab/@-补全真正接线、多行框体验。
6. 性能地基：字素簇宽度测量（Intl.Segmenter + East Asian Width 表）、逐 entry 渲染缓存、帧 diff 渲染（只重写变更行）、能力探测与降级（truecolor/256/16 色）。

**非目标（本批次不做）**
- 鼠标支持与选区、IME 预编辑、vim 键位、cell 打包 60fps 引擎（Claude Code 的 Int32Array 双缓冲方案留作后续阶段）。
- 行模式 UI 的 markdown 渲染（行模式保持纯文本滚动打印，保证管道/CI 输出干净；只统一它的配色 token）。

**反目标**
- 不引入任何运行时第三方依赖（保持零依赖分发优势）；不照抄 Claude Code 代码，只复刻设计规格（配色值、符号系统、布局规则属于功能性事实）。
- 不破坏降级保证：非 TTY / `-p` / `stream-json` / `NO_COLOR` / `COWCAT_TUI=off` 行为完全不变（现有测试锁定）。
- 测试基线 199 全绿不能回归；每个阶段跑全量。

## 3. 约束

- Node ≥ 20，ESM，纯 ANSI（无 ink/bubbletea 类依赖）；Windows 为首要目标平台（用户在 Windows Terminal/PowerShell），需兼容经典 conhost（VT 能力探测 + 降级）。
- 渲染帧成本预算：流式期间单帧 < 8ms（120 行 × 200 列窗口），通过缓存 + 帧 diff 保证。
- 宽字符正确性优先于一切对齐装饰：CJK/emoji 混排对齐不能漂移。

## 4. Claude Code 设计规格摘录（复刻基准）

来源：`analysis/cli-2.1.55.pretty.js` 行号可查证；标注"推断"的项为合理推测。

**配色 token（dark 主题核心值）**：品牌橙 claude rgb(215,119,87)；交互蓝 permission rgb(177,185,249)（审批框边框/行内代码/链接强调）；边框灰 promptBorder rgb(136,136,136)；正文白；inactive rgb(153,153,153)；subtle rgb(80,80,80)；success rgb(78,186,101) / error rgb(255,107,128) / warning rgb(255,193,7)；Bash 粉 bashBorder rgb(253,93,177)；用户气泡底 rgb(55,55,55)；plan 模式青绿 rgb(72,150,140)；autoAccept 紫 rgb(175,135,255)；diff 深绿底/深红底 + 亮绿/亮红字。6 套主题（含色盲友好与 ANSI-only 降级），约 40 个语义 token。

**转录组件**：用户消息 = 不换行气泡（底 userMessageBackground，前缀 subtle `›`，宽 columns-4，折行续行对齐）；工具块行首 `⏺`（minWidth:2 对齐列），运行中 dim、错误红、成功绿，右侧 space-between；Bash 输入预览 `!` 粉色 + 气泡底；回合页脚 dim `✻ for 2m`；错误块 `✗` 前缀；折叠提示 `· enter to collapse`。

**Markdown 管线**：marked → highlight.js 逐行高亮 → hljs class 查色表转 ANSI。代码块**无背景色/无行号/无语言标签**（语言只选高亮器）；行内代码 permission 蓝；blockquote dim+斜体；H1 bold+italic+underline、H2+ bold；列表每级 2 空格缩进；表格按最大列宽对齐；链接 OSC 8 超链接 + 蓝字（不支持 OSC8 的终端退化为纯文本）。

**输入与审批**：输入框 round 圆角边框 `╭─╮│╯─╰` + permission 蓝边框 + 左右 padding 1 + marginY 1；提示符 `›`；审批弹窗圆角 permission 边框 + 选项纵向列表（Yes/Yes always/No 三档）。

**布局与动画**：无打字机（流式重渲染自然形成）；spinner 自定义 4 帧 150ms 黄；光标 600ms 闪烁；宽度截断 truncate-end、折行 wrapAnsi。

## 5. CowCat 现状关键事实（审计结论）

- 渲染管线：entries(text/card/stream) → `_flat()` 每帧全量重 wrap → buildScreen → Screen.draw 整帧 write；10fps 强制 tick；无任何缓存。
- 配色碎片化：6 处硬编码调色板；TuiUI.setTheme 是空函数（TUI 完全绕过主题系统）。
- 宽度测量：visibleLen 仅剥 ANSI 后 .length，CJK/emoji 全按 1 计 → 对齐必然漂移。
- 文本跨行样式会丢失（stripFirstChars 只保留行首 pending 序列）。
- TuiUI.approve() 丢弃 preview/group 参数 → 全屏模式无 diff 预览卡。
- TuiUI 的 Tab/@ 补全字段存在但从未接线 → 全屏模式补全不可用。
- LineEditor 只有追加/退格，无光标移动与编辑快捷键。
- 两套 UI 能力不对齐：diffcard/outputcard 只在行模式生效。

## 6. 实施架构（how）

**新增模块（全部零依赖自研）**
1. `src/tui/wcwidth.js`（~120 行）：`Intl.Segmenter(grapheme)` 字素切分 + 烘焙 EAW W/F 与 emoji 范围表二分查找定宽；返回每字素宽度。替换 render.js/ui.js 所有 `.length` 测量点。
2. `src/tui/capabilities.js`（~150 行）：TTY/CI/NO_COLOR 检测；COLORTERM/WT_SESSION/TERM_PROGRAM 判断 truecolor 能力 → 输出 24bit/256/16 色三档调色板；OSC8/备用屏能力标志。
3. `src/tui/theme.js`（~200 行）：语义 token 单一来源（对齐 §4 的 dark/light 值，xterm-256 近似 + 24bit 精确双档输出）；行模式 UI 的调色板也改为从它派生。
4. `src/tui/markdown.js`（~700 行）：流式增量块解析（段落/ATX 标题/无序有序列表/引用/围栏代码/表格/hr），状态跨 chunk 保留；纯文本正则快路径；输出"预渲染行块"（带 ANSI 的字符串数组 + 每行可见宽度缓存）。
5. `src/tui/highlight.js`（~600 行核心 + 每语言 30-80 行规则）：逐行正则词法 tokenizer（有限状态处理块注释/字符串跨行），token→主题色映射；六语言先行的规则表；**高亮产物视为不透明 ANSI 块缓存，永不重解析**。
6. 渲染缓存改造（`tui/ui.js` + `render.js`）：每个 entry 持有预渲染行缓存（markdown 块只在内容增长/宽度变化时重排）；stream 条目只重排末块；`_flat()` 退化为缓存拼接 + 窗口裁剪。
7. `src/tui/screendiff.js`（~200 行）：Screen.draw 改为与上帧逐行比较，仅重写变更行（`\x1b[<n>A` 上移 + 行写入）；重绘改为事件驱动（键入/流式 chunk/滚动/spinner tick 各自触发），删除 10fps 强制 tick 或降为仅 spinner 区域。

**改造点**
- `TuiUI.approve()` 接通 preview/group → 复用行模式 renderFileCard/renderGroup 的渲染器生成 diff 预览行。
- `LineEditor` 升级：光标移动/Home/End/Ctrl+W/U/K/删除键；TuiUI 键分发表补全。
- Tab/@ 补全接线：TuiUI 构造传入 completions/fileCompletions 回调（行模式 REPL 已有逻辑可复用）。
- 输入框改 round 边框 + permission 色 + placeholder + margin；状态栏加 `? for shortcuts` / shift+tab 提示。
- 审批卡视觉：圆角框 + 三档选项文案对齐原版语义（Yes / Yes, and always allow / No, and tell what to do differently）。

## 7. 阶段划分（每阶段 = 实现 + 测试 + changelog + 全量测试绿）

- **W1 性能与正确性地基**：wcwidth + capabilities + screendiff + entry 渲染缓存 + theme.js 单一来源（含行模式接入）。风险最高、收益最大（后续一切的地基）。
- **W2 转录区渲染**：markdown.js + highlight.js + 消息气泡 + 工具块视觉（⏺ 列/状态色/回合页脚）+ 链接/引用/表格。
- **W3 交互与卡片**：审批 diff 预览卡、输入框升级 + 键位 + 补全接线、状态栏与提示、折叠/展开键位。

依赖顺序：W2/W3 都建立在 W1 的缓存与宽度测量上。W2 与 W3 内部可再拆并行子任务。

## 8. 留给构建者的决定（构建者评审后的裁定，均已在 §10 记录）

## 9. 验收标准

（第 5 条"逐字节一致"范围澄清：仅约束**非 TTY** 输出——CI/管道/stream-json 的输出去装饰后与 v0.9.0 完全一致；TTY 下的 `-p` 彩色输出允许因调色板统一而产生 ANSI 差异。）

## 10. 构建者评审裁定（2026-10-14，6 个问题的决定）

1. **用户消息气泡的入口**：新增鸭子接口方法 `ui.userMessage(text)`，由 bin 的 REPL 在提交后调用。TuiUI 实现为气泡；行模式 UI 实现为空操作（终端已有回显，避免重复打印）。同步加到 MockUI（如存在）与 ui.js 的 UI 类；不碰 readLine/readSecret 内部记录（杜绝密钥泄漏进转录）。
2. **/theme 与缓存**：entry 缓存存**可重渲染源**（条目 kind + 原始文本/块 AST），主题在物化（materialize）时应用。`/theme` 切换后全部历史 entry 标记脏、一次性重渲染（块已预解析，成本为一次配色重映射，可接受）。TUI 启动读 `config.theme`，`/theme` 继续走 `saveTheme` 持久化。
3. **验收第 5 条范围**：见 §9 括注——仅非 TTY 逐字节一致。
4. **审批交互模型**：保持单键 y/n/a 即时生效（与 Claude Code 一致、与现有测试一致）；审批卡视觉升级为圆角 permission 框 + 三档文案展示，但不是焦点模态——滚动等全局键在审批 pending 时保持可用。
5. **markdown 渲染的 entry 范围**：仅 `stream`（助手散文）与 `user`（用户消息）两类走 markdown 渲染；`print()` 保持 raw 快路径（thinking 卡、/cost 表格、diff/bash 卡等预 styled 内容不被 markdown 破坏）。
6. **补全候选来源**：在 bin 定义规范的斜杠命令清单 API（静态内建命令 + 动态可用命令合并），作为 `completions` 回调注入 TuiUI；`completeFiles`（mention.js）用于 @ 补全。修正设计原文"行模式已有逻辑可复用"的表述——实际只有 completeFiles 可复用，命令清单是新建 API。

**原构建者自由裁量项（不变）**：语法高亮首版覆盖 js/ts/py/sh/json/md 六语言；xterm-256 近似优先、24bit 仅 COLORTERM 时启用；表格最小列宽 3 按内容对齐；未闭合 fence 立即按 fence 渲染。

1. 交互模式启动后：用户消息带气泡区分、助手输出 markdown 结构完整（标题/列表/代码块高亮）、工具块 ⏺ 状态色正确、审批卡含 diff 预览。
2. CJK 与 emoji 混排下所有边框/卡片/状态栏对齐不漂移。
3. 流式输出期间 CPU 占用与帧率稳定（无肉眼可见闪烁；resize 不重排历史缓存）。
4. `node --test 'test/**/*.test.mjs'` 全绿（含新增的渲染单元测试与既有降级保证测试）。
5. 管道/CI/`-p`/stream-json 输出与 v0.9.0 逐字节一致（装饰零泄漏）。
