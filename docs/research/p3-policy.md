# P3 调研：策略、配置与审批协议

> 依据 [`dev-plan-v2.md`](../dev-plan-v2.md)「工作规则 1」：每个阶段开始前先做调研，回答阶段内的开放问题，列出被否决的方案及理由。本文件回答 P3 的开放问题，并给出它们对 P3 五项范围的具体影响。
>
> 最后更新：**2026-10-17**。状态：**调研完成**。五项决定已由评审拍板（§2.5、§3.6、§6.4、§6.6、§7.4）；指令文件一项按评审要求补做了 AGENTS.md 标准调研（**附录 E**），结论落在 §5.4。
> 前置：[`dev-plan-v2.md`](../dev-plan-v2.md) 的 `## P3` 段、[`HANDOFF.md`](../HANDOFF.md) §3、[`architecture/03-policy-and-execution.md`](../architecture/03-policy-and-execution.md)。
>
> **本文件的证据边界（必须先说清）**：结论有三类来源，逐条标注。**本次新增了三个探针脚本并实跑，共 32 条断言全部通过**（见附录 B）——凡标注【实测】的数字都出自它们，不是读代码得来的。

## 证据标注约定

沿用 [`p1-kernel.md`](p1-kernel.md) 与 [`p2-ports.md`](p2-ports.md) 的约定：

- **【源码】** 本次会话直接读到实现或配置，给出 `文件:行号`
- **【实测】** 本次新增的探针跑出来的结果，给出 `tools/<脚本>` 与用例号（附录 B）
- **【旧版实测】** 仓库里此前的会话留下的测试断言或 CI 结果，给出 `文件:行号`。**本次没有重跑旧版测试**
- **【上游】** 来自官方文档（附录 C）
- **【推断】** 尚未实测的推论，**不得作为决策依据**
- **【未验证】** 明确未核对

---

## 0. 结论摘要

| # | 问题 | 决定 | 依据 |
|---|---|---|---|
| 二 | 裁决顺序是否保留 `deny > ask > allow` | **保留**（评审通过）。补充：**`deny` 永不被短路**，无人值守只影响 `ask` 的归宿 | §2.5、探针 `policy-decide-probe`（16/16） |
| 三 | 配置分层与合并语义 | **层：用户 → 项目 → 会话**（评审通过）；环境变量**不作层**，逐键决定；**不再有 STATE_KEYS 这类隐式最高层**；**列表键合并**而非替换 | §3.6、探针 `legacy-config-probe`（10/10） |
| 四 | 规则语言 | **结构化字段**（`{tool, path?, command?, risk?, network?}`），否决纯文本 DSL 与函数式 `matches` | §4.4、【源码】`perrules.js:67` |
| 五 | 信任模型 | 信任按**目录身份精确匹配、无继承**；门控改**不对称**（allow 等信任，deny/ask 立即生效）；指令文件统一为 **`AGENTS.md`**，且**未信任时不注入** | §5、探针 `legacy-trust-probe`（8/8）、**附录 E** |
| 六 | 审批协议 | `approval.requested` / `approval.answered` 进日志；**无人值守 = auto-deny**（评审通过，与旧版及 Claude Code `dontAsk` 一致） | §6、【源码】`run-turn.ts:118-123` |
| 七 | 审计作为事件消费者 | 审计消费 `policy.decided` + 新事件；**「永不抛」只约束消费者本身**，不约束被审计端口 | §7、【源码】`ports/process.ts:174-181` |

**四条纠正前提的发现**（第 1、2 条为本次实测）：

1. **v2 的 `deny` 分支在生产里不可达**——`DEFAULT_RULES` 两条规则**一条 deny 都没有**。`deny > ask > allow` 今天只被测试规则触发。【实测】探针 P10。
2. **旧版配置有一个文档从未提及的最高层**：`readState()` 把全局 `config.json` 当 legacy 兜底（`config.js:98`），`loadConfig:373` 再把 9 个 `STATE_KEYS` 套在最外层。于是**全局 `config.json` 里的 STATE_KEY 会被应用两次**，第二次在项目层、环境变量、CLI 之后——哪怕 `state.json` 根本不存在。而 `hooks`/`permissions`/`sandbox`/`theme`/`panel`/`statusLine` 全在这 9 个里，**正好是团队最想共享的那批设置**。【实测】探针 C5/C6。
3. **v2 的 `awaiting_approval` 是空壳**：审批走进程内回调 `deps.approve`（`run-turn.ts:120`），**不产生事件、无超时、`signal` 在该处不被检查**。所以审批协议不是「扩展现有机制」，是从零建一条事件往返。
4. **v1 的 yolo 会短路 `deny` 规则**（有测试钉住），但 **PreToolUse hook 在 yolo 下仍然能拒**——规则与 hook 是两条独立否决通道。

---

## 1. 验证环境

| 项 | 值 |
|---|---|
| 平台 | `win32`（Windows 11），shell 为 PowerShell / Git Bash |
| Node | `v24.18.0` |
| 仓库状态 | `main = aa1b88d`，与 `origin/main` 一致，工作区干净 |
| 测试套件 | **【实测】** `npm test`（build + lint + test）：`tests 219 / pass 204 / fail 0 / skipped 15`，9.6s。skip 的 15 项是需要真后端的沙箱用例 |
| 本次新增实测 | **三个探针，34 条断言全部通过**（P3 T1 后 `policy-decide-probe` 由 14 增至 15，T3a 增至 16，见附录 B）：`tools/policy-decide-probe.mjs`（16）、`tools/legacy-config-probe.mjs`（10）、`tools/legacy-trust-probe.mjs`（8） |
| 本次**未**做 | 未重跑旧版测试套件；未在 Linux/macOS 上跑任何东西；未做跨版本回放实测 |

**平台差异提示**：三个探针都在 Windows 上跑。`legacy-config-probe` 断言的是**优先级与合并语义**，与平台无关；`legacy-trust-probe` 的 T2 断言「存的是 canonical 路径」，在 Windows 上由 `realpathSync.native` 的大小写折叠实现（`canonical.js:69`），**POSIX 上的 symlink 语义未在本机验证**——旧版正因 macOS `/var` → `/private/var` 栽过一次（`trust.js:14-21`）。

---

## 2. 问题一：裁决顺序（`deny > ask > allow` 的重新论证）

用户要求这一条**重新论证**而非沿用。下面给出实现、实测行为、旧版对照、外部对照，以及一条尚未决定的分支。

### 2.1 v2 现状【源码】

```ts
// policy/decide.ts:25
const PRECEDENCE: readonly Verdict[] = ['deny', 'ask', 'allow'];

// policy/decide.ts:30-35 —— 实现体全文
const hits = rules.filter((rule) => rule.matches(request));
for (const verdict of PRECEDENCE) {
  const hit = hits.find((rule) => rule.verdict === verdict);
  if (hit) return { verdict, rule: hit.name, reason: hit.reason ?? null };
}
return { verdict: 'ask', rule: 'no-rule-matched', reason: `no rule covers ${request.name}` };
```

两个性质分开看，`:32` 的 `=== verdict` 是承重的那一行：

- **跨裁决**：先固定 verdict 再找规则，所以**与规则书写顺序无关**（`:31-33`）
- **裁决内**：`find` 在 `filter` 结果上扫描，两者都保序，所以**取数组中下标最小的命中**

### 2.2 实测【实测】

`tools/policy-decide-probe.mjs`，16 条全过（P3 T1 后由 14 增至 15，T3a 增至 16，见附录 B 末）。值得单独列出的：

| 用例 | 期望 | 为什么它值得测 |
|---|---|---|
| P1 | allow 写在数组最前仍输给 deny | 若实现是「走数组取首个命中」，这条会返回 allow |
| P4 | 同裁决取下标最小 | 这条说明「顺序无关」只对**跨**裁决成立，裁决内顺序**是有意义的** |
| P7 | 规则无 `reason` → 返回 `null`，且字段存在 | `?? null` 而非 `||` |
| P8 | `reason: ''` **原样返回空串** | `??` 不触发空串。配置作者写 `""` 会得到 `""`，不是 `null` |
| ~~P9~~ | ~~`matches` 抛异常**直接冒泡**~~ | **该用例已随 ADR-027 失效**：规则从函数改为数据后，「会抛异常的匹配函数」不再可表达——这是净改善，因为规则再也不能在裁决路径上运行代码。探针里该位已换成新的 fail-closed 断言（见附录 B 末） |
| **P10** | **`DEFAULT_RULES` 里一条 deny 都没有** | deny 分支在生产不可达，只被测试规则触发 |

### 2.3 旧版对照【源码】+【旧版实测】

`permissions.js:57-67` 的 `decide` 顺序，**注意第一步**：

```
permissions.js:58  if (mode === 'yolo') return 'allow';        ← 0. 一票放行，在一切规则之前
permissions.js:59  deny 列
permissions.js:61  ask 列
permissions.js:62  allow 列
permissions.js:63  acceptEdits 档
permissions.js:64  READ_ONLY 白名单
permissions.js:66  alwaysAllowed → 否则 ask
```

跨列顺序与书写顺序无关（`find`/`some`），**同列内取数组首个命中**——与 v2 同构。但 `:58` 是 v1 独有的：**yolo 短路了 deny**，`p1-wave1.test.mjs:170-172` 专门断言这条：

```js
const yolo = new Permissions('yolo');
yolo.setRules(loadRules({ permissions: { deny: ['Bash'] } }, KNOWN));
assert.equal(yolo.decide('Bash', { command: 'rm -rf /' }), 'allow', 'rules never apply in yolo');
```

**但 PreToolUse hook 在 yolo 下仍生效**——`p1-wave2.test.mjs:46,60-62` 用 yolo 档验证 hook 拒绝仍然拦得住。规则与 hook 是**两条独立否决通道**。

