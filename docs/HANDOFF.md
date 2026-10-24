# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-24（P7 Cron/Worktree 模块全链路收尾 + `1.0.0-beta.4` 发布）**。
> 交接时仓库状态：**`main` = `0cac652`；Cron/Worktree 三 PR（#202/#205/#204）与发版批次（#208）均已合并；`1.0.0-beta.4` 已发布**——registry 核验：四包 `@beta` = 1.0.0-beta.4，support 包 `latest` 已指齐，CLI `latest` 仍是 v1 `0.15.0`（切换由 `docs/beta-checklist.md` §7 门槛决定）。**
>
> **证据分级**：**【源码】**读代码；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（v2 跑 `dist/`）；**【CI 远端】**GitHub Actions；**【真机】**真实模型 API / 真实 git 跑出的验收记录（`tools/t9-cron-worktree-accept.mjs`，13/13）；**【上游】**官方文档/上游源码；**【推断】**未实测，不作为决策依据。
>
> **归属**：本会话产出 **#202~#204**（Cron/Worktree 一个模块的两半边：调研 → ADR 落表 → T1~T7 实现 → T9 真机验收 → T8 文档收尾）。

---

## 1. 本次会话做了什么

一个 P7 模块（Cron/Worktree），走完整链路「专项调研 → ADR → T1~T7 实现 → T9 真机验收 → 文档收尾」。模块开工前确认：原表内依赖「后台任务」已完成于更早会话（#135~138，ADR-107~113），无需重做。

### Cron（ADR-140~143）

- **作业即事件（T1，`policy/cron.ts` + 内核事件）**：`cron.created/deleted/fired` 落会话日志；调度器 = 日志投影 + 宿主 1s 心跳。v1 的跨会话串台与 `-p` 失效全是「调度状态与日志两存」的结构性产物，事件溯源让 resume 恢复作业表成为免费性质。`fired` 预铸 turnId（`Session.openTurn` 增 `reservedTurnId` 可选参）——审计链在事件层钉死。
- **调度纯函数**：5 字段 vixie 子集（拒扩展语法与越界值）、`nextFire`（严格晚于、本地时区、DOM/DOW 或语义、5 年搜索界）、`isDue`（`*/5` 提前 15s 保提示缓存——ADR-141 ⑥ 半量 jitter 裁决）、50 上限、7 天 TTL。
- **宿主调度器（T3）**：空闲三重检查（`running`/`turnStarting`/`reflecting`，与 reflect 同旗）；**全局每拍至多 1 个 cron 回合**（本机版防惊群）；过期作业先最后 fire 一次再 `by:'expiry'` 自删；调度时间走注入 Clock（sessionDeps 同钟，测试假时钟驱动 due-ness）。
- **cron 回合收窄（T2/T3）**：turn-scoped `unattended`（子 agent 先例同构，零新内核机制）；`startTurn` 泛化 kind='user'|'reflect'|'cron'——cron 回合全工具面但裁 planReview/escalation（桥前拒绝不如不上线）；unattended 宿主无端口无工具无调度（ADR-112 同款）。
- **工具与用户面（T2/T4/T6）**：CronCreate/CronList/CronDelete（Create/Delete risk=write——无人值守花费默认 ask）；协议 `cron.list`/`cron.remove`（不 bump 版本，task.stop 先例）；用户删除写 `cron.deleted by:'user'`；TUI `/cron` 面板（x 删除只认事件）与 ⏰「定时任务触发（无人值守）」回合标注；`cron.enabled` user 层 only。

### Worktree（ADR-144~147，P2 接口债兑现）

- **形态**：`cowcat tui --worktree <name>`——宿主经 ProcessPort `git worktree add .cowcat/worktrees/<name>`（HEAD 基点，sandbox off，宿主动作非模型工具）；已存在复用；link 路径拒绝。
- **信任（ADR-145）**：主检出受信 → 创建成功即 `FileTrustStore.add` 显式继承（可审计可单独撤销）；不受信 → 拒绝且先于一切动作。**不做** CC 的 `-p` skip（ADR-016）与 repo identity 推导（ADR-028 启动快照纪律）。
- **resume 恢复 cwd（ADR-146，存量缺口修复）**：`sessions resume`/`tui --session` 读会话头 cwd 建宿主；目录消失 → stderr 警告并在启动目录继续；只追加不改历史。**行为变更**：旧行为静默在启动目录跑。
- **写策略（ADR-147）**：`createHost.extraWritePaths/extraReadPaths`——worktree 会话追加主检出 `.git` 的 canonical 路径（`git rev-parse --absolute-git-dir`），worktree 里 `git commit` 沙箱内可用；CC 四条隔离检查第一版不做（被否 #6）。
- **退出清理**：`git status --porcelain` + 未推送提交（`log <branch> --not --branches --remotes`）双检查，干净才删树删分支；检查失败保留。

### T9 真机验收（13/13 过，`tools/t9-cron-worktree-accept.mjs`）

- **Cron 腿**（deepseek-flash 真实端点）：自然语言 CronCreate（无教学）→ 心跳 fired → `fired.turnId === turn.opened.turnId` → cron 回合 Write 询问被 `by:'unattended'` 拒绝并留审计 → 一次性 fire 后投影自删 → 周期作业 nextRun/过期 → `cron.remove` 写 `by:'user'`。
- **Worktree 腿**（真 git）：ensureWorktree + 信任继承进 trust.json → 会话头 cwd=worktree → 会话内 Write + `git commit` 经审批成功（沙箱放行主检出 `.git`）→ 提交落 worktree 分支且主检出 `git log` 可见。
- 验收期外部事件：智谱账号 429（余额耗尽）——产品如实记录失败（turn.failed 带原因），驱动改走内置 deepseek provider 完成；catalogue 的 `deepseek-flash` output 上限（393216）为未实测数字，驱动用自定义 preset 限 8192（视觉模块教训再次应验）。

