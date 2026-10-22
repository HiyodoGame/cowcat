# P7 专项调研：工具结果治理（tool clearing / spill / 重复调用防护）

日期：2026-10-22 · 状态：调研（只出决定草案与 ADR 清单，不改 ADR 表、不改源码）

## 1. 问题与范围

dev-plan P7 行（D6）的「工具结果治理」拆成三件事，加一件复核：

1. **tool clearing**：旧工具输出整段移除（不是摘要），与 compaction 分层并用；
2. **超限结果外置（spill）**：超大工具结果落盘、上下文里只留引用与摘要头；
3. **重复调用防护**：连续同工具同参数时注入提醒（repeat-tool-reminder）；
4. **复核 ADR-071 的稳定前缀**：当前折叠实现是否满足「前缀不被改写」这一提示缓存硬约束，clearing 引入后还成不成立。

非目标：不改压缩语义（ADR-071 已决定）；不做跨会话的结果复用/缓存；不动各工具适配器现有的**生成时截断**（bash 100KB 保尾、mcp 20K 字符、read 2000 行等——它们是写入 `tool.finished` 之前的事，本模块管的是**进入上下文之后**的治理）。

## 2. 结论摘要（决定草案）

| # | 草案 | 一句话理由 |
|---|---|---|
| D1 | tool clearing 是**派生视图不是事实**：每轮请求前由 policy 纯函数从 `state.messages` 计算「发送视图」，不入日志、不发事件 | 清除是确定性派生（输入=日志+固定策略），记事件只会每轮刷日志；代价是「发送视图 ≠ 日志真相」，与 readFiles 闸门同类，需文档明示 |
| D2 | 清除只动 `role:'tool'` 消息的 `output`，改写为占位符 `[已清除 N 字节]`；**assistant 的 `toolCalls` 永不删**（两个 wire 协议都要求每个 tool_use 有应答） | 配对约束是协议层硬事实，删调用本身会 400 |
| D3 | 保留窗口 = 最近 2 条完整 tool 结果 + 当前轮次内的全部结果；被清除的计数与字节数进占位符 | 「最近 2 条」对齐「模型短期工作记忆」直觉；阈值是 v1 拍脑袋值，列 ADR 待真机校准（与 CC 的阈值同级问题） |
| D4 | spill 在**适配器层**做统一助手（新 `adapters/spill.ts`），与现有生成时截断同位置同事件字段；引用文本进 `output`，全文写会话状态目录 | 截断本来就在适配器（`bash.ts`/`mcp/client.ts`），同一事件（`tool.finished`）同一字段族（`truncation`），内核零改动 |
| D5 | spill 阈值 `maxInlineBytes = 50_000`（对齐 dsh 的 `maxInlineBytes`）+ 保头 4KB；落盘文件名 `<sessionId>/spill/<callId>.txt` | 直接借上游已验证数字；保头对齐 dsh 的 head 4096 |
| D6 | 重复调用检测在 kernel `run-turn` 主循环：`normalizeCall` 后的 (name, JSON 规范化 input) 与**前一次调用**比较，连续 ≥2 次相同 → 在该次工具结果旁注入一条提醒 user 消息 | 检测要拿「上一轮真实调用」只能在内核；提醒进日志可重放「模型当时看到了什么」（同 ADR-078 ④ 的取舍） |
| D7 | 稳定前缀复核结论：ADR-071 的折叠**当前满足**「头部逐字」纪律（唯一头部改写是压缩，其代价 ADR-071 已承认）；tool clearing 会引入**中部缓存失效**（首个被清除的 tool 结果之后全部失效），这是拿旧数据换的既定代价，**可量化**（`lastUsage` 已带 cache 读数，T-验收真机量） | 见 §6 |

## 3. 取证方式与局限

- 【上游】`p7-frontier-survey.md` §2.2/§4.2 已取证（CC cookbook 三策略对比、dsh `cordis.patch.yml` 阈值、repeat-tool-reminder），本调研直接引用，不重复外查。
- 【源码】本仓库代码由探索代理逐条取证（文件:行号见 §4/§5），关键结论均已人工复核。
- 局限：CC cookbook 的 tool clearing 保留窗口具体数值未取到一手（只有策略定性）；dsh 阈值是 2026-10 快照，版本敏感。
- 【推断】标注处未实测，不作为决策依据。

## 4. 上游形状（引用自 frontier-survey）