### 2.4 外部对照【上游】

| 方案 | 顺序 |
|---|---|
| Claude Code | `deny → ask → allow`，**首个匹配决定结果，规则具体程度不影响顺序** |
| OpenCode | **last matching rule wins**（相反） |

Claude Code 文档把理由写明了，**这正是我们缺的那条依据**：

> 宽 deny 规则如 `Bash(aws *)` 阻止所有匹配调用，**包括那些同时匹配更窄 allow 规则如 `Bash(aws s3 ls)` 的调用。allow 规则无法从 deny 规则里挖出例外。**

即：**优先级顺序是安全语义，不是实现便利**。OpenCode 的 last-match-wins 让「先写 `*` 再写具体项」的惯例成立，代价是 allow 能覆盖 deny。

### 2.5 决定（评审通过）

**保留 `deny > ask > allow`。** 理由不是「一直是这样」，而是：允许多条规则同时匹配同一动作时，**必须有一个方向上不允许被更具体的规则推翻**，否则「deny 某个工具」这种粗粒度安全条令就无法成立。Claude Code 的表述可以逐字采用：

> 宽 deny 规则如 `Bash(aws *)` 阻止所有匹配调用，包括那些同时匹配更窄 allow 规则如 `Bash(aws s3 ls)` 的调用。allow 规则无法从 deny 规则里挖出例外。

**同时保留 v2 现有的两点**：

- 跨裁决与书写顺序无关（探针 P1/P2/P3 钉住）
- 裁决内取数组首个命中（探针 P4 钉住）——这条要写进文档，否则配置作者会假设顺序完全无关

**新增决定：`deny` 永不被短路。**

这是**有意偏离旧版**，要进 ADR（见 §9 的 ADR-024）。理由：

1. v1 的 `permissions.js:58` 让 yolo 在一切规则之前一票 `return 'allow'`，**deny 也一并失效**。若 v2 沿用，则出口标准「无人值守下所有 `ask` 要么按显式规则放行、要么拒绝并留审计」里的「显式规则」就**不包含 deny**——出口标准自相矛盾。
2. Claude Code 的 `dontAsk` 与 OpenCode 的 `--auto` **在这一点上一致**：自动模式只改变本该 `ask` 的请求，**显式 deny 仍然执行**（附录 C.1 第 2 行）。
3. 「无人值守」的语义应当是**收窄**（少问、多做确定安全的事），不该是**放宽**（连明确禁止的也放行）。v1 的 yolo 把两者混在一起了。

**推论**：无人值守只影响 `ask` 的归宿，与 §6.4 取同一个答案（auto-deny）。这两处必须同时成立，否则出口标准的两句话不能同时为真。

### 2.6 待验证

- `no-rule-matched` 这个哨兵名会经 `Decision.rule` 写进 `policy.decided` 事件（`run-turn.ts:113`），且已被 `architecture/03-policy-and-execution.md:12` 写成契约。改名**不会让旧日志打不开**，但会改变旧日志的解释。**当前无任何已发布日志**（`private: 0.0.0`），所以现在改是免费的——**P3 开始后就不再免费**。

---

## 3. 问题二：配置分层与合并语义

### 3.1 旧版的实际顺序【源码】+【实测】

`config.js:346-385`，**后者覆盖前者**：

| # | 层 | 行号 |
|---|---|---|
| 1 | `defaults` | `config.js:347` |
| 2 | 全局 `~/.cowcat/config.json` | `config.js:349-350` |
| 3 | 项目 `.cowcat/config.json` | `config.js:352-353` |
| 4 | 环境变量 `COWCAT_*` / `CC_*` | `config.js:355-367` |
| 5 | CLI overrides | `config.js:369` |
| 6 | **`STATE_KEYS`（来自 `readState()`）** | **`config.js:372-373`** |
| 7 | `resolveModelConfig` 派生 | `config.js:375` |

`docs/USAGE.md:23-24` 印的链尾是 CLI 参数，**第 6 层完全没写**。

### 3.2 第 6 层比文档暗示的更糟【实测】

`STATE_KEYS` 本身就已经反直觉（运行时状态压过 CLI）。但真凶在 `readState()`：

```js
// config.js:97-100
export function readState() {
  const legacy = readJson(resolveStateFile('config.json'));   // ← 全局 config.json
  const state  = readJson(join(cowcatHome(), 'state.json'));
  return { ...legacy, ...state };
}
```

它把**全局 `config.json` 当作 state 的 legacy 兜底**。于是 `loadConfig:373` 重放的不只是 `state.json`，还包括全局 `config.json` 里的同名键。

**后果（探针 C5 直接钉住）**：全局 `config.json` 里的 `hooks` 压过项目 `config.json` 里的 `hooks`——**即使 `state.json` 不存在**。9 个 `STATE_KEYS` 是：

```
["installId","trustedProjects","mcpTrusted","theme","statusLine","hooks","permissions","panel","sandbox"]
```

其中 `hooks`、`permissions`、`sandbox`、`theme`、`panel`、`statusLine` **正是团队会想写进项目配置共享的那批**。而 `USAGE.md:114` 恰恰鼓励「项目级配置锁定团队统一行为」——那条建议对 `model`/`providers`/`maxTokens` 成立（它们不是 STATE_KEY，探针 C3 通过），**对 sandbox/permissions/hooks 不成立**（探针 C5 失败于文档预期）。

### 3.3 合并语义【源码】+【实测】

`mergeLayer`（`config.js:181-194`）是**浅层逐键覆盖**：

| 行为 | 证据 |
|---|---|
| 顶层键整体覆盖 | `config.js:191` `cfg[k] = ...` |
| **数组整体替换，不拼接** | 探针 C7 通过 |
| 只有 `providers` 深合并 | `config.js:137-147` `mergeProviders`；探针 C8 通过（`alpha,beta` 都在） |
| 未识别键**原样透传**，无 schema 校验 | `config.js:180` 注释；`config.js:191` |
| 环境变量只映射 7 个键 + `cache` 特判 | `config.js:356-367`；探针 C9 通过 |

`mergeProviders` 单独存在的理由（`config.js:137-147`）：若直接 `cfg.providers = v`，项目配置会整体抹掉用户的 provider 表。探针 C8 正是验证这一点。

### 3.4 其余旧版事实【源码】

- **项目配置发现**：`findProjectConfig`（`config.js:200-213`）从 `cwd` **向上找到最近一份就停**，无 home 边界，只取一份不累加
- **`substitute` 是整串替换不是插值**：正则 `^\{(env|file):([^}]+)\}$`（`config.js:119`）要求**整串就是一个 token**；`{env:VAR}` 未设置时**抛 ConfigError**（`:124`）
- **解析失败抛异常不降级**：`readJson`（`config.js:80-93`）——JSON 坏 → `ConfigError: Cannot parse <file>: <msg>`（`:91`，**带文件路径**）。唯一例外是 `sandboxFor` 对畸形 sandbox 配置兜底为 `off`（`sandbox.js:195-200`）

### 3.5 外部对照【上游】

Claude Code 的模型与旧版差异明显：

| 维度 | Claude Code | 旧版 cowcat |
|---|---|---|
| 层数 | **5 层**：Managed → CLI(`--settings`) → 项目 local → 项目共享 → 用户 | 6 层（第 6 层未文档化） |
| **环境变量** | **不是一层**——「同一行为既有 shell 变量又有 settings key 时，逐对单独决定，不按层级」 | 是一层，位置在项目之上、CLI 之下 |
| **列表键** | **合并**（`permissions.allow` 等跨层合并） | **整体替换** |
| 例外 | 少数 key 整值取最高层（`fallbackModel` 有序链、`modelPicker`、`availableModels`、`modelSettings`） | 无 |
| 错误报告 | **三级**：`Settings Error`（整文件坏）/ `Settings Warning`（单条坏，**跳过那条保留其余**）/ managed 特例（保留其余 + 个别 key 回退到**更严**值） | 单级：抛 ConfigError |
| 热重载 | settings 文件被 watch，改动即时生效 | 无 |

第 2 行对我们最有价值：**「环境变量是不是一层」是一个设计选择，Claude Code 选了「不是」**。理由是环境变量与 settings key 的覆盖关系**逐对性质不同**（`ANTHROPIC_MODEL` 压过任何文件的 `model`，而 `ANTHROPIC_DEFAULT_MODEL` 只在没有文件设置 `model` 时才生效）。

### 3.6 决定（评审通过）

1. **层定义**：`内建默认 → 用户级 → 项目级 → 会话级`。旧版的「CLI overrides」归入**会话级**——它们是同一种东西（只影响本次会话）。
2. **环境变量不作层**，逐键决定。旧版把它当一层，导致「环境变量 > 项目配置」这种在 Claude Code 看来过粗的规则。**P3 需要为每个可被环境变量覆盖的键单独声明谁赢**。
3. **取消 `STATE_KEYS` 这类隐式最高层**。运行时状态（信任记录、安装 id、theme 等）**独立存放、不参与配置合并**。旧版把两者混在一个 `state.json` 再整体套上去，是 §3.2 那条 bug 的根源。
4. **列表键合并而非替换**（对齐 Claude Code，评审通过）。理由：分层配置的用途就是「项目在用户基础上加东西」，整体替换会让用户级规则在项目里静默消失。
5. **错误报告分级**（对齐 Claude Code 的三级）：整文件坏 → 拒绝启动并报**文件路径 + zod 路径**；单条坏 → **跳过那条、保留其余**并告警。旧版是「一条坏就整体抛」，粒度太粗。

