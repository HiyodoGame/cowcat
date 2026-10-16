# CowCat v2 开发计划

> 取代 `docs/ROADMAP.md` 作为路线依据。架构细节见 [architecture/](architecture/README.md)。
> 最后更新：2026-10-17。

## 工作规则

1. **每个阶段开始前先做调研**，产出一份 `docs/research/<阶段>.md`：回答阶段内的开放问题，列出被否决的方案及理由。没有调研文档的阶段不开工。
2. **决策进 ADR**。影响边界、依赖、平台支持的决定，写进 `docs/architecture/README.md` 的 ADR 表，或单独成文。
3. **契约先于实现**。端口与事件类型先定义，再写适配器；每个适配器都要有契约测试，供替代实现复用。
4. **测试先证明行为，再迁移旧代码**。旧 `agent/` 的行为作为参照，但迁移的是「被证明的结论」，不是代码本身。
5. **所有改动走 PR**，分支保护门禁不变。文档与代码同 PR 更新。
6. **验证口径**：「已验证」只指本机或 CI 实际跑过的结果；未在目标平台跑过的，必须标注「未验证」。
7. **旧代码不维护**。旧 `agent/` 在 P8 切换前只接收安全修复，不接收功能。

## 阶段总览

| 阶段 | 主题 | 状态 |
|---|---|---|
| P0 | 架构基线与内核骨架 | **已完成**（PR #24，`dca0d31`） |
| P1 | 内核加固与工程基线 | **已完成**（PR #31–#38，测试 22 → 69） |
| P2 | 端口与执行网关（含沙箱执行器迁移） | 未开始 |
| P3 | 策略、配置与审批协议 | 未开始 |
| P4 | 模型层 | 未开始 |
| P5 | 工具层 | 未开始 |
| P6 | 前端：headless 协议与 TUI | 未开始 |
| P7 | 功能模块（逐个调研） | 未开始 |
| P8 | 发布切换与旧代码删除 | 未开始 |
| R1 | Windows 原生沙箱调研 | 远期 |
| R2 | 鸿蒙运行时调研 | 远期 |

---

## P0 架构基线与内核骨架（已完成，PR #24）

**目标**：确立分层、依赖规则与内核的核心契约，并用测试证明它们成立。

**交付（已完成）**

- `docs/architecture/` 六份文档 + ADR 表
- `packages/cowcat`：TypeScript 工程（strict、exactOptionalPropertyTypes、noUncheckedIndexedAccess）
- 内核：事件类型、状态归约、Turn 状态机、`Session`（追加 / 回放 / 订阅）、`runTurn`
- 策略：纯函数 `decide`，deny > ask > allow，未命中即 ask
- 适配器：JSONL 会话存储、系统时钟、随机 ID
- `node:*` 导入禁令（lint 强制，已用探针验证会报错）

**出口标准与验证结果**

- [x] `npm run build` 通过（tsc，TS 6.0.3）
- [x] `npm run lint` 通过（eslint 10.13.0 + typescript-eslint 8.71.2，strictTypeChecked）
- [x] `npm test` 22 项全部通过（状态机合法跃迁、策略优先级、回合各路径、回放等价、JSONL 往返与损坏行报错）
- [x] CI 已覆盖 `packages/cowcat`（Linux · Node 22 作业为分支保护必过检查；Windows 腿仅在 main 运行，尚无可核对的真实运行记录）

**未覆盖（有意推迟）**：并发写入、快照、schema 校验、真实模型与工具。

---

## P1 内核加固与工程基线（已完成，PR #31–#38）

> 调研文档：[research/p1-kernel.md](research/p1-kernel.md)（含评审修订 r2）。实现中的偏差、证据与残余风险逐条记在该文档 §8。契约落点见 `architecture/02-kernel.md`。

**调研问题**

- zod 4 与 valibot / typebox 在本场景下的取舍（bundle 体积无关紧要，关心的是类型推导质量与错误信息）
- 单写者锁的实现：文件锁（`O_EXCL` 锁文件）是否足够，是否需要 pid 存活检测
- TypeScript 7（原生版）是否已经在 typescript-eslint 与测试工具链上稳定，决定是否迁移