- **tool clearing 是独立技术**：旧工具输出整段移除而非摘要，与 compaction 分层并用。【上游文档】platform.claude.com/cookbook（Memory / Compaction / Tool Clearing 三策略对比）。
- **剪枝阈值**：无模型、超 8192 字符截 head 4096 / tail 1024。【上游源码】dsh `packages/bundle/base/cordis.patch.yml:360-365`。
- **spill**：超大结果落盘只留引用，`maxInlineBytes: 50000`。【上游源码】同上包。
- **repeat-tool-reminder**：连续重复同工具同参数时注入提醒（循环防护）。【上游源码】dsh。
- **提示缓存约束**：「稳定前缀 + 追加式 + 只清工具结果」是默认姿势；任何重写历史前缀的操作都击穿缓存。【上游文档】同 cookbook。

## 5. 本仓库现状（【源码】）

### 5.1 消息与折叠

- `Message` 三角色联合，`role:'tool'` 是**独立消息**，按 `callId` 与 assistant 的 `toolCalls` 配对（`packages/cowcat/src/kernel/messages.ts:32-55`）。
- 折叠（`reduce` 的 `context.compacted` 分支）：`messages = [summary] + seq > throughSeq 的消息`，**唯一会改写头部的事实**；原始事件一条不删不改（`src/kernel/state.ts:181-212`、`src/kernel/events.ts:125-142`）。
- 会话请求唯一构造点：`run-turn.ts:473-481`（`streamModel`），每轮从 `session.state.messages` **全新构建数组**但内容逐字来自日志视图。
- 两个适配器的配对约束：anthropic 把连续 tool 消息合并进同一个 user turn 的 `tool_result` 块（`src/adapters/model-anthropic.ts:238-290`）；openai 映射为 `role:'tool'`（`src/adapters/model-openai.ts:222-270`）。两家都要求每个 tool_use 有应答——**清除只能换 output 内容，不能删消息/删调用**。

### 5.2 既有截断（生成时，全部在适配器、写入事件之前）

| 点 | 阈值 | 位置 |
|---|---|---|
| bash | 100KB 保尾 | `src/adapters/tools/bash.ts:25`、`src/adapters/output-tail.ts:15-66` |
| mcp | 20K 字符 裁头 | `src/adapters/mcp/client.ts:25,514-521` |
| read | 2000 行 / 20MB 硬 | `src/adapters/tools/read.ts:10-12,141-145` |
| grep | 250 行 | `src/adapters/tools/grep.ts:10` |
| skill 正文 | 32KB 两遍截断 | `src/adapters/tools/skill.ts:76-90` |
| 子代理报告 | 20K 字符 | `src/kernel/subagent.ts:18,112-122` |

`Truncation { truncated, dropped, reason }` 是 `ToolResult` 一等字段（ADR-048）；`tool.finished` 事件还带 `path`（canonical path，readFiles 闸门用，`src/kernel/events.ts:265-272`）——**spill 引用不能复用 `path`**，语义不同。

### 5.3 钩子点

- **clearing**：`streamModel` 构造请求处过滤是唯一单点；policy 纯函数 + 内核应用，先例 `decide()/decideInstruction/decideSkills`（`run-turn.ts:711-712、393、437`）。
- **spill 写能力**：`FsPort` 是只读身份端口（ADR-017），写文件先例全在 adapters（`JsonlEventStore.append`、`FileSnapshotPort.save`），状态目录解析在 `src/host/paths.ts:37-50`。⇒ spill 落 adapters 层，零新端口。
- **重复检测**：主循环内可拿 `session.state.messages` 里每条 assistant 消息的 `toolCalls`（input 已被 `normalizeCall` JSON 规范化，`run-turn.ts:554-564`），字符串比较稳定。

### 5.4 缓存读数已接线

适配器不发 cache 控制头，策略就是依赖前缀稳定（`src/kernel/compact.ts:16-19`）；`lastUsage` 已收录 anthropic 的 `cache_read_input_tokens`（`model-anthropic.ts:357-364`）与 openai/deepseek 的 cached 字段（`model-openai.ts:380-388`）——**clearing 的缓存代价开箱可测**。

## 6. 稳定前缀复核（对 ADR-071 的复核项）

