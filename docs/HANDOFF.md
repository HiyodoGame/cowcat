# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾（或用户要求做会话收尾）重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-23（P7 第四个模块 Plan 模式全链路收尾）**。
> 交接时仓库状态：**`main` = `3ce41cc`，工作区干净；最新发布仍为 `v1.0.0-beta.3`（本批次未发版）。**
>
> **证据分级**：**【源码】**读代码；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（v2 跑 `dist/`）；**【CI 远端】**GitHub Actions；**【真机】**真实模型 API 跑出的会话日志；**【上游】**官方文档/上游源码；**【推断】**未实测，不作为决策依据。
>
> **归属**：本会话产出 **#153~#169**（工具结果治理、Hooks、Plan 模式三个 P7 模块全链路；Skills #147~152 同属本会话前半）；TUI/后台任务/beta.3（#93–#145）属于前序会话。

---

## 1. 本次会话做了什么

四个 P7 模块，各自走完整链路「专项调研 → ADR → 实现 → post-merge 审查修复 → 真机验收」：

### Skills（#147~#152，已完成）

调研 → ADR-114~117 → 实现 → 审查修复 → **T4 真机验收**：glm-5.3-flash 自然触发 2/2。

### 工具结果治理 T-A（#153~#157，已完成）

ADR-118~120：tool clearing 派生视图（保留 2 条 + 占位符 + 附件停发）、spill 50KB 适配器层外置、repeat 防护轮末批量提醒。审查抓到 1 P0（提醒打断 wire 配对毒化日志）。T5 真机：三机制全触发、零 400、cacheRead 88%–99%。

### Hooks（#159~#163，已完成）

ADR-121~123：宿主侧副作用（HooksPort）、CC hooks.json 兼容 v1 六事件 command-only、五配置源叠加 + project trust 门、deny/改写/上下文注入的日志纪律。审查 5 P1 全为 CC 兼容硬偏差（stdin 事件名大小写、双格式决策读取、tool 事件 context 被丢弃等）。T5 真机：block-rm 链路照抄 CC 文档形态零改写生效。

### Plan 模式（#165~#169，已完成）

- 调研 → ADR-124~125 → T1/T2 实现（#167）→ 审查修复（#168，**1 P0**：评审超时后的合法重试被 host 桥陈旧 pendingPlan 杀死回合——approval 桥同病同源一并修复；3 P1：越界 choice 无有效选择也退模式、unattended 短路缺失、host 桥零覆盖）→ **T4 真机验收（#169）**。
- 要点：
  - **ADR-124**：`SessionState.planMode`（plan.mode-changed 事件折叠，快照 replay 兜底）；runCall 门控在 decide 之后、审批之前——不覆盖显式 deny、不落审批、Bash 一刀切（命令级只读判定列后续）、TodoWrite 豁免；进出由人（protocol `plan.setMode` + TUI `/plan`，**评审挂起期间拒绝切换**）。
  - **ADR-125**：`ExitPlan` 内核虚拟工具（planMode 才上 wire，1..4 方案）→ `plan.proposed` → 复用 awaiting_approval 零状态机改动 → 审批卡形态选择 → `plan.decided` → 选中自动 `plan.mode-changed(plan-approved)` 退模式；结果以工具结果回模型；越界 choice 按「都不选」；无人值守（deps.unattended）不 proposed 直接拒；**桥的陈旧项规则：再发问即替换而非拒绝**。
- T4 真机：`cowcat serve` + 脚本化 NDJSON 客户端驱动 glm-5.3-flash：门控拒写→模型自适应改只读探索→2 方案→选 1→自动退模式→审批放行→UNLICENSE 1211 字节真实落盘。

## 2. 测试基线（本机全绿）

| 包 | 通过 | 跳过 | 说明 |
|---|---|---|---|
| cowcat | 792 | 16 | 含 clearing/spill/repeat/hooks/plan 新测试 |
| protocol | 43 | 0 | plan.setMode/plan.reply 两 method |
| tui | 106 | 0 | **必须 `npx --yes node@26.12.0 --test dist/test/`**；本机 Node 24 是 16 个 FFI 假失败 |
| cli | 31 | 0 | oneshot plan 兜底 |

