# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾（或用户要求做会话收尾）重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-21（TUI 反馈会话收尾）**。
> 交接时仓库状态：**工作区干净，`main` 无未合入改动**；本会话没有进行中的分支。
>
> **证据分级**：**【源码】**读代码；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（v2 跑 `dist/`）；**【CI 远端】**GitHub Actions；**【上游】**官方文档/上游源码；**【推断】**未实测，不作为决策依据。
>
> **归属**：本会话产出为 **#93、#98–#102、#109–#121**；更早的 `1.0.0-beta.2` 发布系列（#80–#90）属于前序会话。

---

## 1. 本次会话做了什么

起点是两条线：

1. **beta 实际使用反馈**（kuangkuang 项目一轮 27 分钟会话），修了信任入口、回合提示、审批噪声、危险命令提示，并把 `docs/beta-checklist.md` 的 §1–§3、§4.2 跑完。
2. **TUI 体验重做**：用户连续两轮实测反馈后，先做调研（`docs/research/tui-interaction-redesign.md`），再按 PR 拆分实现。

### PR 一览

| PR | 内容 | 结果 |
|---|---|---|
| #93 | 架构文档状态行同步 beta.2 | 合入 |
| #98 | `cowcat trust` + `turn.noted`（ADR-092/093） | 合入 |
| #99 | beta 清单 §1.1–1.3 实测、README 补 trust | 合入 |
| #100 | §2 编码任务、§4.2 MCP 正例 | 合入 |
| #101 | MCP 崩溃不重启、cancel 杀进程 | 合入 |
| #102 | §3 长会话压缩、子 agent | 合入 |
| #109 | TUI：`/` 提示、会话恢复命令、思考折叠（无新 ADR） | 合入 |
| #110 | TUI：审批选项卡、运行态 spinner、子 agent 面板（ADR-096） | 合入 |
| #111 | TUI：命中区域、滚轮、带边框输入区（ADR-097） | 合入 |
| #112 | TUI：思考流式 + `useMouse`（ADR-098） | 合入 |
| #116 | TUI：逐字揭示、运行中工具卡、滚轮 3 行/60fps（ADR-099） | 合入 |
| #117 | TUI：每行固定一行高、resize 重绘（ADR-100） | 合入 |
| #118 | TUI：100 列阅读宽度、固定 dock、输出代码块（ADR-101） | 合入 |
| #119 | TUI：`/` 可选菜单、状态栏模型/用时（ADR-102） | 合入 |
| #120 | TUI：滚动 auto-follow、`Ctrl+End` 回底（ADR-103） | 合入 |
| #121 | TUI：多行 composer，Enter 发送 / Shift+Enter 换行（ADR-104） | 合入 |

## 2. TUI 现在的能力

- **思考**：`reasoning.delta` 流式到达 → 逐字揭示（50ms tick）→ 回答到达后自动折叠；`Ctrl-T` / `/thinking` 展开或折叠
- **运行态**：状态条有 spinner、当前动作、模型短名、用时、子 agent 数；Bash 运行期间有 `[运行中]` 卡与命令行
- **固定区（dock）**：审批、运行中的子 agent、待办、`/` 菜单都在 transcript 与状态栏之间，滚动不移动
- **审批**：四行可选项（一次 / 本会话该工具 / 只对这一个动作 / 拒绝），`↑↓` + 回车，`y/n/always/s` 字母快捷与鼠标点击也可
- **`/` 菜单**：过滤、`↑↓`、`Tab` 补全、`Enter` 执行、`Esc` 关闭；输入含空格即关闭
- **滚动**：滚轮 3 行（`COWCAT_SCROLL_SPEED` 1–20）、60fps；上滚暂停跟随并计数，`Ctrl+End` 回底
- **布局**：阅读宽度 `min(终端-2, 100)` 居中；每行固定一行高（不二次换行、不被 flex 压缩）
- **输入**：多行 composer（1–6 行），`Enter` 发送、`Shift+Enter` / `Ctrl+J` 换行