1. **现状【源码】**：折叠视图对「未压缩部分」逐字保留，头部唯一改写来自压缩事件本身；每轮重建数组不改内容。⇒ **当前实现满足**「前缀不被改写」纪律。
2. **clearing 引入后**：发送视图每轮清除「最近窗口之外」的 tool 输出——首个被清除消息位于历史中部的某个位置，其后的前缀全部变化 → **缓存命中线退到首个被清除结果之前**，且随会话增长逐轮后退。这是「只清工具结果」策略的上游既定代价（survey §4.2 第 3 条明写这是默认姿势的一部分），不是实现 bug。
3. **纪律补充（草案）**：「不改写未清除部分」——清除只改 output 内容，不动消息顺序、不动其它字段，占位符文本确定性（字节数进文案会破坏确定性！占位符只写 `[已清除 N 字节]`，N 是确定性的；但若按字节数文案逐轮不同，那部分本来就已被清除，无缓存可言）。**占位符文案必须纯确定性**（不含时间戳/随机）。
4. **可量化**：T-验收用同一脚本开/关 clearing 各跑一遍，对比 `lastUsage` 的 cache 读数比值。【推断】未实测，列为验收项。

## 7. 与压缩、指令/技能重注入的交互

- 压缩折叠按 seq 水位线重写头部；clearing 是尾部/中部的视图过滤，两者**正交**，可同时生效（折叠后的 summary 是 user 消息，不是 tool 消息，永不被 clearing 动）。
- 指令/技能重注入（ADR-078 ④）在压缩后追加——clearing 不触碰 user 消息，无交互。
- `readFiles` 闸门（ADR-049）是 state 事实不是消息，clearing 不影响。

## 8. 决定草案（给 ADR 的输入）

| 项 | 草案 | 备选（被否/待定） |
|---|---|---|
| clearing 记账 | 派生视图，不入日志（D1） | 发 `toolOutputs.cleared` 事件：每轮刷日志、快照膨胀，否——除非真机发现派生视图审计不够用再议 |
| 清除单位 | 整条 tool 消息的 output 换占位符（D2） | 字节级裁剪：破坏「整段移除」语义且占位符边界复杂，否 |
| 保留窗口 | 最近 2 条 tool 结果全保 + 当前轮内全保（D3） | 按 token 预算窗口：更好但 v1 复杂度不值，列为后续校准项 |
| spill 位置 | 适配器层统一助手（D4） | kernel 级统一：要新写端口+事件字段，而截断本来就在适配器，否 |
| spill 引用 | `output` 头部引用文本（路径+字节数+前 4KB） | 新事件字段：适配器协议变更大，否 |
| 重复提醒落地 | 进日志的 user 消息（D6，可重放优先） | 仅请求视图：与 ADR-078 ④ 取舍不一致，否 |
| 重复计数范围 | 连续相同即计数（不限同轮/跨轮） | 只看同轮：跨轮死循环正是目标场景，否 |

## 9. 需要落的 ADR（草案）

| ADR | 主题 |
|---|---|
| ADR-118 | tool clearing：派生视图定位（非事实、不入日志）、配对占位符纪律、保留窗口、与压缩/readFiles 的分层、缓存纪律（占位符确定性 + 命中线后退的既定代价） |
| ADR-119 | spill：适配器层位置、`maxInlineBytes` 50KB + 保头 4KB、会话状态目录落盘、引用文本形状、与既有 `truncation` 字段的关系 |
| ADR-120 | 重复调用防护：检测形状（规范化 input 比较）、连续计数、提醒消息形状（确定性文案、进日志）、防误报边界（哪些调用豁免——待定：如天然幂等的 Read 相同参数？） |

## 10. 任务拆分

| 任务 | 内容 | 出口标准 |
|---|---|---|
| T1 | `policy/tool-clearing.ts`（纯函数：保留窗口判定 + 视图过滤）+ `run-turn.ts` `streamModel` 应用 + 单测 | 配对不被拆、占位符确定性、窗口边界、与折叠共存的重放确定性（property 测试补一条） |
| T2 | `adapters/spill.ts` 统一助手 + bash/read 两个最大产出方接入 + `tool.finished` 引用形状 + 单测。**2026-10-22 实现前复核修正**：原写「bash/mcp」，但 mcp 的 20K 字符上限（§5.2）在 spill 阈值 50KB 之下、天然不触发，真正的第二产出方是 read（`allow_large` 可整文件返回至 20MB）；ADR-119 ⑤ 已同步修正 | 超限落盘、引用含路径+字节数+头、未超限零行为变化 |
| T3 | kernel 重复检测（`normalizeCall` 比较）+ 提醒 user 消息进日志 + 单测 | 连续 2 次触发、第 3 次文案计数、不同参数不触发 |
| T4 | 文档：ADR-118~120 落表、dev-plan 行状态、`doctor` 不新增行（治理无可报告量？待定） | 文档与代码同 PR |
| T5 | 真机验收：真实模型长会话，观察 clearing/spill/repeat 三机制真机行为与 cache 读数 | 数据写回本文件 §12 |

