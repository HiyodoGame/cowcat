# CowCat v2 开发计划

> 取代 `docs/ROADMAP.md` 作为路线依据。架构细节见 [architecture/](architecture/README.md)。
> 最后更新：2026-10-20（P7 表新增前沿调研候选行与 R3~R8 远期项，见 [research/p7-frontier-survey.md](research/p7-frontier-survey.md)）。

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
| P2 | 端口与执行网关（含沙箱执行器迁移） | **已完成**（T1–T5 已合；T6 见下） |
| P3 | 策略、配置与审批协议 | **已完成**（PR #14–#23，测试 219 → 347） |
| P4 | 模型层 | **已完成**（T1–T7 全部落地、T6 拆 T6a/b/c；测试 347 → 436；ADR-035~046） |
| P5 | 工具层 | **已完成**（T0–T7 全部落地；测试 436 → 555；ADR-047~054） |
| P6 | 前端：headless 协议与 TUI | **已完成**：T1–T10 全部落地（ADR-055~069），出口标准的两条接缝由 `packages/cli/test/exit-criteria.test.ts` 与 tui 的 lint 规则保证；**人眼验收 2026-10-20 由用户实测通过**，验收中发现「不可读附件让会话永久失败」并由 #66 修复（ADR-069） |
| P7 | 功能模块（逐个调研） | **完成**：上下文压缩（#67 调研 / #68 实现，ADR-070~074）、记忆与项目指令（#69~#72，ADR-075~078）、子 agent（#74~#78，ADR-079~082）、MCP（#79 调研，T1 #80，T2 #81，ADR-083~088；真实端点实测完成） |
| P8 | 发布切换与旧代码删除 | **基本完成**：v1 配置兼容（089）、包切换（090）、删除 `agent/` 与 CI legacy 腿、旧文档归档、`setup` 接线（091）、`1.0.0-beta.3` 四包发布均已完成；剩余：`latest` 仍指 v1（beta 期）、v1 项目 `.cowcat/config.json` / `state.json` 未迁移、`setup` 仍是非交互 |
| R1 | Windows 原生沙箱调研 | 远期 |
| R2 | 鸿蒙运行时调研 | 远期 |
| R3 | ACP 适配器调研（编辑器接入，`packages/protocol` 之上） | 远期 |
| R4 | Agent Session Protocol 会话格式对齐调研（跨 harness resume / fork / 迁移） | 远期 |
| R5 | 多代理编排调研（orchestrator-worker、Gen UI、「模型自装插件」北极星） | 远期 |
| R6 | 大代码库检索与仓库知识库调研 | 远期 |
| R7 | 评测 harness 与任务基准调研（Terminal-Bench 式） | 远期 |
| R8 | 插件生态路线调研（MCP 边界 → 能力包 → 运行时组合） | 远期 |

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

> 调研文档：[research/p2-ports.md](research/p2-ports.md)（含两组本机实测：Windows `taskkill` 边界、POSIX `setsid` 逃逸，见其附录 B）。契约落点见 [architecture/03-policy-and-execution.md](architecture/03-policy-and-execution.md)，路径身份见 [architecture/01-layers.md](architecture/01-layers.md)。

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

**任务拆分**（一个 PR 一个任务；契约先于实现）

| 任务 | 内容 | 状态 |
|---|---|---|
| T1 | 三个端口的契约 + ADR-014～017 + 脱敏规则集（纯函数）+ lint 门禁 + `tools/lint-probe.mjs` | ✅ PR 见 §P2 交付 |
| T2 | `PlatformPort` 适配器：平台识别、shell 解析（Git Bash → PowerShell）、后端探测（真跑而非版本检查）；会话头记录实际 shell（**不升 `schemaVersion`**）。shell 探测方式见 [research/p2-shell-detection.md](research/p2-shell-detection.md) | ✅ PR 见 §P2 交付 |
| T3 | `FsPort` 适配器：迁移 `canonical.js` 的语义（realpath、最深已存在祖先回退、永不抛、缓存）+ 契约测试 | ✅ PR 见 §P2 交付 |
| T4 | `ProcessPort` 适配器：启动、脱敏、截断（保留尾部 + `truncated`）、终止（一次 `/T` / 一次组杀）+ 契约测试 | ✅ PR 见 §P2 交付 |
| T5 | `SandboxExecutor`：`light` + `seatbelt` / `bwrap` 迁移（argv 生成保持纯函数）+ `system` 在不支持的平台拒绝 | ✅ PR 见 §P2 交付 |
| T6 | G1/G2/G3 与「`rm` 可用」「私有临时目录」「拒绝被解释成沙箱」迁移为 v2 测试；**`packages/cowcat` 的 Linux 腿要装 bubblewrap**（现在只有 `agent/` 的腿装了） | ✅ PR 见 §P2 交付 |

**交付（T1）**

- `ports/process.ts`、`ports/fs.ts`、`ports/platform.ts`：三个契约，只含类型与不变量注释；每条不变量都指向调研里的实测出处
- `policy/env.ts`：脱敏规则集作为**纯函数**（旧版只有 `light` 档在脱敏、`system` 反而漏了、后台任务还会回灌，见调研 §4.2）
- `SandboxUnavailableError`：拒绝时带 `reason` / `detail` / `alternatives`，且**不得**读成「沙箱已启用」
- lint：`src/adapters/` 之外禁 `node:child_process` / `node:fs` / `node:os`；`tools/lint-probe.mjs` 逐条验证门禁真的会报错（含 zod 那条没有被覆盖掉）
- ADR-014（进程网关与终止边界）、ADR-015（脱敏在网关内统一）、ADR-016（沙箱默认拒绝不降级）、ADR-017（路径身份归 `FsPort`）
- 测试 69 → 78

**T1 的出口标准与验证结果**

- [x] `npm run build` 通过（tsc，TS 6.0.3，`exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`）
- [x] `npm run lint` 通过
- [x] `npm test` 78 项全通过（本机 Windows / Node `v24.18.0`）
- [x] lint 门禁经 `tools/lint-probe.mjs` 逐条验证：新 block 报 ProcessPort 文案、旧 block 报 kernel 文案、zod 文案仍在、`src/adapters/` 豁免
- [ ] CI 上 `packages/cowcat` 的 Linux / Windows 两腿（本 PR 的 checks）

**已知缺口（不声称已解决）**

- **`FsPort` / `ProcessPort` 适配器仍未写**（`PlatformPort` 已在 T2 补上）：终止、脱敏、截断的真实行为要到 T4 才有测试覆盖
- **`shell` 字段与会话头尚未接线**：决定已定（不升 `schemaVersion`，因为 v2 日志格式从未发布），实现落在 T2 → **T2 已完成**，见下
- **沙箱执行器完全未动**：G1/G2/G3 的迁移与 bubblewrap 的 CI 安装在 T5/T6。
- **lint 新 block 目前只覆盖 `src/` 下不属于 kernel/policy/ports 的文件**（当下只有 `src/index.ts`），真正的考验是 P6 之后出现 `modules/`、`frontends/` 时它是否还拦得住。
- 两个 lint block 覆盖同一规则时**后者整体覆盖前者**（不是合并）——这个坑已经踩过一次并被探针抓到，配置里写了注释说明 `ignores` 是承重的。

**交付（T2）**