**范围**

1. 会话头事件（schema 版本、创建时间、CowCat 版本），打开旧版本日志时明确报错
2. zod 在解码边界校验每一行日志；校验失败报告行号与字段
3. 单写者锁：同一会话同时只能有一个写入者；异常退出后的锁可恢复
4. 快照：可选加速，丢失快照不影响正确性（用属性测试证明：任意快照点回放结果相同）
5. 属性测试（fast-check）：对随机事件序列，验证「回放等于实时状态」与「非法跃迁一律被拒绝」
6. CI（已按决定实现，见 `.github/workflows/ci.yml`）：`packages/cowcat` 的 Linux + Node 22 作业在每个非草稿 PR 上运行；Windows 仅 main，先保守放 main，等实测耗时后再决定是否上 PR。旧套件在 P8 前只在 `agent/` 或 CI 配置变更时运行，通过 `scope` 作业判断；未能判断时一律运行
7. 依赖 ADR：zod、fast-check

**交付（已完成）**

- 会话头事件 `session.opened` 与 schema 版本判定（ADR-012）
- `zod` 4 在解码边界逐行校验，报错含行号与字段路径（ADR-009）
- 单写者锁：`LockPort` + 文件锁协议，默认显式恢复、**不做自动接管**（ADR-010）
- 快照：`SnapshotPort` + `<sessionId>.snapshot.json`，缺失或损坏一律回退全量回放（ADR-013）
- 属性测试：`fast-check`，种子固定（ADR-011）
- 两处**编译期等价断言**：内核事件联合 ↔ schema、`SessionSnapshot` ↔ schema（漂移即构建失败）

**出口标准与验证结果**

- [x] 上述 CI 作业在 PR 上绿（`packages/cowcat · node 22 · ubuntu-latest` 已是必过检查）
- [x] 属性测试通过且种子可复现（种子固定，`COWCAT_PROPERTY_SEED` 可覆盖；失败输出自带 `seed` 与收缩路径）
- [x] 故意写入一条非法日志，能被定位到行号与字段（`line 2: to: …` 与 `line 2: not valid JSON` 各有测试）
- [x] `packages/cowcat` 的测试由 22 项增至 **69** 项
- [x] 三个依赖决定各有一条 ADR，且**实现过程中没有一条被推翻**

**已知缺口（不声称已解决，逐条有出处）**

- **快照只省归约、不省 IO**，且没有任何自动调用点（ADR-013 明示，触发点留给 P6 的组合根）
- **「结构合法但日志不认」的快照不会被发现**（刻意篡改或字符串字段位翻转）——要发现它需要快照携带所覆盖前缀的摘要，见调研 §7 第 7 条
- **macOS 上的锁行为未覆盖**（`macos-15` 作业按需）；Linux 与 Windows 已由 CI 的 PR 腿与 main 腿各自跑过 69 项
- **三个 schema 库在真实 schema 上的对比未做**，理由是 §2.3 已给出选型依据并保留重估条件
- 测试的**覆盖上限由生成器决定**（属性脚本最多 3 次工具调用、入参嵌套深度 2）

---

## P2 端口与执行网关

**调研问题**

- 进程树终止在 Windows 与 POSIX 上的可靠做法（`taskkill /T /F`、进程组）；是否存在子进程逃逸 `taskkill` 的已知情况
- 旧版 seatbelt 与 bwrap 实现中，哪些结论必须保留（见 `docs/fix-plan-2026-10-15.md` 第十六至二十轮）
- 环境变量脱敏的规则集是否与旧版一致，哪些需要补充

**范围**

1. `ProcessPort`：统一的启动网关；取消、超时、输出截断、进程树终止、环境脱敏
2. `FsPort`：路径规范化（迁移旧版 `canonical.js` 的结论：符号链接与大小写统一在这一层做）
3. `PlatformPort`：shell 解析（Windows：Git Bash → PowerShell）、会话头记录实际 shell、进程树终止策略
4. `SandboxExecutor`：`light`、`seatbelt`（迁移）、`bwrap`（迁移）；`system` 档在不支持的平台上拒绝
5. 旧版的 G1 / G2 / G3 语义与 `rm` 可用、私有临时目录等断言，迁移为新测试
6. lint 规则：禁止 `child_process` 与 `fs` 绕过 ProcessPort / FsPort（适配器内除外）

