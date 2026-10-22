# P7 专项调研：会话体验（D8）

日期：2026-10-23 · 状态：调研（只出决定草案与 ADR 清单，不改 ADR 表、不改源码）

## 1. 问题与范围

dev-plan P7 行四件事 + D8 上游信号：

1. **会话头补 cwd 与模型**（resume 语境的登记缺口：`session.opened` 现在只有 schemaVersion/cowcatVersion/shell/parent【源码】`kernel/events.ts:53-55`；恢复后会话列表只见 sessionId）；
2. **标题从日志推导**（无任何先例，grep 全仓零命中；上游 dsh 有同款【上游源码】frontier-survey §2.3）；
3. **回退 / fork 的事件语义**（上游 dsh 双 Esc 回退+fork【上游源码】frontier-survey §2.3；与本仓库事件溯源「天作之合」）；
4. **`@` 文件引用**（只传校验过的路径【上游源码】dsh-at-file）。

非目标：**rewind（回退截断）v1 不做**——证据见 §5.3，三重坑（grants 重放语义、锁生命周期、header 首行不变量）需独立契约，列后续模块。多会话切换 UI、`@` 图片粘贴（剪贴板通路不存在【源码】tui grep paste 零命中）不在 v1。

## 2. 结论摘要（决定草案）

| # | 草案 | 一句话理由 |
|---|---|---|
| D1 | 会话头加**可选** `cwd` 与 `model`（创建时的目录与初始 preset），**不升 schemaVersion** | `parent` 已示范「header 可选字段、旧日志缺席即无」的兼容形状【源码】`events.ts:40-49`；必填才需要 bump（`schema.ts:140-145` 明文），可选字段零迁移 |
| D2 | 标题**不存、只派生**：session-index 解析每个日志的首个 `turn.opened.input` 截断成标题；`SessionSummary` 增 `title/cwd/model`（纯增量，clients 旧行为兼容，`parentSessionId` 已示范此论证【源码】`methods.ts:87-92`） | 「从日志推导」的字面实现；标题会随首条消息自然漂移，物化反而要回答「什么时候更新」；索引已逐文件读首行，多读几行成本可忽略 |
| D3 | **fork = 事件重放式**：新会话经 `Session.create`（`parent: { sessionId: 源, role: 'fork' }`，role 联合扩 `'fork'`）逐条 re-emit 源事件（跳过 header），seq/ts/sessionId 由 emit 重新铸造 | 逐字节拷贝会让每行审计字段（sessionId）与新身份不一致且违反 append-only 的首行纪律【源码】`adapters/node.ts:26-27`；重放式让 fork 日志天然合法、可重放、grants/compaction 状态全部继承 |
| D4 | fork 暴露为 protocol method `session.fork { sessionId } → { sessionId }`；要求源会话**无在跑回合**（fork 当前快照而非竞态） | 分叉一个正在跑的会话会得到半个回合；拒绝优于竞态（host 已有 `rec.running` 判定先例） |
| D5 | `@` 引用 = `turn.send` 增可选 `files: string[]`（绝对路径，TUI 解析 `@path`），**host 读盘**（内核禁 node:* 且 FsPort 无读）在校验后 emit `prompt.attached { turnId: null, files: [{ name, content }] }` 再开回合 | 内容必须进日志才可重放（「合并进 input 改写用户原话」在 hooks 已被否）；host 注入先例 = SessionStart/turn.noted 直写；事件在 `turn.opened` 前折叠成 user 消息，模型先读文件再读指令 |
| D6 | `@` 校验：存在 + UTF-8 可解 + ≤32KB/文件 + 每回合 ≤8 个；二进制/超限/不存在 → **拒整个 turn.send** 并给可读理由 | 「只传校验过的路径」的上游语义；部分附加会让日志里出现半份输入，拒绝是原子的（ADR-052 精神：坏输入是可读结果不是半状态） |
| D7 | TUI：`/sessions` 与会话头显示标题/cwd/模型；输入框 `@` 自动补全不做（v1 裸路径），回显校验错误；fork 走 `/fork` 命令 | 补全要目录遍历 UI，v1 不值；错误回显让「为什么没发出去」可见 |

## 3. 取证方式与局限

- 【上游】frontier-survey §2.3（dsh 会话体验三件套的二手信号，未取一手源码）；header cwd 的一手先例 v1 changelog（`docs/changelog.md:489`）属 archive 非现行规范。
- 【源码】探索代理逐条取证（文件:行号见 §4/§5）。
- 局限：fork 的重放成本（长日志 O(n) 重写）未实测【推断：万级事件秒级，列验收观察】；`@` 的 UTF-8 校验用 lossy 还是拒收，T3 前定死（倾向拒收——坏字节进日志会毒化重放）。

## 4. 本仓库现状（【源码】）

### 4.1 会话头与索引

- `session.opened = { schemaVersion, cowcatVersion, shell, parent? }`【源码】`events.ts:53-55`；`SessionShell = {kind, executable}`。
- `SessionSummary = { sessionId, lastSeq, parentSessionId? }`【源码】`protocol/methods.ts:84-94`；`sessions list` 只打 sessionId+事件数【源码】`cli/sessions.ts:46-52`；TUI 恢复后模型要等下个 `turn.opened`、cwd 永远拿不到【源码】`project.ts:32-47`。
- `session-index` 条目 `{ sessionId, lastSeq, parentSessionId }`，**已逐文件读首行**做防御解析【源码】`adapters/session-index.ts:38-87`；消费方仅 host `listSessions` 与 CLI 两处。