环境开关：`COWCAT_MOUSE=off`（保留终端原生选择）、`COWCAT_ANIMATIONS=off`（冻结动画）、`COWCAT_SCROLL_SPEED=<n>`。

## 3. 新增 ADR

ADR-092 信任入口 · 093 `turn.noted` · 094 `session` 审批档 · 095 危险命令提示 · 096 运行态与 spinner 例外 · 097 命中区域/滚动/输入区 · 098 思考流式与鼠标 · 099 逐字揭示/运行中卡/滚动手感 · 100 一行一 `Line` + resize 重绘 · 101 阅读宽度/dock/代码块 · 102 `/` 菜单与状态栏 · 103 auto-follow · 104 多行 composer。

## 4. 未验证 / 风险（必须先看）

- **真终端里的多行键位**：`Enter` 是否发送、`Shift+Enter`/`Ctrl+J` 是否换行。opentui 的键名是 `return` 而非 `enter`，默认是 `return → newline`；写错不会报错，只会「按回车发不出去」。PR #121 合入后**尚未人眼验证**。
- **鼠标**：`useMouse` 已开启，但终端差异大（Windows Terminal / iTerm2 / VS Code）。滚轮与点击只做过帧与逻辑测试。
- **100 列上限与 dock 高度**：只在 48 列快照与代码层验证，120/160/200 列实际观感未看。
- **多行 composer 增高**：逻辑是 1–6 行 + 边框，超出后 textarea 内部滚动未单独处理。
- 状态栏**没有上下文百分比**（缺 `contextWindow` 来源，见 #122）。

## 5. 开放 issue

| Issue | 内容 |
|---|---|
| #122 | 状态栏上下文百分比（需 `turn.opened.contextWindow`） |
| #123 | 底部浮动「回到底部」按钮 |
| #124 | 输入历史（↑↓） |
| #125 | Bash 实时输出与后台进程列表（内核 `ProcessPort` 改动） |

## 6. 下一步建议

1. 真机验多行键位与鼠标（上面 §4），有问题优先修——输入发不出去是 P0。
2. #122 与 #123 是小改动，可一起做；#124 中等；#125 是内核级，单独排期。
3. `docs/beta-checklist.md` 剩余：§4.1 TUI 30 分钟、§5 平台差异（macOS/Linux 沙箱），必须人眼/真机。
4. `docs/architecture/README.md` 的状态行已标「P8 基本完成」；`latest` 仍是 v1，切换门槛见清单 §7。

## 7. 会话踩坑（新）

- **opentui 键名**：`return` 不是 `enter`；Textarea 的 submit 用 `input.onSubmit`，不是事件。
- **`useMouse` 默认不开**：不开时所有 `onMouse*` 是死代码。
- **二次换行 + flexShrink**：每行 renderable 必须 `wrapMode:'none'`、`height:1`、`flexShrink:0`，否则滚动看起来像整体压缩。
- **PowerShell 5.1 读 UTF-8 脚本要 BOM**；`Get-Content -Raw`/`Add-Content` 会按 ANSI 破坏中文，改测试文件用编辑工具或 Node 写。
- **CI 排队**：本会话两次遇到 runner 排队 5 分钟以上，不是失败；用 `gh run list` 区分 queued 与 fail。

## 8. 构建与测试（不变）

```bash
cd packages/cowcat && npm test        # pretest = tsc build + ESLint
cd packages/protocol && npm test
cd packages/tui && npm test           # Node >= 26.4；本机用 npx --yes node@26.12.0 --test "dist/test/**/*.test.js"
cd packages/cli && npm test           # 依赖前三个已构建
```

探针（不进 lint 门禁，但改分层或发布清单时要跑）：

```bash
node tools/lint-probe.mjs             # 分层禁令逐条验证
node tools/check-tarball.mjs          # 发布白名单；--install 会装 tarball 并跑 --version
```

`file:` 依赖是 junction，必须按 protocol → cowcat → tui → cli 顺序构建。`main` 不可直推，走分支 + PR；提交信息 `type(scope): 中文摘要`，Windows 上用 `git commit -F <文件>`。
