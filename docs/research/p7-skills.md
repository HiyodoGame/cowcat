# P7 Skills 调研

> 状态：**已评审落定**（2026-10-22）：S1~S10 全部采纳（S4 同名优先级与 S5 `yaml` 依赖经用户确认），ADR-114~117 已进 ADR 表。本文只出决定草案与 ADR 清单，按工作规则 1，**不在本文里改 ADR 或源码**。
>
> 上游依据：Agent Skills 规范（`agentskills.io/specification`，2026-10-22 取）与 Claude Code skills 文档（`code.claude.com/docs/en/skills`，2026-10-22 取）。两处都是一手页面；文中【上游】均指这两处。

## 1. 问题与范围

P7 表里 Skills 一行要回答的是：**加载机制与工具暴露；渐进披露（首轮只注入目录、全文按需取用）**（`dev-plan-v2.md` P7 表）。

范围限定：

- 只做**本地文件技能**（`SKILL.md` + 同目录的脚本/参考文档）。不做 claude.ai 同步、不做插件市场、不做 MCP 侧 skills。
- 不做技能里的自动执行（`!`command`` 动态注入）、不做参数替换（`$ARGUMENTS`）、不做 `context: fork`。这些是 Claude Code 的产品行为，不是 Agent Skills 规范的一部分。
- 不在本模块处理 Hooks（P7 表另一行，D3 同一批但独立调研）。

## 2. 结论摘要

1. **格式照 Agent Skills 规范做，不发明私有格式**：`<name>/SKILL.md` + YAML frontmatter，`name` / `description` 必填，其余字段按规范校验。
2. **发现四类目录**：`~/.cowcat/skills/`、`<项目>/.cowcat/skills/`（原生），以及 `~/.claude/skills/`、`<项目>/.claude/skills/`（兼容只读）。目录只扫一层，不递归。
3. **项目层的两个来源都过 `workspaceTrusted` 门**，与 AGENTS.md、项目层 MCP 一致；个人层不受门。
4. **渐进披露用两级**：catalog（每个技能的 `name` + `description`）作为一条会话消息注入；全文只在模型调用 `Skill` 工具时读取。
5. **frontmatter 需要真正的 YAML 解析**：引入 `yaml`（运行时依赖 4 / 6），只在 `src/adapters/` 里用。
6. **`allowed-tools` 在 v1 明确不生效**（安全方向），并在 doctor 里说明「该字段被忽略」——不能让它看起来像生效了。

## 3. 取证方式与局限

- **【源码】** 只读本仓库实现，给 `文件:行号`。
- **【上游】** 两个一手页面，只取与实现相关的段落；页面无版本号，2026-10-22 抓取。
- **【推断】** 未实测的推论，单独标注，不作为决策依据。
- **局限**：
  - 没有真实模型参与，**技能触发率（模型会不会选对技能）无法在本轮给数**。这属于 T4 验收项，不是设计依据。
  - 没有在 Windows 上验证 `~/.claude/skills` 是否存在（本机没装 Claude Code），兼容路径的实际内容未取样。
  - Claude Code 的 listing 具体字节数未实测，本文只用它文档里写明的预算规则。

## 4. 上游格式（一手）

### 4.1 目录与文件

【上游】规范要求技能是一个目录，至少含 `SKILL.md`：

```
skill-name/
├── SKILL.md          # 必需：frontmatter + 指令
├── scripts/          # 可选：可执行代码
├── references/       # 可选：按需读的文档
└── assets/           # 可选：模板/图片/数据
```

规范推荐 `SKILL.md` 正文 **500 行以内**，细节拆到 `references/`；引用用相对技能根的路径，**只一层深**。

### 4.2 frontmatter 字段（规范）

