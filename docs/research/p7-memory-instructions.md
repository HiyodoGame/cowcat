# P7 调研：记忆与项目指令（AGENTS.md）

> **本文件只出决定草案与 ADR 清单，不改源码、不改 ADR 表**（工作规则 3）。
>
> 对象是 `dev-plan-v2.md` P7 表的第二行：**记忆（AGENTS.md / 项目指令）**——调研要点：读取位置、优先级、与信任模型的关系；依赖 P3。

## 证据标注约定

- **【上游源码】** 直接读到上游仓库的实现，给 `仓库/路径` 与符号
- **【上游文档】** 官方文档原文，给 URL 或文档路径
- **【本仓库】** 读本仓库代码
- **【推断】** 未实测的推论，**不得作为决策依据**

**本文件没有【实测】条目**：这轮只读代码与文档，没有跑任何仓库上的加载实验。

## 0. 结论摘要

1. **四家上游都是「链」，我们目前是「最近的一个文件」。** 【本仓库】`policy/instructions.ts` 的 `INSTRUCTION_FILENAMES = ['AGENTS.md', 'CLAUDE.md']` + `ports/instructions.ts` 的 `nearest()`：从 cwd 往上找**第一个**文件。上游无一例外是「全局一个 + 项目根到 cwd 一条链」，有的还加子目录按需加载。
2. **「注入成什么」是这一轮真正的契约问题**，四家分成两派：Claude Code 明确是「system prompt 之后的一条 user 消息」；DeepSeek 更进一步，把指令做成**可重放的 durable `user/message`**；codex 拼进 prompt；opencode 组装进 initial instructions。**我们两条路都还没有走**——【本仓库】`ModelRequest.system` 至今没有任何调用方设置。
3. **指令与压缩会打架，而且我们刚做完压缩。** 如果指令进历史，一次 compaction 就会把旧指令遮掉；DeepSeek 的处理是「基线在压缩后重新注入」。这条必须在 ADR 里写死，否则压缩过后模型会在没有项目指令的情况下继续干活。
4. **接口层已经就绪，缺的是接线**：【本仓库】`InstructionPort`（`nearest`）、`FileInstructionSource`、`decideInstruction`（信任闸门）、`describeInstructionSkip`（跳过时说一句）都存在并有测试，但 **`host` 与 `run-turn` 一次都没调用它们**。

## 1. 取证方式（可复现）

| 工具 | 形态 | 取证 |
|---|---|---|
| **Claude Code** | 闭源；官方文档 | 【上游文档】`code.claude.com/docs/en/memory`（本次逐段读） |
| **codex** | Apache-2.0 | 【上游文档】`developers.openai.com/codex/guides/agents-md`；仓库内 `docs/agents_md.md` 只是指向它 |
| **opencode** | MIT | 【上游文档】`anomalyco/opencode@dev:services/www/src/docs/content/instructions.mdx` |
| **DeepSeek Harness** | 开源 | 【上游文档】`deepseek-ai/deepseek-harness@master:packages/context/agent-instructions/README.md` |

## 2. 问题一：怎么找到指令文件

### 2.1 四家的发现规则

| 工具 | 全局 | 项目 | 子目录 | 同名覆盖 |
|---|---|---|---|---|
| **Claude Code** | `~/.claude/CLAUDE.md`；另有组织级 managed 文件（`/etc/claude-code/CLAUDE.md` 等） | cwd 及其**所有祖先**的 `CLAUDE.md` / `.claude/CLAUDE.md`，**全部拼接**，从根到 cwd 依次在上下文里出现 | 子目录的 `CLAUDE.md` **按需**加载：Claude 读写编辑该目录下文件时加载一次 | `CLAUDE.local.md` 追加在 `CLAUDE.md` 之后；`AGENTS.md` **只在没有** CLAUDE.md 时读（或显式配置成两者都读） |
| **codex** | `$CODEX_HOME/AGENTS.md`，有 `AGENTS.override.md` 时用它 | 从项目根（`.git`）**向下走到 cwd**，逐目录检查：`AGENTS.override.md` → `AGENTS.md` → 配置的 fallback 名；**每个目录最多一个文件** | 不单独处理（链本身就是到 cwd） | 拼接、空行分隔，**越靠近 cwd 越靠后**；空文件跳过；总字节超过 `project_doc_max_bytes`（默认 32 KiB）就停 |
| **opencode** | `~/.config/opencode/AGENTS.md` | cwd **向 home 方向**逐级找，到项目根为止 | 探索到更深的目录时**按需**加载，最近者优先、去重 | **V2 不认 `CLAUDE.md`**；另有 `instructions: []` 可配 glob/绝对路径/URL，排在 AGENTS.md 之后 |
| **DeepSeek** | `$DSH_HOME/AGENTS.md` → `~/.agents/AGENTS.md`（两个全局根，内容相同时折叠） | 项目根（`.git` 标记）到 cwd 的**每个**候选文件，宽→窄 | 成功的 `read`/`write`/`edit` 触达更深目录后，下一次请求附带新文件 | 基础候选 `AGENTS.md`/`CLAUDE.md` + 本地叠加 `AGENTS.local.md`/`CLAUDE.local.md`；**按 trim 后内容去重** |

