# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-25（P0/P1 产品化批次收尾：Kimi Code 会话额度中断后的接手）**。
> 交接时仓库状态：**分支 `fix/p0-productization`（基于 main `d446db7`）待评审**；四包全绿（TUI 需 Node 26）；ADR-148~156 已落表。
>
> **证据分级**：**【源码】**读代码；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（v2 跑 `dist/`）；**【CI 远端】**GitHub Actions；**【真机】**真实模型 API / 真实 git 跑出的验收记录；**【上游】**官方文档/上游源码；**【推断】**未实测，不作为决策依据。
>
> **归属**：批次的实现主体（P0-A/B/C、P1-A、P1-B 大部与九条 ADR）出自 Kimi Code 会话（2026-10-24，周额度耗尽中断，任务清单 4/6 done、P1-B 进行中、全部未提交）；本 ZCode 会话接手：WIP 快照保护、三处中断残留修复、测试对齐 ADR、重连投影测试补齐、全量验证与本文档。

---

## 1. 本次会话做了什么

### 批次内容（ADR-148~156，主体出自 Kimi 会话）

- **P0-A 启动一致性（ADR-148）**：`doctor` 把渲染器门槛不足升级为默认入口 FAIL 与非零退出；全局/逐命令帮助双门槛披露；`--help`/`help` 不建宿主；仓库 shim 指向 v2 入口的发布前 smoke；CLI 增 `runtime.ts`。
- **P0-B TUI 基础（ADR-149）**：Ctrl+C 分级（先取消→清草稿→800ms 双击退出）；空输入 ↑/↓ 滚正文；`/changes` 变更面板（Write 不伪造 diffstat，只报写入行数）；命令面板过滤与点击；`atcomplete`（@ 引用收窄）。
- **P0-C 行为恢复（ADR-150/151）**：适配器把 413/超长 400 归一为 `ContextOverflowError`，内核按 70%/50%/35% 有界收缩重试；内核统一最小 system prompt（`kernel/system-prompt.ts`），普通与压缩请求共用。
- **P1-A 会话控制（ADR-152/153）**：`model.list/set`（会话级覆盖、失败保旧选择）与 `context.compact`（手动压缩走窄协议）；`grants.list`/`grants.revoke`（撤销是追加事件 `approval.revoked`，投影自 `approval.answered`）+ TUI `/permissions`。
- **P1-B 恢复闭环（ADR-154/155/156）**：运行中输入整回合排队（上限 8、FIFO、预留 turnId、附件启 turn 时才 emit）；Write/Edit 写前快照 + `change.undo/redo` + TUI `/undo` `/redo`（快照失败则拒绝修改）；输入历史由日志重建（上限 100、连续去重）+ Ctrl+R 反向搜索 + 连接断开重连（`RunTuiOptions.reconnect` 工厂、世代守卫）。

### 本会话接手部分

1. **WIP 快照（`5406eff`）**：71 文件 +2905 行零提交 → 先入库保护，worktree `.worktrees/p0-productization`。
2. **三处中断残留修复**：内核 `TurnNote` 联合补 `queue-failed` 成员（host/事件/schema/分支均已就位，唯独类型缺，TS2678）；`startQueued` 入口守卫与 while 条件重复（CFA 收窄致 lint 恒真 ×4）；TUI 重连守卫 `disposed` 被链式收窄判恒假（收进 `stale()` 闭包）；`turn.send` 的 `files` readonly→可变拷贝。
3. **测试对齐 ADR**：双会话模型选择测试假设一条连接同时收两会话事件，与「一连接一活动会话」（`server.openSession` 解绑先前订阅）矛盾，改按序附加按序等待；`/changes` 两个断言仍期待 Write 伪造 `+N`，按 ADR-149④ 改「写入 N 行」+ 不出现伪造 diffstat。
4. **补 P1-B 缺口**：reconnect 零测试 → 新增 `reconnect.test.ts`（重放投影与 live 逐字段一致——视图是日志的纯函数，无第二事实源；历史上限/连续去重）。

## 2. 测试基线