| 字段 | 必需 | 约束 |
|---|---|---|
| `name` | 是 | 1–64 字符；仅小写字母、数字、连字符；不以 `-` 开头/结尾；无连续 `--`；**必须等于父目录名** |
| `description` | 是 | 1–1024 字符；既要写「做什么」也要写「什么时候用」 |
| `license` | 否 | 许可证名或同目录许可证文件名 |
| `compatibility` | 否 | ≤ 500 字符；环境要求（产品、系统包、网络） |
| `metadata` | 否 | 字符串键值映射，供客户端自用 |
| `allowed-tools` | 否 | 空格分隔的预授权工具串（规范标为 **experimental**） |

### 4.3 渐进披露（规范原文的三层）

【上游】

1. **元数据**（约 100 tokens）：所有技能的 `name` + `description` 在启动时载入；
2. **指令**（建议 < 5000 tokens）：技能被激活时才载入 `SKILL.md` 正文；
3. **资源**：`scripts/` `references/` `assets/` 里的文件，真正需要时才读。

这条是 D4 的直接依据，也是本文 §6.4 的设计来源。

### 4.4 Claude Code 的实现细节（只取与我们有冲突或可复用的部分）

【上游】`code.claude.com/docs/en/skills`：

- **listing 预算**：名字永远在；描述按预算截断。`description` 与 `when_to_use` 合并后**单条截断 1,536 字符**；超出总量时丢描述而不是丢名字。预算可用 `skillListingBudgetFraction`（文档示例 `0.02` = 上下文的 2%）或 `SLASH_COMMAND_TOOL_CHAR_BUDGET`（固定字符数）调整；文档未写默认比例，本文不假定。
- **内容生命周期**：技能正文进入会话后**作为一条消息长期保留**；相同内容重复调用只加一句「已加载」，不重复注入。
- **压缩后重挂**：自动压缩后把「每个技能的最近一次调用」重新挂到摘要之后，每个保留前 **5,000 tokens**，合计预算 **25,000 tokens**；按最近使用排序，旧的可能整条丢弃。
- **`allowed-tools`**：只在调用技能的那一轮生效，下一条用户消息到达即失效；**workspace trust 不 gate 这个字段**，项目技能的 `allowed-tools` 在未受信目录里也照样生效。
- **CC 扩展字段**：`when_to_use`、`disable-model-invocation`、`user-invocable`、`disallowed-tools`、`model`、`effort`、`context: fork`、`agent`、`background`、`hooks`、`paths`、`shell`、`argument-hint`、`arguments`。
- **容错**：未知字段静默忽略；YAML 解析失败时**技能仍然加载**，只是所有字段为空（即描述丢失、无法被自动触发）。
- **位置**：enterprise / personal（`~/.claude/skills`）/ project（`.claude/skills`）/ nested（子目录）/ `--add-dir` / plugin。个人覆盖项目（同名时 personal 赢）。

## 5. 本仓库现状（【源码】）

| 事实 | 位置 | 对设计的影响 |
|---|---|---|
| **没有 system prompt**：`ModelRequest.system` 存在但内核从不设置，指令作为 **user 消息**注入 | `ports/model.ts`（字段）、`kernel/run-turn.ts:342-381`、`kernel/state.ts:197-207` | catalog 沿用同一形状：一条 user 消息，而不是塞进 system |
| `instructions.loaded` 是**产出消息的事件**，回放不碰文件系统 | `kernel/events.ts:155-172`、`kernel/state.ts:197-207` | skills 需要同构事件，否则回放会与真实请求分叉 |
| 压缩会清掉被摘要吞掉的 `instructionsSeq`，下一轮重新注入 | `kernel/state.ts:190-194` | skills 需要自己的 `skillsSeq`，同一处清理 |
| `FsPort` 只做**路径身份**（canonical/samePath/kindOf/exists），不读文件 | `ports/fs.ts:30-46` | 目录扫描与文件读取放 adapter；政策层只做纯决策 |
| 指令读取在 adapter 里用 `node:fs/promises`，失败一律「当作没有」 | `adapters/instructions.ts:85-91` | skills 沿用：坏的技能目录不能让会话起不来 |
| 工具表是**静态 Map**，MCP 会替换成动态表 | `host/host.ts:782-808`、`host:246` | `Skill` 做成静态工具即可，不需要动态表 |
| 项目层受信门控两件事：项目规则与项目指令 | `host/host.ts:199-205`、`policy/instructions.ts:67-84` | 项目技能必须走同一扇门 |
| zod 只允许出现在 `src/adapters/`（lint 强制） | `AGENTS.md`、`docs/architecture/04-dependencies.md` | frontmatter 校验（zod）与 YAML 解析都只能落在 adapter |
| 运行时依赖 **3 / 6**，每引入一个都要 ADR | `04-dependencies.md:14,28` | 新增 `yaml` 必须进 ADR 表并登记（落定后 **4 / 6**） |
| 判断标准 2：**几十行的纯工具函数自己写，不引依赖** | `04-dependencies.md:10` | 所以要先论证 frontmatter 解析**不是**几十行（见 §6.3） |