四方一致的三件事：

1. **全局 + 项目链**，不是「最近的一个」；
2. **顺序 = 宽 → 窄**，具体的规则在后；
3. 有**预算**，超过就截断/丢弃。

### 2.2 我们现在的做法【本仓库】

- `ports/instructions.ts:20-29`：`nearest(cwd)` 返回 cwd 或其祖先上**第一个**文件；注释写明「'Nearest' is the standard's rule — the closest file wins」，并且**空文件不算**（避免空 `AGENTS.md` 遮住旁边的 `CLAUDE.md`）。
- `policy/instructions.ts:12`：`['AGENTS.md', 'CLAUDE.md']`，AGENTS.md 优先。
- 没有子目录按需加载，没有全局文件，没有预算。

**这个选择的来历**（ADR-029）：v1 把专有的 `COWCAT.md` 排在最前，导致写了标准文件的仓库被静默忽略。修法是「不要专有名」，但当时也顺带选了「只读最近一个」。

### 2.3 决定草案

**D1：升级为「全局 + 项目链」，保留 AGENTS.md 优先与空文件不算。**

- 全局：`~/.cowcat/AGENTS.md`（没有就跳过）。
- 项目：项目根（`.git` 所在）到 cwd 的每一层，每层取**第一个存在的**候选（`AGENTS.md` → `CLAUDE.md`），再叠加该层的 `*.local.md`（gitignore 掉的那种）。
- 顺序：全局 → 根 → … → cwd；同一层 local 在后。
- **代价**：monorepo 里祖先目录的规则开始生效——这可能正是想要的，也可能带来噪音。Claude Code 为此提供了 `claudeMdExcludes`；我们**不做**排除配置，先看真实需求（写进「不做」清单）。

## 3. 问题二：注入成什么（本轮最要紧的契约）

### 3.1 四家的形态

| 工具 | 注入形态 | 是否在会话记录里 | 压缩后 |
|---|---|---|---|
| **Claude Code** | **system prompt 之后的 user 消息**（文档原文：「CLAUDE.md content is delivered as a user message after the system prompt, not as part of the system prompt itself」） | 未说明（闭源），但「项目根 CLAUDE.md 压缩后**从磁盘重读并重新注入**」是明写的 | 重新从磁盘读、重注入；子目录 CLAUDE.md 与 `paths` 规则按需再加载 |
| **codex** | 拼进模型的 user instructions（`codex_protocol` 的 instructions 通道） | 未在本文档口径内 | 由它自己的 compaction 重建 |
| **opencode** | 组装进 initial instructions：agent/provider system prompt → Code Mode → MCP/skill 指引 → **全局与项目 AGENTS.md** → 日期/环境 → 会话级指令 | 会话历史里有 instruction entry（文档说「nested files are deduplicated while their instruction entry remains in model-visible history」） | 未被本文档讨论 |
| **DeepSeek** | **durable `user/message`**，带 sourced 变更列表，外面套 `<system-reminder>` 框架；基线一条、新增/变更/删除各一条 | **是**（明写「replay, compact, and resume exactly like other history」） | 压缩会遮住旧基线，**重新注入基线** |

### 3.2 两条路对我们的含义

| | A：走 `ModelRequest.system` | B：走事件（一条 user 消息进日志） |
|---|---|---|
| 模型看到什么 | 与真实请求一致 | 一致（只是一条普通消息） |
| 可重放「模型当时看到了什么」 | **不能**——`system` 不进日志 | **能** |
| 占上下文预算 | 占（与 message 一样是 token） | 占 |
| 与压缩的关系 | **无关**：压缩只换 messages，system 原样重发 | **有关**：compaction 会把指令消息遮住，必须重新注入 |
| 实现量 | 小：在 `host`/`run-turn` 设 `request.system` 即可 | 中：新事件或新消息来源、折叠规则、压缩后重注入 |
| 审计 | 只能看「磁盘上现在是什么」 | 能看「当时是什么」 |

**这条要与 ADR-071 一起读**：我们刚把压缩做成「按 seq 水位线替换历史」。如果指令是历史里的一条消息，那么压缩后它会被遮住——除非 compact 在生成摘要时**把指令排除在压缩范围之外并重新注入**（DeepSeek 的做法：基线在压缩后重建）。

