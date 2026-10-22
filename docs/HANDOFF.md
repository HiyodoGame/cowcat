# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾（或用户要求做会话收尾）重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-22（P7 Skills 与工具结果治理两模块全部收尾）**。
> 交接时仓库状态：**`main` = `14ab603`，工作区干净；最新发布仍为 `v1.0.0-beta.3`（本批次未发版）。**
>
> **证据分级**：**【源码】**读代码；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（v2 跑 `dist/`）；**【CI 远端】**GitHub Actions；**【真机】**真实模型 API 跑出的会话日志；**【上游】**官方文档/上游源码；**【推断】**未实测，不作为决策依据。
>
> **归属**：本会话产出为 **#147–#157**（Skills 全链路 + 工具结果治理全链路）；更早的 TUI/后台任务/beta.3（#93–#145）属于前序会话。

---

## 1. 本次会话做了什么

两个 P7 模块，各自走完整链路「专项调研 → ADR → 实现 → post-merge 审查修复 → 真机验收」：

### Skills（#147~#152，已完成）

- 调研（#147）→ ADR-114~117 落表（#148）→ T1/T2 实现（#149）→ 审查修复（#151，3 P1 + 5 P2：NEVER_GIVEN 加 `Skill`、yaml lint 强制、`SkillNeeds` 快照化等）→ **T4 真机验收（#152）**：glm-5.3-flash 自然触发 2/2、对照 0/1，catalog 7558 字节。
- 决定要点：四类目录（`~/.cowcat/skills` 等）一层扫描；同名项目 > 个人；`metadata` 放宽为 map；catalog 预算 min(8KB, 2%) 逐条截断；catalog 作为 `skills.loaded` 事件进日志；`Skill` 工具无 pathInput、正文 ≤32KB。

### 工具结果治理 T-A（#153~#157，已完成）

- 调研（#153）→ ADR-118~120 落表（#154）→ T1~T3 实现（#155）→ 审查修复（#156，**1 P0**：同轮 `[A,A,B]` 时提醒打断 wire 配对毒化日志——改轮末统一注入；2 P1：TUI/CLI 前端消费、clearing 处置附件；4 P2：消毒/原子写/notebook 补 spill/文案分支）→ **T5 真机验收（#157）**。
- 决定要点：
  - **ADR-118 tool clearing**：派生视图非事实——最近 2 条 tool 结果全保，更旧的 output 换确定性占位符、attachments 停发（占位符明说）；日志零改动；`policy/tool-clearing.ts` 纯函数，`streamModel` 唯一应用点。
  - **ADR-119 spill**：`adapters/spill.ts`，>50KB 写 `<sessionsDir>/<sessionId>/spill/<sanitized-callId>.txt`（temp+rename 原子写），inline 留引用 + 4KB 保头（UTF-8 不撕序列）；bash/read/notebook 接入；写盘失败回退整段。
  - **ADR-120 repeat 防护**：连续同 (name, 规范化 input) ≥2 次 → 该轮全部 tool.finished 之后注入提醒 user 消息（新事件 `tool.repeat-detected` 进日志可重放）；只提醒不阻断；文案按上一次调用成败分两种。
- T5 真机：三机制全部触发（repeat 提醒 CLI stderr 可见；spill 两次落盘且模型正确理解引用语义用 od 验证；clearing 后日志 65KB vs 请求 ~6K tokens、零 400、cacheRead 88%–99%）。

## 2. 测试基线（本机全绿）

| 包 | 通过 | 跳过 | 说明 |
|---|---|---|---|
| cowcat | 745 | 16 | 含 tool-clearing/spill/tool-repeat 新测试 |
| protocol | 43 | 0 | 本批次未改 |
| tui | 104 | 0 | **必须 `npx --yes node@26.12.0 --test dist/test/`**；本机 Node 24 跑会 16 个 FFI 假失败 |
| cli | 31 | 0 | |

`tools/lint-probe.mjs` 全绿。CI 三平台绿（#156 曾因 `rmSync` 清理在 POSIX 抛 ENOTDIR 挂过 ubuntu/macos，已修——**catch 块里的清理也要兜底**）。

## 3. 新增 ADR（本会话）

ADR-114 技能来源与发现 · 115 frontmatter 兼容与 yaml 依赖 · 116 catalog 渐进披露 · 117 `Skill` 工具契约 · **118 tool clearing（派生视图/占位符/附件停发）** · **119 spill（适配器层/50KB/不承诺清理）** · **120 repeat 防护（轮末批量注入/只提醒不阻断）**。