## 6. 设计

### 6.1 发现范围与优先级

| 层 | 路径 | 信任 |
|---|---|---|
| 个人（原生） | `~/.cowcat/skills/<name>/SKILL.md` | 不受门 |
| 个人（兼容） | `~/.claude/skills/<name>/SKILL.md` | 不受门 |
| 项目（原生） | `<项目根>/.cowcat/skills/<name>/SKILL.md` | **受 `workspaceTrusted` 门** |
| 项目（兼容） | `<项目根>/.claude/skills/<name>/SKILL.md` | **受 `workspaceTrusted` 门** |

- **项目根**的判定沿用指令链：从 `cwd` 向上第一个带 `.git` 的目录（`adapters/instructions.ts:34-44`）。**不**扫 `cwd` 与根之间的每一层（Claude Code 的 nested 语义），v1 只认项目根，避免同名技能在 monorepo 里出现两个来源。
- **只扫一层**：`skills/` 的直接子目录，必须是大写 `SKILL.md`。`references/` 里的文件不参与发现。
- 符号链接目录：`FsPort` 的 canonical 语义已经解析符号链接（`ports/fs.ts:30-46`），按目标判重。

**优先级（同名）**：项目 > 个人；同层 `.cowcat` > `.claude`。**与 Claude Code 相反**（CC 是 personal 覆盖 project），理由：本仓库的指令链是「更具体优先」（ADR-076），项目自带的技能应当覆盖个人默认值；且兼容目录是「借用」的，不应压过原生目录。这条分歧必须在 ADR 里写明，否则会被当成 bug。

### 6.2 信任边界

- 项目层两个来源共用 `workspaceTrusted`（`host/host.ts:199-205`）。未受信时：**不注入 catalog、不可调用**，并发一条 notice（形状复用 `describeInstructionSkip` 的可操作性：说清跳过了几个技能、怎么解锁）。
- 个人层不受门：`~/.cowcat` 与 `~/.claude` 是用户自己写的，和 `~/.cowcat/AGENTS.md` 同级（ADR-075）。
- 受信之后重新发现不需要缓存失效：`decideSkills(files, trust)` 是纯函数，与 `decideInstruction` 同构。

### 6.3 frontmatter 解析：为什么需要 `yaml`

判断标准 2 要求先论证「不是几十行」。真实的 `SKILL.md` frontmatter 至少会出现：

- 单行标量里带冒号（`description: Deploy: staging and prod`）——朴素 `split(':')` 会切错；
- 引号字符串、行内 `#`；
- 块标量（`description: >-` 折行，多行描述在真实技能里很常见）；
- 列表与嵌套映射（`allowed-tools` 的 YAML 列表形式、`metadata` 的 map）。

一个只认 `key: value` 的手写解析器会**静默**把 `description: >-` 读成字符串 `">-"`，然后技能永远匹配不上——这正是 D3（出生即兼容）想避免的迁移成本。自己写对上述子集需要正确处理缩进、引号与折叠规则，已经超出「几十行纯函数」的范畴。