`tools/lint-probe.mjs` 全绿。CI 三平台绿（偶发：npm EPERM/SSL 与 job 取消，重跑即过）。

## 3. 新增 ADR（本会话）

ADR-114~123（见 HANDOFF 前版）· **124 Plan 模式会话级只读约束** · **125 ExitPlan 方案预审与评审桥**（②⑤⑥ 已按 #168 审查修订）。

## 4. 未验证 / 风险（必须先看）

- **Plan 模式**：Bash 一刀切的真实摩擦只有 2 轮样本（被拒即改道，未见死循环）；TUI 方案卡真人点击未验（交互与审批卡同构，风险低）；方案上限 4 未见触顶场景。
- **Hooks 已知偏差**（调研 §11.1）：updatedToolOutput 形状、纯文本 stdout 不注入、Windows 占位符、trust 目录语义——全部有意为之。
- **T-A 遗留**：clearing 保留窗口长会话三档对比、大会话缓存对照、repeat 误报面。
- **approval 桥陈旧项语义已变**（#168）：超时后同回合下一次 ask 现在**替换**陈旧 pending 而非拒绝——这是行为变更，旧会话无感知，但如有文档/外部依赖「第二次 ask 报错」的预期需更新（未发现）。
- **既有保留项**：`~/.claude/skills` 33 技能占 catalog ~7.5KB；`Shift+Enter` 不修；`cowcat trust` 不影响运行中的会话。

## 5. 开放 issue

无。

## 6. 下一步建议

1. **P7 下一个模块，用户选**：会话体验（D8）、可观测性（D9）、审批与沙箱闭环（D7）、Cron/Worktree 等。
2. **Plan 后续（不阻塞）**：Bash 只读命令分类（需重定向/包装器解析，单独调研）；CC 式「批准时附扩权列表」（ADR-032 既有约束的另一半）；TUI 方案卡真人走查。
3. **发版**：四个模块（Skills/T-A/Hooks/Plan）攒一批发 `beta.4` 由用户定。

## 7. 会话踩坑（本会话新增）

- **PowerShell 单引号 here-string 里 `''` 不转义**：写入文件是两个字面引号——TS 测试名里的撇号用中文或避开。
- **`@types/node` 的 `assert.equal/ok` 带断言签名**：`assert.equal(x.ok, false)` 之后 TS 已收窄，再写 `if (!x.ok)` 会被 `no-unnecessary-condition` 报 always-truthy——收窄后直接访问属性。
- **git checkout 切换分支不清理工作区**：在本机 main 工作区直接改了一轮审查修复，恰好可用（修复基于已合并代码）；但提交前务必 `git branch --show-current` 确认。
- **CI 两类假失败**（重跑即过，已两次实测）：ubuntu job「operation was canceled」（10 分钟截断）；windows runner npm `ERR_SSL_BAD_RECORD_MAC`。
- **事件驱动测试的时序坑**：`plan.proposed` 事件到达客户端 ≠ 内核已停在桥上（host 桥还没挂 pending）——断言「拒绝切换」类行为要轮询而不是竞速。

## 8. 构建与测试（不变）

```bash
cd packages/cowcat && npm test        # pretest = tsc build + ESLint，测试跑 dist/
cd packages/protocol && npm test
cd packages/tui && npm test           # Node >= 26.4；本机用 npx --yes node@26.12.0 --test dist/test/
cd packages/cli && npm test           # 依赖前三个已构建
```

探针：`node tools/lint-probe.mjs`、`node tools/check-tarball.mjs --install`。`file:` 依赖是 junction，按 protocol → cowcat → tui → cli 顺序构建。`main` 不可直推；提交信息 `type(scope): 中文摘要`，Windows 用 `git commit -F <文件>`；**改完必须跑 `npm test`（含 lint），`npm run build` 不跑 lint**。

真机验收素材：真实模型凭证 `~/.cowcat/config.json` preset `zai-coding-plan/glm-5.3-flash`；验收/驱动脚本与提交信息在 `C:\Users\Con_WKK\AppData\Local\Temp\cowcat-tui-accept\`（t4-plan-accept.mjs 可复用为 serve 级验收驱动）。
