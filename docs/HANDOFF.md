# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-23（P7 第五个模块会话体验全链路收尾）**。
> 交接时仓库状态：**`main` = `27884be`，工作区干净；最新发布仍为 `v1.0.0-beta.3`（本批次未发版）。**
>
> **证据分级**：**【源码】**读代码；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（v2 跑 `dist/`）；**【CI 远端】**GitHub Actions；**【真机】**真实模型 API 跑出的会话日志；**【上游】**官方文档/上游源码；**【推断】**未实测，不作为决策依据。
>
> **归属**：本会话产出 **#153~#175**（工具结果治理、Hooks、Plan 模式、会话体验四个 P7 模块全链路 + 收尾；Skills #147~152 同属本会话前半）。

---

## 1. 本次会话做了什么

五个 P7 模块，各自走完整链路「专项调研 → ADR → 实现 → post-merge 审查修复 → 真机验收」：

### 已完成模块（概要）

- **Skills（#147~152）**：ADR-114~117；T4 真机自然触发 2/2。
- **工具结果治理 T-A（#153~157）**：ADR-118~120；clearing 派生视图/spill 50KB/repeat 轮末批量；T5 三机制全触发、零 400、cache 88%–99%。
- **Hooks（#159~163）**：ADR-121~123；CC hooks.json 兼容 v1（六事件 command-only、五配置源叠加、trust 门）；T5 block-rm 照抄 CC 文档形态零改写生效。
- **Plan 模式（#165~169）**：ADR-124~125；planMode 会话级状态 + ExitPlan 方案预审复用审批卡；审查 P0 = 超时重试被陈旧 pendingPlan 杀回合（approval 桥同病同源一并修）；T4 真机：门控拒写→模型自适应→2 方案→选中退模式→UNLICENSE 落盘。
- **会话体验（#171~175）**：ADR-126~128——
  - **会话头/标题**：session.opened 可选 cwd/model（不升版本）；标题不存只派生（首个 prompt 截断 40 字符）；SessionSummary 纯增量。
  - **session.fork**：事件重放式（parent role 'fork'、seq/ts/sessionId 重铸、失败删半截日志）；源无在跑回合才允许；fork header 继承源 cwd/model。
  - **@ 文件引用**：turn.send 扩 files；host 校验（绝对/UTF-8 fatal/32KB/8 个）后回合前注入 prompt.attached；失败拒整个 send；TUI parseAtRefs（词边界+路径字符+存在性过滤）。
  - **审查捎带修的真竞态**：attach/subscribe 的 buffer flush 由 queueMicrotask 改同步——原实现里 subscribe 后微任务前到达的事件会超车缓冲队列（表现为 [1,3,2] 乱序），该竞态自接缝诞生即存在。
  - **rewind 明确不做**（grants/锁/header 三重坑，后续立项条件 = 先答「截断后授权归哪」）。
  - T5 真机：@ 注入作答、fork 重放继承实证（fork 新回合无附件即答出源上下文）、标题/cwd/模型全字段可见。

## 2. 测试基线

| 包 | 通过 | 说明 |
|---|---|---|
| cowcat | 799+ | 逐文件全绿（host 28、session-experience 4 等） |
| protocol | 43 | |
| tui | 114 | **必须 Node 26**（本机 Node 24 是 FFI 假失败） |
| cli | 31 | |

**本机环境注意**：有两个外部 `du` 进程长期跑满磁盘 IO，全量并行的计时敏感测试（background/bash/process）本地随机 flake、**逐文件全绿**；CI 为权威门（三平台绿）。改完跑 `npm test`（含 lint），别只 `npm run build`。

## 3. 新增 ADR（本会话）

ADR-114~125（前四模块）· **126 会话头与标题推导** · **127 session.fork 事件重放（rewind 不做的理由）** · **128 @ 文件引用（校验注入、拒整个 send、@token 收窄语义）**——127/128 已按 #174 审查修订。

## 4. 未验证 / 风险

- **会话体验**：fork 万级事件的重放时延未实测；相对 @ 路径的 resume 跨目录语义（已知语义未真机）；TUI @ 无自动补全。
- **Plan 模式**：Bash 一刀切摩擦样本少；TUI 方案卡真人点击未验。
- **Hooks 已知偏差**（调研 §11.1）：updatedToolOutput 形状、纯文本 stdout、Windows 占位符、trust 目录语义。
- **T-A 遗留**：clearing 保留窗口三档对比、大会话缓存对照。
- **approval 桥语义变更**（#168）：超时后同回合下一次 ask 现在替换陈旧 pending 而非拒绝——行为变更，无已知外部依赖。
- **attach 语义变更**（#174）：subscribe 同步 flush——对服务端调用顺序的约束不变（server 先回复+重放再 subscribe），但自定义 host 消费者若依赖微任务延迟需知。

## 5. 开放 issue

无。

## 6. 下一步建议

1. **P7 下一个模块，用户选**：可观测性（D9，OTel GenAI 适配器）、审批与沙箱闭环（D7）、记忆续篇·经验蒸馏（D10）、视觉工具（D11）、Cron/Worktree。
2. **rewind**：立项前必须先答「截断后 always/session 授权归哪、锁怎么收、0 行 header 怎么办」。
3. **发版**：五个模块（Skills/T-A/Hooks/Plan/会话体验）攒一批发 `beta.4` 由用户定。

## 7. 会话踩坑（新增）

- **`@types/node` 的 assert 带断言签名**：`assert.equal(x.ok, false)` 后 TS 已收窄，守卫 if 会被 `no-unnecessary-condition` 报——收窄后直接访问。
- **事件驱动测试的时序**：completed 事件到达客户端 ≠ 主机清理完成；断言「拒绝切换」类行为要轮询。根治法（#174）：清理挂在**事件送达时同步做**，不留微任务窗口。
- **微任务 flush 是竞态温床**：「subscribe 后 queueMicrotask flush」会被期间到达的事件超车；要保序就同步 flush。
- **本机外部 `du` 进程**让全量测试 10 倍慢、计时测试随机 flake——逐文件绿即代码绿，CI 是权威。
- PowerShell here-string 不转义 `''`；带 CRLF 的文件做 .NET Replace 前先确认匹配；改完必须 `git branch --show-current`。

## 8. 构建与测试（不变）

```bash
cd packages/cowcat && npm test        # pretest = tsc + ESLint；改完必须跑这个
cd packages/protocol && npm test
cd packages/tui && npm test           # 本机用 npx --yes node@26.12.0 --test dist/test/
cd packages/cli && npm test
```

探针 `node tools/lint-probe.mjs`。真机素材：`~/.cowcat/config.json` preset `zai-coding-plan/glm-5.3-flash`；验收驱动在 `C:\Users\Con_WKK\AppData\Local\Temp\cowcat-tui-accept\`（t4-plan-accept.mjs、t5-se-accept.mjs 可复用）。