结论：引入 **`yaml`**（eemeli/yaml，零运行时依赖，纯 ESM 可用），只在 `src/adapters/` 里 import。运行时依赖 **4 / 6**，需 ADR。备选（被否）：`js-yaml`（带 `argparse` 依赖）、手写子集解析器（静默错误）。

### 6.4 catalog：注入什么、多大

渲染形状（纯函数，policy 层）：

```
<system-reminder>
以下技能可用。需要时调用 Skill 工具，name 必须完全一致。
- pdf-processing: Extract PDF text, fill forms... Use when handling PDFs.
- commit: Stage and commit the current changes.
</system-reminder>
```

预算（三个数都要可解释）：

| 项 | 值 | 依据 |
|---|---|---|
| 单条 description 上限 | 1024 字符 | 规范上限，不需要额外截断规则 |
| catalog 总预算 | `min(8 KB, 窗口 × 2%)`；窗口未知时 8 KB | 与 CC 的「百分比预算 + 1536 字符/条」同量级但更简单；8 KB ≈ 2k tokens，50~80 个技能 |
| 超预算策略 | 先丢描述、保留名字；再按名字排序截断到预算 | CC 明确「名字永远在」；我们照做，因为名字是调用 `Skill` 的唯一入口 |

- **不截断名字**：catalog 里出现一个不能调用的名字是更糟的错误。
- 注入是 `skills.loaded` 事件 → 一条 user 消息（§5 第一行），`text` 里是渲染后的 catalog，回放不需要文件系统。
- **content 里的 `</system-reminder>` 必须转义**，与 `renderInstructions` 同一处理（`policy/instructions.ts:155-159`）。
- 顺序按名字排序（稳定前缀），不按目录遍历顺序——遍历顺序随文件系统变化，会让前缀抖动。

### 6.5 `Skill` 工具

```
Skill({ name: string }) -> 技能正文 + 文件清单
```

- 命中：返回 `SKILL.md` 正文（去掉 frontmatter），末尾附 `references/` `scripts/` `assets/` 的**相对路径清单**（只列一层，文件 + 目录名），并注明「用 Read/Bash 按需取用」。
- body 上限 **32 KB**：超出截断并附 `truncation` 事实（沿用 ADR-048 的 `Truncation` 字段）。规范建议 < 5k tokens，32 KB ≈ 8k tokens，是「异常但可用」的上限，不是目标。
- 未命中：返回可用名字列表（若超预算只给前若干个 + 总数），**不猜近似名**。
- 风险等级 `read`，无 `pathInput`：读的路径来自发现结果，不是模型输入。这样路径规则不会误伤，也无法用 `../` 越权。
- 正文作为 tool 消息留在会话里；压缩把它丢掉之后，模型可以再次调用（catalog 已重新注入）。
- 同一技能重复调用：v1 直接返回正文（简单），**不做** CC 的「已加载」去重——去重需要跨事件记住已注入的 body 哈希，收益是省一次工具输出，留 T2。

### 6.6 与策略/沙箱的关系

- `Skill` 只读文件，不执行正文里的任何东西。正文里让模型「运行 scripts/x.sh」时，仍然是一次普通的 `Bash` 调用，照常过策略与沙箱（ADR-016/033）。
- **`allowed-tools` v1 不生效**：CC 的语义是「技能可以给自己扩权，且不受 workspace trust 约束」；本条与 ADR-028/030 直接冲突（仓库内容不得自我授权）。要做也必须挂在 ADR-094 的「`session` 审批档」上，并且只对受信项目生效。v1 的诚实做法：解析该字段、**不生效**、doctor 明示。把它静默忽略会让作者以为已经预授权。
- `disable-model-invocation: true`（CC 扩展）**v1 就 honor**：它只让这个技能不进 catalog（不能用 Skill 工具触发），是「收紧」方向，成本一行过滤。这样仓库里为 CC 写的「只许人手动跑」的技能不会意外被模型触发。
- `paths`（按文件 glob 激活）、`context: fork`、`hooks` 等一律不生效；doctor 汇总「被忽略的字段」，不逐条刷屏。