**决定 4 带来的必答问题**（进 ADR-026，P3 实现时定）：合并之后，**怎么撤销一条上层 `allow`**？整体替换的语义下这不需要回答（项目覆盖用户即可）；合并之后必须有显式机制。Claude Code 的答案是 deny/ask 列的 `!` 负向前缀（`Read(*.env)` 后跟 `Read(!sample.env)`），并附两个限制：`!` 只能相对于当前目录、不能挖进「整目录被拦」的内部。

**建议方向**（P3 实现时定，本文件不定）：**先用「更具体的 deny 覆盖」而不引入 `!` 语法**——deny 天然优先（§2.5），所以「撤销一条 allow」可以写成一条更窄的 deny，不需要新语法。`!` 只在「需要撤销一条 deny」时才必要，而那属于收紧方向，可以留到有实际需求再设计。

### 3.7 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 沿用旧版 6 层 + `STATE_KEYS` | §3.2 的错误是结构性的，不是可以修的 bug：把「用户想共享的设置」和「本机运行时状态」放进同一个命名空间，就必然产生静默覆盖 |
| 环境变量作为最高优先级层 | 与 Claude Code 的结论相反，且实际会产生「同机不同 shell 得到不同策略」的不可复现问题 |
| 严格分层覆盖、列表不合并 | 与「分层配置」的用途矛盾（见决定 4） |

---

## 4. 问题三：规则语言（纯数据 vs 表达式）

### 4.1 v2 现状：出口标准今天不可能达成【源码】

```ts
// policy/decide.ts:12-17
export interface Rule {
  readonly name: string;
  readonly matches: (request: ActionRequest) => boolean;   // ← 函数
  readonly verdict: Verdict;
  readonly reason?: string;
}
```

P3 出口标准是「策略的全部裁决都能由配置表达，**无需改代码**」。**函数型 `matches` 让这条在现有架构下不可能达成**——配置无法表达函数。这是 P3 最核心的一处结构改动。

另一半问题在 `ActionRequest` 的形状（`policy/decide.ts:5-10`）——它**只有 4 个字段**，且匹配维度缺失：

```ts
readonly kind: 'tool';   // 单值字面量，全仓库只有这一个取值
readonly callId: string;
readonly name: string;
readonly risk: ToolRisk;
```

| 缺失 | 证据 |
|---|---|
| 无工具入参 `input` | 唯一构造点 `run-turn.ts:111` 只填 4 个字段，`call.input` 未传入 |
| 无路径、无命令、无域名 | 同上 |
| `kind` 只有 `'tool'` | `decide.ts:6` |

`architecture/03-policy-and-execution.md:9` 已预告「P2 起扩展为进程、文件路径、网络域名等请求种类」——**该扩展至今未发生**。

规则集在生产里也只有一个生产者：`DEFAULT_RULES`（`policy/defaults.ts`），调研当时两条规则：

| # | `name` | `matches` | `verdict` | `reason` |
|---|---|---|---|---|
| 1 | `reads-are-free` | `r.risk === 'read'` | `allow` | 无 |
| 2 | ~~`mutations-need-approval`~~ | ~~risk ∈ {write, exec, network}~~ | ~~`ask`~~ | **P3 T3a 删除，见下** |

**第 2 条在 T3a 被删除，这是一个必须修的缺陷，不是偏好。** 因为 `decide` 按**类别**排序（`deny > ask > allow`，ADR-023），一条 catch-all 的 `ask` 会**遮蔽所有 `allow`**——于是没有任何配置能让一次写操作被允许，P3 出口标准第一条「策略的全部裁决都能由配置表达」**无论写什么都不可达**，信任门控也随之失去意义。

修法就是外部参照的做法：**「默认询问」是兜底，不是一条规则**。`decide` 在没有规则命中时本来就返回 `ask`（`no-rule-matched`），那才是它该待的地方。见 ADR-034，探针 P12/P16 钉住。**注意这没有改变任何裁决结果**：写/执行/网络仍然被询问，只是报告的理由从那条规则的文案变成了兜底的文案。

**匹配维度只有 `request.risk`。** 默认规则集里**没有任何工具名字符串**，对 `Bash`、`rm -rf` 一无所知。

### 4.2 旧版 DSL 的表达力天花板是**签名锁死**的【源码】

```js
// perrules.js:67
matchRule(rule, toolName, input)
```

三个参数，**没有 risk、没有 network、没有参数子字段入口**。`classifyCommand()` 产出的 `risk: 'low'|'elevated'|'dangerous'`（`sandbox.js:142`）与规则引擎**完全无连接**。

语法面（`perrules.js:9`）：

```
/^([A-Za-z][\w.-]*)\s*(?:\((.*)\))?$/s
```

三个真实例子（`agent/test/p1-wave1.test.mjs`）：

```js
{ tool: 'Bash', pattern: null, prefix: false, raw: 'Bash' }              // :100 整工具
{ tool: 'Bash', pattern: 'npm run test', prefix: true, raw: 'Bash(npm run test:*)' }  // :102-104
'Edit(src/**)'                                                            // :157 路径 glob
```

`subjectFor`（`perrules.js:60-65`）只有 **2 个正交维度**：工具名 × 单个 subject 字符串。

| 想表达的维度 | 能否 |
|---|---|
| 路径模式 | 能但受限——glob 只对 6 个「路径工具」开放（`:34`）；非路径工具的 `*` 必须写成尾部 `:*`（`:35-37`） |
| 命令模式 | 只有「整串等值」或「`:`/`/`/空格 边界前缀」（`:71-78`），**无 `&&`/管道感知** |
| **risk** | ❌ 签名里没有（`:67`） |
| **network** | ❌ 无字段 |
| 正则 | ❌ |
| 参数子字段 | ❌ 只匹配单一拼接 subject |

**另有三处缺陷，无测试覆盖**（本次读代码发现）：

1. **`Grep(src/**)` 能通过校验却永远不可能匹配路径**——`isPathTool` 含 `Grep`（`:34`），而 `subjectFor` 对它返回 `input.pattern`（**搜索正则本身**，`:64`）
2. **非 Bash 工具的 `:*` 前缀被静默丢弃**——`Edit(foo:*)` 解析出 `prefix: true`（`:38-39`），但非 Bash 分支（`:79-84`）**根本不读 `rule.prefix`**，退化成等值匹配
3. **`?` / `[...]` 能匹配却过不了校验**——`:79` 的判定含它们，`:35` 的字符集 `/^[\w./{}*-]+$/` 不含

### 4.3 外部对照【上游】

Claude Code 用的是同一族的 `Tool(specifier)` 文本语法，但语义面比旧版深得多：

- 工具名位置支持 glob：`"*"`、`"mcp__*"`（仅 deny/ask；allow 的工具名 glob 必须带字面 `mcp__<server>__` 前缀）
- **参数匹配 `Tool(param:value)`**：`Agent(model:opus)`、`Bash(run_in_background:true)`
- **但不能匹配工具的主内容字段**——`command`（Bash）、`file_path`（Read/Edit/Write）、`url`（WebFetch）。文档明说理由：

> `Bash(command:rm *)` 会被复合命令绕过，所以 Claude Code 忽略它并发启动警告。

- `*` 的语义**极其微妙**：「尾部 `*` 前的空格是规则的一部分」，`Bash(ls *)` 与 `Bash(ls*)` 不同（后者也匹配 `lsof`）
- 文档**自己承认文本规则不可靠**：`Bash(rm *)` 挡不住 `/bin/rm`、`sh -c 'rm -rf'`、`git -C . push`，并用一张表列出

这条是**纯结构化方案的有力论据**：文本 DSL 的微妙语义会变成测试负担与绕过面。P2 已有同类教训——「不生成双拼写规则，实测无效且把 deny 面扩大一倍，漏同步即绕过」（`p2-ports.md`）。

### 4.4 决定（评审通过）

**采纳结构化字段规则，否决函数式与纯文本 DSL。**

```ts
interface Rule {
  readonly name: string;
  readonly verdict: Verdict;
  readonly reason?: string;
  readonly when: {                    // 全部可选，省略即「不限」
    readonly tool?: string | readonly string[];   // 工具名，允许哨兵 '*' 与 'mcp__<server>__*'
    readonly path?: string;                       // 路径模式，交给 FsPort 匹配（不自己实现 glob）
    readonly command?: string;                    // 命令前缀，语义与旧版 :* 对齐
    readonly risk?: ToolRisk | readonly ToolRisk[];
    readonly network?: SandboxNetwork;
  };
}
```

三条设计要点：

1. **路径匹配交给 `FsPort`**（`ports/fs.ts`），不在策略层重实现 glob。旧版自己写了 `tools/glob.js`（`globToRegExp`），而 v2 已经有 canonical/`samePath` 这一套——把「一个目录不能有两个名字」的原则延伸到规则匹配，是 P2 已经付过学费的地方。
2. **`ActionRequest` 必须扩形状**，但**不必进日志**——`policy.decided` 只携带 `Decision`（`kernel/events.ts:21`），`ActionRequest` 不进任何事件（`run-turn.ts:113` 只传 `callId`+`decision`）。所以扩 `ActionRequest` **不破坏回放兼容性**。这是 P3 少有的「免费改动」。
3. **`command` 用前缀语义并明确写进文档**，不含 `&&`/管道感知（与旧版一致）。要更细就上沙箱，不要靠规则——这正是 Claude Code 文档说的「要文件系统与网络强制，用 sandbox，不要用命令文本规则」。

**`Rule` 是否需要一个 `source` 字段**（用户级/项目级/会话级）留待 P3 实现时定：它决定「怎么撤销一条上层规则」，与 §3.6 决定 4 的列表合并配套。