- `adapters/shell.ts`：候选链与接受规则，**纯逻辑**——`which` / `exists` / `run` / 路径拼接全部注入，所以「Git Bash 优先于 PowerShell」「装了但跑不起来要跳过」「绝不接受裸名」这些决定都能在任意机器上测
- `adapters/sandbox-probe.ts`：bwrap / seatbelt **真跑**探测 + 失败分类（missing / userns-blocked / error / unsupported-platform），每条不可用的裁决都带错误首行与可粘贴的修复命令
- `adapters/platform.ts`：`NodePlatform implements PlatformPort`；两项探测**同步且按会话记忆一次**（PowerShell 5.1 单次启动 745ms）
- 会话头增加 `shell: { kind, executable }`（ADR-019），由 `SessionDeps.shell` 注入，与 `cowcatVersion` 同一条注入路径
- ADR-018（shell 绝对路径 + 真跑验证）、ADR-019（记 shell 不升 schemaVersion）
- 测试 78 → 102

**T2 的出口标准与验证结果**

- [x] `npm run build` / `npm run lint` 通过
- [x] `npm test` 102 项全通过（本机 Windows / Node `v24.18.0`）
- [x] lint 门禁经 `tools/lint-probe.mjs` 复验：两条 block 的文案都还在，`src/adapters/` 仍豁免
- [x] **真机跑通整条链**：本机（Git 在 `E:`，注册表三键全缺）解析出 `E:\WorkSoftwares\Git\bin\bash.exe`，kind = `git-bash`，与调研的实测一致；终止策略 `taskkill-tree`，沙箱裁决 `unsupported-platform` + WSL2 替代路径
- [ ] CI 上 `packages/cowcat` 的 Linux / Windows 两腿（本 PR 的 checks）
- [x] **macOS 的 `/bin/bash` 优先于 `$SHELL`（zsh）已结清**：加了 `packages/cowcat · node 22 · macos-15` 腿 + 硬断言（`test/platform.test.ts`）。macOS 是唯一默认 shell 不是 bash 的平台，所以这条断言只有在它上面成立才有意义；同一条腿还会打印解析结果与 Seatbelt 裁决

**T2 已知缺口（不声称已解决）**

- **`FsPort` / `ProcessPort` 适配器仍未写**：终止、脱敏、截断的真实行为要到 T4 才有测试覆盖 → `FsPort` 已在 T3 补上，只剩 `ProcessPort`
- **沙箱执行器完全未动**：G1/G2/G3 的迁移与 bubblewrap 的 CI 安装在 T5/T6 → T5 已交付执行器与 CI 安装，**完整 G1/G2/G3 矩阵仍在 T6**
- **`pwsh` 分支仍未实测**：本机没装 PowerShell 7，`pwsh` 优先于 5.1 这条只有链序测试覆盖，没有真机验证
- **沙箱探测只到「能不能用」**：profile 本身的正确性（G1/G2/G3）属于 T5；v2 包的 Linux 腿也还没装 bubblewrap（T6）→ 已在 T5 完成，见下→ 已在 T5 完成，见下

**交付（T5）**

前置是一轮完整调研：[research/p2-sandbox.md](research/p2-sandbox.md)。用 Docker Desktop 的 Linux VM 起一次性容器，装 **bwrap 0.9.0**（与 CI 那条 `ubuntu-24.04` 腿同版本），把旧版 argv 的每条假设都真跑一遍。四条发现改了设计：

| 发现 | 实测 | 决定 |
|---|---|---|
| 沙箱内可以创建嵌套 user namespace | `unshare -U` rc=0；加 `--disable-userns` 后 rc=1 | 加固 flag 上 argv，但**探测两次**：不带判可用、带判加固。不带就发会让第一条命令失败，报成不可用会逼用户关沙箱（ADR-020） |
| 沙箱不是它自己调用者的权限边界 | root 调用者：`uid_map 0 0 4294967295`，沙箱内 uid=0，`/etc/shadow` 可读；非特权调用者：被拒绝 | 不拒绝，但在 root 下把这件事写进限制项上报 |
| 沙箱里 `&` 起来的后台任务活不过那条命令 | 三种网络配置下均死亡（沙箱活性已证明） | 写进文档，属预期而非 bug |
| 私有 `/tmp` 是内存一半、RAM 支撑、0755 | 20487492 KB / 40014 MiB 宿主；`--size` 实测真限流 | 固定 2 GiB + `--perms 1777`（ADR-021） |

代码分层：`policy/sandbox-defaults.ts` 与 `policy/sandbox-paths.ts`（纯）→ `adapters/sandbox/backends/{bwrap,seatbelt}.ts`（纯 argv/SBPL）→ `adapters/sandbox/executor.ts`（唯一不纯：后端选择、拒绝判定、私有临时目录生命周期）。

**契约修订**（三处，都有依据）：`SandboxCommand` 加 `env`/`cleanup`（macOS 无挂载命名空间，`TMPDIR` 是唯一表达方式）；`ProcessResult` 加 `sandbox: { mode, backend, limitations }`（架构文档原则 2 要求审计记**实际生效**的模式与后端）；新增 `SandboxRequestRefusedError`（macOS `network: 'on'` 是「请求满足不了」而非「沙箱不可用」）。

**合规**：Seatbelt 运行时白名单转写自 Apache-2.0 的 `@anthropic-ai/sandbox-runtime`，仓库是 MIT 且原本**无任何署名**。已加 `NOTICE` 并在常量处标注来源与修改。

**T5 的出口标准与验证结果**

- [x] `npm run build` / `npm run lint` 通过
- [x] `npm test` 152 → **203**，0 失败（本机 Windows：5 项按平台 skip，其中沙箱真机两条带探测分类原因）
- [x] 两条后端生成器都是**纯函数**，因此在 Windows 上完整单测了 ~150 条 SBPL 规则与 bwrap 全部 flag
- [x] 执行器测试钉住**两种拒绝**、显式点名不可用后端时的响亮失败（此测试抓到并修掉一个真缺口）、以及临时目录的生命周期
- [x] `ci.yml` 的 `packages/cowcat` Linux 腿装上 bubblewrap + AppArmor profile（T6 的前置提前到这里）
- [ ] **真机烟测待 CI**：生成的 argv 真跑、项目内写入到达宿主、项目外写入未到达宿主、被拒读取报 ENOENT、DNS 不可解析

**T5 已知缺口（不声称已解决）**

- **完整的 G1/G2/G3 矩阵仍在 T6**：本任务只证明 argv 能跑且基本隔离成立 → **T6 已完成**，见下

**交付（T6）**

前置是一轮前沿文献调研：[research/p2-sandbox-literature.md](research/p2-sandbox-literature.md)（`websearch` 集成返回 402，改用 arXiv API 直查）。七篇相关文献改变了两处做法：