### 6.7 最小可用面

- **`/skills`**（TUI）：列出本次会话的 catalog（名字 + 来源 + 是否被 trust 跳过），本地视图，不走协议。
- **`cowcat doctor`**：新增 `skills` 行——发现数量、按来源分组、跳过的项目技能、被忽略的字段、catalog 字节数。形状照 `doctor.ts:156-180` 的 `instr` / `mcp` 行。

### 6.8 不做的（v1 边界）

| 不做 | 原因 | 何时再议 |
|---|---|---|
| 文件监听 / 热更新 | catalog 是稳定前缀，热更新会让前缀抖动并破坏回放一致性 | T2，配 `/skills reload` 显式刷新 |
| 自动重挂（CC 的 5k/25k） | 需要记录「每个技能最近一次注入的 body」，压缩路径要改；v1 靠重新调用已足够 | T2 |
| `$ARGUMENTS` / `!`command`` | 产品行为，且 `!` 等于在技能里藏一条无审批的命令 | 不做，除非有独立 ADR |
| plugin / enterprise / nested | 生态未定，先不引入第二套发现规则 | R8 插件生态 |
| MCP 侧 skills | MCP 首版已明确不做（ADR-083 ①） | 不议 |

## 7. 与压缩、提示缓存的交互

- catalog 是会话的**稳定前缀**之一：只在会话开始时（或压缩后重注入）出现，内容只依赖磁盘与 trust，会话中途不变。
- 压缩清理：`state.ts:190-194` 的 `instructionsSeq` 旁增加 `skillsSeq`。**注意顺序**——重注入要在 `ensureInstructions` 之后，保证前缀顺序是「指令 → 技能」而不是随压缩时机漂移。
- 技能正文在 tool 消息里，压缩按现有规则处理；不额外保留。若模型需要，重新调用 `Skill` 即可，代价是一次工具往返。

## 8. 决定草案

| # | 决定 | 依据 |
|---|---|---|
| **S1** | 格式照 Agent Skills 规范：`<name>/SKILL.md` + YAML frontmatter；`name` 必须等于目录名 | 规范；D3 |
| **S2** | 发现四类目录（原生 + `.claude` 兼容只读），只扫项目根与个人层，只扫一层 | §6.1 |
| **S3** | 项目层受 `workspaceTrusted` 门；未受信不注入、不可调用、发 notice | ADR-030/077 对称 |
| **S4** | 同名优先级：项目 > 个人，`.cowcat` > `.claude`（**有意与 CC 相反**） | ADR-076「更具体优先」 |
| **S5** | 引入 `yaml`（4 / 6），只在 adapters；解析失败/约束不合 → 跳过 + warning，**不学 CC 的「无字段也加载」** | §6.3 |
| **S6** | catalog 作为 `skills.loaded` 消息注入，单条 description ≤ 1024 字符，总量 `min(8 KB, 窗口 2%)`，超预算先丢描述保名字，按名字排序 | §6.4 |
| **S7** | `Skill` 工具：`read` 风险、无 `pathInput`、body ≤ 32 KB 且带 `Truncation`；未命中列可用名字 | §6.5 |
| **S8** | `allowed-tools` v1 **不生效**并在 doctor 明示；`disable-model-invocation` v1 生效（不进 catalog） | ADR-028/030、ADR-094 |
| **S9** | 不做热更新、不做自动重挂、不做 `!`command`` / `$ARGUMENTS` | §6.8 |
| **S10** | `/skills`（TUI）与 doctor 的 `skills` 行进同一批，缺一不可 | §6.7 |

## 9. 需要落的 ADR（草案）

> ADR 表当前最大编号是 **113**，以下从 **114** 起排；落表时以当时最大编号顺延。