### 4.2 fork 的现成件与坑

- 现成：id 铸造、子会话 create+parent 先例、emit 重铸 seq/ts【源码】`session.ts:144-153`；快照只是加速器、重放兜底【源码】`session.ts:247-258`。
- 坑（全部被 D3 规避）：逐字节拷贝的审计字段不一致 + 首行不变量；rewind 独有的：无 truncate API、锁全生命周期持有、截到 0 行无 header、**grants 随截断消失用户被重问**（语义需产品决定）。

### 4.3 `@` 的通路

- `turn.send = { sessionId, input }` strictObject，无附件字段【源码】`protocol/methods.ts:41`；TUI 提交纯文本【源码】`run.ts:666`。
- 现有 attachment 是 tool→model 展示通路（`view.attachments` 来自 `tool.finished.attachments`），类型仅 `image|document`、注释明令「引用绝不带字节」【源码】`ports/attachments.ts:11-22`——**不能复用**，`@` 走文本注入。
- 注入模板：`hooks.context-added`（turn 前 user 消息事件，可重放）【源码】`run-turn.ts:280-293`、`events.ts:305-318`。

### 4.4 兼容纪律（复用即可）

header 可选字段不 bump（parent 先例）；快照新字段「必填+失败重放」（planMode 先例 `schema.ts:404-406`）；新 method 五处注册 + `methodNotFound` 兜底不 bump version（plan.setMode 先例）。

## 5. 决定草案（给 ADR 的输入）

| 项 | 草案 | 备选（被否/待定） |
|---|---|---|
| header 字段形态 | 可选 `cwd`/`model`，不 bump（D1） | 必填+bump：旧会话全部变「不可读」级别的迁移，为两个展示字段不值 |
| 标题存储 | 派生不存（D2） | 物化进 header/state：要回答「何时更新」，且标题编辑（改名）引出第三套语义 |
| fork 实现 | 事件重放（D3） | 文件拷贝：审计字段不一致，否；硬链/快照共享：锁与写者翻倍，否 |
| fork 时机 | 源无在跑回合（D4） | 随时 fork（复制已落盘前缀）：rec.running 判定外还要处理「刚好写完的事件」，竞态不值 |
| `@` 注入层 | host 读盘 + 事件（D5） | TUI 读盘塞进 input：改写用户原话（hooks 同款否决）；内核读盘：禁 node:* |
| `@` 失败语义 | 拒整个 turn.send（D6） | 部分附加+警告：日志出现半份输入，否 |
| rewind | v1 不做，列后续 | 强行同做：grants/锁/header 三坑任何一个的错答都会污染 v1 的其余三件 |

## 6. 需要落的 ADR（草案）

| ADR | 主题 |
|---|---|
| ADR-126 | 会话头与标题推导：header 可选 cwd/model（不 bump，parent 先例）；SessionSummary 增 title/cwd/model 派生字段；session-index 防御解析首个 turn.opened；标题截断规则（长度/换行） |
| ADR-127 | session.fork 事件语义：重放式实现、parent.role 'fork'（SessionParent role 联合扩宽，subagent 逻辑不读 fork）、无在跑回合要求、grants/compaction 状态继承的声明、**rewind 不做**的理由与后续条件 |
| ADR-128 | `@` 文件引用：turn.send 扩 files 参数、host 校验（存在/UTF-8/32KB/每回合 8 个）与注入事件 `prompt.attached`（turn 前 user 消息，可重放）、失败拒整个 send、TUI 错误回显 |

## 7. 任务拆分

| 任务 | 内容 | 出口标准 |
|---|---|---|
| T1 | header cwd/model（events/schema/session.create 透传/host 接线/CLI TUI 展示）+ session-index 标题派生 + SessionSummary 扩展 | 旧日志读入无 bump；sessions list 见标题/cwd/模型；schema 编译期锁过 |
| T2 | `session.fork` method 五处注册 + host 重放实现 + `parent.role 'fork'` + CLI `sessions fork` | fork 后新会话 replay 等价、grants 继承、运行中拒绝；fork 出的会话 resume 正常 |
| T3 | `turn.send` files 参数 + `prompt.attached` 事件三件套 + host 校验读盘 + 单测 | 校验矩阵（不存在/二进制/超限/过多）；事件序（attached 在 turn.opened 前）；重放一致 |
| T4 | TUI：会话头展示、`/fork`、输入 `@` 解析与错误回显；doctor 不新增行 | TUI project/run 测试 |
| T5 | 真机验收：fork 一个真实会话 resume 继续；`@` 文件真机引用；记录写回 §12 | 真机会话日志可复查 |

## 8. 待验证

1. **fork 重放成本**【推断】：万级事件日志的 fork 时延；验收 T5 量一下，若 >1s 考虑 index 侧优化（列为后续）。【须实测】
2. **标题截断的 CJK 宽度**【推断】：按字符数还是显示宽度截断（wcwidth 已有先例 `text/width.ts`）；倾向按字符数 40 + 省略号，真机看列表可读性再调。【须实测】
3. **`@` 文件的二进制误判面**【推断】：UTF-8 拒收会让 .zip/.png 直接失败——这是语义（文本引用）不是缺陷；提示文案说清「文本文件」。【须实测】
4. **fork 后子会话折叠**：`sessions list` 按 parentSessionId 折叠会把 fork 也折进源——语义可辩护（同族会话）但用户可能找不到 fork；T2 前定：折叠保留 + 列表标注 `(fork)`。【须裁决】
