# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-28（TUI 原生组件化与奶牛猫动效）**。
> 交接时仓库状态：**本地 `main` 已合入 `feat/component-tui`，基线 `61979b5`，未推送远端**。
>
> **证据分级**：**【源码】**读代码；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（v2 跑 `dist/`）；**【CI 远端】**GitHub Actions；**【真机】**真实模型 API / 真实终端验收；**【上游】**官方文档/上游源码；**【推断】**未实测，不作为决策依据。

---

## 1. 本批完成

按“原生组件契约 → 布局与业务组件 → 像素猫与状态机 → 真实渲染与全量验证”实施。协议、内核事件格式和端口未改。

| 类别 | 内容 | 结果 |
|---|---|---|
| 组件契约 | ADR-171：纯数据 `SceneNode` + 稳定 key + `ui/` 原生 renderable 适配层 | 不再以 `╭/▌/▸/[x]` 等字符模拟边框、色条、选择或复选状态；Markdown 与 diff 正文保留 |
| 基础组件 | `scene.ts`、`primitives.ts`、`composer.ts`、`dialog.ts` | Panel、ChoiceList、Status、Sprite、Image 统一边框、背景、点击和原位更新；旧 `ui/card.ts` 删除 |
| 布局 | ≥144 三栏，104–143 双栏，<104 单栏；中栏阅读宽度上限 100 | 中屏不再同时挤压正文；长会话 ID 与路径可换行显示；窄屏活动信息回 dock |
| 对话与操作 | 消息、工具、审批、计划、信任、任务、cron、会话、权限、变更、命令菜单、状态栏全部迁移 | 选中态使用整行背景；审批主体/规则/警告完整换行；短终端保留审批选项；附件说明在图片前 |
| 奶牛猫 | 固定 24×16 像素精灵：白毛、黑色斑块、粉色鼻尖、眼睛、身体与尾巴 | 不依赖 ASCII 或终端图片协议；idle/thinking/tools/approval/success/failed 六态 |
| 状态与动效 | 主回合接入，优先级为待审批 > 工作 > 思考 > 短暂结果反馈 > idle | 200ms 活跃帧与约 4 秒 idle 眨眼；`COWCAT_ANIMATIONS=off` 冻结；隐藏/销毁停止计时器 |
| 状态栏 | 主活动 + 模型/模式/时间/上下文/用量等结构化事实 | 窄宽度优先保留当前动作，不再用完整会话 ID 和全部指标堆满一行 |
| 真实问题修复 | 原生 borderColor 后写会重开边框；Rail 高度因此少一行 | 先设置颜色再禁用边框；真实帧证明待办、路径和 ID 恢复显示 |
| 消费方与探针 | CLI 测试读取场景结构；lint 允许 `ui/**` 与 `run.ts` 接触 OpenTUI；smoke 覆盖信任门与二次退出 | 完整协议回合、分层规则与真实进程退出均验证 |

## 2. 验证结果

| 包 / 检查 | 结果 | 证据 |
|---|---|---|
| protocol | 47/47 | `npm --prefix packages/protocol test` |
| cowcat | 932 通过、16 个既有平台 skip，0 fail | `npm --prefix packages/cowcat test` |
| tui | **201/201** | Node 26.12，`npx --yes node@26.12.0 --test "packages/tui/dist/test/**/*.test.js"`；build + ESLint 同过 |
| cli | 41/41 | `npm --prefix packages/cli test`；真实协议审批回合通过 |
| 原生渲染 | 80/120/150 档、CJK、长路径、审批、图片、猫咪颜色与主题 token | `createTestRenderer` 字符帧与 color spans；新 golden 逐帧检查 |
| 性能 | frameOf：100 轮约 0.07ms、200 轮约 0.09ms；思考 tick 约 16.31ms | `node tools/tui-perf-probe.mjs`；保留 entry cache 与可见区域挂载 |
| 探针 | 分层、OpenTUI API、Impeccable detector | `tools/lint-probe.mjs`、`tools/tui-api-probe.mjs`、Impeccable `detect --json` |
| 真实进程 | 信任选择、会话落盘、Ctrl+C 退出、锁释放 | Node 26.12 `tools/tui-smoke.mjs`，隔离 `COWCAT_HOME` |

## 3. 独立审查与修复

独立 reviewer 找到 1 Critical、6 Important 和 2 Minor，全部已在同一修复批次处理：

- **长审批安全**：正文使用原生 `ScrollText`，固定允许/拒绝操作，初始显示命令尾部，鼠标回看时不再自动拉回。
- **组件正确性**：按 key 在指定索引替换；图片每次同步当前 source；`COWCAT_WIDTH=full` 同步移除中栏宽度上限。
- **长列表与状态**：模型对话框使用滚动列表和固定 footer；provider/effort 的状态以可读「当前」文本保留。
- **思考与计时**：窄屏独立推进思考，关闭动画立即完整揭示；主回合与后台工作立即切换活跃帧，idle 精确安排眨眼开闭。
- **测试**：补充真实渲染回归和 `runTui` 集成验证，覆盖 80 列、120 列、关闭动画、鼠标滚动与退出。

## 4. 本批 ADR

- **ADR-171** 所有装饰使用原生组件树；三档响应式布局；固定尺寸奶牛像素精灵；保留纯 frame、keyed 更新与可见区域挂载。
- 既有 ADR-167 的 ASCII 猫与统一 120 列断点、ADR-164 的字符色条标题由新决策替代；`06-frontend.md` 的目录与分层说明已同步。

## 5. 未验证 / 风险

- **真实终端观感**：真实进程启动与退出已验证，但没有取得新分支的可见窗口截图；不同终端的色彩、闪烁、原生图片协议与长时间使用仍需按 beta-checklist 人眼验收。
- **原生图片协议**：headless 证明 `ImageRenderable` 的布局及 blocks 回退；kitty/sixel 未实测。
- **远端 CI**：本批没有推送或运行 GitHub Actions，三平台 CI 仍需作为合并前权威门。
- **真实模型**：本批不调用付费模型端点，不新增模型行为声明。
- **公开 TUI 组件 API**：旧的字符卡片导出被结构化组件替代；这是刻意的界面与渲染契约重构，不保留旧装饰兼容层。

## 6. 下一步建议

1. 完成独立代码审查与全量验证后，由用户决定提交、推送分支和创建 PR；不直推 main。
2. 在目标终端检查 80/120/160 列、关闭动画、长对话滚动、审批与真实图片协议。
3. 合并后按 beta-checklist 做真实模型与持续使用验收。