| #（暂号） | 一句话 |
|---|---|
| ADR-114 | 技能的发现范围、同名优先级与项目层信任边界（含与 Claude Code 相反的两条：项目 > 个人、解析失败即跳过） |
| ADR-115 | frontmatter 兼容策略与 `yaml` 依赖（运行时 4 / 6；只在 adapters；honor 字段清单） |
| ADR-116 | catalog 渐进披露：注入形状、预算、排序与压缩后重注入（`skillsSeq`） |
| ADR-117 | `Skill` 工具契约：`read` 风险、32 KB 上限、未命中语义；`allowed-tools` v1 不生效 |

## 10. 任务拆分

| 任务 | 内容 | 出口标准 |
|---|---|---|
| T1 | 内核 + 适配器：`SkillPort` / `policy/skills.ts`（纯决策与渲染）/ `adapters/skills.ts`（扫描 + YAML）/ `skills.loaded` 事件 / `state.skillsSeq` / `Skill` 工具 | 单测覆盖：规范约束逐条拒绝、同名优先级、未受信跳过、预算截断、转义、`disable-model-invocation`；`npm test` 全绿 |
| T2 | `host` 接线 + doctor `skills` 行 + TUI `/skills` | `cowcat doctor` 在真实目录上给出正确行；未受信项目的技能不出现 |
| T3 | 文档：ADR-114~117 落表、`04-dependencies.md` 加 `yaml` 行、P7 行状态、README 能力清单 | 文档与代码同 PR（工作规则 5） |
| T4 | 真机验收：真实模型触发一次技能；未受信项目被跳过；压缩后 catalog 仍在、`Skill` 仍可调 | 结果写进 `beta-checklist.md` 或独立验收记录 |

## 11. 待验证

1. **模型触发率**【推断，需 T4】：catalog 只给 name + description 时，模型在中文任务里选对技能的概率——没有数据，不能预先承诺「像 CC 一样准」。
2. **`~/.claude/skills` 的实际内容形态**：**2026-10-22 已取得真实样本**（本机 33 个技能，其中 24 个 `lark-*`）：块标量、`metadata.requires` 嵌套对象、`version` / `user-invocable` / `argument-hint` 等 CC 扩展字段都在。据此把 `metadata` 校验收宽为「只要求是 map」（ADR-115 ② 已修订），否则会拒掉 24 个 Claude Code 能用的技能。
3. **Windows 路径大小写与 junction**：`canonical` 已处理符号链接，但 `<项目>/.claude/skills` 在 Windows 上的实际大小写行为未取样。
4. **8 KB / 2% 的预算**：**2026-10-22 实测有了第一个真实分布**——33 个技能（24 个 `lark-*`）的描述合计远超 8 KB。初版「超预算即丢全部描述」产出 674 字节纯名单；改成按剩余预算等分截断后是 7578 字节，每条描述约 200 字节。是否够模型判断，仍待 T4 触发率数据。
5. **`description` 含中文时的预算**：规范按字符计，我们的预算按字节——CJK 一字三字节，50 个中文技能可能比 80 个英文技能更早触顶。T2 实测后写进文档。

## 12. 与 Claude Code 的有意分歧（评审重点）

| # | Claude Code | 本仓库 | 理由 |
|---|---|---|---|
| 1 | personal 覆盖 project | project 覆盖 personal | ADR-076「更具体优先」；项目约定应是权威 |
| 2 | 项目 `allowed-tools` 不受 workspace trust 约束 | v1 完全不生效 | ADR-028/030：仓库内容不得自我扩权 |
| 3 | YAML 解析失败仍加载（字段为空） | 跳过并报告 | 静默的技能比没有技能更贵；ADR-025 的两级报错同一取向 |
| 4 | 压缩后自动重挂最近调用（5k/25k） | v1 不重挂，靠重新调用 | 改动少、语义清楚；重挂作为 T2 |
| 5 | 支持 nested / plugin / `--add-dir` | 只认个人层与项目根 | 多来源同名规则会膨胀；等 R8 插件生态 |