## 2. 测试基线

| 包 | 通过 | 说明 |
|---|---|---|
| cowcat | 910 | 870 → 910（cron 解析/工具/调度器/worktree）；逐文件全绿，16 skip 为平台既有项 |
| protocol | 44 | 43 → 44（cron.list/cron.remove 契约） |
| tui | 121 | 119 → 121（/cron 折叠与回合标注；**需 Node 26**，本机 `npx --yes node@26.12.0 --test dist/test/`） |
| cli | 31 | 不变全绿（--worktree flag、doctor worktree 行） |

**本机环境注意**：外部 `du` 进程干扰与计时 flake 的既有结论不变；CI 为权威门（三平台）。

## 3. 新增 ADR

**ADR-140~147**（#203，草案见 [`research/p7-cron-worktree.md`](research/p7-cron-worktree.md) §4）：140 作业即事件 · 141 触发语义（含 §9-1 取 7 天过期、§9-2 半量 jitter、§9-6 到期最后 fire 一次三裁决）· 142 cron 回合 turn-scoped 收窄 · 143 工具与用户面（§9-3 配置键裁决）· 144 Worktree 形态（§9-4 `run --worktree` 留后续、§9-5 `.worktreeinclude` 留后续）· 145 信任创建时显式继承 · 146 resume 恢复 cwd · 147 extraWritePaths 兑现 P2 接口债。

## 4. 未验证 / 风险（登记，不声称已解决）

- **TUI 人眼验收**：`/cron` 面板与 ⏰ 标注只有帧快照覆盖，真实终端渲染未看（T10 人眼清单的既有缺口同类）。
- **CLI 端到端**：`tui --worktree` 的 chdir/退出清理是薄胶水（单元测试 + 真 git 探针覆盖），真终端组合未跑；resume 恢复 cwd 同理。
- **cron 回合委托子 agent**：代码路径有测试，真机未遇。
- **外部 `git worktree remove` 对在跑会话的影响**（调研 §8-4）：宿主运行期间不防外部删除，表现未实测。
- **Windows 路径矩阵**：短名（8.3）、含空格的 worktree 路径未跑（常规路径真机已过）。
- **智谱 429**：账号余额问题，非产品缺陷；glm 路线的 cron 真机复验待充值后。
- **失败的 cron fire**（如模型未配置）：下拍重试，无退避——真机未遇。

## 5. 开放 issue

无。

## 6. 下一步建议

1. **评审合并三 PR**：#202（调研）→ #203（ADR，链 #202）→ #204（实现 T1~T9；合并前 retarget main）。合并顺序不可乱（#203 基于 #202，#204 基于 main 但语义依赖 #203 先落）。
2. **P7 下一个模块，用户选**：剩 NotebookEdit/PDF、WebFetch/WebSearch、`run --worktree`（§9-4）、`.worktreeinclude`（§9-5）；或处理 beta.4 反馈期的 checklist 验收。
3. **beta.4 反馈期**：按 `docs/beta-checklist.md`（beta.4 标题）走验收，§7 五个门槛满足后再切 CLI `latest`。

## 7. 会话踩坑（新增）

- **`turn.send` 应答跑赢回合本身**：send 的 RPC 回复在 turn.opened 后即可返回，回合随后才跑完——断言作业/事件存在前必须等到了 `cron.created`/`turn.completed`；动了时钟的测试同理（createdAt 可能落在推进后的时钟上，next fire 推远一分钟）。三个测试栽在这。
- **块注释里的 `` `*/5` `` 会提前闭合 docblock**（`*/` 序列）——cron 源码注释里写表达式要拆开写。
- **`canonical()` 把缺失尾巴重拼成平台分隔符**：比较用户拼写与 canonical 结果必须先 `normalize` 拼写（Windows 下 `/` vs `\`）。
- **PowerShell 双引号字符串会插值 `${...}`**：脚本化批量替换 `.ts` 文件内容时模板里的 `${main}` 被吃掉、替换静默不生效——用 edit 工具或单引号。
- **真 git 的两处教材**（调研 §8-1 的价值实证）：无 remote 时 `--not --remotes` 把主检出已有的提交算成未推送；删目录不留情面会触发 stale registration 拒建，须 `prune` 后重试。
- **catalogue 数字必须实测**（第三次应验）：`deepseek-flash` 内置 output=393216 是推断级，验收驱动用自定义 preset 绕开。
- **真机验收断言要对协议形状**：`session.open` 应答按设计不带 cwd（ADR-126 ③ 走 `session.list`），断言写错地方会把产品误判成缺陷。

## 8. 构建与测试（不变）

```bash
cd packages/cowcat && npm test        # pretest = tsc + ESLint；改完必须跑这个
cd packages/protocol && npm test
cd packages/tui && npm test           # 本机用 npx --yes node@26.12.0 --test dist/test/
cd packages/cli && npm test
```

探针：`node tools/lint-probe.mjs`、`node tools/t9-cron-worktree-accept.mjs`（真机，需 ZHIPU_API_KEY 或 DEEPSEEK_API_KEY）。真机素材 preset：驱动内自定义 `deepseek/t9-flash`（避开 catalogue 未实测限额）。