### 4.5 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 保留 `Rule.matches` 函数 | 与出口标准直接矛盾（配置无法表达函数） |
| 沿用 `Tool(pattern)` 纯文本 DSL | §4.2 的表达力天花板由签名决定，加字段等于换语言；§4.3 的外部文档自己承认文本规则不可靠 |
| 允许少量表达式（如旧版设想） | 引入求值器 = 引入新的攻击面与新的错误报告问题；且旧版**从未实现过**，没有可参照的行为基线 |

---

## 5. 问题四：信任模型

### 5.1 旧版行为基线【源码】+【实测】

| 项 | 行为 | 证据 |
|---|---|---|
| 存哪 | `~/.cowcat/state.json` 的 `trustedProjects`，字符串数组 | 探针 T1 通过 |
| 存什么 | **canonical 路径**（`trust.js:29`） | 探针 T2 通过 |
| 判定 | `isTrustedProject` = `some(p => samePath(p, cwd))`（`trust.js:22-24`） | — |
| **继承** | **无**。信任 `<dir>` **不**信任 `<dir>/sub`，**也不**信任父目录 | **探针 T4/T5 通过** |
| 重复 | 幂等，按身份去重（`trust.js:35-36`） | 探针 T3 通过 |
| 类型防御 | 非数组 → `[]`（`trust.js:10-12`） | 探针 T7 通过 |
| 降级 | **唯一开关是 `permissions.setMode('plan')`**（`cowcat.mjs:303`/`311`） | — |
| `-y` 能覆盖吗 | **不能**，注释明说 `-y never overrides trust`（`cowcat.mjs:298`） | — |
| 退出受限 | `/act` 再问一次，**只本次会话、不写 state.json**（`cowcat.mjs:934-949`） | — |
| 能力声明 | **不存在**。信任的唯一效果就是切 plan | — |

`isTrustedProject` 只做**整目录精确匹配**，没有「子目录继承父目录信任」逻辑——子目录必须自己被信任过。T4/T5 是这个模型里最承重的两条断言。

### 5.2 指令文件：统一为 `AGENTS.md`（附调研，详见附录 E）

旧版这里的实现（`project.js`）有一处**命名倒挂**：候选列表是 `['COWCAT.md', 'AGENTS.md', 'CLAUDE.md']`（`project.js:6`），**专有名字排在开放标准之前**。于是一个仓库只要写了 `COWCAT.md`，它写好的 `AGENTS.md` 就永远读不到——而 `AGENTS.md` 是被 60k+ 项目使用、由 Agentic AI Foundation（Linux Foundation）托管的开放格式（附录 E.1）。

**评审决定：候选列去掉 `COWCAT.md`，`AGENTS.md` 为标准名。**

改后的行为**与 opencode 的 local 类别逐字同构**（附录 E.2）：`AGENTS.md` 优先，`CLAUDE.md` 作兼容回退，从 cwd 向上第一个命中即止。

**同时发现两条旧版缺口**（都不在 P2 的交接文档里）：

1. **这条路径没有信任校验。** `project.js:27-32` 把文件内容注入 system prompt（调用点 `cowcat.mjs:322-326`），向上走到文件系统根。**未信任的仓库里的 `AGENTS.md` 会被无条件注入。** 而 AGENTS.md 标准明确说列在文件里的测试命令**会被 agent 自动执行**（附录 E.1 第 5 条）——这让它不只是提示注入的入口，还是命令执行的入口。
2. **`/init` 生成的是 `COWCAT.md`**（`init.js:10-23`，且硬编码 `Permissions('plan')`）。统一到 `AGENTS.md` 后 `/init` 也要跟着改，否则每个新项目都会被它写出一份标准认不出的文件。

**另有两处需要 P3 定的语义**（本文件给方向，实现时定）：

| 问题 | 标准怎么说 | opencode 怎么做 | 建议方向 |
|---|---|---|---|
| 根目录与嵌套的 `AGENTS.md` 是**合并**还是**就近取一份**？ | 「closest one takes precedence」，暗示就近权威，**未明说祖先是否仍参与** | local 遍历**第一个命中即止**；monorepo 靠 `instructions` 的 glob（`packages/*/AGENTS.md`）显式列 | **就近取一份 + 支持 `instructions` 式glob 显式追加**。自动合并会让「离得近的规则能否覆盖远的」变成又一条要论证的优先级 |
| 指令文件走 symlink 怎么办？ | 迁移建议**就是用 symlink**（`ln -s AGENTS.md AGENT.md`） | 未取证 | **过 `FsPort.canonical`**。这条是白捡的教训——同一个仓库已经因为 `/var` → `/private/var` 栽过 7 个 CI 失败（`trust.js:14-21`） |

### 5.3 外部对照【上游】

Claude Code 的信任门控是**不对称**的，这比旧版「一个开关切 plan」细得多：

| 规则类别 | 未信任时 |
|---|---|
| `permissions.allow`、`additionalDirectories`、多数 `env` | **不生效**，等用户信任文件夹 |
| `deny`、`ask` | **立即生效** |

逻辑自洽：**deny/ask 是收紧权限，无需授权；allow 是放宽，需要授权。**

还有一条精细规则：`.claude/settings.local.json`（**未被 git 跟踪时**）的 allow 规则**不走信任步骤**——因为那是用户自己的文件而非仓库的；一旦该文件被 git 跟踪，信任步骤就适用。

外部对照里**没有找到**「指令文件（`AGENTS.md` / `CLAUDE.md`）是否需要信任」的直接表述——`agents.md` 标准与 opencode 的 rules 页都未提信任门。**标为未验证**（§5.5 第 4 条）。不过 §5.2 第 1 条缺口是**我们自己代码里的事实**，不依赖外部对照就成立。

### 5.4 决定（评审通过）

1. **沿旧版实测语义**：信任按**目录身份**精确匹配、**无继承**。这是本次实测确认过的行为（探针 T4/T5），且 macOS 那次教训（`trust.js:14-21`）说明「身份而非拼写」是不能省的一条。
2. **门控改为不对称**（对齐 Claude Code）：未信任时 `deny`/`ask` 生效、`allow` 不生效。旧版「一刀切切 plan」粒度太粗——它连「明确 deny 的工具」都要走 plan 闸门，而 plan 闸门放行的 `READ_ONLY` 白名单（`permissions.js:4`，13 项）包含 `CronCreate`、`ScheduleWakeup` 这类**会改状态**的工具。
3. **指令文件统一为 `AGENTS.md`**（见 §5.2）：候选列去掉专有的 `COWCAT.md`，`AGENTS.md` 为标准名、`CLAUDE.md` 作兼容回退；`/init` 跟着改名。
4. **未信任时不注入指令文件**（评审决定）。理由是 §5.2 第 1 条：AGENTS.md 里的命令会被自动执行，所以它不是纯文本注入，而是命令执行入口。这条与决定 2 的精神一致——**收紧不需要授权，放宽才需要**：指令文件是「放宽 agent 行为」的内容，未信任时不生效。
5. **信任记录独立存放**，不参与配置合并（与 §3.6 决定 3 一致）。
6. **保留 `-y` 不覆盖信任**（`cowcat.mjs:298`）。这是一条正确的旧版行为，显式写进 ADR 避免后人「顺手修掉」。

**建议方向**（P3 实现时定，本文件不定）：决定 4 的「不注入」需要给用户一条出路，否则未信任仓库里的 AGENTS.md 会**静默失效**——与 §3.2 那条 bug 是同一类体验问题。建议：**不注入，但明确告知**（「本目录未受信任，已跳过 `AGENTS.md`（N 行）」），并让 `/act` 后重新加载。旧版 `/act` 只重置 `restricted` 标志（`cowcat.mjs:934-949`），不会重读指令文件。

### 5.5 待验证

- 未信任仓库里的 `AGENTS.md`：Claude Code 与 opencode 是否门控、怎么门控。**本次未取证**（`agents.md` 标准与 opencode rules 页都没提信任）。§5.4 决定 4 不依赖这条，是自行判定的。
- `AGENTS.md` 的嵌套/就近语义在真实 monorepo 里的行为（§5.2 表格第 1 行）。openai 主仓库在写作时有 88 份 AGENTS.md，是可查证的样本，**本次未查**。
- POSIX 上的 symlink 信任语义（探针 T2 只在 Windows 上跑过，见 §1 平台提示）。

---

## 6. 问题五：审批协议

### 6.1 v2 现状：`awaiting_approval` 是空壳【源码】

状态在 `kernel/turn.ts:6` 定义，转移表 `kernel/turn.ts:19`，**进出路径各只有一条**：

```
进入：awaiting_tools → awaiting_approval    （run-turn.ts:119，全仓库唯一调用点）
离开：→ awaiting_tools | failed | cancelled （turn.ts:19）
```

```ts
// kernel/run-turn.ts:118-123
if (decision.verdict === 'ask') {
  await session.transition('awaiting_approval', decision.rule);
  const approved = await deps.approve(request, decision);
  ...
}
```

四个后果：

| 事实 | 证据 |
|---|---|
| 审批**不产生任何事件**——`approved` 布尔只影响返回值，最后被记成一条 `tool.finished{ok:false}` | `run-turn.ts:120-122`、`:38-44` |
| **没有超时**，`await` 可无限期 pending | `run-turn.ts:120` |
| **`signal` 在该块不被检查** | `run-turn.ts:118-123` 整块无 `signal.aborted` |
| `reason` 传的是 `decision.rule`（规则名），**不是 `Decision.reason`** | `run-turn.ts:119` |

### 6.2 加事件会连带触发三处硬失败【源码】+【推断】

`approval.requested` / `approval.answered` 要进 `KernelEvent` 联合（`kernel/events.ts:15-23`，现 6 个成员）。这会连带：