**D2：选 B（进日志），并把「压缩后重新注入」写成同一份契约。**

理由：

1. **可重放是本仓库的地基**（ADR-059 ②、`state.ts` 的纯折叠）。「模型看见的指令」如果不可重放，以后再出一次「为什么它没按 AGENTS.md 做」就没有证据——这正是 v1 栽过的坑（私有的 `COWCAT.md` 被静默忽略）。
2. DeepSeek 已经把这条验证到「指令消息要像普通历史一样 compact / resume」，并且给出了完整的注入/更新/删除三态文案，照抄成本最低。
3. 走 `system` 的唯一硬优势是「压缩不用管」，但只要 plan 里那条重注入规则写清楚，B 的代价是可控的。

**代价（必须写进 ADR）**：AGENTS.md 的全文会进历史，会被压缩摘要吞掉一次；每次压缩后要重新注入一条新的基线（历史里因此可能出现两份基线，需要靠「文件内容摘要 + 路径」判重）。

## 4. 问题三：信任（我们比上游多一层）

- 【本仓库】ADR-030：**未受信的目录不注入**，并且要用 `describeInstructionSkip` 明说「找到了但因未受信跳过（N 行）」。这条比四家都严：codex/opencode 没有任何信任闸门；Claude Code 只对**跨目录的外部 import** 要求批准；DeepSeek 明写「symlink 会跨信任边界，建议用 fs policy 或 OS sandbox 兜」。
- 【上游文档】Claude Code 的 external import 批准只发生一次，且用户级文件默认信任。
- 【推断，需实测】链路化之后，**祖先目录的文件成为新的信任面**：一个 monorepo 的根 `AGENTS.md` 现在会被读进上下文。它仍受 workspace trust 约束（受信的是 cwd 所在工作区），所以不需要第二个闸门，但要在 ADR 里写清「信任的单位是工作区，不是单个文件」。

**D3：保留 ADR-030 的闸门与「跳过要说出来」；链路化不改变信任单位。**

**D4：不跟随符号链接。** DeepSeek 把「symlink 跨信任边界」列为已知风险并建议用沙箱兜；我们的沙箱只管命令执行，不管读文件（`Read` 走 FsPort）。保守做法是遇到 symlink 就当文件不存在并记一行——比事后解释「为什么它读了仓库外的文件」便宜。

## 5. 问题四：预算

| 工具 | 预算 | 超了怎么办 |
|---|---|---|
| Claude Code | 单文件 > 4 MiB 跳过；建议 ≤ 200 行 | 启动时警告；`/doctor` 提议削减 |
| codex | `project_doc_max_bytes` 默认 **32 KiB**（可调） | 达到上限就停止添加 |
| DeepSeek | `maxBytes` **65,536**（必填）；单文件 `maxSourceBytes` 1 MiB | **先整份丢弃更宽的，再截断最具体的**；并发一条可见的 `Workspace instruction budget …` 提示 |
| opencode | 未见上限 | — |

**D5：取 DeepSeek 的形状**：`maxBytes = 65,536`，宽→窄丢弃优先、最具体的文件可截断，超限时输出一条可见提示（不是静默）。理由：它同时给了「怎么丢」和「说出来」，而我们的 ADR-069 刚刚为「不说」付过学费。

## 6. 问题五：会话中途改了文件

| 工具 | 行为 |
|---|---|
| Claude Code | **不生效**：中途编辑 CLAUDE.md 不影响当前会话，`/clear`、`/compact` 或重启后才生效（压缩会重读） |
| codex | 每次**运行/新会话**重建链，没有心跳 |
| opencode | **每次请求前**检测变化并追加 instruction update |
| DeepSeek | **触达式**：不做 watcher；成功的 `read`/`write`/`edit` 才重新发现更深目录；`resume` 时对账 |

**D6：v2 先不做中途刷新，与 Claude Code 一致**：文件在会话开始时读，压缩后重读一次，其余时间不变。理由：可预测、少一条并发路径；`Read` 一个刚改过的 AGENTS.md 时模型自己能看见变化。

## 7. 决定草案汇总

| # | 决定 |
|---|---|
| **D1** | 全局 `~/.cowcat/AGENTS.md` + 项目根到 cwd 的链；每层 AGENTS.md 优先、`*.local.md` 叠加；空文件不算 |
| **D2** | 指令**进日志**（一条 sourced user 消息）；压缩后**重新注入基线**，判重靠路径 + 内容摘要 |
| **D3** | 信任单位是工作区（ADR-030 不变），跳过必须说出来 |
| **D4** | 不跟随符号链接 |
| **D5** | 预算 65,536 bytes；宽→窄丢弃，最具体文件可截断；超限给可见提示 |
| **D6** | 不做中途刷新；只在会话开始与压缩后读取 |