## 4. 未验证 / 风险（必须先看）

- **clearing 保留窗口 2 条**：仍是拍脑袋值（ADR-118 ④ 已声明）；需要几十条 tool 结果的长会话做三档对比，未做。
- **clearing 缓存代价**：只有 6K 规模单点数据（88%–99% 命中）；大会话无对照数据（clearing 无开关）。
- **repeat 提醒误报面**：真机仅 1 次触发且恰当；Read 重读的噪音未实例化。
- **`~/.claude/skills` 的 33 个技能每次会话进 catalog ~7.5KB**：`paseo*` 等无关技能可给 SKILL.md 加 `disable-model-invocation: true`（每会话省 ~2k tokens）；批量开关（`skills.disabled`）不在 v1。
- **既有保留项**（前序会话）：`Shift+Enter` 多数终端等于回车（不修，用户决定）；后台任务 Windows `taskkill /T` 未人眼验证；TUI 鼠标差异。
- **`cowcat trust` 不影响运行中的会话**（四子系统共用启动时 trust 快照，全系统一致行为）——Skills 批次已登记，仍有效。

## 5. 发布状态

不变：`v1.0.0-beta.3`（tag `e8852f6`）。本会话两个模块未发版；下个发布批次会带上 Skills + 工具结果治理。

## 6. 开放 issue

无。

## 7. 下一步建议

1. **P7 下一个模块，二选一**（用户尚未选定）：**Hooks**（复用 Skills 的 YAML/Claude Code 兼容经验）或其他 dev-plan 行（Plan 模式、会话体验、可观测性……）。
2. **T-A 遗留校准项**（不阻塞）：保留窗口三档对比（长会话）、clearing 大会话缓存对照。
3. **切 `latest` 剩余门槛**：`beta-checklist.md` §4.1 连续 30 分钟、§5 平台差异（前序会话遗留）。
4. **桌面端 / Web 端形态**（远期）：`Shift+Enter` 与新交互在那里才不受终端限制。

## 8. 会话踩坑（新）

- **PowerShell 内联命令嵌套引号必坏**：复杂 `node -e` 在 PowerShell 下会被改写（三次实测），写 `.mjs` 脚本再跑；给模型传带引号的命令时，PowerShell 单引号字符串内单引号要翻倍。
- **node:test 的 pass/fail 摘要在输出前部**：`-Last 5` 只能看到 fail 行，看不到 pass 数；要看全摘要用 `Select-String "pass "`。
- **TUI 测试必须 Node 26**：本机 Node 24 跑 opentui 是「native FFI 不可用」的 16 个假失败，不代表代码坏了。
- **catch 块里的清理代码也能抛**（rmSync ENOTDIR）：Windows 不炸 POSIX 炸，清理一律再包一层兜底。
- **TS 5.5+ 会给 filter 回调推断类型谓词**：`filter(m => m.role === 'tool')` 后再写 `m.role === 'tool'` 会被 `no-unnecessary-condition` 报错——filter 后直接当已收窄用。
- **真机 glm-5.3-flash 传嵌套引号命令必丢内层引号**：两次实测都丢；验收大输出别依赖模型现场拼命令，预置文件让模型 Read 更确定性。

## 9. 构建与测试（不变）

```bash
cd packages/cowcat && npm test        # pretest = tsc build + ESLint，测试跑 dist/
cd packages/protocol && npm test
cd packages/tui && npm test           # Node >= 26.4；本机用 npx --yes node@26.12.0 --test dist/test/
cd packages/cli && npm test           # 依赖前三个已构建
```

探针（不进 lint 门禁，但改分层或发布清单时要跑）：

```bash
node tools/lint-probe.mjs             # 分层禁令逐条验证
node tools/check-tarball.mjs --install # 发布白名单 + 装 tarball 跑 --version
```

`file:` 依赖是 junction，必须按 protocol → cowcat → tui → cli 顺序构建。`main` 不可直推，走分支 + PR；提交信息 `type(scope): 中文摘要`，Windows 上用 `git commit -F <文件>`。

真机验收素材：真实模型凭证 `~/.cowcat/config.json` preset `zai-coding-plan/glm-5.3-flash`，`ZHIPU_API_KEY` 已设置；验收脚本与提交信息在 `C:\Users\Con_WKK\AppData\Local\Temp\cowcat-tui-accept\`。