1. `test/schema.test.ts:12` 的编译期等价断言变红——形式是手写双向 `extends` + 常量赋值 `true`（`test/schema.test.ts:7-16`），失败报 `Type 'false' is not assignable to type 'boolean'`
2. `kernel/state.ts:23-62` 的 switch 需补 case——【推断】TS 判别联合穷尽性检查会报缺返回
3. 旧 build 读新日志时 `z.discriminatedUnion`（`adapters/schema.ts:58-82`）匹配不到 → `decodeEventLine` 抛 `corrupt session log`（`adapters/schema.ts:157-159`），**不可降级**

另有一处顺序事实需要一并考虑：`Session.emit` 公开且**不校验事件类型白名单**（`session.ts:122`），且 **`append`(`:133`) 先于 `reduce`(`:134`)**——非法事件**先落盘再被归约拒绝**。

**`schemaVersion`**：现值 `1`（`kernel/schema-version.ts:5`）。改必需头字段就要 bump（`adapters/schema.ts:52` 注释）。**bump 会破坏全部存量日志**（`session.ts:55` 抛错、`:171` 静默丢快照）。但 **v2 从未发布**（`private: 0.0.0`），所以 ADR-018/019 的先例适用：**现在不用升**。

### 6.3 旧版审批【源码】+【旧版实测】

- **两阶段**：phase 1 并发（`runnable`，上限 `maxParallelTools` 默认 4），phase 2 **严格串行、一次一张卡**（`loop.js:244-289`）
- **无人值守 = auto-deny**，两层独立实现：UI 立即返 `'n'`（`ui.js:147-150`），loop 用不同文案回灌模型（`loop.js:274-279`）。判定依据是 **`opts.print`（`-p`），不是 `process.stdin.isTTY`**
- 退出码：`-p` 下有拒绝则 `process.exitCode = 2`（`cowcat.mjs:822`）
- **超时未实现**——裸 `await`、TUI 的 Promise 内无 timer、`readLine()` 无超时。全仓唯一的 timeout 属于 hook（`hooks.js:96`）
- **审批裁决没有结构化记录**：session JSONL 无 approval 记录；TUI 的 `→ y`/`→ always`/`→ n` 是纯内存；`audit.log` 只记 Bash 且 `decision` 字段取值是 `run|elevated-run|blocked|mode-change`（`sandbox.js:173`），**不是用户裁决**
- **`alwaysAllowed` 不持久化**——进程内 `Set`（`permissions.js:38`），重启即失。粒度按 `pickKeyInput`（`:104-109`）：Write/Edit 按路径、Bash 按整条命令、其余按完整参数对象

### 6.4 无人值守语义：**决定 auto-deny**（评审通过）

| 方案 | 无人值守下的 `ask` |
|---|---|
| **旧版 cowcat** | auto-**deny** |
| **Claude Code `dontAsk`** | auto-**deny**——「auto-denies every call that would otherwise prompt」 |
| **OpenCode `--auto`** | auto-**approve**——「automatically approve requests not explicitly denied；显式 deny 仍执行」 |

**采用 auto-deny**，与旧版及 Claude Code 的 `dontAsk` 一致。

三点理由：

1. **与 §2.5 的决定自洽**。`deny` 永不被短路，所以无人值守只改变 `ask` 的归宿；而在无人值守下把 `ask` 变 `allow`，等于给「无人值守」赋予了「放宽权限」的含义——与它在 §2.5 里被定为**收窄**相反。
2. **出口标准的字面要求**：「所有 `ask` 要么按显式规则放行、要么拒绝并留审计」。auto-approve 下，一台无人看管的机器会把 `ask` 全部放行，**没有「留审计」的对应物**（审计记的是「自动批准了」，不是「谁批准了」）。
3. **旧版有现成且被测过的文案与退出码**（`print-mode.test.mjs:52-55`、`cowcat.mjs:822` 的 `exitCode = 2`），沿用成本最低。

**注意 OpenCode 的 `--auto` 与 `deny` 的关系**：显式 deny 仍然执行。这一点三家**一致**，也是 §2.5 决定「deny 永不短路」的外部依据之一。

### 6.5 旧版的两条真缺口（P3 必须设计覆盖）【源码】

**B2：`general` 与 `lead` subagent 拿到 yolo**

```js
// subagent.js:58
const perms = new Permissions(spec.tools ? 'plan' : 'yolo');
```

`tools: null` 的角色就是 `general`（`prompts/subagents.js:70`）与 `lead`（`:62`）。主会话批准一次 `Agent` 调用后，子 agent 内部**所有 Write/Edit/Bash 免审批**。叠加 `run_in_background: true`（`tools/agent.js:47-58`）主回合立刻返回 task id。**无任何测试断言这条路径**。

**B11：`ExitPlanMode` 的 `allowedPrompts` 绕过规则校验**

```js
// tools/planmode.js:121-125 —— p.prompt.trim() 直接当 pattern，没跑 validateRule
```

模型可以提 `{tool:'Bash', prompt:'rm -rf /'}`，用户批准计划即获得**进程内永久前缀放行**。**无测试断言恶意 prompt 的行为**。

其余绕过面（`hooks` 从不弹审批、TUI `!` shell 完全在权限体系外、`/export` `/memory add` `/rewind` 走第二条审批通道因此 PreToolUse hook 对它们无效、`network:'ask'` 只覆盖 Bash）记录在附录 A，供 P3 逐条决定是否覆盖。

### 6.6 决定（评审通过）

1. **`approval.requested` / `approval.answered` 作为事件进日志**，`answered` 至少携带 `{ callId, verdict: 'once'|'always'|'reject', by: 'user'|'policy'|'timeout' }`。旧版把裁决丢在内存里，是 §6.3 那条「没有结构化记录」的根因。
2. **`AskUser` 三选项对齐**：`once` / `always` / `reject`（旧版与 OpenCode 都是这三个）。
3. **`always` 的持久化范围：先做会话内**（评审通过）。三方在此各不相同：

   | 方案 | `always` 的范围 |
   |---|---|
   | 旧版 cowcat | 进程内，重启即失 |
   | OpenCode | 仅当前会话 |
   | Claude Code | **按工具而异**：Bash/WebFetch/WebSearch **永久**（写进 `settings.local.json`），文件修改**只到会话结束** |

   **会话内**是旧版与 OpenCode 的交集，且不需要回答「永久规则存在哪、怎么撤销、怎么随仓库走」这三个问题。Claude Code 的「按工具而异」有理由（能完整展示「这会允许什么」时才给永久选项），但那是**在已有持久化机制之后**的细化——**留到 P3 之后单独立项**。这条与 §3.6 决定 4（列表合并）耦合：永久规则一旦支持，就必须能撤销（ADR-026）。
4. **超时必须实现，且归宿是 auto-deny**。旧版没有超时，v2 现在也没有（§6.1）。超时后按 §6.4 走 auto-deny 并留审计——`approval.answered` 的 `by` 字段区分 `'user'` 与 `'timeout'`。
5. **无人值守 = auto-deny**（§6.4），且**与 §2.5 的 deny 决定取同一答案**：`deny` 永不被短路，无人值守只改变 `ask` 的归宿。
6. **B2 必须封**：子 agent 不应无条件拿 yolo。至少让**父会话已批准的 `Agent` 调用**携带一个显式的权限继承声明，而不是从 `tools === null` 推断。
7. **B11 必须封**：`allowedPrompts` 走与配置规则**同样的校验与同样的分层**，不能是绕过校验的直注入点。

### 6.7 待验证

- §6.2 第 2 条（switch 缺 case 会编译报错）是【推断】，未实际编译验证
- 「append 先于 reduce」已由源码确认，但**未构造反例实测**「非法事件先落盘」
- 给 `Decision` 加字段时旧 build 会**静默 strip**（`adapters/schema.ts:8-12` 开放对象约定）——【推断】，未做跨版本回放实测

---

## 7. 问题六：审计作为事件消费者

### 7.1 审计今天看不到沙箱事实【源码】

`ProcessResult` 有 13 个字段，含 `sandbox`（实际生效的 `mode`/`backend`/`limitations`）、`termination`、`removedEnv`、`ignoredDeny`（`ports/process.ts:133-163`）。**但它不进任何事件**：

```ts
// kernel/events.ts:22
tool.finished = { callId: string; ok: boolean; output: string }
```

所以 P3 范围 5「审计作为事件的消费者」要记录实际生效的档位/后端，**前提是先扩 `tool.finished` 或新增事件**。`ProcessResult` 的注释已经说清它记录的是**网关实际施加的**而非请求的（`ports/process.ts:154-160`）——这正是审计想要的语义，只差一条通路。

### 7.2 旧版审计【源码】

| 项 | 行为 |
|---|---|
| 调用点 | **只有 5 处**，全在 Bash 沙箱路径 + `/sandbox`。**权限裁决、plan 拒绝、信任决定、Edit/Write 拒绝、MCP 全部不审计** |
| 同步写 | 是，**有明确理由**（`sandbox.js:154-159`）：async 版会丢最后一行，且让 Windows CI 的审计测试变 flaky（睡 300ms 有时读到未写完的文件） |
| 「永不抛」 | **是真的 try/catch**（`sandbox.js:161`…`:180`），且整个函数体在 try 内 |
| **但失败是静默的** | `catch` 空实现（`sandbox.js:180`）——不落 stderr、不计数、不重试。**审计写失败在产品上完全不可观测** |
| 字段 | `ts/tool/mode?/backend?/network?/cwd/risk/decision/violations?/command`（`command` 硬截断 500） |
| 档位字段 | **只在 system 档写** `mode`+`backend`；light/off 档的审计行里**没有**模式字段（为了让「light/off 审计行与早期版本逐字节一致」，`sandbox.js:166-167`） |
| 位置 | `~/.cowcat/audit.log`，JSONL，**追加** |
| 轮转 | **无**——无大小上限、无读取接口、无清理 |

### 7.3 「永不抛」不是仓库通则【源码】

