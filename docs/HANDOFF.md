# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾（或用户要求做会话收尾）重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-22（beta.3 发布与 TUI 真机验收）**。
> 交接时仓库状态：**`main` 即最新，工作区干净，`v1.0.0-beta.3` 已发布并打 tag；四包 `beta`/`latest` 均已核对。**
>
> **证据分级**：**【源码】**读代码；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（v2 跑 `dist/`）；**【CI 远端】**GitHub Actions；**【真机】**用户在其终端里人眼看/操作过；**【上游】**官方文档/上游源码；**【推断】**未实测，不作为决策依据。
>
> **归属**：本会话产出为 **#93、#98–#102、#109–#113、#127–#145**（含 beta.3 发布与本次真机验收修复）；更早的 `1.0.0-beta.1/2` 发布系列（#80–#90）属于前序会话。

---

## 1. 本次会话做了什么

两条线：

1. **TUI 体验重做与后台任务**（P7 的实时输出/后台）：TUI 交互按调研重写（`/` 菜单、审批选项卡、思考流式与逐字揭示、滚动手感、100 列阅读宽度、多行 composer、输入历史、上下文占用、回到底部），并落地实时输出通道与后台任务（ADR-107~113）。
2. **beta.3 发布与真机验收**：用户在 Tabby Terminal 上按验收卡跑组 1–3，发现多行输入实际不可用；修复后发布 `1.0.0-beta.3`。

### PR 一览（本会话后半段）

| PR | 内容 | 结果 |
|---|---|---|
| #134 / #139 | 完成态工具卡长行被截 2 格 | 合入 |
| #135–#138 | 后台任务：端口与注册表、接线与生命周期、`task.stop`、`/tasks` 面板 | 合入 |
| #140 | 多行输入补 `Alt+Enter`，`Shift+Enter` 不再承诺（ADR-104 ⑥） | 合入 |
| #141 | 把 `Ctrl+Enter`/`Ctrl+J` 走的 `linefeed → newline` 显式化（ADR-104 ⑦） | 合入 |
| #142 | 登记 2026-10-22 TUI 验收结果（§4.1 / §4.4 / §9） | 合入 |
| #143 | `1.0.0-beta.3` 发布批次（四包版本、changelog、README、清单标题） | 合入 + tag `v1.0.0-beta.3` |
| #144 | 修正 `PUBLISH.md` 发布路径（tarball 平铺，不是 `packages-<name>/`） | 合入 |
| #145 | `PUBLISH.md` 补 `--tag beta` 与默认 tag 风险 | 合入 |

## 2. TUI 现在的能力

- **输入**：多行 composer（1–6 行）。`Enter` 发送；换行 **`Ctrl+J` / `Ctrl+Enter` 任何终端可用**（同一个 LF 字节），`Alt+Enter` 多数终端可用（`ESC CR`），`Shift+Enter` 仅 kitty 协议终端有效（Tabby 上等于回车）。首行 ↑ / 末行 ↓ 取历史（会话内 100 条），其余方向键归光标
- **思考**：`reasoning.delta` 流式到达 → 逐字揭示（50ms tick）→ 回答到达后自动折叠；`Ctrl-T` / `/thinking` 展开或折叠
- **运行态**：状态条有 spinner、当前动作、模型短名、用时、子 agent 数、运行中的后台任务数；Bash 运行期间有 `[运行中]` 卡、命令行与实时输出尾部（最多 20 行）
- **后台任务**：Bash 可用 `run_in_background`（30 分钟/2 小时）；`/tasks` 列出任务，`↑↓` 选择、`x` 停止、`Esc` 关闭；replay 里没有结束事件的任务显示「状态未知」且不可停止
- **固定区（dock）**：审批、`/tasks` 面板、运行中的子 agent、待办、`/` 菜单都在 transcript 与状态栏之间，滚动不移动
- **审批**：四行可选项（一次 / 本会话该工具 / 只对这一个动作 / 拒绝），`↑↓` + 回车，字母快捷与鼠标点击也可
- **滚动**：滚轮 3 行（`COWCAT_SCROLL_SPEED` 1–20）、60fps；上滚暂停跟随并计数，`Ctrl+End` 回底；`↓ 回到底部` 可点击
- **上下文占用**：状态栏显示 `ctx N%`（`input + 缓存读/写 + output` ÷ 窗口）
- **布局**：阅读宽度 `min(终端-2, 100)` 居中；每行固定一行高；终端 resize 立即重绘

环境开关：`COWCAT_MOUSE=off`、`COWCAT_ANIMATIONS=off`、`COWCAT_SCROLL_SPEED=<n>`。

## 3. 新增 ADR

ADR-092 信任入口 · 093 `turn.noted` · 094 `session` 审批档 · 095 危险命令提示 · 096 运行态与 spinner 例外 · 097 命中区域/滚动/输入区 · 098 思考流式与鼠标 · 099 逐字揭示/运行中卡/滚动手感 · 100 一行一 `Line` + resize 重绘 · 101 阅读宽度/dock/代码块 · 102 `/` 菜单与状态栏 · 103 auto-follow · 104 多行 composer（**⑥⑦ 本次修订：换行键的终端依赖**）· 105 上下文占用与回到底部 · 106 输入历史 · 107 实时输出通道 · 108 `tool.output.delta` · 109 运行中卡实时尾部 · 110 后台任务注册表 · 111 后台生命周期事件 · 112 后台超时/无人值守/退出 · 113 `task.stop` 与 `/tasks` 面板。