## 12. T5 真机验收记录（2026-10-22）

**结论：三机制全部真机触发，会话零 400、cache 命中率保持 ~90%+。**

### 环境

- 模型：`zai-coding-plan/glm-5.3-flash`（真实 API），`cowcat run --yes`，临时受信项目
- 内核版本：#156 合并后（含审查修复）

### 场景 A：重复调用防护 — 通过

- 输入要求模型「同一 node 命令跑两次」；模型两次调用**参数完全相同**的 `Bash`（均因引号问题 exit 2）
- 第二次调用触发提醒：CLI stderr 打出「⚠️ 模型在重复调用 Bash（第 2 次，参数相同）」；日志事件 `tool.repeat-detected count=2`
- 文案变体正确：bash 非零退出是 `ok:true`（结果已返回、由模型解读 exit code），提醒走「已返回结果」分支，符合设计

### 场景 B：spill + clearing + 缓存 — 通过

- 预置 60,002 字节 `big.txt`，模型 Read 一次读全 → **spill 触发**（60002 字节落盘 `sessions/<id>/spill/call_*.txt`，模型收到引用 + 4KB 头）
- 模型随后用 `od` 字节级验证文件内容 → od 输出 60,072 字节 → **二次 spill**
- 模型正确理解引用语义：最终答复明说「接收到的正文被清除、只保留头部 4KB，经 od 验证」
- **clearing 生效的旁证**：日志持有 ~65KB 输出（真相），而各轮请求 input 仅 5.9K–6.7K tokens——wire 上是占位符 + 引用；4 条 tool 消息超过保留窗口后最旧的被清除，**全程零 400**（配对完好）
- **cache 读数（§11.2 的首个数据）**：四轮请求 cacheRead 5,824 / 5,888 / 6,528 / 5,888，占 input 的 88%–99%——此规模下 clearing 的中部失效没有击穿缓存（命中线退到首个被清除结果之前，前缀仍大段命中）

### 未覆盖 / 边界

- §11.1（保留窗口 2 条是否合理）仍未验证：需要更长会话（几十条 tool 结果）做三档对比，列为后续
- §11.2 只有单一会话的单点数据，无开/关对照（clearing 无开关）；「代价量级」在此规模下≈可忽略，大会话待补
- repeat 提醒的误报面（§11.4）：真机仅触发 1 次且判定恰当；Read 重读的噪音情况未见实例

## 11. 待验证

1. **保留窗口 2 条是否合理**【推断】：拍脑袋值；需要更长会话（几十条 tool 结果）做三档对比。**§12 后仍未验证**，列为后续。
2. **clearing 的缓存代价量级**：**2026-10-22 §12 首个数据**——小规模会话（4 条 tool 结果、input ~6K）cacheRead 占 88%–99%，中部失效未击穿缓存；无开/关对照（clearing 无开关），大会话待补。【部分实测】
3. **CC 的 clearing 保留窗口一手数值**：cookbook 只有策略定性，数值未取到；不阻塞（D3 已选独立阈值）。【上游，可后补】
4. **重复提醒的误报面**：**2026-10-22 §12 首个实例**——真机触发 1 次，判定恰当（模型确实在重试同一失败命令）；ADR-120 ③ 已按「只提醒不阻断、v1 无豁免」裁决，Read 重读的噪音情况仍无实例。【部分实测】
5. **spill 文件的生命周期**：**2026-10-22 已查证【源码】**——CLI 没有会话删除命令（`packages/cli/src/cli/sessions.ts` 只有 list/resume），会话日志本身就没有清理路径；spill 目录（`<sessionId>/spill/`）随会话日志同生命周期、同目录策略，**不新增清理义务**，磁盘增长归「sessions 目录治理」这个既有话题。ADR-119 只需写明「不承诺清理」。