- **标注验证等级**（[2610.04504](https://arxiv.org/abs/2610.04504) 的 VAL，「zero is an outcome, not a guarantee」）：G1/G2/G3 证明的是 **L2 客观事实**，不是保证。写进测试文件头与架构文档，避免「215 pass」被读成「沙箱是安全的」。
- **把「沙箱管不到什么」钉成测试**（[2605.18583](https://arxiv.org/abs/2605.18583) 的 overeager 分类：范围扩张是与逃逸并列的第四类授权问题，实测仅移除授权声明即使越界率从 0.0% 升到 17.1%）：新增一条断言「范围内破坏**确实能发生**」，以防日后被过度声称，或被「顺手修好」而 deny 掉 `rm`。

`test/sandbox-enforcement.test.ts` 扩成完整矩阵（本机 12 条按平台 skip，Linux/macOS 真跑）：

| 用例 | 断言 |
|---|---|
| G0 | 沙箱内能跑；结果携带**实际生效**的 mode/backend |
| G1 | 项目内写入到达宿主（否则下面的拒绝也可能来自「什么都拒绝」）；`rm` 可用；宿主临时目录下的写入不落地；`/etc` 被拒 |
| G1 边界 | **范围内破坏不被阻止**（钉住保证的边界） |
| G2 | 读面外不可达；**被允许的家目录里的凭据路径仍不可达**；家目录本身仍可读 |
| G3 | DNS 在沙箱内失败 |
| 私有临时目录 | 宿主临时文件不可见 + 沙箱临时目录可写 |
| 可解释性 | 结果携带足够解释拒绝的材料 |

**修了一个真 bug**：挂载顺序。`--tmpfs /tmp` 排在读绑定**之后**时会遮住宿主 `/tmp` 下的每一个读授权——实测允许的 `$HOME/notes.txt` 变成 GONE。两个 profile 的顺序要求相反且各有原因，已写进架构文档与测试。

Linux CI 腿新增一步打印探测裁决，用来回答「AppArmor profile 生效后 `--disable-userns` 是否可用」——若 `hardening` 为空，日志会显示，且每次运行的 limitations 都会说明沙箱更弱（这是预期的降级，不是失败）。

**T6 在两条真机腿上又挖出四个真问题**（这是它真正的价值——写完测试不等于跑过测试）

1. **私有临时目录没走 canonical 化**：mkdtemp 的结果直接进了 Seatbelt 的 `(subpath …)`，而它不经过 `resolveEntries`。macOS 上前者是 `/var/…`、内核报 `/private/var/…`，于是规则什么都没授予，实测**沙箱自己的 TMPDIR 不可写**。
2. **遍历符号链接需要对 SYMLINK vnode 的读权限**：`/var`、`/etc`、`/tmp` 本身是符号链接，而 profile 只授了 DIRECTORY 的 metadata，于是**任何人会写的绝对路径全部 EPERM**，而 profile 看起来完全正确。补 `file-read-metadata (vnode-type SYMLINK)`（ADR-022）。中途我误判成「`subpath` 匹配字面路径」并实现了「每条路径发两种拼写」——实测**无效**，且把 deny 面扩大一倍（每条 deny 要手工复制两份，漏一处就是绕过），已删除并由一条测试钉住。
3. **隔离断言不能拿 `existsSync` 当探针**：它在 `statSync` 与 `readFileSync` 都 EPERM 的路径上返回 true。且之前那个 `false` 是**错因通过**——查找在 `/var` 就失败了，策略从没被问到。断言改为看**内容是否到达**。
4. 顺带修掉自己两个测试 bug：`unlinkSync` 返回 undefined 所以 `&&` 会短路；`node()` 只给整串加一次 `require("fs").`。

**T6 的出口标准与验证结果**

- [x] `npm run build` / `npm run lint` 通过
- [x] `npm test` 205 → **219**，0 失败
- [x] **两条真机腿全绿**：`packages/cowcat · node 22 · ubuntu-latest`（bubblewrap 0.9.0 + AppArmor profile）与 `macos-15`（seatbelt）
- [x] 必过检查 9 条全绿

**T6 已知缺口（不声称已解决）**

- **没有 seccomp 过滤**：目前最大的加固缺口。bwrap 支持 `--seccomp FD`，但需要一份编译好的 BPF 程序与允许清单维护策略。依据 SysComb（[2608.26871](https://arxiv.org/abs/2608.26871)）——限制可用系统调用可缩小内核攻击面。记为 R1
- **G1/G2/G3 停在 L2**：没有可判定的完备性论证，平台换了也不会有人被提醒
- **macOS 上读面之外路径的存在性可被观察，内容不可**（实测：Node 的 `existsSync` 返回 true 而 `statSync`/`readFileSync` 是 EPERM）。这是 agent 可用的小侧信道，已写进限制项。未单独测裸 `access(2)`
- **root 调用者下还剩哪些隔离未量化**：文件权限不再保护，但挂载与网络隔离仍在
- **worktree 兄弟目录未自动纳入写策略**：应由调用方作为额外写路径传入（P3 接入 worktree 时）
- **`setsid()` 逃逸仍是推断**（附录 B 实证它能逃，但「前台超时孤儿」一类无样本）
- **AppArmor 与 `--disable-userns` 的交互未验证**：WSL2 内核没有 Ubuntu 24.04 那条限制，只有 CI 能验。若加固被拒，会自动降级为「不加固 + 上报限制项」，不会失败
- **root 调用者下还剩哪些隔离未量化**：文件权限不再保护，但挂载隔离与网络隔离仍在。需要一次以 root 跑完整矩阵的实验
- **worktree 兄弟目录未自动纳入写策略**：旧版会扫描父目录；v2 里它应由调用方作为额外写路径传入（P3 接入 worktree 功能时）
- **Seatbelt 的 profile 正确性只在 macOS 腿验证**：生成器是纯函数，可在任意机器单测结构；但「macOS 接受这个 profile」只有 `macos-15` 腿能证明

**交付（T3）**

- `adapters/fs.ts`：迁自 `agent/src/canonical.js`。`realpathSync.native` 优先，失败则**上溯到最深已存在祖先**再接回缺失的尾巴（`write.allow` 里的 `.env` 与尚未创建的 worktree 兄弟目录靠这条）；`resolve()` 先行，所以 `..` 在开始取 `dirname()` 之前就折叠掉了
- **永不抛**：`kindOf` / `exists` 把 EACCES、ELOOP、ENOTDIR 收成 `null` / `false`——沙箱路径上抛异常会变成工具路径的崩溃
- 两处对旧版的实质修正：**缓存挂实例**（旧版是模块级 `Map`，两个适配器静默共享、测试拿不到干净的）；**只在找到现存祖先时才缓存**（没有 Z: 盘时 `Z:\project\file.txt` 的答案只是调用者的写法，缓存住等于在盘出现后仍钉死错误答案）
- `test/fs.test.ts` 8 项**对着真实文件系统**测：假文件系统在这里是错的工具——被测的性质本身就是文件系统的行为。平台拒绝建符号链接时**带原因 skip**，不静默通过

**T3 的出口标准与验证结果**

- [x] `npm run build` / `npm run lint` 通过
- [x] `npm test` 111 项（108 通过 / 3 项按平台 skip / 0 失败，本机 Windows / Node `v24.18.0`）
- [x] 三个 skip 各自带原因，且在对应平台上是真跑：POSIX shell 断言（Windows）、`/dev/null` 的 `other` 分支（Windows）、**断链符号链接**（本机无开发者模式，Windows 缺文件符号链接权限——目录 junction 可以，所以其余 6 项照常跑）
- [x] 缓存的陈旧窗口被钉成契约而不是注释：改指向后仍返回记忆值，`clearCache()` 之后才更新
- [ ] CI 上 `packages/cowcat` 的 Linux / Windows / macOS 三腿（本 PR 的 checks）

**T3 已知缺口（不声称已解决）**

- **`PathPolicyResolver` 仍是接口**：`agent/src/sandbox/policy.js` 的 `expandPath` 与策略构建属于 T5，届时它会消费 T3 的 `FsPort`
- **Windows 8.3 短名（`RUNNER~1`）未单独测**：需要刻意创建短名目录才能构造；真实 runner 上 `realpath` 会把它还原，靠 Windows 腿间接覆盖
- **不存在的路径在 Windows 上按大小写敏感比较**（回退到 `resolve()` 时保留调用者写法）。两侧都经过 `realpath` 的真实路径不受影响，且 `test/fs.test.ts` 的 fixture 一律先 canonicalize——但这是一处已知不对称，没有证据前不猜着「修」它

**交付（T4）**

- `adapters/terminate.ts`：唯一的终止路径。超时、取消、shutdown 全部经过它；`??=` 保证只启动一次终止。Windows 一次 `taskkill /T /F`（**绝不在此前单杀子进程**——父一死就 exit 128，实测 12/12 采样孤儿存活）；POSIX 进程组 SIGTERM → 宽限 → SIGKILL。`TreeKiller` 是可注入的接缝，所以升级算术与 ESRCH / 128 分支**不用真进程**也能测
- `adapters/process.ts`：`NodeProcess implements ProcessPort`。脱敏（light 与 system 都做，off 不做——旧版 `sandboxEnv()` 只在 light 脱敏，**严格档反而漏了**，且 `background.js` 又把 `...process.env` 铺回去）、截断（保留尾部 + 丢弃计数）、超时与取消同路径、启动失败是 reject 而非结果
- `adapters/output-tail.ts`：纯函数的尾部累加器。`kept + dropped === total` 是它唯一需要成立的恒等式，测试按恒等式断言而不是按具体数字
- **补了 `ProcessResult` 的两个字段**（`dropped` / `removedEnv` + `ignoredDeny`）：ADR-015 要求「剥离了哪些变量名」作为事实返回、调研 §2.3 要求「丢掉的字符数」，而 T1 合并的契约里两者都没有。不补就是实现期悄悄丢掉已决定的事实
- 测试 111 → 150

**T4 的出口标准与验证结果**

- [x] `npm run build` / `npm run lint` 通过；`agent/` 的 762 项未受影响；`tools/lint-probe.mjs` 复验通过
- [x] `npm test` 150 项（147 通过 / 3 项按平台 skip / 0 失败）
- [x] **抓到并修掉一个真 bug**：测试用了「假 POSIX 平台 + 真 Windows 宿主」，`kill(-pid)` 在 Windows 上无意义且失败形态像 ESRCH，而我把 ESRCH 当成「组已消失」= 成功，于是**报告了一次根本没发生的组杀**，子进程活到自然结束。现在的判据是「ESRCH 视为已消失」**仅在不存在的进程组的平台上成立**，Windows 上落到单杀回退并如实标记
- [x] **真机树杀端到端验证**：孩子 → 孙进程三层，孙进程自己写 pid 文件；超时后断言该 pid 已不存在。Windows 上是 `taskkill-tree` 且 `fallbackUsed: false`
- [x] 脱敏是真跑子进程验的：让子进程自己打印 `process.env.MY_TOKEN`，断言为 `null`，并断言结果里**不含那个值**

**T4 已知缺口（不声称已解决）**

- **沙箱执行器不存在**：`system` 档目前一律 `not-implemented` 拒绝（Windows 是 `unsupported-platform`）。真正的 seatbelt / bwrap 包装属于 T5
- **`setsid()` 逃逸仍是推断**：附录 B 的实测证明它能逃，但「前台超时孤儿」这一类没有样本。终止记录对此**不置词**——`residuePossible` 的含义是「无法证明整棵树没了」，setsid 属已声明的覆盖边界而非未证明项，两者在同一条记录里无法区分
- **终止记录没有失败原因字段**：`taskkill` 是 exit 128 还是根本起不来，记录里只能看到 `residuePossible: true`。可操作性够（意思是「可能有残留」），但排障时拿不到细节
- **`light` 档仍无执行期提醒**：ADR-007 要求它的文案不得暗示 OS 隔离，文案属于 P5 的工具层，本任务只保证网关不越权

**出口标准**

- Linux 上 bwrap 执行器的 G1/G2/G3 测试通过
- macOS 上 seatbelt 执行器的 G1/G2/G3 测试通过（按需触发 `macos-15` 作业；未触发前标注「未验证」）
- Windows 上 `system` 档请求被拒绝，拒绝信息包含替代路径

---

## P3 策略、配置与审批协议

> **调研已完成**：[`research/p3-policy.md`](research/p3-policy.md)（含三个探针共 34 条实测断言、AGENTS.md 标准调研见其附录 E）。六项决定与 ADR-023~034 已落。**本阶段实现已完成**（T1–T5 已合，测试 219 → 347）。

**调研问题**

- 配置分层：用户级、项目级、会话级的优先级与合并语义；项目级配置在不受信任的仓库里能否生效（参考旧版 `trust.js` 的结论）
- 规则语言：纯数据（JSON）规则，还是允许少量表达式；倾向纯数据，待对比
- 审批协议：`ask` 在内核中如何表达为事件，前端如何回应，超时与无人值守模式如何处理

**调研结论摘要**（详见调研文档 §0）

- 配置分层收敛到**三层 + 环境变量逐键决定**，并**取消 `STATE_KEYS` 式隐式最高层**（ADR-025）
- 规则语言定为**结构化字段**，否决函数式 `matches` 与纯文本 DSL（ADR-027）
- 信任门控改**不对称**（ADR-028）；指令文件统一为 **`AGENTS.md`** 且**未信任不注入**（ADR-029、ADR-030）
- 无人值守 = **auto-deny**（ADR-032）；`deny` **永不被短路**（ADR-024）
- 旧版两条真缺口必须在实现期封：子 agent 从 `tools === null` 推断 yolo、`allowedPrompts` 绕过规则校验（ADR-032）

**范围**

1. 配置 schema（zod），加载与分层合并，错误报告带文件与路径
2. 路径信任模型：工作区是否受信任、信任记录如何持久化
3. 规则集从默认规则扩展为可配置规则，保留「deny > ask > allow」与「未命中即 ask」——**并已就「deny 是否可被无人值守短路」重新论证**，结论是永不被短路（ADR-024）
4. 审批：`approval.requested` / `approval.answered` 作为事件进入日志，支持无人值守模式的显式开关
5. 审计：作为事件的消费者，而不是内核内的分支

**任务拆分**（一个 PR 一个任务；契约先于实现）

| 任务 | 内容 | 状态 |
|---|---|---|
| T1 | 规则语言改为结构化字段：`Rule.matches` → `Rule.when`，`ActionRequest` 扩形状，`validateRules`（ADR-027） | ✅ 已合（#16）。测试 219 → 245 |
| T2a | `ActionRequest` 的生产者：`ToolSpec.pathInput` / `commandInput` 声明，`run-turn.ts` 读输入并填请求，`path` 过 `FsPort.canonical` | ✅ 本 PR。测试 245 → 257 |
| T2b | 配置 schema（zod，只许在 `adapters/`）+ 三层加载合并 + 两级错误报告（ADR-025/026） | ✅ 本 PR。测试 257 → 276 |
| T3a | 信任门控（ADR-028）+ 配置层来源标注；顺带修掉 `DEFAULT_RULES` 里遮蔽 allow 的 catch-all `ask`（ADR-034） | ✅ 本 PR。测试 276 → 289 |
| T3b | 信任记录的存储：独立于配置、按 canonical 路径、无继承（ADR-025 决定 3） | ✅ 本 PR。测试 289 → 306 |
| T3c | `AGENTS.md` 加载与未信任不注入（ADR-029/030） | ✅ 本 PR。测试 306 → 323 |
| T3 | 信任模型：门控不对称 + 记录独立存放（ADR-028）；`AGENTS.md` 加载、未信任不注入（ADR-029/030） | 见 T3a/b/c |
| T4 | 审批协议：`approval.requested` / `answered` 进日志、超时 → auto-deny、`always` 会话内（ADR-031/032）；封子 agent yolo 与 `allowedPrompts` 两条旧版缺口 | ✅ 内核侧本 PR。**两条缺口在 v2 还封不了**（无子 agent、无 plan 模式），已记为未来实现的约束。测试 323 → 335 |
| T5 | 审计作为事件消费者（ADR-033）；先扩事件让沙箱事实进日志 | ✅ 本 PR。测试 335 → 347 |

**P3 六项范围全部落地。** 两条出口标准的现状：

- 「策略的全部裁决都能由配置表达」——**库层面成立**（T1 让规则变成数据，T2b 让数据从配置来，T3a 让 allow 真正可达）；**端到端仍未成立**，因为还没有 CLI 去读配置文件（P6）
- 「无人值守下所有 `ask` 要么按显式规则放行、要么拒绝并留审计」——**成立**：`ask` 的归宿是 auto-deny（T4）+ 留审计（T4 事件 + T5 消费者），而 `deny` 永不被短路（ADR-024）。端到端同样等 CLI

**从 P2 带到 P3 的接口债**

- worktree 兄弟目录作为额外写路径传入的接口（见调研 §5 与旧版 `sandbox/policy.js:83-96` 的行为基线）

**出口标准**

- 策略的全部裁决都能由配置表达，无需改代码（**库层面成立**：`Rule.when` 是数据（T1），配置 schema 能表达全部裁决（T2b）。**端到端仍未成立**——还没有 CLI 去读配置文件，P6）
- 无人值守模式下，所有 `ask` 的动作要么按显式规则放行，要么拒绝并留审计（**成立**：`ask` 的归宿是 auto-deny（T4）+ 留审计（T4 事件 + T5 消费者），而 `deny` 永不被短路（ADR-024）。**端到端仍未成立**——还没有 CLI，无人值守开关无处可给，P6）

---

## P4 模型层

> **调研已完成、ADR-035~046 已定（评审通过），T1–T7 全部落地（T6 拆成 T6a/b/c 并全部完成，本 PR 收口）**：[`research/p4-models.md`](research/p4-models.md)。协议行为**由录制夹具固定**（自 T4 起 CI 不访问网络）；出口标准的比对口径见该文 §8 与 **ADR-043**。做法见 [`HANDOFF.md`](HANDOFF.md) §3。

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

**任务拆分**（一个 PR 一个任务；契约先于实现）

| 任务 | 内容 | 状态 |
|---|---|---|
| T1 | **契约与事件**：`ModelRequest` / `ModelChunk` 扩展（ADR-035）、用量四项（ADR-040）与 `model.usage` 进日志（ADR-041）；连带改 `state.ts` 的 switch、`adapters/schema.ts` 的解码边界与**编译期等价断言**；`ScriptedModel` 随之改造。**不动适配器** | ✅ 本 PR。测试 347 → 355 |
| T2 | **OpenAI 兼容适配器**（Chat Completions，ADR-036）+ 注入 transport（ADR-042） | ✅ 本 PR。测试 355 → 369 |
| T3 | **Anthropic 适配器**（ADR-036）：六种 `RawMessageStreamEvent`、`input_json_delta` 拼装、usage **合并而非覆盖** | ✅ 本 PR。测试 369 → 380 |
| T4 | **录制-回放夹具与录制脚本**（ADR-042）：录原始字节、**配对夹具**、厂商差异钉板、请求头裁剪 | ✅ 本 PR。测试 380 → 388 |
| T5 | **重试、退避与取消边界**（ADR-039）：默认 2 次、尊重 `Retry-After`、取消涵盖退避等待、不重试已开始输出的流 | ✅ 本 PR。测试 388 → 406 |
| T6 | **模型预设为数据**（ADR-037/038）：拆成 T6a/b/c（见下） | ✅ T6a/b/c 全部落地 |
| T6a | **契约与类型**（ADR-045）：`ModelChunk` 增 `reasoning`（**整块**，带不透明签名）、`Message.assistant` 增 `reasoning`、`model.message` 带上它；连带改 `state.ts` 的 switch、`adapters/schema.ts` 的解码边界与**编译期等价断言**。**不动适配器、不动 runTurn 的请求构造** | ✅ 本 PR。测试 413 → 416 |
| T6b | **两个适配器的读写**（ADR-038/045）：读 `reasoning_content`/`reasoning`（OpenAI 兼容）与 `thinking_delta` + `signature_delta`（Anthropic）并把签名原样带回；**只在预设声明时**回传；`providerOptions` 序列化 + **保留字**与**协议不变量**校验（`budget_tokens` 那类）；`maxTokens` 接线 | ✅ 本 PR。测试 416 → 432 |
| T6c | **预设进内核**（ADR-046）：`ModelPreset` 类型与 `TurnOutcome.notes`、`TurnDeps.preset` 取代 `modelId`；`maxTokens ← limits.output`；`toolCalls:false` 不发 `tools` 并随 `notes` 上报；档位未声明则不发 + note；配对夹具补上推理内容、golden 随之更新 | ✅ 本 PR。测试 432 → 436 |
| T7 | **出口标准**（ADR-043）：配对夹具跑出同一事件序列；取消不产生半条 `model.message` | ✅ 本 PR。测试 406 → 413 |

**出口标准**

- 同一个回合脚本，在两种协议的录制夹具上得到相同的事件序列（归一化后）
- 取消在流式中途生效，且不产生半条 `model.message`

---

## P5 工具层

> **调研已完成、ADR-047~052 已定（评审通过，2026-10-18）；ADR-053/054 随实现落表；T0–T7 全部落地（P5 收口）**：[`research/p5-tools.md`](research/p5-tools.md)。三条调研问题的答案依次见该文 §3（zod 入参 → wire JSON Schema，含 31 项实测）、§4（截断作为结构化事实进日志）、§5（纯 JS Glob/Grep 的性能实测，以及**不引入 ripgrep** 的理由）；任务拆分、每条的验收证据与「不做什么」见其 §14.2/§14.3。
>
> **一处必须知道的前提**：厂商侧对 JSON Schema 子集的接受度**零实测**（无凭据/端点），因此 ADR-047 决定的是**机制**（一处常量 + 语言子集约定），校准留在 P6 第一次真连端点时做（调研 §3.5）。

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

**任务拆分**（一个 PR 一个任务；契约先于实现——T1/T2 落地前不写任何具体工具）

| 任务 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| T0 | **决定落表**（纯文档）：调研 §11 的六条落成 ADR-047~052；本段补上任务表；三处架构文档的待改点写进对应任务 | 六条已评审通过（2026-10-18） | ✅ 本 PR |
| T1 | **契约与事件**（ADR-048/049/051）：`ToolResult` 增 `truncation`；`tool.finished` 增 `truncation`（可空）+ **canonical `path`**；`ToolPort.run` 增**第三参数**（只描述本次授予）；`reduce` 派生「本会话已读文件」集合；连带改 `adapters/schema.ts` 的解码边界、编译期等价断言、`state.ts`、`test/support.ts`。**不动任何具体工具**；同 PR 改 `02-kernel.md` | T0 | ✅ 本 PR（测试 436 → 448） |
| T2 | **工具定义 API 与 wire schema 派生器**（ADR-047/052）：一处产出的 `toJSONSchema({ io:'input', target })` + 剥 `$schema`；被禁词汇（联合 / nullable / record / literal）的**执行点**；`defineTool()`（zod 校验 → `ok:false` + 字段级原因，不抛）。同 PR 改 `01-layers.md`（`adapters` 加「工具实现」） | T0（可与 T1 并行） | ✅ 本 PR（测试 448 → 458） |
| T3a | **Glob + 文件遍历**（ADR-050）：`.gitignore` 语义子集（六种模式；三条不支持且**必须上报**）、保留硬跳过、100 上限 + 结构化截断事实 | T2 | ✅ 本 PR（测试 458 → 470） |
| T3b | **Grep**：三种模式与上下文参数、单文件 1MB / 二进制跳过、250 上限、**`files_with_matches` 与 `count` 达到 `head_limit` 即停** | T3a | ✅ 本 PR（测试 470 → 485；新增 ADR-053） |
| T3c | **Read（文本部分）**：分页、5MB/20MB 两级、**CRLF 作为可判定事实告知**；图像 / PDF / notebook **显式拒绝并指向 P7**（v2 契约里没有附件通路，那是 P7 的契约工作） | T2 | ✅ 本 PR（测试 485 → 500） |
| T4 | **Write 与 Edit**（ADR-049 的消费方）：五条替换规则照旧、**拒绝空 `old_string`**、消费日志派生的已读集合（**恢复会话后依然成立**）、Edit 报错点明 CRLF；**出口标准点名的边界用例同 PR** | T1、T2、T3c | ✅ 本 PR（测试 500 → 517；闸门落在 `runTurn`） |
| T5 | **Bash 薄壳**：`command` → argv（经 `PlatformPort`，**不经 `shell:true`**）、`ProcessSpec` 组装、`facts` 回填、退出码非零**不是**失败、`run_in_background` **显式拒绝**、消费第三参数（`network: 'ask'` **不得静默当 `off`**）；含 `SandboxProfile` 的配置键与纯解析函数 | T1、T2 | ✅ 本 PR（测试 517 → 537；新增配置键与 `resolveSandboxProfile`） |
| T6 | **TodoWrite**：全量替换语义与状态校验；**「状态存哪」先落一个小 ADR**（会话日志内 vs 外部文件 vs 纯事件） | T2 + 小 ADR | ✅ 本 PR（测试 537 → 546；ADR-054 取「会话日志内的事件」） |
| T7 | **出口标准与收口**：七个工具的统一契约测试、Edit 边界用例复核、v1 清单对照记录、端到端回合（读→改→跑命令→审批→截断）；同 PR 更新 `03-policy-and-execution.md` 的端口表 | T3a–T6 | ✅ 本 PR（测试 546 → 555；P5 出口标准见下） |

**出口标准**

- 核心六个工具的契约测试通过；Edit 的边界用例（多处匹配、空匹配、CRLF）全部覆盖
- 与旧版工具清单对照，缺失项都有明确的「推迟到 P7」记录

**P5 交付记录（2026-10-19 收口）**

七个工具全部落地，住 `packages/cowcat/src/adapters/tools/`：`Read`（文本）/ `Write` / `Edit` / `Glob` / `Grep` / `Bash` / `TodoWrite`。统一契约由 `test/tools-contract.test.ts` 钉住：规格完整、wire schema 是对象且无 `$schema`、被窄化字段真实存在、**非法入参与垃圾入参都变成 `ok: false` 的结果而不是抛错**、每个工具在真正跑过的一次调用里都上报 `truncation` 事实。端到端见 `test/end-to-end.test.ts`（一个回合里读 → 改 → 待办 → 审批 → 跑命令 → 两种截断，并且重开会话后状态一致）。

**与旧版清单对照**（旧版 19 个工具文件 / 30 个静态 wire 名，逐条归类见 [`research/p5-tools.md`](research/p5-tools.md) §13）：

| 旧版 wire 名 | P5 状态 |
|---|---|
| `Read` / `Write` / `Edit` / `Glob` / `Grep` / `Bash` / `TodoWrite` | **已交付**（Read 只做文本；Bash 经 `ProcessPort`；TodoWrite 状态进日志，ADR-054） |
| `NotebookEdit` | 推迟 **P7**（范围 5 点名） |
| `Read` 的图像 / PDF / notebook 三个分支 | **改归 P6**（2026-10-19 裁定：内联图片进 P6）——原判「推迟 P7」的阻塞点是**契约**：v2 的 `Message` 联合没有附件通路。ADR-057 把附件通路提前到 P6，因此这三个分支由 **P6 T5–T6** 交付，不再是 P7 |
| `TaskOutput` / `TaskStop` / `TaskCreate` / `TaskGet` / `TaskUpdate` / `TaskList` | 推迟 **P7**（后台任务）；`run_in_background` 因此在 P5 **显式拒绝**而不是静默忽略 |
| `Agent`（子 agent） | 推迟 **P7** |
| `WebFetch` / `WebSearch` | 推迟 **P7**（网络） |
| `EnterPlanMode` / `ExitPlanMode` | 推迟 **P7**（plan 模式；ADR-032 已记既有缺口） |
| `CronCreate` / `CronDelete` / `CronList` / `ScheduleWakeup` | 推迟 **P7**（cron） |
| `ListMcpResources` / `ReadMcpResource` / `SubscribeMcpResource` / `UnsubscribeMcpResource` 与动态 `mcp__*` | 推迟 **P7**（MCP） |
| `AskUserQuestion` | 推迟 **P6/P7**（自由提问与审批是两件事） |

**无「无记录缺失」**：每一个旧版 wire 名都有归属。**P5 范围内唯一被砍的是 Read 的三个非文本分支，而它们在 2026-10-19 被裁定改归 P6**（附件通路提前，ADR-057）——所以「推迟」这个词对它们已经不再准确，见 P6 段的 T5/T6。

---

## P6 前端：headless 协议与 TUI

> **T1~T10 全部落地（ADR-055~069）——自动部分完成；剩下的只有真实终端上的人眼验收**（清单在 [`architecture/06-frontend.md`](architecture/06-frontend.md) 的「T10 收口」）。T2 协议、T3 `serve` 与 stdio 传输、T4 CLI 入口、T5 附件契约、T6 `Read` 非文本分支、T4a 三步（协议独立成包 ADR-062、组合根与宿主 ADR-063/064、可执行文件 ADR-065）、T7 骨架（主题 token ADR-061、TUI 骨架 ADR-066）、T8 卡片（ADR-067）、T9 图片（ADR-068）：[`research/p6-frontend.md`](research/p6-frontend.md)（五个问题的决定草案、被否决方案、图像协议矩阵、以及**一次实测**：旧版宽度表的排序缺陷）。契约文档是 [`architecture/06-frontend.md`](architecture/06-frontend.md)。
>
> **两处评审裁定（2026-10-19）**：① TUI 渲染**采纳 `@opentui/core`**（opencode 的渲染器）→ ADR-056；② **工具结果里的内联图片进 P6**（原计划在 P7）→ ADR-057 把「附件通路」的契约工作提前到本阶段。两处裁定都把代价写进了 ADR 正文，不是隐含假设。
>
> **包结构已定（ADR-062 = 选项 A′，T4a 分三步落）**：`packages/protocol`（协议，Node ≥22，无 opentui 无内核）→ `packages/cowcat` 加 `src/host/`（组合根 + `ProtocolHost` 实现）→ `packages/cli`（`bin` + 子命令表 + `doctor`）；`packages/tui` 退回渲染器 + 协议客户端，**不依赖内核**。**第 1 步与第 2 步都已落地**。查清的事实：仓库**没有 npm workspace**，`@corescense/cowcat-core` 是 `private` 且从未发布 → 跨包依赖只能 `file:`，而 `file:` 是**链接**（实测：npm 既不装目标的依赖也不构建它），所以消费者那条腿要自己 `npm --prefix ../protocol ci && run build`——2/3 落地后 `packages/cowcat` 成了一个消费者，因此 CI 的**三条 cowcat 腿**（`ci.yml` 的 ubuntu 与 windows、`ci-macos.yml` 的 macOS）也都加了这一步。三个选项（A′/B/D）的比较与理由写在 ADR-062 正文里。

**调研问题**

- headless 协议形态：JSON-RPC over stdio 是否足够；是否需要 SSE 或 WebSocket 给 IDE 用
- TUI 渲染：自研（沿用 wcwidth 与区域刷新）还是 ink；以实际终端的刷新率与闪烁做测量，不凭经验
- 命令行入口与子命令结构，参考旧版 `cliargs.js` 的经验

**范围**

1. headless 协议：版本化，覆盖会话打开、发送输入、订阅更新、回应审批、取消
2. 协议层的契约测试（不启动真实终端）
3. TUI 只通过协议工作：渲染订阅到的事件，不持有会话状态副本
4. `cowcat` 命令行入口

**任务拆分**（一个 PR 一个任务；契约先于实现）

| 任务 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| T0 | **决定落表**（纯文档）：ADR-055~060 进 ADR 表；新增 `architecture/06-frontend.md`；本段补任务表；**更正 P5 段与 P7 模块表**（Read 的非文本分支改为 P6 交付）；`04-dependencies.md` 记 opentui 准入 | 调研评审通过 | ✅ 本 PR |
| T1 | **前提验证**：CI 能否提供 Node ≥26.4（**已验证：v26.4.0 存在、26 线当前 v26.12.0**）；`@opentui/core` 在本机与 windows CI 腿能否安装并跑起最小界面；**装不上就地降级为「本机开发 + 手动验收」并把结论写回文档** | T0 | ✅ 本 PR（装得上，不降级） |
| T2 | **协议**：方法表 + 类型（zod 解码边界）+ 内存传输 + 契约测试（打开/输入/事件/审批/取消）+ `attachment.read` | T0 | ✅ 本 PR |
| T3 | **`serve` 子进程**：stdio 传输、生命周期、`initialize` 版本协商、一条 spawn 测试 | T2 | ✅ 本 PR（宿主是**拒绝型占位**，见 T4a） |
| T4 | **CLI 入口**：子命令表（数据）、帮助文本、`doctor` 最小版本 | T2 | ✅ 本 PR（`serve`/`doctor` 可用，其余四个动词在表里说明缺什么） |
| T4a | **组合根**（T3 的宿主缺口），按 ADR-062 分三步：**① 协议独立成包（`packages/protocol`，Node ≥22，无 opentui 无内核）**；② `packages/cowcat` 加 `src/host/`（组合根 + `ProtocolHost` 实现：模型预设目录与配置键按 **ADR-063**、落盘布局/信任闸门/基线规则/宿主形状按 **ADR-064**、七个工具、策略、审批桥）；③ `packages/cli`（`bin` + 子命令表 + `doctor`，动态 import 取 serve 与 tui；包边界、Node 门槛、选项进表与 `run` 的审批策略按 **ADR-065**） | T3、T4 | ✅ 三步全部落地（协议包、内核组合根、可执行文件；`cowcat serve`/`run`/`sessions list`/`doctor` 可用，`tui`/`setup` 与 `sessions resume` 仍等 T7） |
| T5 | **附件契约**（ADR-057）：`ToolResult.attachments` / `tool.finished.attachments` / `Message` 引用 / `ModelRequest` 内容部件；两协议适配器各自映射；**日志往返与「字节不进日志」的测试** | T0 | ✅ 本 PR（Read 真的读图见 T6） |
| T6 | **`Read` 恢复非文本分支**：图像 / PDF / notebook 走附件通路；大小与类型校验沿用 P5 口径 | T5 | ✅ 本 PR |
| T7 | **前端骨架**（独立包）：opentui 接入、`protocol/ app/ ui/ components/ theme/ image/` 目录、`project()` 纯函数与帧快照测试 | T1、T2 | ✅ 本 PR（协议已在 T4a 独立成包；`image/` 是 T9 的。**`cowcat tui` 与 `sessions resume` 同时接线**，帧快照 + `project()` 单测 + 真实进程探针见 `tools/tui-smoke.mjs`） |
| T8 | **组件**：session-frame / message / tool-card / approval-card / todo-panel / diff-card / status-bar / command-palette | T7 | ✅ 本 PR（还带了 `text/`（宽度表 + 换行 + diff）、命令表与键位两个纯模块、品牌指南 §4.2 的折叠与 §2.2 的催促文案。**未做**：滚动回看、Plan/Act 模式、语法高亮——理由见 `06-frontend.md` 的待办） |
| T9 | **图片渲染**（ADR-058）：`ImageRenderable` + 能力探测（env + `a=q` 静默查询）+ 三级回退；**两个位置**（工具结果内联 + 预览模态） | T8、T5 | ✅ 本 PR（**三级回退与探测是渲染库内建的**（kitty/sixel/blocks，无 iTerm2），我们落**尺寸 / 位置 / 三态**；**内联已落，预览模态没做**——见 ADR-068 与 `06-frontend.md` 的待办） |
| T10 | **收口**：出口标准复核（协议回合测试 + lint 禁 import 的探针）、真实终端上的刷新率/闪烁与图片协议验收（**需要人眼与支持协议的终端**）、`06-frontend.md` 定稿 | T2–T9 | ✅ 自动部分本 PR（**出口标准两条各有一条接缝测试/规则**：`packages/cli/test/exit-criteria.test.ts` 把真实协议事件流喂给 `project()`/`frameOf()`；`ui/screen.ts` 成为唯一允许 import 渲染器的文件，4 条 lint 探针证明规则会报错）。**人眼那一半待做**：`06-frontend.md` 的「T10 收口」有 8 条验收清单 |

**出口标准**

- 用 headless 协议完整跑通一个带工具与审批的回合（测试中）
- TUI 中删除任何直接访问内核内部的代码路径（lint 或测试保证）

---

## P7 功能模块（逐个调研，逐个 ADR）

每个模块开工前必须有调研文档。顺序按依赖关系排列，但可以按需调整。

> **2026-10-20 前沿调研**（[research/p7-frontier-survey.md](research/p7-frontier-survey.md)）：下表既有行的校准（D1~D4）与新增行（D5~D11，排在表尾）都以（D#）标注；其中一条排期建议是 **子 agent 提前到 MCP 之前**（D1——上下文隔离是当前公认性价比最高的单一手段）。每个候选行开工时仍按工作规则 1 另出专项调研。

| 模块 | 调研要点 | 依赖 |
|---|---|---|
| 上下文压缩 | 压缩触发点、压缩结果是否作为事件入日志、与回放的关系 | P2、P5 |
| 记忆（AGENTS.md / 项目指令） | 读取位置、优先级、与信任模型的关系 | P3 |
| 子 agent | 子会话是否独立日志、结果如何回传、权限是否收窄；**排期提前到 MCP 之前**（D1）。**已完成**（[research/p7-subagents.md](research/p7-subagents.md)、ADR-079~082）：独立子会话 + `Task` 虚拟工具 + 只收不放的权限 + 结果预算；`sessions list` 默认折叠、TUI 一行摘要；端到端（重放 / 取消 / 锁清理）已验 | P3、P5 |
| MCP | 官方 SDK 评估；stdio 服务器必须经 ProcessPort，因此天然被沙箱覆盖；对齐 **2026-07-28 规范**（D2：**无状态、逐请求 `_meta`**；HTTP 授权首选 Client ID Metadata Documents，**DCR 已 deprecated**）且首版**只做 stdio + tools**；v1 旧规范实现只迁结论不迁代码。**已调研并落表**（[research/p7-mcp.md](research/p7-mcp.md)）：ADR-083~088；**T1 已合（#80）**（双时代探测、`mcp__server__tool`、项目层受信、`ProcessPort.open()`、崩溃不重启）；**T2 已合（#81）**（分页、`subscriptions/listen` / 旧版 `list_changed`、活工具表）；**真实端点实测完成**（模型 + `server-everything`） | P2、P3 |
| Hooks | 触发时机、失败语义、是否经过策略；出生即兼容 Claude Code hooks.json 格式的取舍（D3）。**已完成**（[research/p7-hooks.md](research/p7-hooks.md)、ADR-121~123）：调研（#159）→ ADR（#160）→ T1~T4 实现（#161，`ports/hooks`、`adapters/hooks`、kernel 四处挂接、`hooks.context-added`、host 五源接线、doctor 行）+ 审查修复（#162，5 P1 全为 CC 兼容硬偏差 + 8 P2）+ **T5 真机验收通过**（§12：block-rm 链路真机 deny、doctor 三要素、CC 文档形态零改写生效） | P3 |
| Skills | 加载机制与工具暴露；渐进披露（首轮只注入目录、全文按需取用）（D4）。**已完成**（[research/p7-skills.md](research/p7-skills.md)）：ADR-114~117；T1/T2 实现（`ports/skills`、`policy/skills`、`adapters/skills`、`adapters/tools/skill`、`skills.loaded` 事件、doctor 行、TUI `/skills`）+ 审查修复（#151，3 P1 + 5 P2）+ **T4 真机验收通过**（§13：真实模型 glm-5.3-flash 自然触发 2/2、对照组 0/1） | P5 |
| 后台任务 | 生命周期与会话的关系，取消与清理 | P2 |
| Worktree | 与会话和信任的关系 | P2、P3 |
| Cron | 无人值守下的策略收窄 | P3、后台任务 |
| 文档类工具（Notebook、PDF、图像） | PDF 解析是否引入依赖；图像是否需要模型侧支持。**图像 / PDF 的读取已在 P6 T5–T6 交付**（ADR-057 的附件通路）；本行剩下的部分（`NotebookEdit` 的编辑语义、PDF 文本抽取的取舍）仍是 P7 | P5、P6 |
| Plan 模式 | 进入/退出契约（ADR-032 已记既有缺口，P5 对照表判归 P7 但此前无对应行）；**多方案预审**：执行前生成 2~N 个方案供用户选择（D5）。**已实现主体**（[research/p7-plan-mode.md](research/p7-plan-mode.md)、ADR-124~125）：T1 内核（`plan.mode-changed`/`plan.proposed`/`plan.decided` 三事件、`SessionState.planMode`、runCall 门控、ExitPlan 虚拟工具、评审暂停复用 awaiting_approval）+ T2 host/protocol/TUI/CLI（`plan.setMode`/`plan.reply` 两 method、host 评审桥照抄审批桥、TUI `/plan` 命令与方案卡、oneshot 兜底拒答）；**T4 真机验收通过**（§11：serve + 协议客户端全链路，2 方案→选择→退模式→审批执行→UNLICENSE 落盘） | P3、P5 |
| 工具结果治理 | tool clearing（旧工具输出整段清除，与压缩分层）、超限结果外置、重复调用防护；**稳定前缀不被改写**以命中提示缓存（D6）。**已完成**（[research/p7-tool-governance.md](research/p7-tool-governance.md)、ADR-118~120）：调研（#153）→ ADR（#154）→ T1~T3 实现（#155，`policy/tool-clearing`、`adapters/spill`、bash/read 接入、`tool.repeat-detected`）+ 审查修复（#156，1 P0 + 2 P1 + 4 P2）+ **T5 真机验收通过**（§12：三机制真机触发、零 400、cache ~90%+） | P5、上下文压缩 |
| 审批与沙箱闭环 | 沙箱/权限拒绝 → 一次性扩权申请与重试；用量仪表（token / 成本进事件与状态条）（D7）。**已调研**（[research/p7-approval-sandbox.md](research/p7-approval-sandbox.md)）：**ADR-129~131 已落表**（#179，含安全评审硬条款）：T1 Escalate+grants 覆盖 deny+refused/escalations 折叠、T2 沙箱闭环（拒绝识别/unsandboxedApproved）、T3 用量累计+成本（usageTotals/preset price/session.open 暴露）+ T4 TUI（审批卡 subject 首行+dimensions+sanitize、状态条 Σ/≈成本）均已实现（#180）；**post-merge 审查修复**（#181：回合级 EscalationTurnContext、path canonical、消费移到闸门后、生效 verdict 落日志、TUI 申诉卡无 session 行、subject wrap、+3 全链路测试）已合；**T5 真机验收通过**（§10：glm 自然申诉 1/1、once 重试放行、price/usage 全字段真机可见）；withoutSandbox 真沙箱后端标注未验 | P2、P3 |
| 会话体验 | 会话头补 cwd 与模型（`resume` 语境，`HANDOFF.md` §6 已登记）；日志推导标题；回退并 fork 的事件语义；`@` 文件引用（D8）。**已调研**（[research/p7-session-experience.md](research/p7-session-experience.md)）：ADR-126~128：T1 会话头 cwd/model + 标题派生（T2 session.fork 事件重放 + T3 @ 文件引用 + T4 TUI/CLI 均已实现，#173）；**T5 真机验收通过**（§12：@ 引用注入与作答、fork 重放继承实证、标题/cwd/模型派生可见）；rewind v1 不做（grants/锁/header 三重坑，列后续） | P6、上下文压缩 |
| 可观测性 | OTel GenAI 语义约定子集；事件日志 → span 适配器边界（D9），**已完成**：[research/p7-observability.md](research/p7-observability.md)，ADR-132~134 落表（#185），T1~T2 实现（#186：adapters/otel 纯翻译器 + OTLP 绑定 + host 组合根接线，内核零改动、重放安全、fork 双计语义），post-merge 审查修复（#187：3 P1 全修——provider.name 生产死代码 readHeader prime、畸形 endpoint 拖死宿主、subagent 遥测缺口 + 11 P2），**T4 真机验收通过**（§9：span 树/Required 属性/usage 对账全对，glm cache 命中 ~99.6%） | P6 组合根 |
| 记忆续篇：经验蒸馏 | 任务后后台蒸馏回写 AGENTS.md / skills 的**写入闸门**（与信任模型的交互）；衔接 ADR-075~078（D10） | 记忆模块 |
| 视觉工具 | 纯文本模型的 OCR / 布局结构化工具；本地与云端取舍；附件通路复用（ADR-057/058）（D11） | P6 T5–T6 |

---

## P8 发布切换

**范围**

1. `packages/cowcat` 切换为正式包：去掉 `private`，产物结构、`bin`、`engines` 与 `files` 核对
2. tarball 检查（文件清单、体积、无源码映射泄露策略按需决定）
3. CI 重构：旧 `agent/` 的作业迁移或删除
4. 删除旧 `agent/`；`docs/ROADMAP.md` 等旧文档归档到 `docs/archive/`
5. CHANGELOG 从 `1.0.0-beta.1` 起算；发布由人工完成 2FA（与既有流程一致）
6. headless / CI 形态：`cowcat run` 一次性任务出口的打磨 + GitHub Action / SDK 包装（前沿调研 D12；对应 Codex 2026 的 CI 集成打法）

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