| 包 | 通过 | 说明 |
|---|---|---|
| cowcat | 915/931 | 910 → 915（overflow/system-prompt/排队/grants/checkpoint/undo-redo）；16 skip 平台既有项 |
| protocol | 44/44 | model.list/set、context.compact、grants、排队契约 |
| tui | 146/146 | **Node 26.12.0**（`npx --yes node@26.12.0 --test dist/test/`）；Node 24 下 16 个 OpenTUI FFI 渲染用例起不来（环境事实，非缺陷，既有结论） |
| cli | 41/41 | doctor FAIL 升级、帮助披露、runtime、launchers |

探针与守卫：`lint-probe` 全过、`policy-decide-probe` 16/16、`check-tarball` 四包干净、CLI 冒烟（`--version`/`help`）正常。**CI 三平台为权威门。**

## 3. 新增 ADR

**ADR-148~156**：148 doctor 双门槛 FAIL（修订 ADR-065 ⑤ 口径）· 149 TUI 操作与变更可见性闭环 · 150 溢出归一与有界收缩重试（兑现 ADR-070⑤）· 151 内核最小 system prompt（兑现 ADR-072⑤）· 152 model/context 窄协议 · 153 授权可查可撤销 · 154 排队回合 · 155 写前快照与 undo/redo · 156 历史重建与重连。分步计划（五份，Kimi 会话 superpowers 插件产物）2026-10-25 已归档至 `docs/archive/2026-10-24-p*-*.md`。

## 4. 未验证 / 风险（登记，不声称已解决）

- **TUI 人眼验收**：`/changes`、`/permissions`、Ctrl+R、双击退出只有帧快照与逻辑测试，真实终端未看（T10 人眼清单既有缺口同类）。
- **真机端到端**：overflow 70/50/35 恢复、排队排水、undo/redo 真实文件场景均为夹具级覆盖，未跑真实模型 API。
- **`docs/superpowers/plans/` 去留**：已决定（2026-10-25）——五份计划归档至 `docs/archive/`，`superpowers/` 目录移除；理由与过程见对应 docs PR。
- **Kimi 会话审计底稿**：批次源头 `flash-hawkman-longshot.md` 在 Kimi 会话目录（`~/.kimi-code/sessions/wd_cowcat_ee6ac06e6355/`），未入库；如需追溯以会话记录为准。
- **usage 预算拒绝**（P1-B 计划 Task 3 的可选项）：未做，计划里即标注 if feasible，登记不视为缺口。

## 5. 开放 issue

无。

## 6. 下一步建议

1. **评审合并本 PR**（`fix/p0-productization` → main；已合并 #210）；`docs/superpowers/plans/` 已归档（2026-10-25）。
2. **beta.4 反馈期**：ADR-148 把「默认入口门槛不足」升级为 FAIL 会改变 `docs/beta-checklist.md` 的验收口径，合入后同步该文档。
3. **TUI 人眼清单**：新面板与键位上真终端过一遍（§4 第一条）。
4. 另线：Hindsight 记忆接入文档（MCP 路径 + MemoryPort ADR 草案）在主检出未提交，走独立 docs PR。

## 7. 会话踩坑（新增）

- **中断批次的三类残留形态**：类型联合缺成员（TS2678 编译死）、CFA 收窄误杀跨 `await` 守卫（lint 恒假）、测试写在 ADR 裁决之前——接手先跑基线，再拿 ADR 表当裁判修测试，不反着来。
- **一条连接一个活动会话**：`server.openSession` 解绑先前订阅（防 A 的审批发给 B）——双会话测试必须按序附加、按序观察。
- **`restrict-template-expressions` 连 `number` 都拦**：模板串里 `String(i)`，别赌规则宽松。
- **CFA 收窄的两个解法**：删与循环条件重复的入口守卫；或把状态读进闭包函数（`stale()`），TS 不跨调用收窄。
- **Node 24 vs 26 再证**：TUI 渲染用例本机一律 `npx --yes node@26.12.0 --test dist/test/`，直接 `npm test` 的 16 个失败是环境不是回归（与 main 基线逐一比对可证）。

## 8. 构建与测试（不变）

```bash
cd packages/cowcat && npm test        # pretest = tsc + ESLint；改完必须跑这个
cd packages/protocol && npm test
cd packages/tui && npm test           # 本机用 npx --yes node@26.12.0 --test dist/test/
cd packages/cli && npm test
```

探针：`node tools/lint-probe.mjs`、`node tools/policy-decide-probe.mjs`、`node tools/check-tarball.mjs`。