这是一条**需要纠正的表述**。实测的承诺边界：

| 端口 | 永不抛？ | 证据 |
|---|---|---|
| `ProcessPort.run` | ✅ **最强的一条** | `ports/process.ts:174-181`：只有「起不来」和「沙箱档位不可用」才 reject；非零退出、信号、终止失败都是**结果**不是错误 |
| `FsPort.*` | ✅ 刻意同步 + 永不抛 | `ports/fs.ts:18-19`、`:34-35` |
| `PlatformPort.sandboxBackends` | ✅ 探测坏掉降级为「无后端」 | `ports/platform.ts:109-111` |
| `ToolPort.run` | ❌ **无保证** | `ports/index.ts:27`；`run-turn.ts:125-130` 自己包 try/catch 转成 `{ok:false}` |
| `ModelPort.stream` | ❌ 无保证 | `ports/index.ts:40` |
| `EventStore.append` / `Clock.now` / `IdSource.next` | ❌ 无承诺 | `ports/index.ts:44-45`、`:49`、`:53` |

**所以正确表述是：审计消费者本身永不抛，不等于被审计的端口永不抛。** 把两者混为一谈会让审计失去意义——被观察的事实若拿不到（例如 `ProcessPort` 起不来），审计必须**记录「拿不到」这件事**，而不是安静地什么都不写。旧版 `sandbox.js:180` 的空 catch 正是反例。

### 7.4 决定（评审通过）

1. **审计是 `Session.subscribe` 的普通消费者**（`kernel/session.ts:115`），不是内核内的分支。新事件经 `:135` 自动进入订阅流，订阅者无需改内核。
2. **审计消费者永不抛**，但**失败必须可见**：至少计数 + 在会话结束时上报。旧版的静默 catch 不可沿用。
3. **先扩事件再谈审计内容**：要让审计看到沙箱事实，必须先让 `tool.finished`（或新事件）带上 `ProcessResult` 的关键子集。**只带 `{ ok, output }` 的现状下，审计能表达的内容不比旧版多。**
4. **跨档位字段一致**：旧版「light/off 档不写 mode」是为了字节级兼容历史日志——v2 没有这个包袱（从未发布），**所有档位都写实际生效的 mode/backend**。
5. **审计与 `policy.decided` 的分工**：`policy.decided` 是**裁决事实**（已在日志里），审计是**消费者视角的投影**（可能带时间聚合、可能带运行时事实如 `ProcessResult`）。审计**不重复记录**已有事件里的内容。

### 7.5 待验证

- 审计写失败要「可见」到什么程度，取决于 P6/P7 的 headless 协议——**本阶段不定**，只登记。

---

## 8. 对 P3 五项范围的具体影响

对照 [`dev-plan-v2.md`](../dev-plan-v2.md) 的 `## P3` 范围：

| 范围 | 本调研的影响 |
|---|---|
| 1. 配置 schema（zod）、加载与分层合并、错误报告带文件与路径 | 层定义收敛到**用户/项目/会话**三层 + 环境变量逐键（§3.6）。**取消 `STATE_KEYS` 式隐式最高层**（§3.2）。错误报告**分两级**（§3.6 决定 5） |
| 2. 路径信任模型：工作区是否受信任、信任记录如何持久化 | 沿旧版**精确匹配、无继承**（§5.1，探针 T4/T5）。门控改**不对称**（§5.4 决定 2）。**新增两项**：指令文件统一为 `AGENTS.md` 且**未信任时不注入**（§5.2、§5.4 决定 3/4） |
| 3. 规则集从默认规则扩展为可配置规则，保留「deny > ask > allow」与「未命中即 ask」 | 顺序**保留**并补上理由（§2.5）。`Rule.matches` 从函数改**结构化字段**（§4.4）。`ActionRequest` **扩形状但不必进日志**，是免费改动（§4.4 要点 2） |
| 4. 审批：`approval.requested` / `approval.answered` 进日志，支持无人值守显式开关 | 加事件连带**三处硬失败**（§6.2）。**超时必须实现**（§6.6 决定 3）。无人值守**二选一**且与 deny 短路取同一答案（§6.4）。**B2/B11 两条旧版缺口必须封**（§6.5） |
| 5. 审计：作为事件的消费者，而不是内核内的分支 | **先扩事件**才能看到沙箱事实（§7.1）。**「永不抛」的边界要写清**（§7.3）。审计失败必须可见（§7.4 决定 2） |

**出口标准复核**：

- 「策略的全部裁决都能由配置表达，无需改代码」——**今天不成立**（§4.1），靠 §4.4 的结构化规则达成
- 「无人值守下所有 `ask` 要么按显式规则放行、要么拒绝并留审计」——**今天不成立**（无超时、无事件）；两项决定落定后这句话才自洽：`ask` 的归宿是 auto-deny（§6.4）+ 留审计（§6.6 决定 1/4），`deny` 永不被短路（§2.5）

---

## 9. 需要落的文档与 ADR

ADR 编号从 **ADR-023** 起（当前最后一篇是 ADR-022，见 `HANDOFF.md` §4）。

| 建议 ADR | 内容 | 来源 |
|---|---|---|
| ADR-023 | 裁决顺序 `deny > ask > allow`，及「allow 无法从 deny 挖例外」的理由 | §2.5 |
| ADR-024 | **`deny` 永不被短路**（有意偏离旧版 yolo 语义） | §2.5 |
| ADR-025 | 配置层定义：用户/项目/会话三层，环境变量不作层；运行时状态独立存放不参与合并 | §3.6 |
| ADR-026 | 列表键合并策略，及「如何撤销上层 `allow`」 | §3.6 决定 4 |
| ADR-027 | 规则语言：结构化字段，路径匹配委托 `FsPort` | §4.4 |
| ADR-028 | 信任门控的不对称性（allow 等待信任，deny/ask 立即生效） | §5.4 决定 2 |
| ADR-029 | **指令文件统一为 `AGENTS.md`**：候选列、发现语义（就近 vs 合并）、symlink 处理 | §5.2、**附录 E** |
| ADR-030 | 未信任时不注入指令文件，以及如何让用户知道它被跳过了 | §5.4 决定 4 |
| ADR-031 | 审批事件形状（`approval.requested` / `answered`）与 `always` 的会话内范围 | §6.6 决定 1-3 |
| ADR-032 | 无人值守语义：`ask` → auto-deny、超时 → auto-deny | §6.4、§6.6 决定 4/5 |
| ADR-033 | 审计作为订阅者；「永不抛」的边界；失败可见性 | §7.4 |

**需同步修改的既有文档与代码**：

- `architecture/03-policy-and-execution.md:9`——「P2 起扩展为进程、文件路径、网络域名等请求种类」这句尚未发生，P3 若不扩要改掉
- `architecture/03-policy-and-execution.md:12`——`no-rule-matched` 的契约表述，随 §2.6 决定一并处理
- `dev-plan-v2.md` 的 `## P3` 段——范围 3 的「保留 deny>ask>allow」需补上「并且重新论证过」
- `agent/src/project.js:6` 的候选列与 `agent/src/init.js` 的 `/init` 输出——**P8 删除旧树前，这两处是否顺手改取决于是否算「安全修复」**（工作规则 7）。**建议不改旧树**，在 v2 里按 ADR-029 实现即可，避免在冻结的树上做非安全改动
- **仓库自己缺一份 `AGENTS.md`**——本项目要求别人这么写，自己根目录却没有（本次全仓搜索结果为空）。**建议在 P3 落 ADR-029 时一并补上**，内容是构建/测试/分层禁令/提交规范

---

## 10. 待验证清单（汇总）

| # | 项 | 性质 | 影响 |
|---|---|---|---|
| 1 | `kernel/state.ts` switch 缺 case 是否真会编译报错 | 【推断】 | §6.2；影响加事件的改动面估计 |
| 2 | 「非法事件先落盘（append 先于 reduce）」是否有可观测后果 | 【推断】 | §6.2；影响 `emit` 是否要加白名单 |
| 3 | 跨版本回放：新 `Decision` 字段是否被旧 build 静默 strip | 【推断】 | §6.2；影响是否必须 bump `schemaVersion` |
| 4 | 未信任仓库里 `AGENTS.md` 的门控：Claude Code / opencode 怎么做 | 【未验证】 | §5.5；**不再阻塞决定**（§5.4 决定 4 是自行判定的） |
| 5 | POSIX 上 symlink 的信任语义（`/var` → `/private/var` 类） | 【未验证】 | §5.5；探针只在 Windows 跑过 |
| 6 | 旧版 `audit.log` 在生产中的实际失效率 | 【未验证】 | §7.3；决定「失败可见」要做到多细 |
| 7 | 旧版 `perrules.js` 三处缺陷是否有实际被利用的路径 | 【未验证】 | §4.2；影响 §4.5 的否决理由是否够硬 |
| 8 | `USAGE.md:20` 声称的「209 provider / 907 model」 | 【未验证】 | 与 P3 无关，登记备查 |
| 9 | `AGENTS.md` 嵌套/就近语义在真实 monorepo 里的行为 | 【未验证】 | §5.2 表格第 1 行；openai 主仓库有 88 份 AGENTS.md 可作样本，本次未查 |

---

## 11. 实现后的偏差记录

> 本文件是 P3 开工前的调研。P3 实现后，此处逐条记录「调研怎么说的 / 实现实际怎么做的 / 差在哪」。**当前为空是预期状态。**

（留空）

---

## 附录 A：本次研究用到的旧版证据索引

按主题索引，便于 P3 实现期核查。全部为【源码】，除标注外。