## 4. 未验证 / 风险（必须先看）

- **`Shift+Enter` 在多数终端等于回车**（Tabby 实测发 `0d`，无 kitty 协议）。换行键位见 §2；桌面端 / Web 端能拿到完整 keyboard 事件，到那时再实现（用户 2026-10-22 决定）。已记入 `beta-checklist.md` §8。
- **鼠标**：`useMouse` 已开启，但 Windows Terminal / iTerm2 / VS Code / Tabby 差异大；滚轮与点击只做过帧与逻辑测试，`↓ 回到底部` 的点击同样只在帧层验证。
- **100 列上限与 dock 高度**：120/160/200 列的实际观感未逐档记录（2026-10-22 验收只说「没太大问题」）。
- **多行 composer 增高**：1–6 行 + 边框，超出后 textarea 内部滚动未单独处理。
- **输入历史的边界判定**：按**视觉行**判定，已用 headless renderer 探针确认折行计数；真实终端里的 ↑↓ 手感未逐项登记。
- **后台任务**：面板与 `x` 停止只在帧层与协议层验证；Windows 上 `taskkill /T` 对后台树的实际行为未人眼验证（终止路径沿用 ADR-014）。
- **后台输出**：实时尾部依赖适配器 100ms / 8KB 合并；高频输出的实际帧率未在真实终端量过。
- **连续 30 分钟**：`beta-checklist.md` §4.1 最后一条未专门计时；§5 平台差异（macOS/Linux 沙箱、Windows `cmd`、不同 Node）仍缺。

## 5. 发布状态

`1.0.0-beta.3`（tag `v1.0.0-beta.3`，commit `e8852f6`）：

- 四包 shasum 与本地 `pack-release` 产物逐包核对一致（直连 registry、禁缓存）
- `dist-tags`：protocol / core / tui 的 `latest` 与 `beta` 均为 `1.0.0-beta.3`；CLI（`@corescense/cowcat`）的 `latest` 仍是 v1 `0.15.0`，`beta` = `1.0.0-beta.3`
- 干净缓存下 `npm i @corescense/cowcat@beta` → `cowcat --version` = `1.0.0-beta.3`
- 切 `latest` 的门槛：`beta-checklist.md` §7 五条

## 6. 开放 issue

无。

## 7. 下一步建议

1. **补 §4.1 连续 30 分钟与 §5 平台差异**（都是人眼/真机项），这是切 `latest` 的剩余门槛。
2. **继续 P7 剩余模块**：Hooks、Skills（D3/D4：兼容 Claude Code 格式 + 渐进披露）、工具结果治理（T-A）、Plan 模式、会话体验、可观测性、经验蒸馏、视觉工具。先后见 `research/p7-frontier-survey.md` §9。
3. **P7 后台续篇**：模型侧 `TaskOutput`/`TaskStop`、后台输出落文件（ADR-113 明确推迟）。
4. **桌面端 / Web 端形态**（远期）：`Shift+Enter` 与新交互在那里才不受终端限制。

## 8. 会话踩坑（新）

- **`npm view` 会读本地缓存**：`E:\DevEnv\npm-cache` 返回旧 packument，让人误判「某个包没发出去」，继而重发得到 `E403 cannot publish over previously published versions`。判断发布状态只用直连 registry + `cache-control: no-cache`（命令见 `PUBLISH.md` ⑤.7）。
- **prerelease 必须 `--tag beta`**：漏了 npm 直接拒绝；而默认 tag 是 `latest`，所以在 npm 放宽检查的情况下漏写会静默顶掉 `latest`。
- **`pack-release.mjs --out` 是平铺的 tarball**，没有 `packages-<name>/` 子目录（旧文档写错，已修）。
- **opentui 的修饰键全靠终端**：`Shift+Enter` / `Ctrl+Enter` 能否区分取决于终端是否实现 kitty 协议；只有裸 LF（`Ctrl+J`）与 `ESC CR`（`Alt+Enter`）在网络之外还站得住。
- **PowerShell 显示中文/十六进制不可信**：`git log --format` 经 PowerShell 管道后 `Format-Hex` 会显示 `3f`（问号）伪装成「提交信息被破坏」；用 `node -e` + `execFileSync` 读原始字节才是真结果。

## 9. 构建与测试（不变）

```bash
cd packages/cowcat && npm test        # pretest = tsc build + ESLint，测试跑 dist/
cd packages/protocol && npm test
cd packages/tui && npm test           # Node >= 26.4；本机用 npx --yes node@26.12.0 --test "dist/test/**/*.test.js"
cd packages/cli && npm test           # 依赖前三个已构建
```

探针（不进 lint 门禁，但改分层或发布清单时要跑）：

```bash
node tools/lint-probe.mjs             # 分层禁令逐条验证
node tools/check-tarball.mjs --install # 发布白名单 + 装 tarball 跑 --version
```

`file:` 依赖是 junction，必须按 protocol → cowcat → tui → cli 顺序构建。`main` 不可直推，走分支 + PR；提交信息 `type(scope): 中文摘要`，Windows 上用 `git commit -F <文件>`。