**出口标准**

- Linux 上 bwrap 执行器的 G1/G2/G3 测试通过
- macOS 上 seatbelt 执行器的 G1/G2/G3 测试通过（按需触发 `macos-15` 作业；未触发前标注「未验证」）
- Windows 上 `system` 档请求被拒绝，拒绝信息包含替代路径

---

## P3 策略、配置与审批协议

**调研问题**

- 配置分层：用户级、项目级、会话级的优先级与合并语义；项目级配置在不受信任的仓库里能否生效（参考旧版 `trust.js` 的结论）
- 规则语言：纯数据（JSON）规则，还是允许少量表达式；倾向纯数据，待对比
- 审批协议：`ask` 在内核中如何表达为事件，前端如何回应，超时与无人值守模式如何处理

**范围**

1. 配置 schema（zod），加载与分层合并，错误报告带文件与路径
2. 路径信任模型：工作区是否受信任、信任记录如何持久化
3. 规则集从默认规则扩展为可配置规则，保留「deny > ask > allow」与「未命中即 ask」
4. 审批：`approval.requested` / `approval.answered` 作为事件进入日志，支持无人值守模式的显式开关
5. 审计：作为事件的消费者，而不是内核内的分支

**出口标准**

- 策略的全部裁决都能由配置表达，无需改代码
- 无人值守模式下，所有 `ask` 的动作要么按显式规则放行，要么拒绝并留审计

---

## P4 模型层

**调研问题**

- `openai` 与 `@anthropic-ai/sdk` 的流式、重试、取消语义；是否满足 `ModelPort` 契约
- 国产厂商的 OpenAI 兼容端点差异（工具调用格式、流式增量格式、错误码）；逐家核实，不凭印象
- Anthropic 端点是否必须走官方 SDK，还是 OpenAI 兼容层即可

**范围**

1. `ModelPort` 适配器：OpenAI 兼容协议（主力）、Anthropic 协议
2. 流式归一化：文本增量、工具调用拼装、用量统计，统一成内部 `ModelChunk`
3. 重试与退避：仅对可重试错误；取消立即生效
4. 录制-回放夹具：CI 中不访问网络，协议行为由夹具固定
5. 模型预设（厂商、端点、默认模型）以数据形式存在，不写死在代码里

**出口标准**

- 同一个回合脚本，在两种协议的录制夹具上得到相同的事件序列（归一化后）
- 取消在流式中途生效，且不产生半条 `model.message`

---

## P5 工具层

**调研问题**

- 工具输入 schema 到模型所需 JSON Schema 的转换方式
- 输出截断策略与「截断事实」的记录方式（沿用 ProcessPort 的 `truncated` 约定）
- 纯 JS 的 Glob / Grep 在大仓库上的性能下限，是否需要可选的 ripgrep 加速

**范围**

1. 工具定义 API：名称、风险等级、zod 入参、执行函数
2. 核心工具：Read、Write、Edit、Glob、Grep、Bash（经 ProcessPort）、TodoWrite
3. Edit 的精确替换语义与旧版保持一致（唯一性检查、`replace_all`）；先用测试固定行为
4. 只读工具并发策略：默认串行；若要并发，必须有测试证明结果顺序
5. Notebook、PDF、图像等文档类工具不在 P5，作为 P7 的模块

**出口标准**

- 核心六个工具的契约测试通过；Edit 的边界用例（多处匹配、空匹配、CRLF）全部覆盖
- 与旧版工具清单对照，缺失项都有明确的「推迟到 P7」记录

---

## P6 前端：headless 协议与 TUI

**调研问题**

- headless 协议形态：JSON-RPC over stdio 是否足够；是否需要 SSE 或 WebSocket 给 IDE 用
- TUI 渲染：自研（沿用 wcwidth 与区域刷新）还是 ink；以实际终端的刷新率与闪烁做测量，不凭经验
- 命令行入口与子命令结构，参考旧版 `cliargs.js` 的经验

