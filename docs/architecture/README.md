# CowCat v2 架构文档

> 状态：P0 完成（架构基线 + 内核骨架）。本目录随实现同步更新；与代码不一致时以代码和测试为准，并在同一 PR 里修正文档。

## 目标

CowCat 是一个长期分发的 npm 编程 agent。v2 的目标不是在旧代码上继续加功能，而是建立一个**可测试、可替换、可跨平台**的运行底座，再把功能按模块挂上去。

## 文档索引

| 文档 | 内容 |
|---|---|
| [01-layers.md](01-layers.md) | 分层、包结构、依赖方向（有 lint 强制） |
| [02-kernel.md](02-kernel.md) | 事件、会话日志、Turn 状态机、回放、取消 |
| [03-policy-and-execution.md](03-policy-and-execution.md) | 策略引擎、端口、进程执行网关、沙箱执行器 |
| [04-dependencies.md](04-dependencies.md) | 依赖策略与每个依赖的选择依据 |
| [05-platforms.md](05-platforms.md) | Windows / macOS / Linux / 鸿蒙 的平台策略与调研结论 |
| [../dev-plan-v2.md](../dev-plan-v2.md) | 全面重构的阶段计划与出口标准 |

## 架构决策记录（ADR）

| 编号 | 决策 | 状态 |
|---|---|---|
| ADR-001 | 语言迁移到 TypeScript，编译产物为 ESM JavaScript（tsc，不 bundle） | 已落地（P0） |
| ADR-002 | 内核采用事件溯源：持久化的是事实事件，状态由事件归约得到 | 已落地（P0） |
| ADR-003 | 内核、策略、端口层与运行时解耦：禁止直接引用 `node:*`，由 lint 强制 | 已落地（P0） |
| ADR-004 | 不保留旧版兼容：旧会话、旧配置、旧 CLI 参数不迁移 | 已决定 |
| ADR-005 | 依赖以「是否承担协议或安全责任」为准绳，协议与安全类优先采用官方维护的库 | 已决定，具体依赖分阶段引入 |
| ADR-006 | 新实现与旧 `agent/` 并存于 `packages/cowcat`，旧代码在 P8 切换后删除 | 已决定 |
| ADR-007 | Windows 原生沙箱不在 v2 初期交付；`system` 档在不支持的平台上显式拒绝而不是降级 | 已决定，调研见 05 |
| ADR-008 | 鸿蒙原生支持是后续目标；现阶段的唯一约束是内核不依赖宿主运行时 | 已决定，调研待专项 |
| ADR-012 | 会话日志带 schema 版本头：`session.opened` 只在创建时写入，兼容性由内核判定，缺头或未知版本明确报错而不是猜测 | 已决定，见 [02-kernel.md](02-kernel.md#会话头与-schema-版本) |
| ADR-013 | 快照只是回放加速、不参与仲裁：缺失或损坏一律回退全量回放，且写入由调用方显式触发 | 已决定，见 [02-kernel.md](02-kernel.md#快照) |

## 与旧文档的关系

`docs/ROADMAP.md`、`docs/sandbox-*.md`、`docs/fix-plan-2026-10-15.md` 描述的是旧架构的演进历史，保留作为事故与教训的档案。新路线以本目录和 `docs/dev-plan-v2.md` 为准。