## 8. 需要落的 ADR（清单，草案）

| # | 一句话 |
|---|---|
| **ADR-075** | **指令是历史里的一条消息**：注入形态、source 标记（路径 + 行数 + 摘要）、与 system 的边界；压缩后重新注入 |
| **ADR-076** | **发现规则**：全局 + 项目链（root→cwd）、候选顺序、local 叠加、空文件与 symlink 的处理 |
| **ADR-077** | **预算**：65,536 bytes；丢弃顺序与可见提示 |
| **ADR-078** | **与压缩的交互**：基线不在压缩范围内或被压缩后重建；判重键（路径 + 内容哈希） |

（ADR-029/030 不推翻：`nearest` 被 ADR-076 取代，信任闸门保留。）

## 9. 任务拆分（草案）

| 任务 | 内容 | 依赖 |
|---|---|---|
| T1 | 端口扩展：`chain(cwd)` 取代 `nearest(cwd)`，返回有序的 `InstructionFile[]`（含 local 叠加与空文件过滤） | — |
| T2 | 渲染与预算：拼成一条消息、宽→窄丢弃、截断、生成提示文案 | T1 |
| T3 | 注入：会话开始时写入一条 sourced user 消息（新事件或消息来源标记） | T2 |
| T4 | 与压缩的交互：基线重新注入 + 判重 | T3、ADR-071 |
| T5 | 信任与跳过提示接线（`decideInstruction` / `describeInstructionSkip` 进 host 与 `doctor`） | T1 |
| T6 | 收口：`doctor` 报告加载了哪些指令文件、跳过了哪些 | T2~T5 |

## 10. 待验证

1. **真实仓库的体量分布**：一个典型 monorepo 的链加起来有多少字节？65 KiB 是上限还是常态？（决定预算是否需要更小）
2. **链的重复**：本仓库自己的根 `AGENTS.md` 与 `packages/cowcat` 若各有一份，重复内容占多少？
3. **压缩后重注入的判重**：内容哈希在「用户改了一个字」时应重新注入，在「没改」时应跳过——需要一次真实压缩前后对照。
4. **Windows 路径**：`~/.cowcat` 与项目根判定在 Git Bash / PowerShell 下的一致性（`FileInstructionSource` 目前用的是 `FsPort`，需要确认它给的是同一个规范路径）。

## 11. 附录 A：本仓库现状（逐条）

| 事实 | 位置 |
|---|---|
| 候选文件名 `AGENTS.md` → `CLAUDE.md` | `packages/cowcat/src/policy/instructions.ts:12` |
| 「最近的一个文件」，空文件不算 | `packages/cowcat/src/ports/instructions.ts:20-29` |
| 未受信 → `skipped-untrusted`，并给出行数 | `packages/cowcat/src/policy/instructions.ts:23-48` |
| 文件读取实现 | `packages/cowcat/src/adapters/instructions.ts:23-30` |
| **没有被接线**：`host` / `run-turn` 都没有调用 `InstructionPort` | 全仓库 `rg` 仅命中导出与定义 |
| `ModelRequest.system` 存在但无人设置 | `packages/cowcat/src/ports/index.ts:210-216` |

## 12. 附录 B：上游要点（可直接对照实现）

- **Claude Code**【上游文档】：四层作用域（managed / user / project / local）；祖先目录全部拼接、根在前；子目录按需；`@path` 导入（最多 4 跳，外部导入需批准）；`.claude/rules/*.md` + `paths:` frontmatter 按文件类型加载；>4 MiB 跳过；建议 ≤200 行；**以 user 消息形式在 system prompt 之后**；压缩后从磁盘重读并重注入；中途编辑不生效。
- **codex**【上游文档】：`AGENTS.override.md` 优先于 `AGENTS.md`；每目录最多一个；fallback 文件名可配；总字节上限默认 32 KiB；空文件跳过；每次运行重建。
- **opencode**【上游文档】：全局 + 到项目根的链；子目录读取时按需且去重；V2 **不认 CLAUDE.md**；`instructions` 数组支持 glob 与 HTTP(S)；请求前检测变化并追加 update。
- **DeepSeek**【上游文档】：两个全局根 + 项目链 + local 叠加；65,536 bytes；宽→窄丢弃；内容去重；注入为 durable `user/message`（可重放/可压缩/可 resume）；触达式重新发现；symlink 跨信任边界记为风险；删除与更新各有专门文案。
