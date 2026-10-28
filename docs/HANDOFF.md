# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-28（完整服务商配置与首次启用引导）**。
> 交接时仓库状态：**未提交分支 `fix/provider-dialog-cowcat-logo`，基线 `f39c085`，未推送远端**。
>
> **证据分级**：**【源码】**读代码；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（v2 跑 `dist/`）；**【CI 远端】**GitHub Actions；**【真机】**真实模型 API / 真实终端验收；**【上游】**官方文档/上游源码；**【推断】**未实测，不作为决策依据。

---

## 1. 本批完成

本批先修复弹窗与「奶痞猫」，随后按用户实际测试补齐服务商配置和首次启用流程。新增 ADR-172；不改变内核事件格式或模型 SDK。

| 类别 | 内容 | 结果 |
|---|---|---|
| 完整服务商配置 | `provider.configure` + `providerForm` 分步状态机 | 内置模板选择真实模型；自定义 OpenAI/Anthropic 收集端点、key 引用、模型、必要限额和工具能力，不再只保存名称 |
| 原子持久化与应用 | `writeUserProviderConfiguration`、宿主校验与缓存更新 | provider、preset、默认模型一次写入；保留其它配置；成功后应用当前会话，保留其它显式会话覆盖 |
| 首次启用 | 结构化 `not-configured` 路由与草稿保存 | 发送或 `/model` 直接进入配置；保存或取消后恢复草稿，保存不自动调用模型 |
| 凭据边界 | 仅 `apiKeyEnv` 名称 | 不接收或保存 secret；URL 凭据被拒绝；缺 key 返回 `requiresRestart`，不冒充已可用 |
| 弹窗与筛选 | 不透明背景、修饰键边界、共享过滤结果 | 普通 `a` 新增、Shift+A 搜索、Enter 不选错项目；旧的 incomplete 条目可用同一向导补全 |
| 奶痞猫与动画 | 方向 B 标识、28×20 半像素头像、六态相位排程 | 不透明半块、idle 呼吸/眨眼/视线、思考/工具动画，关闭动画全部静止 |

官方调研与证据见 `docs/research/provider-onboarding.md`（OpenCode、Codex、Claude Code 官方文档）。

## 2. 验证结果

以下为**本分支实际执行**的命令与结果：

| 包 / 检查 | 结果 | 证据 |
|---|---|---|
| tui | **220/220，0 fail** | Node 26.12，build + ESLint 后完整 `node:test` |
| 配置交互 | 完整自定义键盘流程、无模型发送、保存/取消恢复、`/model` 入口 | `test/provider-dialog.test.ts`、`test/provider-form.test.ts`；断言完整 `provider.configure` 与零自动模型调用 |
| 宿主与持久化 | 目录、校验、完整写盘、激活、缺 key、原子写、扩展字段保留、非法输入分类 | `test/provider-onboarding.test.ts`、`test/providers.test.ts` 与 `test/host.test.ts` 定向通过 |
| protocol | **48/48，0 fail** | 完整 `provider.configure` 协议往返 |
| cowcat | **939 通过、16 个既有平台 skip，0 fail** | `npm --prefix packages/cowcat test`；build + ESLint 通过 |
| cli | **41/41，0 fail** | `npm --prefix packages/cli test`；真实协议审批回合通过 |
| 猫咪渲染与动画 | 固定尺寸、透明组合、真实相位与 reduced-motion | 完整 TUI 套件覆盖 |
| 探针 / 打包 / 真实进程 | 全部通过 | `lint-probe`、Node 26.12 `tui-api-probe`、`tui-smoke`（启动、绘制、退出 0、无残留锁）、`check-tarball` 与 `git diff --check`；不宣称真实终端观感或远端 CI |

## 3. 自审与修复

前一轮 4 个 Important（Shift+A、半像素透明、动画排程、过滤选择）均已先失败复现再修复。新配置批次两次尝试独立 reviewer：主模型遇到 5 小时配额限制，备用模型路由不可用，因此改为**当前会话自审**（弱于独立 reviewer，不冒充独立审查）。

自审补上的两项回归：
- **preset 扩展字段保留**：编辑时不再丢弃 effort、价格和厂商扩展项；只合并本次明确配置的字段。
- **非法输入分类**：配置校验失败返回 `hostRefused`，不写成内部错误，也不留下半截配置。

通用 Sprite 缩小后的旧行/列残留仍为 deferred Minor：当前猫咪尺寸固定，不触发该路径。

## 4. 本批 ADR

- **ADR-172** 完整服务商配置、原子保存并应用、未配置模型的可恢复引导。
- **ADR-171** 奶痞猫头部标识、28×20 半像素头像与真实相位排程。
- **ADR-166/165** 普通 dialog 输入与字段补丁保留兼容，完整配置由 `providerForm` 和 `provider.configure` 承担。
- **ADR-167** 活动栏预算左 32 / 右 30。
- 品牌指南升级 v1.2；`06-frontend.md` 同步。

## 5. 未验证 / 风险

- **真实终端观感**：真实进程启动与退出已验证，但没有取得新分支的可见窗口截图；不同终端的色彩、闪烁、原生图片协议与长时间使用仍需按 beta-checklist 人眼验收。自动化工具不能直接操作终端窗口。
- **原生图片协议**：headless 证明 `ImageRenderable` 的布局及 blocks 回退；kitty/sixel 未实测。
- **远端 CI**：本批没有推送或运行 GitHub Actions，三平台 CI 仍需作为合并前权威门。
- **真实模型**：本批不调用付费模型端点，不新增模型行为声明。
- **公开 TUI 组件 API**：旧的字符卡片导出被结构化组件替代；这是刻意的界面与渲染契约重构，不保留旧装饰兼容层。

## 6. 下一步建议

1. 由用户决定提交、推送分支和创建 PR；不直推 main。
2. 在目标终端检查 80/120/160 列、关闭动画、长对话滚动、审批与真实图片协议。
3. 合并后按 beta-checklist 做真实模型与持续使用验收。