**配置**（`agent/src/config.js`）：`cowcatHome` :32-35｜`STATE_KEYS` :52｜`defaults` :59-78｜`readJson` :80-93｜**`readState` :97-100**｜`writeState` :103-111｜`substitute` :117-133｜`mergeProviders` :137-147｜`mergeModelPatch` :151-164｜`envPick` :216-218｜`mergeLayer` :181-194｜`findProjectConfig` :200-213｜**`loadConfig` :346-385**（`STATE_KEYS` 重放在 **:373**）

**信任**（`agent/src/trust.js`）：`trustedProjects` :10-12｜`isTrustedProject` :22-24｜`trustProject` :28-41｜macOS 教训注释 :14-21。降级入口 `agent/bin/cowcat.mjs:299-317`；`/act` :934-949。

**规则 DSL**（`agent/src/perrules.js`）：`RULE_RE` :9｜`MCP_TOOL_RE` :15｜`validateRule` :18-40｜`isPathTool` 集合 :34-37｜`loadRules` :44-56｜`subjectFor` :60-65｜**`matchRule` :67-85**。glob 方言 `agent/tools/glob.js:9-45`。

**权限引擎**（`agent/src/permissions.js`）：`READ_ONLY` :4｜`MODES` :6｜`PLAN_BASH_ALLOW` :9-14｜`shiftTabModes` :29-33｜`alwaysAllowed` :38｜**`decide` :57-67**（yolo 短路在 **:58**）｜`deniedBy` :69-71｜`planReject` :91-101｜`pickKeyInput` :104-109｜`approveAlways` :80-88。

**审批执行**（`agent/src/loop.js`）：`executeToolUses` :77-292｜工具未注册 :106-109｜输入校验 :110-114｜plan 闸门 :118-126｜deny 规则 :129-138｜network 标记 :147｜ask 入队 :152｜phase 0 hook :161-176｜checkpoint :179-182｜phase 1 并发 :226-242｜phase 2 串行 :244-289｜懒重决策 :249｜auto-deny 文案 :274-279｜always 记忆 :287。

**hooks**（`agent/src/hooks.js`）：事件清单 :10-13｜kill switch :15-24｜超时 :46-50｜`exec` :53｜`fireHooks` :89-132｜`denyByExit` 极宽条件 :121｜http fail-open :122/:128。

**审计**（`agent/src/sandbox.js`）：模块级 fail-open 声明 :28-32｜`auditRecord` **:154-181**（同步写理由 :154-159，try/catch :161/:180，字段 :162-176）。

**worktree**（`agent/src/sandbox/policy.js`）：`expandPath` :58-65｜`isGlob` :67｜`splitEntries` :69-77｜**`worktreeSiblings` :83-96**（纯目录名匹配，不查 git）｜默认写集与「刻意移除 /tmp」注释 :118-127。命名耦合 `agent/src/worktree.js:34-35`。

**checkpoint / background**：`checkpoint.js` 全文无信任/审批检查（严格位于审批之后，靠 `loop.js:179-182` 的调用点顺序）；`background.js:35` `exec` + env 合并链。

**文档声称 vs 实现不符**（§3 之外另七条）：`system` 档不脱敏 env（`sandbox.js:206-213` vs `USAGE.md:41`）｜sandbox 档位注释缺 `system`（`config.js:74-77` vs `policy.js:35`）｜默认写集无 `/tmp`（`changelog.md:55` 陈旧）｜`STATE_KEYS` 文档列 7 个实际 9 个（`USAGE.md:116`，且 `USAGE.md:54` 自相矛盾）｜`decision` 枚举注释漏 `'violation'`（`sandbox.js:173` vs `bash.js:161`）｜审计字段清单过时（`changelog.md:195`）｜**分层链隐藏了 `state.json` 层**（`USAGE.md:23-24` vs `config.js:373`）。

**旧版绕过面清单**（16 条，本次逐条核对）：`yolo` 短路规则｜**subagent yolo（`subagent.js:58`）**｜hooks 不弹审批（`hooks.js:5`）｜TUI `!` shell（`tui/ui.js:1231-1263`）｜startup `execSync`（`prompts/system.js:9`）｜worktree git（`worktree.js:17`）｜后端探测（`sandbox/probe.js:43,54`）｜状态栏 git（`tui/ui.js:241`）｜桌面通知（`notify.js:55`）｜MCP server 进程（`mcp.js:175`）｜**`allowedPrompts` 直注入（`planmode.js:121-125`）**｜后台 Bash（`background.js:35`，非绕过）｜后台 subagent（`tools/agent.js:47-58`）｜cron（`cowcat.mjs:794-798`，`-p` 下走 auto-deny）｜斜杠命令第二条审批通道（`cowcat.mjs:992-993`/`1060-1061`/`1172-1173`，绕过 PreToolUse hook）｜MCP 信任批准（`cowcat.mjs:543-552`，独立机制、按机器记）。

---

## 附录 B：本次新增的实测（三个探针）

三个探针都遵循 `tools/lint-probe.mjs` 的约定：**每条断言先写明期望**，比对真实返回值，**期望不符即非零退出**。一个只会打印的探针是一个无法失败的探针。

| 脚本 | 断言数 | 覆盖 |
|---|---|---|
| `tools/policy-decide-probe.mjs` | **16 / 16** | v2 `decide()` 的裁决矩阵、`reason` 的 `null` vs `''`、缺字段时 fail-closed、`DEFAULT_RULES` 的可达面与可校验性、**allow 的可达性**（P16） |
| `tools/legacy-config-probe.mjs` | **10 / 10** | v1 六层优先级的每一层、`STATE_KEYS` 重放（含无 `state.json` 的情形）、数组替换、`providers` 深合并 |
| `tools/legacy-trust-probe.mjs` | **8 / 8** | `trustedProjects` 落点与形态、canonical 存储、幂等、**无子目录/父目录继承**、legacy 兼容、类型防御 |

**跑法**：`node tools/<脚本>.mjs`。`policy-decide-probe` 需要先在 `packages/cowcat` 跑 `npm run build`（它测 `dist/`，与测试套件同一份产物）。

**两个探针本身踩的坑，记下来免得下次重踩**：

1. **`import()` 绝对路径在 Windows 上是错的**——`import('F:\\...')` 被 ESM loader 拒为 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，必须走 `pathToFileURL(p).href`。（`policy-decide-probe` 第一次跑就栽在这。）
2. **`.mjs` 里第一版探针有 4 条失败，其中 3 条是我自己的 bug**——两个用例用了会被 `resolveModelConfig` 校验的 `model` 值（`config.js:280` 拒绝不带 `provider/` 前缀的名）；一个用例在设完环境变量**之后**才调 `enter()`，而 `enter()` 会清空 `COWCAT_*`。**只有 C5 那条失败是真的。** 这正是 HANDOFF §5 第 5 条「一次只改一个变量」的第二次应验。

**未做的实测**（登记在 §10）：跨版本回放（待验证 3）、symlink 信任（待验证 5）、旧版测试套件复跑（本阶段无必要）。

### B-补：P3 T1 落地后对本探针的更新（2026-10-17）

ADR-027 把 `Rule.matches`（函数）换成 `Rule.when`（数据），探针的构造 API 随之改变。**本条记录改动，不覆盖上面 r2 的原文**：

| 项 | r2（调研时） | P3 T1 后 |
|---|---|---|
| 断言数 | 14 | **15** |
| 「不关心」的写法 | `matches: () => true` | `when: {}` |
| P9 | 「`matches` 抛异常直接冒泡」 | **用例已失效并替换**——函数形式被移除后，规则不能再在裁决路径上运行代码，所以「抛异常的匹配函数」不可表达。新 P9 断言的是替代它的性质：**`when` 选了请求里没有的字段时必须不匹配**（fail-closed，`absent` ≠ `do not care`） |
| 新增 P15 | — | `DEFAULT_RULES` 必须通过 `validateRules`——默认规则若会被加载器跳过，就是一个静默的策略漏洞 |

新增的 `validateRules` 是 ADR-025 决定 5「单条坏 → 跳过那条、保留其余并告警」的落地通道：`decide` 必须在工具路径上永不抛，所以不可用的规则（glob 路径、相对路径、文件系统根、未知 risk）必须在**加载前**被报出来，而不是在回合中途炸掉。glob 被拒是刻意的——`policy/` 不依赖宿主运行时，无法向 `FsPort` 问文件系统，在这里另实现一套 glob 只会造出第二个可能与 ADR-017 权威实现不一致的路径匹配器。

---

## 附录 C：外部对照（T10）

**背景**：`websearch` 集成返回 **HTTP 402**，与 P2 时同一故障。已按降级路径改用 `webfetch` 直取官方文档，**该降级路径可用**。

**取证来源**：

| 来源 | URL |
|---|---|
| Claude Code · settings 与优先级 | `https://docs.claude.com/en/docs/claude-code/settings` |
| Claude Code · permissions 与规则语法 | `https://code.claude.com/docs/en/permissions` |
| OpenCode · permissions | `https://opencode.ai/docs/permissions/` |

**未取证**：Codex 的配置面与审批语义。本文件对 Codex 不作任何陈述。

### C.1 与 CowCat 现行设计冲突的六处

| # | 维度 | CowCat（v1 实为 / v2 现状或计划） | Claude Code | OpenCode |
|---|---|---|---|---|
| 1 | **裁决顺序** | `deny > ask > allow`（v2 现状，且 v1 同） | **相同**，且给出理由 | **last matching rule wins**（相反） |
| 2 | **无人值守的 `ask`** | auto-deny（v1） | `dontAsk` = auto-**deny** | `--auto` = auto-**approve**（显式 deny 仍执行） |
| 3 | **信任门控** | 一刀切切 plan（v1） | **不对称**：allow 等信任，deny/ask 立即生效 | 未取证 |
| 4 | **环境变量** | 是一层，位置在项目之上 | **不是一层**，逐键决定 | 未取证 |
| 5 | **列表键** | 整体替换（v1 实测） | **合并** | 未取证 |
| 6 | **错误报告粒度** | 单级：一条坏就整体抛（v1） | **三级**：整文件坏 / 单条坏跳过保留其余 / managed 回退更严 | 未取证 |

