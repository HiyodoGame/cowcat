# CowCat TUI 全面升级实施计划（W1 地基 → W2 转录渲染 → W3 交互）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 CowCat 全屏 TUI 从纯文本四区布局升级为对标 Claude Code 观感的渲染质量（markdown 渲染、代码高亮、语义色系统、气泡/卡片视觉、完整输入交互），同时重建性能地基。

**Architecture:** 零依赖纯 ANSI。新增五个自研模块（wcwidth/capabilities/theme/markdown/highlight）+ 渲染缓存与帧 diff 改造现有 entries→_flat→buildScreen→Screen.draw 管线；三波递进，每波全量测试绿后进下一波。

**Tech Stack:** Node ≥20 ESM，无第三方依赖；测试 `node --test`。

**Spec:** `docs/superpowers/specs/2026-10-14-tui-redesign-design.md`（§10 的 6 条裁定是本计划的一部分）

## Global Constraints

- 零新增运行时依赖；所有新模块在 `agent/src/tui/` 下。
- 非 TTY / `-p` / `stream-json` / `NO_COLOR` / `COWCAT_TUI=off` 输出与 v0.9.0 逐字节一致（装饰零泄漏；既有降级测试必须原样通过）。
- TTY `-p` 允许因调色板统一出现 ANSI 差异（spec §9 括注）。
- 工作目录不是 git 仓库：不做 commit 步骤，每个 Task 的收尾验证 = 全量测试 `cd agent && node --test 'test/**/*.test.mjs'` 全绿。
- 测试基线 199；完成时目标 ≥ 230。
- 配色 token 值以 spec §4 表为准（dark 主题）；256 色近似优先，24bit 仅 `COLORTERM=truecolor` 时启用。
- 代码/注释风格与现有模块一致；不加解释性废话注释。

## Review Focus（规格隐含但易漏的输入/失败模式）

