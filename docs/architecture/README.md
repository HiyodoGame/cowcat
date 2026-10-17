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
| ADR-009 | 采用 `zod` 4 作为**解码边界**的校验库：只允许出现在 `src/adapters/`，由 lint 里单独一条 pattern 强制 | 已决定，见 [04-dependencies.md](04-dependencies.md) |
| ADR-010 | 会话单写者锁：`open(lock,'wx')` 认领 + pid 存活检测**仅用于诊断**，默认显式恢复、**不做自动接管**（构造式反例见调研 §3 附录 C） | 已决定，见 [02-kernel.md](02-kernel.md#单写者锁) |
| ADR-011 | 采用 `fast-check` 4 作为属性测试框架（开发依赖，随 `npm test` 进 CI）；种子固定，失败可用种子与 shrinking 路径复现 | 已决定，见 [04-dependencies.md](04-dependencies.md) |
| ADR-012 | 会话日志带 schema 版本头：`session.opened` 只在创建时写入，兼容性由内核判定，缺头或未知版本明确报错而不是猜测 | 已决定，见 [02-kernel.md](02-kernel.md#会话头与-schema-版本) |
| ADR-013 | 快照只是回放加速、不参与仲裁：缺失或损坏一律回退全量回放，且写入由调用方显式触发 | 已决定，见 [02-kernel.md](02-kernel.md#快照) |
| ADR-014 | **所有子进程只经 `ProcessPort` 启动**；进程树终止按平台二分：POSIX 用进程组（`detached` + `kill(-pgid)`，SIGTERM→宽限→SIGKILL），Windows 用 `taskkill /T /F` 且**必须在直接子进程仍存活时调用**；回退到单进程杀必须作为「可能残留」的事实上报；超时与取消走同一条终止路径；**明确声明自建会话（`setsid`）的后代不在保证范围内** | 已决定（P2 T1），见 [03-policy-and-execution.md](03-policy-and-execution.md#进程执行网关) |
| ADR-015 | 环境变量脱敏在 `ProcessPort` 内统一执行，`light` 与 `system` **都脱敏**、`off` 不脱敏；规则集沿用旧版三项（保留列表 / 形状正则 / 显式 deny），但**覆盖面从 1 条路径扩到全部子进程**，并把「剥离了哪些变量名」作为事实返回（只记名字不记值） | 已决定（P2 T1），见 [03-policy-and-execution.md](03-policy-and-execution.md#环境变量脱敏) |
| ADR-016 | 沙箱执行器的失败语义：**默认拒绝、不降级**（推翻旧版 `failOpen` 默认 `true`）；「授权了也没网」这类不可满足的请求**不可被配置覆盖**地拒绝，并必须给出替代路径 | 已决定（P2 T1），见 [03-policy-and-execution.md](03-policy-and-execution.md#失败模式的设计原则) |
| ADR-017 | 路径身份由 `FsPort` 独占：符号链接解析 + 最深已存在祖先回退 + 永不抛 + 缓存，任何把路径当**键**的地方（信任、会话身份、白名单、策略条目）必须走同一实现；端口方法保持**同步**，以便沙箱的策略→argv 映射仍是纯函数 | 已决定（P2 T1），见 [01-layers.md](01-layers.md#端口清单) |

## 与旧文档的关系

`docs/ROADMAP.md`、`docs/sandbox-*.md`、`docs/fix-plan-2026-10-15.md` 描述的是旧架构的演进历史，保留作为事故与教训的档案。新路线以本目录和 `docs/dev-plan-v2.md` 为准。