### C.2 值得直接借用的三处

1. **裁决顺序的理由**（Claude Code permissions 页）——「allow 规则无法从 deny 规则里挖出例外」，这句可直接进 ADR-023。
2. **规则不是安全边界**（同一页）——文档用一张表列出 `Bash(rm *)` 挡不住 `/bin/rm`、`sh -c 'rm -rf'`、`git -C . push`，并明确推荐「要文件系统与网络强制，用 sandbox」。这与 P2 的沙箱工作直接衔接。
3. **不能匹配主内容字段的理由**——`Bash(command:rm *)` 会被复合命令绕过，所以 Claude Code **忽略它并发启动警告**。这解释了为什么 §4.4 的 `command` 必须是**前缀语义并有文档写明边界**，而不是「精确匹配整条命令」。

### C.3 一条给规则语言选型的警告证据

Claude Code 的 `Bash(ls *)` 与 `Bash(ls*)` **语义不同**——文档原文：「尾部 `*` 前的空格是规则的一部分」。这类微妙语义是**纯结构化方案的论据**：文本 DSL 的每个字符都可能承载语义，而每个语义都需要一条测试来钉。

Claude Code 还在 deny/ask 规则里用了 `!` 负向前缀来解决「怎么从一条宽规则里挖出例外」（`Read(*.env)` 后跟 `Read(!sample.env)`），并明确了两个限制（`!` 只能相对于当前目录、不能挖进整目录被拦的内部）。**这正是 §3.6 决定 4「列表合并」和 ADR-026 必须回答的问题。**

---

## 附录 D：本节修订记录（r1 → r2）

> 沿用 [`p1-kernel.md`](p1-kernel.md) §3.7 的做法：**不覆盖 r1 的原文**，逐条记录评审意见与因此产生的改动。

**r1 → r2 的评审输入**（2026-10-17）：五项决定按 r1 的建议方向拍板；指令文件一项要求**改为标准的 `AGENTS.md`，且先调研确定具体写法**。

| # | 评审意见 | r2 的改动 | 位置 |
|---|---|---|---|
| 1 | `COWCAT.md` → 标准 `AGENTS.md`，先调研写法 | 新增**附录 E**（标准 + opencode 模型）；§5.2 重写为调研结论 + 两条旧版缺口 + 两个待定语义；§5.4 新增决定 3（命名）与决定 4（未信任不注入） | §5.2、§5.4、**附录 E** |
| 2 | §2.5 的待决分支按建议定 | 待决 → **决定：`deny` 永不被短路**，补三条理由（出口标准自洽、外部两家一致、收窄 vs 放宽） | §2.5、ADR-024 |
| 3 | §3.6 列表合并按建议定 | 待评审 → **决定**；新增「如何撤销上层 `allow`」的建议方向（用更窄的 deny，不引入 `!` 语法） | §3.6、ADR-026 |
| 4 | §6.4 无人值守按建议定 | 待选 → **决定：auto-deny**，补三条理由 | §6.4、ADR-032 |
| 5 | §6.6 `always` 范围按建议定 | 待评审 → **决定：先做会话内**；把「按工具而异」明确留给后续单独立项 | §6.6 决定 3 |
| 6 | §7.4 审计按建议定 | 标题由「决定草案」改为「决定（评审通过）」，内容不变 | §7.4 |
| — | 连带 | ADR 清单 10 → **11 条**（拆分出「AGENTS.md 命名」与「未信任不注入」两条）；待验证 8 → **9 条**；§8 影响表与出口标准复核同步更新 | §8、§9、§10 |

**r2 未改动的内容**：§1 验证环境、§2.1-2.4 与 §2.6、§3.1-3.5 与 §3.7、§4 全节、§5.1 与 §5.3 与 §5.5、§6.1-6.3 与 §6.5 与 §6.7、§7.1-7.3 与 §7.5、附录 A/B/C。

**r2 的两处自我更正**（探针与文档层面，非评审意见）：

1. `tools/legacy-config-probe.mjs` 第一版有 4 条断言失败，**其中 3 条是探针自己的 bug**（用会被 `resolveModelConfig` 校验的 `model` 值、在清空环境变量之后才设环境变量）。只有 C5（`readState` 回退全局 `config.json`）是真发现。详见附录 B 末尾。
2. r1 的 §0 摘要曾把 `readState` 的效果写成「`state.json` 压过一切」。**不准确**——真正的机制是全局 `config.json` 也被当作 state 兜底，所以**没有 `state.json` 时它同样压过项目层**。r2 已改正（§3.2）。

---

## 附录 E：`AGENTS.md` 标准调研

**取证来源**：

| 来源 | URL | 性质 |
|---|---|---|
| AGENTS.md 官方站 | `https://agents.md` | 格式标准本体 |
| opencode · Rules | `https://opencode.ai/docs/rules/` | 一家实现的优先级语义 |

**未取证**：Claude Code 的 `CLAUDE.md` 文档、Codex 的 `AGENTS.md` 文档。本附录对这两者不作陈述。`websearch` 仍为 HTTP 402，全程走 `webfetch`。

### E.1 标准本体（`agents.md`）

| 项 | 内容 |
|---|---|
| 定位 | 「给 agent 的 README」——与 README 分离，因为内容对人不重要但对 agent 重要 |
| 采用规模 | **60k+ 开源项目**（官方站给出的 GitHub 搜索口径） |
| 托管 | **Agentic AI Foundation（Linux Foundation）** 下的 LF Projects |
| 起草方 | OpenAI Codex、Amp、Jules（Google）、Cursor、Factory |
| 生态 | Codex、Jules、Factory、Aider、goose、**opencode**、Zed、Warp、VS Code、Devin、UiPath、Junie、Amp、Cursor、RooCode、Gemini CLI、Kilo Code、Phoenix、Semgrep、GitHub Copilot、Windsurf、Augment Code、Ona |
| **必填字段** | **无。** 「AGENTS.md is just standard Markdown. Use any headings you like」 |
| 位置 | 仓库根；**monorepo 可放嵌套 `AGENTS.md`**（openai 主仓库当时有 88 份） |
| 优先级 | 「The closest AGENTS.md to the edited file wins; **explicit user chat prompts override everything**」 |
| 冲突 | 就近的那份赢 |
| **会执行命令吗** | **「Yes—if you list them.」** 列在文件里的测试命令会被 agent 尝试执行并在收尾前修好失败 |
| 常见章节 | Project overview / Build and test commands / Code style guidelines / Testing instructions / Security considerations |
| 迁移 | 改名并**建 symlink 保持向后兼容**：`mv AGENT.md AGENTS.md && ln -s AGENTS.md AGENT.md`（可见历史名是单数 `AGENT.md`） |
| 维护 | 当活文档对待 |

**第 5 条（会执行命令）是本次最有价值的发现**：它把「指令文件要不要信任门」从一个「提示注入」问题升级为「**命令执行**」问题。§5.4 决定 4 的依据主要是这一条。

**第 6 条（symlink 迁移）与我们已付过的学费同构**：项目已经因为 `/var` → `/private/var` 的 symlink 双拼写栽过 7 个 macOS CI 失败（`trust.js:14-21`）。指令文件若按 symlink 拼写做缓存或去重，会重演同一个 bug。§5.2 表格第 2 行的建议方向即出于此。

### E.2 opencode 的优先级模型（比标准更精确）

opencode 把 AGENTS.md 分成三类，并给出明确的裁决顺序：

```
1. Local     从当前目录向上遍历（AGENTS.md, CLAUDE.md）
2. Global    ~/.config/opencode/AGENTS.md
3. Claude Code 兼容  ~/.claude/CLAUDE.md（除非用环境变量关掉）
```

> The first matching file wins in each category. ... if you have both `AGENTS.md` and `CLAUDE.md`, only `AGENTS.md` is used.

四条可直接借用的做法：

1. **同类别内 `AGENTS.md` 优先、`CLAUDE.md` 作兼容回退**——与 v1 的候选列同构，只差 v1 把专有的 `COWCAT.md` 插在最前（`project.js:6`）
2. **个人级与项目级分离**：项目级 `./AGENTS.md` 随仓库提交、给团队；个人级 `~/.config/opencode/AGENTS.md` 不提交。v1 对应概念是「memory」，**两者关系 P3 未涉及，登记待查**
3. **`instructions` 数组**做显式追加，支持 **glob**（`packages/*/AGENTS.md`）与**远程 URL**（5 秒超时）。这是 opencode 解决 monorepo 的方式——**不自动合并嵌套文件，而是让你显式列**。§5.2 表格第 1 行的建议方向即以此为准
4. **`/init` 脚手架**：扫描仓库、必要时问几个问题，然后**创建或就地改进** `AGENTS.md`（已有则不盲替）。v1 的 `/init` 生成 `COWCAT.md`（`init.js:10-23`），要跟着改名

**一个反面样本**：opencode **不自动解析 `AGENTS.md` 里的 `@file` 引用**。文档给的两种替代是「用 `instructions` 配 glob」或「在 AGENTS.md 里写显式指令让模型自己用 Read 工具按需加载」。后者把「读哪些文件」变成了模型的判断，**在信任模型上是有风险的**（模型可以顺着引用读到信任范围外的文件）。**P3 若支持引用，建议只走 `instructions` 式的显式声明**，不要让模型自行展开。

### E.3 落成决定

见 §5.2（命名与两条缺口、两个待定语义）与 §5.4 决定 3/4。对应 ADR-029、ADR-030。
