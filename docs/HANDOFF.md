# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-26（UX 对齐批次收尾：验收驱动的 9 个 PR 全部合入）**。
> 交接时仓库状态：**main @ `9e99716`，无开放 PR**；四包全绿（TUI 需 Node 26）；ADR-157~160 已落表；`docs/superpowers/plans/` 已归档至 `docs/archive/`。
>
> **证据分级**：**【源码】**读代码；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（v2 跑 `dist/`）；**【CI 远端】**GitHub Actions；**【真机】**真实模型 API / 真实 git 跑出的验收记录；**【上游】**官方文档/上游源码；**【推断】**未实测，不作为决策依据。

---

## 1. 本次会话做了什么（9 个 PR，全部已合入）

用户验收驱动的批次：每一条都从真机反馈或明确审查结论出发。

| PR | 内容 | 备注 |
|---|---|---|
| #211 | Hindsight MCP 接入指南 + MemoryPort ADR 草案 | docs；草案在 `docs/architecture/adr-memory-port-draft.md`，落表编号自 161 起 |
| #212 | beta-checklist 验收口径同步（ADR-148~156 项入清单 + §1.5 源码预跑） | 兑现上一批次 HANDOFF §6 |
| #177 | openai 7.36 → 7.39（dependabot） | |
| #213 | superpowers 分步计划归档 `docs/archive/`，`superpowers/` 目录移除 | 决策记录在 PR 描述 |
| #214 | 斜杠菜单/命令面板补选择跟随窗口 | 用户报「翻到底不翻页」；task-panel 惯用法补齐 |
| #215 | **性能修复**：`wrap` O(n²)→单遍 + `draw()` 合并 | 用户报「运行中非常卡」；探针 `tools/tui-perf-probe.mjs` 入库；单帧 298ms→22ms（10 轮）、流式 969→26ms |
| #216 | **批次 A**：工作区信任引导 + 会话选择器（ADR-157/158） | 用户报「无信任弹窗」「sessions 不分工作区」；协议新增 `trust.status/grant`、CLI connect 工厂改为每次重建宿主 |
| #217 | 打开的问题拥有回车，已答滞留卡不再压制菜单 | 用户完整复现定位三处叠加；`submit()` 分支重排 + frame/keymap 统一 `verdict === null` 判定 |
| #218 | **P2 批次**：接受编辑模式 + Shift+Tab/Esc-Esc/Ctrl+L（ADR-159/160） | UX 审查的 P2 全做；内核事件 + 协议 `accept-edits.set` + 三键位 |

UX 审查（对照 Claude Code / Codex / Gemini CLI）三批全部收官：P1=#216、问题2修复=#217、P2=#218。P3 两项（`!` 前缀 bash、Ctrl+V 图片粘贴）挂起。

## 2. 测试基线

| 包 | 通过 | 说明 |
|---|---|---|
| cowcat | 922/938 | 16 skip 平台既有项；新增 accept-edits 六用例 |
| protocol | 46/46 | trust 契约 + accept-edits.set 契约 |
| tui | 165/165 | **Node 26.12.0**（`npx --yes node@26.12.0 --test dist/test/`） |
| cli | 41/41 | |

探针与守卫：`lint-probe` 全过、`check-tarball` 四包干净。**CI 三平台为权威门。**

## 3. 新增 ADR

**ADR-157** 未受信工作区在首个会话前询问，授予即重建宿主（`trust.status/grant` 窄协议；CLI connect 工厂每次重建；拒绝按现状继续）· **ADR-158** 会话切换是工作区内的交互面板（cwd 过滤、Enter 原地切换、纯函数 pickableSessions）· **ADR-159** 接受编辑模式（事件溯源；仅 Write/Edit 的 ask、位于 deny/plan/写前读之后；Bash 永不放行；无 standing grant）· **ADR-160** Shift+Tab 三态循环 + Esc-Esc 取回上一条 + Ctrl+L 诚实重绘。

## 4. 未验证 / 风险（登记，不声称已解决）

- **产物级验收**：ADR-148~160 全部只在源码级验过（真机记录见 beta-checklist §4.5）；npm 产物勾选等 beta.5。
- **信任授予→宿主重建的端到端**：各半环节有测试，整链路真机走查已过（§4.5），但重建失败的异常路径（配置在授予后损坏）只有代码审读。
- **frameOf 全量重建**（#215 登记遗留）：100+ 轮会话单帧 200–400ms，配合 50ms 合并可感；按 entry 缓存渲染行是下一步。
- **P3 挂起**：`!` 前缀直跑 bash、Ctrl+V 图片粘贴。
- **MemoryPort ADR 草案**待评审（#211 入库的 `adr-memory-port-draft.md`）。

## 5. 开放 issue

无。

## 6. 下一步建议

1. **beta.5 发布**：ADR-148~160 是一批用户可感的功能（doctor FAIL 口径、菜单/面板、性能、信任、会话管理、模式循环），发布后按 beta-checklist §1.1/§4.1 的产物级口径勾选。
2. **frameOf 按 entry 缓存**：性能遗留，entry 不可变、以引用+宽度为键即可。
3. P3 两项按需排期。
4. MemoryPort 草案评审（届时编号 161 起，与 Hindsight MCP 指南配套）。

## 7. 会话踩坑（新增）

- **`python` heredoc 批量改 TS 源**：正则与转义（`\s`、`\/`）在两种语言里语义不同，两次都是断言失败救场——断言必须开，失败就改用 Edit 工具，别赌。
- **ScriptedHost 与 ProtocolHost 签名必须逐字一致**：`Promise<boolean>` vs `Promise<void>` 会在 build 期爆；写 host 方法先看 `setPlanMode` 模板（void + server 回显参数）。
- **SessionState 扩展的三个连锁点**：快照 schema（`Equals` 类型测试会抓）、`property.test` 的状态字面量、投影/穷尽 switch——加字段时一并 grep。
- **渲染层纯函数禁 `process.*`**：`frameOf` 是快照契约，cwd 这类环境事实要进 view 状态再传组件。
- **CFA 跨闭包收窄第四例**：门控状态（trust 答案、hostRebuilt）收进对象属性（`gate`），与 `activity.timer`/`frame.timer` 同列。
- **`KeyLike` 没有 `shift` 字段**而 KeyEvent 有：加可选字段即可，Shift+Tab 就位；lint 会拦 `?? false`（非空类型），直接传。

## 8. 构建与测试（不变）

```bash
cd packages/cowcat && npm test        # pretest = tsc + ESLint；改完必须跑这个
cd packages/protocol && npm test
cd packages/tui && npm test           # 本机用 npx --yes node@26.12.0 --test dist/test/
cd packages/cli && npm test
```

探针：`node tools/lint-probe.mjs`、`node tools/policy-decide-probe.mjs`、`node tools/check-tarball.mjs`、`node tools/tui-perf-probe.mjs`（渲染性能，怀疑回归时跑）。