**范围**

1. headless 协议：版本化，覆盖会话打开、发送输入、订阅更新、回应审批、取消
2. 协议层的契约测试（不启动真实终端）
3. TUI 只通过协议工作：渲染订阅到的事件，不持有会话状态副本
4. `cowcat` 命令行入口

**出口标准**

- 用 headless 协议完整跑通一个带工具与审批的回合（测试中）
- TUI 中删除任何直接访问内核内部的代码路径（lint 或测试保证）

---

## P7 功能模块（逐个调研，逐个 ADR）

每个模块开工前必须有调研文档。顺序按依赖关系排列，但可以按需调整。

| 模块 | 调研要点 | 依赖 |
|---|---|---|
| 上下文压缩 | 压缩触发点、压缩结果是否作为事件入日志、与回放的关系 | P2、P5 |
| 记忆（AGENTS.md / 项目指令） | 读取位置、优先级、与信任模型的关系 | P3 |
| 子 agent | 子会话是否独立日志、结果如何回传、权限是否收窄 | P3、P5 |
| MCP | 官方 SDK 评估；stdio 服务器必须经 ProcessPort，因此天然被沙箱覆盖 | P2、P3 |
| Hooks | 触发时机、失败语义、是否经过策略 | P3 |
| Skills | 加载机制与工具暴露 | P5 |
| 后台任务 | 生命周期与会话的关系，取消与清理 | P2 |
| Worktree | 与会话和信任的关系 | P2、P3 |
| Cron | 无人值守下的策略收窄 | P3、后台任务 |
| 文档类工具（Notebook、PDF、图像） | PDF 解析是否引入依赖；图像是否需要模型侧支持 | P5 |

---

## P8 发布切换

**范围**

1. `packages/cowcat` 切换为正式包：去掉 `private`，产物结构、`bin`、`engines` 与 `files` 核对
2. tarball 检查（文件清单、体积、无源码映射泄露策略按需决定）
3. CI 重构：旧 `agent/` 的作业迁移或删除
4. 删除旧 `agent/`；`docs/ROADMAP.md` 等旧文档归档到 `docs/archive/`
5. CHANGELOG 从 `1.0.0-beta.1` 起算；发布由人工完成 2FA（与既有流程一致）

**出口标准**

- 新包的功能覆盖旧版的核心路径（对照清单逐项勾选）
- 旧 `agent/` 删除后 CI 全绿

---

## R1 Windows 原生沙箱（远期调研）

按 [05-platforms.md](architecture/05-platforms.md) 的结论执行：先评估非提权 restricted token 的强度上限，再决定是否作为可选增强。默认安装不需要管理员权限，这一条不变。

## R2 鸿蒙运行时（远期调研）

先回答运行时形态、沙箱原语与分发方式三个问题，产出 `docs/research/harmony-runtime.md`。在调研结论出来前，不做任何鸿蒙特定代码。

---

## 风险登记

| 风险 | 影响 | 应对 |
|---|---|---|
| 旧版隐含结论在迁移中丢失（如 Seatbelt 的符号链接、根 inode） | 沙箱静默失效 | P2 以旧版测试与 fix-plan 为清单逐条迁移；macOS 真实验证 |
| 全面重构期间没有可用版本 | 用户无产出 | 旧 `agent/` 保留安全修复；P8 之前不发布新包 |
| 依赖的协议库变化快 | 适配器需要频繁跟进 | 依赖只出现在适配器；录制夹具锁住行为 |
| CI 配额再次吃紧 | 迭代变慢 | 新包 CI 与旧包一样按路径与分支分级；macOS 按需 |
| TypeScript 7 生态迁移 | 工具链不兼容 | P1 已评估：**不迁移**——阻塞在 typescript-eslint 的 peer 范围与 TS 7.0 不提供编译器 API（见 [04-dependencies.md](architecture/04-dependencies.md) 的 `typescript` 行，含重估条件）。锁定 6.x |