1. **CJK/emoji 混排对齐**——中文全角、emoji ZWJ 簇（👨‍👩‍👧 宽 2 不是 6）、组合符宽 0；现有 `.length` 测量全部漂移。→ Task 1/4 测试锁定。
2. **resize 后缓存失效**——终端宽度变化时全部 entry 重排但历史 markdown 块不得重新解析。→ Task 4 测试。
3. **流式 chunk 边界**——markdown 标记/grapheme 被切成两半（``` 跨 chunk、粗体标记跨 chunk）。→ Task 6 测试。
4. **未闭合围栏代码块**——流式中 fence 未闭合时必须立即按代码块渲染已收内容。→ Task 6 测试。
5. **`print()` 预 styled 内容不被 markdown 破坏**——/cost 表格、thinking 卡、diff 卡原样输出。→ Task 8 测试。
6. **审批 pending 时流式/滚动仍可用**——单键 y/n/a 即时生效，不是焦点模态。→ Task 9 测试 + 既有测试不得回归。

---

## W1 — 性能与正确性地基

### Task 1: 字素簇宽度测量 `wcwidth.js`

**Files:**
- Create: `agent/src/tui/wcwidth.js`
- Test: `agent/test/w1-wcwidth.test.mjs`

**Interfaces:**
- Produces:
  - `graphemes(s: string): string[]` — `Intl.Segmenter('und', { granularity: 'grapheme' })` 切簇
  - `charWidth(ch: string): number` — EAW W/F 或 emoji 范围 → 2；组合符/Mn 类 → 0；其余 → 1（烘焙范围表 + 二分查找）
  - `stringWidth(s: string): number` — 对各 grapheme 求和（输入须已剥 ANSI，调用方负责）
  - `sliceWidth(s: string, maxWidth: number): { text: string, rest: string }` — 按宽度切，不劈开宽字符

- [ ] **Step 1: 写失败测试** `agent/test/w1-wcwidth.test.mjs`
  断言：`stringWidth('abc')===3`；`stringWidth('中文')===4`；`stringWidth('a👍b')===4`；`stringWidth('👨‍👩‍👧')===2`（单簇）；`stringWidth('e\u0301')===1`（e+组合符）；`stringWidth('⠋')===1`（盲文）；`sliceWidth('中文x', 3)` 返回 `{text:'中文', rest:'x'}`。
- [ ] **Step 2: 跑测试确认失败** `cd agent && node --test test/w1-wcwidth.test.mjs` → 模块不存在 FAIL
- [ ] **Step 3: 实现** `agent/src/tui/wcwidth.js` 按 Interfaces 签名。EAW W/F 与 emoji 范围数据烘焙为两个有序数组 `RANGES_WIDE`、`RANGES_EMOJI`（含常见区段：1100-115F、2E80-A4CF、AC00-D7A3、F900-FAFF、FE30-FE6F、FF00-FF60、FFE0-FFE6、1F300-1F64F、1F900-1F9FF、2600-26FF、2700-27BF 等）；`charWidth` 先查宽表再查 emoji 表，组合符用 `\p{Mn}|\p{Me}|\p{Mc}`（`/u`）判 0。用 `Intl.Segmenter`，不可用时退化逐 codepoint。
- [ ] **Step 4: 跑测试确认通过** → PASS
- [ ] **Step 5: 全量验证** `node --test 'test/**/*.test.mjs'` → 199 全绿

### Task 2: 终端能力探测 `capabilities.js`

**Files:**
- Create: `agent/src/tui/capabilities.js`
- Test: `agent/test/w1-capabilities.test.mjs`

**Interfaces:**
- Produces: `detectCapabilities({ env?: object, stdinIsTTY: boolean, stdoutIsTTY: boolean }): { colors: 'none'|'16'|'256'|'24bit', altScreen: boolean, osc8: boolean }`
  规则：`NO_COLOR` 或 `CI` 或非 TTY → colors 'none'；`COLORTERM` 含 truecolor/24bit 或 `WT_SESSION` 存在或 `TERM_PROGRAM` 存在 → '24bit'；`TERM` 含 '256' → '256'；否则 '16'。altScreen = 双 TTY 且 `TERM!=='dumb'`。osc8 = altScreen 且非经典 conhost（以 `WT_SESSION`/`TERM_PROGRAM`/`TERM` 判定，纯 conhost 保守为 false）。

- [ ] **Step 1: 写失败测试**：环境矩阵断言（例：`{WT_SESSION:'x',stdinIsTTY:true,stdoutIsTTY:true}` → '24bit', altScreen true, osc8 true；`{CI:'true',...}` → 'none'；`{TERM:'xterm-256color'}` → '256'；`{}` + 双 TTY → '16'）。
- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现** 按签名与规则
- [ ] **Step 4: 确认通过** → PASS
- [ ] **Step 5: 全量验证** → 199 全绿

### Task 3: 语义色 token 系统 `theme.js`

**Files:**
- Create: `agent/src/tui/theme.js`
- Test: `agent/test/w1-theme.test.mjs`

**Interfaces:**
- Produces:
  - `TOKENS: string[]`（17 个：brand/permission/promptBorder/text/inactive/subtle/success/error/warning/bashBorder/userBubbleBg/bashBubbleBg/planMode/autoAccept/diffAddedFg/diffAddedBg/diffRemovedFg/diffRemovedBg）
  - `getTheme(name: 'dark'|'light', level: '16'|'256'|'24bit' = '256'): Record<string, string>` — 每个 token 返回 SGR 前缀（如 `'\x1b[38;5;174m'` / `'\x1b[38;2;215;119;87m'`）
  - dark 值取自 spec §4（brand 215,119,87；permission 177,185,249；promptBorder 136,136,136；success 78,186,101；error 255,107,128；warning 255,193,7；bashBorder 253,93,177；userBubbleBg 55,55,55；planMode 72,150,140；autoAccept 175,135,255；diffAddedFg 78,186,101/diffAddedBg 24,70,35 系深色底；diffRemovedFg 255,107,128/diffRemovedBg 70,30,35）；light 值取 spec §4 对应列。256 近似表手工就近映射（brand→209 系、permission→147、success→78、error→204、warning→220、bashBorder→205、planMode→73、autoAccept→141、userBubbleBg 用 `\x1b[48;5;...m` 背景 SGR）。
  - 背景类 token（userBubbleBg/bashBubbleBg/diff*Bg）返回背景 SGR（`48;`），其余前景（`38;`）。

- [ ] **Step 1: 写失败测试**：dark/256 下 `theme.brand === '\x1b[38;5;209m'`（或就近映射值，测试锁定实际选择）；dark/24bit `theme.permission === '\x1b[38;2;177;185;249m'`；`theme.userBubbleBg` 以 `48;` 开头；light 主题 `theme.text !== dark.text`；17 个 token 齐全。
- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现** 按签名；RGB→256 就近映射表内嵌。
- [ ] **Step 4: 确认通过** → PASS
- [ ] **Step 5: 全量验证** → 199 全绿

### Task 4: 渲染正确性 + 缓存 + 帧 diff

**Files:**
- Modify: `agent/src/tui/render.js`（visibleLen/truncateAnsi/wrapText/stripFirstChars 全部改走 wcwidth）
- Modify: `agent/src/tui/screen.js`（draw 改帧 diff）
- Modify: `agent/src/tui/ui.js`（entry 渲染缓存；事件驱动重绘；10fps tick 仅在有 running 卡时以 150ms 跑）
- Test: `agent/test/w1-render.test.mjs`；Modify: `agent/test/tui.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `stringWidth/sliceWidth`；Task 3 的 `getTheme`（Task 5 才接线，本 Task 沿用现有硬编码色，只换测量）。
- Produces:
  - `render.js` 导出新增 `ansiStateCarry(fromLine: string): string`——提取一行末尾仍活跃的 SGR 状态，供折行续行前缀（修复跨行样式丢失）。
  - `Screen` 实例属性 `lastLines: string[]`（供测试断言 diff 行为）。
  - `TuiUI` 内部 entry 结构增加 `_rendered: { width: number, lines: string[] } | null` 与 `materialize(entry, width)` 缓存逻辑（不导出）。

- [ ] **Step 1: 写失败测试** `agent/test/w1-render.test.mjs`：
  - `visibleLen('中\x1b[31m文\x1b[0m')===4`；`truncateAnsi('中文文', 3)` 截出 2 个汉字不多不少；
  - `wrapText('\x1b[31mhello world\x1b[0m', 8)` 第二行仍以红码开头（ansiStateCarry）；
  - Screen diff：fake output 捕获两次 draw（`['a','b']` 再 `['a','c']`），第二次输出**不含** 'a' 行重写、含 'c'；行数变少时正确清尾；
  - 缓存：同一 entry 两次 materialize 同宽度返回同一数组引用；宽度变化后重算。
- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**：render.js 换测量；wrapText 按 grapheme 宽贪心断行并给续行补 ansiStateCarry；screen.js draw 与 lastLines 逐行 diff（用 `\x1b[<n>A` 上移定位 + 逐行写，尾部多余行清 `\x1b[J`）；tui/ui.js 每个 entry 缓存渲染行（text/stream 走 wrapText 缓存，card 走 renderCard 缓存），`_flat()` 只拼缓存；重绘触发点：print/streamChunk/key/scroll/resize；spinner interval 150ms 仅在存在 running 卡时开启（无卡时清除）。
- [ ] **Step 4: 确认通过** + `node --test test/tui.test.mjs`（既有 render 测试若断言旧行为则按新语义更新）→ PASS
- [ ] **Step 5: 全量验证** → 199 全绿

### Task 5: 调色板统一 + 主题切换生效

**Files:**
- Modify: `agent/src/ui.js`（模块级调色板 `C` 改为 `getTheme('dark','256')` 派生；`setTheme` 重解析）
- Modify: `agent/src/tui/ui.js`（`setTheme(name)` 实现：重解析 theme、全部 entry 标脏、重绘；构造时读 `getConfig().theme`）
- Modify: `agent/bin/cowcat.mjs:667-672`（确认 `/theme` 分支已调 `ui.setTheme(want)`；没有则补）
- Test: `agent/test/w1-theme-apply.test.mjs`

**Interfaces:**
- Consumes: Task 3 `getTheme`。
- Produces: `TuiUI.setTheme(name: 'dark'|'light')` 生效；行模式 `UI.setTheme` 行为不变（外部接口同名）。

- [ ] **Step 1: 写失败测试**：`UI` 实例 `setTheme('light')` 后 `COPY` 无关、调色板对象引用变化且某色值随主题改变；`TuiUI`（fake input/output 构造）`setTheme('light')` 后再次 `_draw()` 输出含 light 主题特征色、且 entries 缓存被标脏（暴露 `_entriesDirtyCount` 或断言 header 颜色变化）。
- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**：ui.js 的 `C` 改为 `getTheme()` 结果 + `setTheme` 时 `Object.assign(C, getTheme(...))` 保持引用稳定；TuiUI 持有 `this.theme`，渲染函数从 `this.theme` 取色（本 Task 只接 header/status/卡片边框，条目正文颜色在 W2 接入）；`setTheme` 遍历 entries 置 `_rendered=null`。
- [ ] **Step 4: 确认通过** → PASS
- [ ] **Step 5: 全量验证** → 199 全绿

## W2 — 转录区渲染

### Task 6: 流式 markdown 渲染器 `markdown.js`

**Files:**
- Create: `agent/src/tui/markdown.js`
- Test: `agent/test/w2-markdown.test.mjs`

**Interfaces:**
- Consumes: Task 1 `stringWidth/sliceWidth`；Task 3 `getTheme`。
- Produces:
  - `createMarkdownRenderer({ theme, width, highlight?: (code: string, lang: string) => string }): { push(chunk: string): { text: string, width: number }[], reset(width: number): void }`
  - 输出行结构 `{ text: string, width: number }`（text 含 ANSI；width 为可见宽）。
  - 纯文本快路径：累积首 200 字符内无 markdown 元字符（`#*_`>`|`-+` 集合）则直接 wrap 不解析。
  - 块：paragraph / ATX 标题（h1 bold+italic+underline，h2+ bold，标题后空行）/ ul+ol 列表（每级 2 空格，二级 ul 用字母序号 a. b.）/ quote（dim+italic）/ 围栏代码（highlight 回调渲染内容；未闭合 fence 立即按 fence 渲染已收行；无背景色无行号无语言标签）/ 表格（列按内容最大宽对齐，最小列宽 3，表头 `---`）/ hr（`---` 单独成行）。
  - 行内：`**bold**`、`*italic*`/`` `code` ``（permission 色）、`[t](url)`（OSC8 超链接 + permission 色；调用方按 caps.osc8 决定是否传支持标记——renderer 选项 `osc8: boolean`）。
  - 流式语义：`push` 返回本次新增/变更的行（尾部未闭合块每 push 全量重出该块已渲染行，调用方替换）；状态跨 chunk 持久。

- [ ] **Step 1: 写失败测试**（fixture 驱动）：
  - `# Title` → h1 样式行（bold+italic+underline SGR）+ 空行；
  - `- a\n  - b` 二级列表缩进与字母序号；
  - 围栏：`` ```js\nconst x=1\n``` `` 经假 highlight 回调逐行着色；未闭合 fence push('```js\nconst') 立即产出代码行；
  - chunk 拆分：`` **bo`` + ``ld** `` 最终渲染为加粗单词且只出现一次；
  - 表格对齐（含中文列宽按 Task 1 测量）；
  - 纯文本快路径：200 字无元字符文本 push 后不产生标题/列表样式；
  - 段落折行：中文段落按宽度折行不断词。
- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**：行块状态机（块级解析缓冲未闭合块；行内样式用正则 tokenizer 输出 `[{text, style}]` span 再合成 ANSI 行）；fence 内容交 `highlight` 回调（缺省原样）。
- [ ] **Step 4: 确认通过** → PASS
- [ ] **Step 5: 全量验证** → 绿

### Task 7: 正则词法语法高亮 `highlight.js`

**Files:**
- Create: `agent/src/tui/highlight.js`
- Test: `agent/test/w2-highlight.test.mjs`

**Interfaces:**
- Consumes: Task 3 theme。
- Produces:
  - `highlightCode(code: string, lang: string, theme): string` — 返回 ANSI 高亮字符串（多行，行尾换行）
  - `LANGUAGES: string[]` = `['js','ts','python','sh','json','md']`（别名映射 javascript→js、typescript→ts、py→python、bash/shell→sh、markdown→md；未知语言原样返回）
  - 词法器：逐行扫描、有限状态跨行（块注释/三引号字符串）；每语言规则表（正则→token 类）
  - token→色（spec §4）：keyword/literal/class/name→permission 蓝；built_in/type/attr→青（74 系）；string/regexp→红；number→绿；comment/doctag→绿（comment 另加 dim）；function→黄；meta/tag→灰；op/punct→text。
  - 核心 `tokenizeLine(rules, line, state)` 导出（供测试与 markdown fence 复用）。

- [ ] **Step 1: 写失败测试**：每语言一段代表性代码断言关键 token 被对应颜色 SGR 包裹（js 的 `const`/字符串/注释/函数名；python 的 `def`/`#` 注释/装饰器；json 的 key/string/number；sh 的 `#!/bin` shebang 注释/`$VAR`；ts 的 `: string` 类型；md 标题）；块注释跨行状态保持；未知语言原样。
- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**：`tokenizeLine` 按规则表顺序匹配（长正则优先），命中切 token；状态对象 `{ inBlockComment?: string, inString?: string }`。
- [ ] **Step 4: 确认通过** → PASS
- [ ] **Step 5: 全量验证** → 绿

### Task 8: entry 分类、用户气泡、工具块视觉、userMessage、回合页脚

**Files:**
- Modify: `agent/src/tui/ui.js`、`agent/src/tui/render.js`
- Modify: `agent/src/ui.js`（`UI.userMessage(text){}` 空操作；`MockUI` 同样加）
- Modify: `agent/bin/cowcat.mjs`（REPL 提交后 `ui.userMessage(line)` 再 `runTurn`；`runTurn` 结束回调回合时长）
- Test: `agent/test/w2-transcript.test.mjs`；Modify: `agent/test/tui.test.mjs`

**Interfaces:**
- Consumes: Task 6 renderer、Task 7 `highlightCode`、Task 3 theme。
- Produces:
  - `TuiUI.userMessage(text: string)`：推 kind='user' 条目，气泡渲染（bg=theme.userBubbleBg，前缀 subtle `› `，宽 columns-4，续行与正文对齐）。
  - `streamChunk` 首 chunk 建 kind='assistant' 条目并创建 markdown renderer（width=当前转录宽）；末条目增量渲染。
  - `endStream()`：结束 renderer、推 `✻ for Ns|m` dim 页脚（N 从 userMessage 到 endStream 计时；`turnSeconds()` 内部）。
  - 工具卡：`⏺` 前缀列（minWidth 2），running=dim、success=绿、error=红；卡尾 hint dim `· ctrl+o to expand/collapse`；`_handleKey` 增加 ctrl+o（`\x1b[15;5~` 与 `\x1bOj`/`ctrl+o` 按现有键解析习惯）切换最近卡 expanded。

- [ ] **Step 1: 写失败测试**：
  - `userMessage('你好')` 后 `_flat()` 含 userBubbleBg 背景行且以 `›` 开头；中文宽度假影不影响后续对齐；
  - `streamChunk('**bold**')` + `endStream()`：转录含加粗 span + `✻ for` 页脚；
  - 工具卡三态颜色（running/success/error）各断一个 SGR；
  - ctrl+o 切换 expanded；
  - `print()` 推入含 `|` 的预排版表格行（模拟 /cost）不被 markdown 改样（raw 路径）；
  - spawn e2e：fake SSE 一轮对话，管道输出断言无 alt-screen（降级保证原样）。
- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**：entries kind 化（user/assistant/text/card）；materialize 按 kind 分流（assistant 走 markdown renderer 缓存行）；行模式 UI.userMessage 空操作、MockUI 同步加（duck 接口完整性）。
- [ ] **Step 4: 确认通过** + tui.test.mjs 旧断言适配 → PASS
- [ ] **Step 5: 全量验证** → 绿

## W3 — 交互与卡片

### Task 9: 审批卡 diff 预览（TUI 接通 preview/group）

**Files:**
- Modify: `agent/src/tui/ui.js`（`approve(toolName, proposal, opts)` 接收 `opts.preview`/`opts.group`，卡体渲染 diff 行）
- 复用: `agent/src/diffcard.js` 的 `renderFileCard`/`renderGroup`（先读其导出签名）
- Test: `agent/test/w3-approval.test.mjs`

**Interfaces:**
- Produces: `TuiUI.approve` 与行模式 `UI.approve` 同签名同语义（preview/group 渲染为卡内可折叠区）；单键 y/n/a 行为不变。

- [ ] **Step 1: 写失败测试**：构造 TuiUI（fake 流），`approve('Edit',{file:'a.js',patch:'...'},{preview:[...]})` 断言卡体含 preview 行且边框为 theme.permission 色；模拟按键 'n' 正确 resolve；pending 期间再 `_onKeys` 滚动键不 resolve。
- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**：bin 调 `ui.approve` 处已传 preview（行模式在用），TUI 侧把 preview/group 行并入审批卡 entries（folded 默认，ctrl+o 展开）。
- [ ] **Step 4: 确认通过** → PASS
- [ ] **Step 5: 全量验证** → 绿

### Task 10: 输入框与状态栏提示

**Files:**
- Modify: `agent/src/tui/render.js`（`buildInputBox({ text, width, theme, placeholder, multiline, cursor })` 纯函数；`renderStatus` 加提示位）
- Modify: `agent/src/tui/ui.js`（输入框 round 边框 + permission 色 + placeholder + margin；状态栏 hint）
- Test: Modify: `agent/test/tui.test.mjs`；Create: `agent/test/w3-inputbox.test.mjs`

**Interfaces:**
- Produces: `buildInputBox` 导出（纯函数，单测目标）；round 边框字符 `╭─╮│╯─╰`；placeholder 空输入时显示（zh：'输入消息，/ 命令，@ 文件'；en：'Type a message, / for commands, @ for files'）；状态栏 hint：无 pending 时 dim `? for shortcuts` + `shift+tab to switch mode`。

- [ ] **Step 1: 写失败测试**：width 20 空输入 → 输出含 ╭/╰ 与 placeholder、边框 permission SGR；有文本时 placeholder 消失；`renderStatus` 输出含 hint 文案。
- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: 确认通过** + 既有 input box 测试适配 → PASS
- [ ] **Step 5: 全量验证** → 绿

### Task 11: LineEditor 光标与编辑键

**Files:**
- Modify: `agent/src/lineeditor.js`（光标模型：buffer+cursor；left/right/home/end/backspace/delete/Ctrl+W/Ctrl+U/Ctrl+K；`render()` 输出含光标定位）
- Modify: `agent/src/tui/ui.js`（`_handleKey` 把上述键喂 editor）
- Test: Create: `agent/test/w3-editor.test.mjs`；既有 lineeditor 相关测试适配

**Interfaces:**
- Produces: `LineEditor` 新 API：`insert(ch)` 在光标处插、`moveLeft/moveRight/home/end()`、`deleteBack/deleteForward()`、`killWordBack/killToStart/killToEnd()`、`get cursor()`、`render(width)` 返回 `{ lines: string[], cursorRow, cursorCol }`。旧 append-only 调用点（tui/ui.js）同步迁移。

- [ ] **Step 1: 写失败测试**：插入后移光标再插入的 buffer 正确性；各 kill/删除键边界（空 buffer、行首、行尾）；多行 buffer 光标行列。
- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: 确认通过** → PASS
- [ ] **Step 5: 全量验证** → 绿

### Task 12: 补全接线（斜杠命令 + @ 文件）

**Files:**
- Modify: `agent/bin/cowcat.mjs`（构造 `slashCommandList()`：静态命令数组（取自 :800 /help 清单）+ 动态存在性过滤；作为 `completions` 回调传入 TuiUI 构造）
- Modify: `agent/src/tui/ui.js`（Tab 循环候选、@ 前缀走 `fileCompletions`，候选行渲染在输入框下方）
- Test: Create: `agent/test/w3-completion.test.mjs`

**Interfaces:**
- Produces: TuiUI 构造选项 `completions?: (prefix: string) => string[]`、`fileCompletions?: (prefix: string) => string[]`（已在构造占位，本 Task 接线）；候选行 UI：输入框下 dim 行显示当前候选 + `Tab` 循环、`Esc` 取消。

- [ ] **Step 1: 写失败测试**：TuiUI（注入假 completions）输入 `/th` 按 Tab → 输入框文本变 `/theme`、候选行显示；连续 Tab 在多候选循环；输入 `@ RE`（假 fileCompletions）→ 候选为文件路径；Esc 清候选。
- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**：bin 侧清单 API + TuiUI 补全状态机（前缀检测、`completionState`）。
- [ ] **Step 4: 确认通过** → PASS
- [ ] **Step 5: 全量验证** → 绿

### Task 13: 发版收尾（0.10.0）

**Files:**
- Modify: `agent/package.json`（0.9.0 → 0.10.0）
- Modify: `docs/changelog.md`（0.10.0 条目：TUI 全面翻新三波内容摘要）
- Modify: `docs/ROADMAP.md`（新增 P4 段落 ✅）
- Modify: `docs/USAGE.md`（TUI 相关描述行如有过时同步）

- [ ] **Step 1: 全量测试** `node --test 'test/**/*.test.mjs'` 全绿（≥230 tests）
- [ ] **Step 2: 冒烟** `node agent/bin/cowcat.mjs --version` → `cowcat/0.10.0`；管道 `-p` 冒烟输出无 alt-screen 转义
- [ ] **Step 3: 写 changelog/ROADMAP/USAGE 更新**
- [ ] **Step 4: 最终复验** 全量测试再跑一次全绿
