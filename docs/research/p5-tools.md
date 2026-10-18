# P5 调研：工具层

> 依据 [`dev-plan-v2.md`](../dev-plan-v2.md)「工作规则 1」：每个阶段开始前先做调研，回答阶段内的开放问题，列出被否决的方案及理由。本文件回答 P5 的开放问题，并给出它们对 P5 五项范围的具体影响。
>
> 最后更新：**2026-10-18**。状态：**调研完成；三处待评审项已于 2026-10-18 裁定**（见下）。本文件只出决定草案与 ADR 清单（工作规则 2/3）；**ADR 与源码都不在本 PR 里改**，落表由 T0 执行（§14、§15）。
> **评审裁定（2026-10-18）**：① §6.3 的闸门落点取 **A（由日志派生，改事件形状）** → ADR-049；② §8.3 接受**给 `ToolPort.run` 加一个只描述「本次授予」的第三参数** → ADR-051；③ §11 注的两个探针脚本**随本调研 PR 一起留下**。
> 前置：[`dev-plan-v2.md`](../dev-plan-v2.md) 的 `## P5` 段、[`architecture/02-kernel.md`](../architecture/02-kernel.md)（回合执行与 `tool.finished`）、[`architecture/03-policy-and-execution.md`](../architecture/03-policy-and-execution.md)（端口表已写「`ToolPort`：接口已定，工具 P5」，`:156`）。
>
> **本文件的证据边界（必须先说清）**：
> - 本文件有**两次新增实测**，都在仓库内、可复现：`tools/p5-json-schema-probe.mjs`（zod → JSON Schema，**31/31 断言通过**）与 `tools/p5-glob-grep-probe.mjs`（Glob/Grep 性能，**7/7 结构性断言通过**，跑在 3 棵树上）。两个脚本是开发期脚本，按 [`AGENTS.md`](../../AGENTS.md) 约定**不进 lint 门禁、不进发布包**；**已裁定随本调研 PR 留下**（它们就是本文件实测结论的证据入口，见 §11 注）。
> - **工具对真实模型端点的行为依然零实测**：本机没有凭据，也没有端点。因此「OpenAI 的 `parameters` / Anthropic 的 `input_schema` 到底接受哪些 JSON Schema 关键字」在本文件里是**【推断】**，是 §12 待验证清单的第 1 项，**不得作为决策依据的最终形态**——决定草案因此写成「可切换」而不是「选定哪一个」。
> - 【源码】分三类，都给出 `文件:行号`：v2 现状（`packages/cowcat/`）、v1 对照（`agent/`）、以及本次真正的**实测**（标注为【实测】并给脚本名与用例）。**v1 全量测试套件本轮未重跑**（`agent/` 的 762 项是 P4 调研的记录，不是本轮数据）。
> - 【推断】是尚未验证的推论，**不得作为决策依据**。

## 证据标注约定

沿用 [`p1-kernel.md`](p1-kernel.md)、[`p2-ports.md`](p2-ports.md)、[`p3-policy.md`](p3-policy.md) 与 [`p4-models.md`](p4-models.md) 的约定：

- **【源码】** 本次会话直接读到实现或数据，给出 `文件:行号`
- **【实测】** 本次会话真跑出来的，给出脚本名与用例号
- **【上游】** 来自官方文档或官方 SDK 源码，给出链接（附录 C）
- **【推断】** 尚未实测的推论，**不得作为决策依据**
- **【未验证】** 明确未核对

---

## 0. 结论摘要

| # | 问题 | 决定草案（→ 建议 ADR） | 依据 |
|---|---|---|---|
| 二 | 工具住在哪一层、定义 API 是什么 | 核心工具住 **`src/adapters/tools/`**（`Adapter` 是唯一允许碰宿主的层，内核级工具必须能读写文件与起进程）；定义 API 沿用已有的 `ToolPort`/`ToolSpec`，P5 只补 `inputSchema` 的**产出方式**与入参校验落点 | §2、【源码】`eslint.config.js:67-68`、`ports/index.ts:20-62` |
| 三 | zod 入参 → 模型所需 JSON Schema | 工具的 zod schema 是**单一来源**，wire 形态由 `z.toJSONSchema(schema, { io: 'input', target: … })` **机械派生**；剥掉 `$schema`，并在编写约定里**禁用** `const`/`propertyNames`/`type` 数组这类只在部分实现里存在的词汇。**不手写 JSON Schema** | §3、【实测】`tools/p5-json-schema-probe.mjs` 31/31 |
| 四 | 输出截断策略与「截断事实」的记录方式 | `ToolResult` 增**结构化截断事实**（沿用 `ProcessPort` 的 `truncated` + `dropped` 口径），并**带进 `tool.finished`**；人类可读的尾注仍然写进 `output`（两个读者、两种渲染，同 `p2-ports.md` §2.3） | §4、【源码】`ports/index.ts:47-57`、`ports/process.ts:160-167`、`adapters/output-tail.ts:15-46` |
| 五 | 纯 JS Glob/Grep 的性能下限，是否要 ripgrep | **保持纯 JS**，但补两条：walk **尊重 `.gitignore`**、`files_with_matches` **支持早退**。瓶颈不是算法（740 文件 warm 只需 ~160ms），是「访问了 .gitignore 会排除的树」与「没有早退」；ripgrep 仅作为**P7 可选后端** | §5、【实测】`tools/p5-glob-grep-probe.mjs` 7/7（3 棵树） |
| 六 | Edit 语义与「先读后改」闸门 | Edit 的替换语义**照旧**（唯一性 / `replace_all` / 拒绝 `old === new` / 必须先读）；**新增一条 v1 缺口的修正**：Read 必须把「这个文件是 CRLF」作为**可判定事实**告知。闸门落点**已裁定取「由日志派生」**（评审 2026-10-18，见 §6.3） | §6、【源码】`agent/src/tools/edit.js:27-49`、`agent/src/init.js:12` |
| 七 | 只读工具是否并发 | **P5 保持串行**（与 `02-kernel.md` 已有决策一致）；并写清「为什么不能简单并发」——审批与状态跃迁是逐调用的顺序事实 | §7、【源码】`run-turn.ts:95`、`02-kernel.md:67` |
| 八 | Bash 与执行网关的接线 | Bash 是**薄壳**：构造 `ProcessSpec` → `ProcessPort.run` → `facts` 原样回填。**两个契约缺口必须在这里解决**：① `SandboxProfile` 从哪来；② `network: 'ask'` 的「按已批准的命令授予」**今天没有载体** | §8、【源码】`executor.ts:150-160`、`ports/index.ts:59-62`、`policy/config.ts:37-38` |
| 九 | 入参校验放哪 | **在工具内**（zod parse），失败返回 `ok: false` 的 `ToolResult`；内核不新增校验分支 | §9、【源码】`agent/src/tools/registry.js:29-34`、`run-turn.ts:376-381` |

**四条纠正前提的发现**（都是读源码／实测得出的，与前一份计划或直觉不同）：

1. **`ToolResult` 里没有任何位置放「我截断了什么」**。【源码】`ports/index.ts:47-57` 只有 `ok` / `output` / `facts?`；`facts` 是 **`ExecutionFacts`（沙箱与进程终止事实）**，不是通用事实袋。于是 Read/Glob/Grep 的截断（「只给了 2000 行」「截到 100 个文件」）**要么退化成一个尾注字符串，要么进不了日志**——而 ADR-033 已经把「可判定事实必须能被审计看到」定为取向。这不是「加个字段」，是契约缺了一类事实。
2. **`network: 'ask'` 的承诺已经写进了给用户看的文案，但机制不存在**。【源码】`adapters/sandbox/executor.ts:157` 告诉用户「use network "off" (the default) or "ask", which grants it per approved command」，而 `ToolPort.run(input, signal)`（`ports/index.ts:61`）**拿不到审批结果**，`run-turn.ts:376-377` 也从不把裁决交给工具。也就是说：**「按已批准的命令授予网络」今天没有任何载体**。这是 P5 必须回答的，否则 Bash 在 `ask` 档只能当 `off` 用，却对用户说它能用。
3. **zod 4 的默认 target 会把「联合类型」写成 `type` 数组，不是 `anyOf`**。【实测】§3.1：`z.union([z.string(), z.number()])` → `{"type":["string","number"]}`；`z.string().nullable()` → `{"type":["string","null"]}`。这是 draft-2020-12 的写法，也是**最可能在厂商侧校验器上翻车**的一处（`target: 'openapi-3.0'` 下同一 schema 变成 `anyOf` + `nullable: true`）。「选一个 target 就完事」是错的，真正稳的做法是**限制工具 schema 的表达力**（§3.4）。
4. **v1 的 Glob/Grep 不看 `.gitignore`**。【实测】§5.1：本仓库 walk 到 **634** 个文件，而 `rg --files` 只有 **359** ——差的是被忽略的 `dist/` 等产物；在 `F:\WorkSpace\AIProjects` 上纯 JS walk 访问了 **414,839** 条路径（11.0s），`rg --files` 只列 3,181。v1 的硬跳过只有 `node_modules` / `.git` / `.hg` / `.svn`（`agent/src/tools/glob.js:6`）。

---

## 1. 验证环境

| 项 | 值 |
|---|---|
| 平台 | `win32`（Windows 11），shell 为 PowerShell / Git Bash |
| Node | `v24.18.0` |
| 仓库状态 | `main = e33b654`（`feat(kernel): 预设进内核（P4 T6c，ADR-046） (#41)`），与 `origin/main` 一致，工作区干净；本轮只在 `tools/` 下新增两个探针脚本 |
| v2 测试套件 | **【实测】** `packages/cowcat` 的 `npm test`（含 `pretest` 的 `tsc` build + ESLint）：**436 tests / 420 pass / 0 fail / 16 skipped**，10090.9ms。与 `HANDOFF.md` 记的 436 一致 |
| v1 测试套件 | **本轮未重跑**（不计为证据）。P4 调研记录的 762 项仅作参考 |
| 本次新增实测 1 | **【实测】** `node tools/p5-json-schema-probe.mjs` → zod **4.6.7**，**31/31** 断言与实测一致（§3.1） |
| 本次新增实测 2 | **【实测】** `node tools/p5-glob-grep-probe.mjs [root]` → 3 棵树、**7/7** 结构性断言通过（§5.1） |
| 本次**未**做 | 未访问任何模型端点（无凭据）→ **厂商对 JSON Schema 子集的接受度零实测**；未在 Linux/macOS 上跑任何东西；未跑 v1 套件；未录夹具 |

**一条方法说明**：§5 的计时都**跑两遍**（`[first touch]` 与 `[warm]`）。原因是一次真实的踩坑：同一棵树（`ClaudeCode_dev`，740 文件）首轮 Grep 测得 **19.3s**，而同一份代码紧接着只花 **135ms**，独立脚本 warm 读完全部 740 个文件（10.1MB）只要 **52ms**。那 19.3s **不可复现**，判定为冷 I/O（Windows Defender / 冷 NTFS 元数据），不是算法成本。**只跑一遍的计时会把这件事"证明"成相反的结论**，所以探针里每个文件系统用例都有两行。

---

## 2. 问题一：工具住在哪一层，定义 API 是什么

### 2.1 v2 现状【源码】

- 端口已定，**实现为零**：`ToolPort { spec, run }`、`ToolSpec { name, description, risk, inputSchema?, pathInput?, commandInput? }`、`ToolResult { ok, output, facts? }`（`ports/index.ts:20-62`）；`index.ts:57-60` 已把它们导出为公共 API。全仓 `src/` 下**没有任何 `ToolPort` 的实现**（grep 只命中端口定义与 `run-turn.ts` 的消费点）。
- 内核侧的消费已经完整：`runTurn` 建 `ActionRequest`（`run-turn.ts:318-325`）→ `decide` → 审批 → `tool.run` → `tool.finished`（`run-turn.ts:96-108, 312-381`）；工具结果经 `reduce` 变成 `Message.tool`（`state.ts:73-76`）。**P5 不需要动内核的循环**，只需要提供 `ToolPort` 的实现并把 `inputSchema` 填上。
- `ToolSpec.inputSchema` 的注释已经把生产者指给 P5，并说明适配器只读不造（`ports/index.ts:24-31`；ADR-044 实例①）。
- 架构文档已把这一格留好：`03-policy-and-execution.md:156` 的端口表写着「`ToolPort`｜接口已定，工具 P5」。

### 2.2 分层规则对「工具放哪」的实际约束【源码】+【实测】

lint 里有一条很容易踩空的事实：**在 `src/adapters/`、`src/kernel/`、`src/policy/`、`src/ports/` 之外**，第二个 block（`files: ['src/**/*.ts']`，`ignores: ['src/adapters/**', 'src/kernel/**', 'src/policy/**', 'src/ports/**']`）会禁用 `node:child_process` / `node:fs` / `node:os`（`eslint.config.js:54-83`）。

推论（**这条是 P5 的第一块基石**）：**如果新建 `src/tools/`，里面的 Read/Write/Glob/Grep 一律 import 不了 `node:fs`**。可选路径只有三条：

1. 把核心工具放进 **`src/adapters/tools/`**（`adapters/` 已在 ignored 列表里，零 lint 例外）；
2. 新建 `src/tools/` 并**给 lint 加第二个例外**；
3. 只让工具经 `FsPort` 访问文件系统 —— 但 `FsPort` 今天只有 `canonical` / `samePath` / `kindOf` / `exists` 四个方法（`ports/fs.ts:30-46`），**没有 read / write / stat / list**，读一行文本都做不到。

【实测】`packages/cowcat` 的 `npm run lint` 在 436 项测试前通过；`tools/lint-probe.mjs` 逐条验证这些禁令**真的会报错**（`AGENTS.md`）。也就是说第 2 条不是「改个配置」，而是**削弱一条被探针钉住的规则**。

`01-layers.md:13` 的图里有 `modules` 层，但它的定义是「以能力形式注册，**不被内核认识**」——子 agent、MCP、记忆、压缩、skills、hooks、cron。核心工具恰恰相反：**内核必须认识它们**（`ToolSpec` 要发给模型、`risk` 要参与裁决）。所以核心工具属于 `adapters`，不属于 `modules`。

### 2.3 被否决的方案

- **手写 JSON Schema，不用 zod**：两份入参定义（校验用 + wire 用）必然漂移；ADR-044 已经把「`inputSchema` 的生产者是 P5」记在端口注释里，指向的就是「工具的入参只写一次」。
- **`ToolPort` 改成函数式 `run(input, ctx)` 并让 `ctx` 带上内核状态**：等于把内核状态机暴露给工具，`01-layers.md:65` 明令前端不能读内核内部，工具没有理由比前端更近。
- **把 `FsPort` 扩成完整文件系统端口，工具只依赖端口**：看起来最干净，但代价是 `FsPort` 要新增 6–8 个方法、`policy` 层同一份接口必须保持与运行时无关（`ports/fs.ts:20-26` 的同步理由是「策略→argv 映射必须是纯函数」），而 `FsPort` 的职责被 ADR-017 定成**路径身份**。文件读写**不是身份问题**，塞进去会让「谁拥有路径身份」这条唯一性被稀释。

### 2.4 决定草案

1. **核心工具住 `src/adapters/tools/`**，`01-layers.md` 补一行说明（`adapters` 的职责从「文件存储 · 时钟 · 进程」扩成「… · 工具实现」）。**不给 lint 开第二个例外**。
2. **定义 API 沿用现有 `ToolPort` / `ToolSpec`**，不加字段（`inputSchema` 的产出见 §3，入参校验见 §9）。工具的「声明」保持**纯数据**（`spec`），行为在 `run`，与 ADR-027 把 `Rule` 从函数改成数据的取向一致。
3. 工具集用**一个注册点**装配（`ReadonlyMap<string, ToolPort>`，`run-turn.ts:37` 已是这个形状），由组合根在 P6 建；P5 只提供构造函数与一个「核心七件」的默认集合。

### 2.5 待验证

- `src/adapters/tools/` 这个位置是否会被 `tools/check-tarball.mjs` 的发布白名单正确收进 `dist/src`（`packages/cowcat/package.json:17-19` 已经用 `files: ["dist/src"]` 覆盖整个目录）——**未核对**，但看不出风险。

---

## 3. 问题二：zod 入参 → 模型所需的 JSON Schema

这是 P5 唯一一个**本轮有实测落脚点**的问题，所以证据最厚。

### 3.1 本次实测：zod 4.6.7 到底产出什么【实测】

`node tools/p5-json-schema-probe.mjs`（31 个断言，全部按预期；脚本见附录 A）。要点：

| 观察 | 实测值 |
|---|---|
| `$schema` | **默认会带上** `"https://json-schema.org/draft/2020-12/schema"`；它是普通数据键，可原地 `delete`；`target: 'openapi-3.0'` 下**完全不产出** |
| 对象闭合 | `z.object()` → `additionalProperties: false`（与 `.strict()` 同）；`.passthrough()` → `additionalProperties: {}`（空 schema = 任意，**不是 `true`**） |
| 必填 | 只有非 optional 字段进 `required`；`z.number().int()` → `"type":"integer"` 且带 `minimum`/`maximum: ±9007199254740991` |
| 枚举 / 字面量 | `z.enum([...])` → `enum`；`z.literal('x')` → `"type":"string","const":"x"`（draft-04 下退成 `enum:["x"]`） |
| **联合** | `z.union([string, number])` → **`"type":["string","number"]`**，**不是 `anyOf`**；`target:'openapi-3.0'` 下才是 `anyOf` |
| **可空** | `z.string().nullable()` → `"type":["string","null"]`；openapi-3.0 下是 `"nullable":true` |
| 判别联合 | `z.discriminatedUnion` → `oneOf`（这一点两个 target 一致） |
| record | `z.record(z.string(), z.string())` → `propertyNames` + `additionalProperties:{"type":"string"}`；**draft-04 下 `propertyNames` 消失** |
| `$ref` | 复用同一 schema 对象**默认内联**（`reused:'inline'`），只有 `reused:'ref'` 才产出 `$defs`+`$ref`；**递归 schema 例外**，默认就用 `$defs`+`$ref` 断环 |
| **不可表达类型** | `z.date()` / `z.bigint()` / `z.function()` **直接抛错**（`unrepresentable:'throw'` 是默认）：「Date cannot be represented in JSON Schema」等 |
| `io: 'input'` | `required` 保留（**带 `.default()` 的字段除外**——它变成可省），`additionalProperties` **不再产出** |
| 描述 | `.describe('…')` 与 `.meta({description})` **都能**到达 wire |

一个值得一提的副作用：**`io:'input'` 与对象闭合是对立的**。想要 `additionalProperties:false`（OpenAI `strict` 模式要的形状）就得用 output 模式，而 output 模式下带 `.default()` 的字段仍是**必填**——语义上模型本可以不传它。

### 3.2 上游：zod 自己把这件事定成什么【上游】

- `ToJSONSchemaParams` 的默认值是 `target: 'draft-2020-12'`、`unrepresentable: 'throw'`、`cycles: 'ref'`、`reused: 'inline'`；`target` 可选 `draft-2020-12` / `draft-07` / `draft-04` / `openapi-3.0`（附录 C-1）。
- 官方文档明确「`z.object()` 默认产出 `additionalProperties: false`」，并**明确**「`io: 'input'` 时 `additionalProperties` 不设置」，且 `z.looseObject()` 永不设 false、`z.strictObject()` 永远设 false（附录 C-2）。
- 官方列出**不可表达**的类型清单：`bigint` / `int64` / `symbol` / `undefined` / `void` / `date` / `map` / `set` / `transform` / `nan` / `custom` / `number().multipleOf(0)`，并说「It is unsound to attempt a conversion… you should modify your schemas」（附录 C-3）。
- `unrepresentable: 'any'` 会把不可表达类型换成 `{}` 并**丢掉那条校验**（附录 C-3）——这正是 ADR-044 说的「在适配器/default 里挑一个动作等于替产品做决策」，只不过位置换成了转换器。

### 3.3 被否决的方案

- **`unrepresentable: 'any'`**：让「工具作者写了一个模型根本收不到的类型」静默变成「接受任意值」。写错 schema 的人不会知道，模型会收到一个放宽的合约。**拒绝**：宁可启动即抛。
- **在适配器里做转换**：`inputSchema` 是 `ToolSpec` 的一部分，适配器只读（`model-openai.ts:272-284` 已经是 `spec.inputSchema ?? { type: 'object', properties: {} }`）。转换器一旦住进适配器，两种协议就要各写一遍，而它跟协议**无关**。
- **固定一个 target 并把差异留给厂商**：见 §0 发现 3 —— 联合类型在 2020-12 与 openapi-3.0 下的**数据结构不同**（`type` 数组 vs `anyOf`），这不是「同一个 schema 换个版本号」，是两种形状。既然厂商侧接受度零实测，就不能把整个工具集的可调用性押在一个未验证的选择上。
- **把 JSON Schema 当不可信输入在工具侧再校验一遍**：等于把同一份约束实现两次，且 wire 上的 schema 与工具内的 zod 必须一致——不引入第二次机会，只引入第二个可能不一致的地方。

### 3.4 决定草案

1. **单一来源**：工具的入参用 zod 定义；wire 形态由 `z.toJSONSchema(schema, { io: 'input', target: <常量> })` 派生，**产出一处、两协议共用**（与 ADR-036「协议适配器只做映射」同一条边界）。
2. **剥掉 `$schema`**：它是纯元数据，也是唯一一个「厂商侧校验器可能不认识」却**对模型毫无帮助**的键。剥掉它零成本、零语义损失。
3. **`io: 'input'`**：模型提供的是**入参**，不是产出；实测里 `.default()` 字段因此正确地变成可省（§3.1）。
4. **限制表达力，而不是事后转换**：工具 schema 编写约定禁止 ① `z.union`/`nullable`（要写 `type` 数组或 `nullable` 的**都用别的方式表达**，例如 `z.string()` + 一个显式的 `kind` 字段）② `z.record`（`propertyNames` 是 draft-04 也没有的键）③ `z.literal`（`const` 在 draft-04 退化成 `enum`，行为随 target 变）④ `z.date()` 一族（本来就抛）。**约定优于转换**的理由：转换要覆盖四种 target 的差异矩阵（§3.1 表），而约定只有四条，且**违反时能立刻被探针/测试发现**。
5. **target 与「是否剥 `$schema`」做成一处常量**（例如 `adapters/tools/json-schema.ts` 里的 `WIRE_SCHEMA = { io:'input', target:'draft-2020-12' }`），并把「厂商实测」留到 P6 组合根第一次真连端点时校准（§12 第 1 项）。**决定的是机制，不是那一个值**。
6. **`tool_call: false` 的模型不发 `tools`**（ADR-046 决定③已落地），所以「工具 schema 上不了 wire」这件事不需要 P5 关心。

### 3.5 待验证（本文件最重的一项）

**厂商侧接受度零实测**，因此以下全部标【推断】：

1. OpenAI 兼容端点的 `parameters` 是否接受 **type 数组**（`{"type":["string","number"]}`）——【推断】部分本地推理实现会拒；这也是 §3.4 第 4 条把联合禁用掉的原因。
2. Anthropic 的 `input_schema` 是否接受 `additionalProperties` / `anyOf` / `$defs+$ref`——【推断】接受 `anyOf`；`io:'input'` 恰好不产出 `additionalProperties`，这可能**顺手**降低风险。
3. `propertyNames`（record 产出）在两家是否被忽略还是报错——【推断】至少会被忽略；已由 §3.4 第 4 条禁用。
4. 剥掉 `$schema` 之后两家是否都能正常接受——【推断】能（该键在两家文档里都不是必填）。

**校准路径**（写进 P5 任务的验收）：P6 接上真实端点后，用**一个带联合、带可选、带默认值的探针工具**各打一次两家，把结果记回本文件 §12；在拿到结果前，§3.4 的约定意味着**没有任何核心工具需要联合类型**，所以真实风险面是零。

---

## 4. 问题三：输出截断与「截断事实」的记录方式

### 4.1 v2 里已经有的两件东西【源码】

- **执行网关的截断口径已经定死**：`ProcessSpec.outputCap`（保留尾部、上报丢弃数）→ `ProcessResult.truncated` + `ProcessResult.dropped {stdout, stderr}`（`ports/process.ts:99-100, 160-167`），实现是 `OutputTail`（`adapters/output-tail.ts:15-46`：`dropped` 永远是 `total - kept`，注释写明「两个计数器早晚会互相矛盾」）。
- **`ToolResult` 里没有对应物**：只有 `ok` / `output` / `facts?`（`ports/index.ts:47-57`）。`facts` 是 `ExecutionFacts`（沙箱 + 终止记录 + 脱敏名单），**不是通用事实袋**，注释也这么写。

### 4.2 v1 的三种不一致形状【源码】

| 工具 | 上限 | 超限时怎么说 |
|---|---|---|
| Read | 2000 行（`read.js:18, 89`）、5MB/20MB 两级（`:19-20, 79-81`） | 尾注 `[showing lines a-b of N]`（`:95`） |
| Glob | 100 个（`glob.js:5, 97`） | 尾注 `[N match(es), truncated to first 100]`（`:100-101`） |
| Grep | 250 行（`grep.js:7, 93`），单文件 1MB 跳过（`:6, 104`） | 尾部 header `[N file(s), M match(es), K file(s) skipped (too large)]`（`:160`） |
| Bash | **无上限**，只靠 `maxBuffer: 10MB`（`bash.js:183`） | 无（超 maxBuffer 会直接失败） |

三种形状都是**人可读的字符串**。作为给模型的提示这没问题；作为**事实**它不可机器读，而且 `tool.finished.output` 是唯一通路（`run-turn.ts:97-107`），所以截断在日志里就是一段散文。

### 4.3 缺口：这个事实今天无处安放

P5 范围第 2 条点名的六个核心工具里，**Read / Glob / Grep 三个都会截断**，Bash 经网关也有截断（`outputCap` → `truncated` + `dropped`，但它们停在 `ProcessResult` 里，**要经 `ToolResult.facts` 才能出去**——而 `facts` 是 `ExecutionFacts`，装不下通用的截断计数）。

### 4.4 被否决的方案

- **只写尾注，不加字段**：放弃「日志是事实来源」。审计要回答「这次回答是不是被截过」时只能正则解析散文。
- **把 `facts` 放宽成 `Record<string, unknown>`**：把一个**有名字、有契约**的字段变成杂物袋。`ExecutionFacts` 的每一字段都能被审计逐条解释，放宽之后不能。
- **新增一条 `tool.truncated` 事件**：截断不是独立发生的事实，它是**同一份结果的属性**；单独成事件会让「结果」与「结果的属性」可能分别丢失。ADR-041 把用量单独立事件是因为**它有独立的到达时刻**，截断没有。

### 4.5 决定草案

1. `ToolResult` 增可选字段，形状沿用网关口径（`truncated: boolean`、`dropped: number`，再加一个 `reason` 说明是哪条上限）——**同一个概念在仓库里只能有一种算术**（§4.1 的 `OutputTail` 注释就是这个教训）。
2. `tool.finished` 带上它（新增**可选**字段，`null` = 工具没上报，与 `facts` 同形）。**这会触发三处编译期硬失败**（`adapters/schema.ts` 的 `discriminatedUnion`、`state.ts` 的 switch 穷尽性、编译期等价断言），按 ADR-031/041 的先例，那是**特性**。
3. **`output` 里的尾注照旧保留**：模型需要它（同一事实、两个读者、两种渲染，`p2-ports.md` §2.3 已为进程输出定过同样的口径），审计读字段。
4. v2 从 v1 照搬的上限：Read 2000 行 / Glob 100 / Grep 250 行；**Bash 的 10MB `maxBuffer` 不再照搬**，改用网关的 `outputCap`（尾部 + 计数），因为那是已经实现并测过的路径。

---

## 5. 问题四：纯 JS Glob/Grep 的性能下限与 ripgrep

### 5.1 实测【实测】

`node tools/p5-glob-grep-probe.mjs [root]`（结构性断言 7/7；计时为测量值，不作断言）：

| 树 | walk 文件数 | walk | Glob `**/*.ts` | Grep `files_with_matches` | Grep content | `rg --files` |
|---|---|---|---|---|---|---|
| `cowcat`（本仓） | 634 | 10ms | 9ms（命中 100 上限） | 125ms（166 文件 / 798 命中） | 9ms | 37ms → **359** |
| `ClaudeCode_dev` | 740 | 14ms | 15ms | 161ms（26 文件 / 84 命中） | 113ms | 34ms → **343** |
| `AIProjects`（父目录） | **414,839** | **11,041ms** | —（未跑） | —（未跑完，超时） | — | 92ms → **3,181** |

补充测量：在 `ClaudeCode_dev` 上用独立脚本 **warm 读完全部 740 个文件（10.1MB）耗时 52ms**、无单文件超过 50ms。

### 5.2 三条结论

1. **算法不是瓶颈。** 740 个文件的完整「走 + 读 + 逐行正则」在 warm 状态下是**百毫秒级**。任何「纯 JS 太慢所以必须上 ripgrep」的结论都不能从这组数据里得出来——**唯一的慢样本（19.3s）无法复现，且已定位为冷 I/O**（§1 方法说明）。
2. **真正的成本是「访问了不该访问的树」。** 本仓 634 vs `rg` 359、`AIProjects` 414,839 vs 3,181。v1 的硬跳过只有四个目录名（`glob.js:6`），`.gitignore` 完全不看；于是在一个带 `dist/`、`target/`、`.venv/`、构建缓存的树上，walk 的规模与「仓库里有多少源码」无关。**这是一个可以被修复的量级问题，而不是一个需要换实现的性能问题。**
3. **`files_with_matches` 没有早退。** 【源码】`grep.js:100-163`：只有 `count` 与 `content` 两种模式里有 `break outer`，`files_with_matches` 会把整棵树读完再在最后切片。探针里「要 5 个文件名」与「要全部」耗时相同（103ms vs 125ms，同一棵树）。默认模式恰好是 `files_with_matches`（`grep.js:71`），也就是**模型最常调的那一种最没有优化余地**。

### 5.3 被否决的方案

- **现在就引入 ripgrep 作为后端**：① 它是**外部可执行文件**不是库，按 ADR-014 必须经 `ProcessPort` 启动，于是又多一条「探测-真跑-分类失败」的平台分支（ADR-018 已经为 shell 付过一次这个成本）；② 本机实测的 92ms vs 11s **不是同一口径**（rg 跳过隐藏目录与 ignore 目录），把它读成「100 倍」是错的；③ ADR-005 的依赖预算要求「是否承担协议或安全责任」——加速不是。
- **只修早退，不修 `.gitignore`**：解决不了主因（§5.2 第 2 条）。
- **把 `.gitignore` 解析整个交给第三方 glob 库**：会引入一个新运行时依赖只为读一个文件格式；但这个格式（否定 `!`、目录通配、嵌套 gitignore、全局 excludes）**确实有语义边界**，所以它必须是**显式的决定**而不是顺手实现（→ §5.4 注与 §12）。

### 5.4 决定草案

1. **P5 保持纯 JS 实现**（不新增依赖），做两条修正：① walk **尊重 `.gitignore`**（并按 `rg` 的口径同时跳过隐藏目录），**同时保留** `node_modules` 等硬跳过（`.gitignore` 不在时也要安全）；② `files_with_matches` / `count` 在达到 `head_limit` 时**早退**。
2. **输出上限沿用 v1**（Glob 100 / Grep 250），并把「截了多少」按 §4 的口径上报。
3. **ripgrep 作为 P7 的可选加速后端**立项（与「后台任务」「MCP」同批），触发条件是「有实测证据表明在目标仓库上不可接受」——本轮没有这样的证据。
4. **`.gitignore` 的语义范围**作为 P5 实现前的一个明确决定：至少支持 `pattern`、`dir/`、`/anchored`、`*`、`**`、`!negation`；**不支持**嵌套 `.gitignore`、全局 excludes、`core.excludesFile`（并把这个限制作为**限制项上报**，而不是静默漏掉——这是 ADR-016/021 的一贯口径）。

### 5.5 待验证

1. `.gitignore` 子集是否够用：拿 `cowcat`、`ClaudeCode_dev` 两棵树跑一次「跳过后的文件数 vs `rg --files` 的文件数」，两者应当接近（本轮未做）。
2. 在 Linux CI 上同一份探针的数字（本轮只有 Windows）——**未验证**。
3. 真·大仓库（>10 万可搜索文件、无 ignore 目录）的 warm 上限——**未验证**；§5.1 的 414,839 条路径里绝大多数是进程无法快速读取的目录（`AIProjects` 是父目录，非单一仓库），所以它证明的是「walk 会被非源码目录撑大」，不是「热读 41 万文件要多久」。

---

## 6. 问题五：Edit 的精确替换语义与「先读后改」闸门

### 6.1 要继承的语义【源码】

`agent/src/tools/edit.js:27-49` 的五条规则，逐条确认 P5 照搬：

1. 文件必须存在，否则报错（`:29`）；
2. **本会话读过才允许改**（`:30-32`，`ctx.readSet`）；
3. `old_string === new_string` 直接拒绝（`:33-35`，「nothing to change」）；
4. `old_string` 在文件里出现 **0 次** → 报错（`:38-40`）；**>1 次且未给 `replace_all`** → 报错并给出命中次数（`:41-43`）；
5. `replace_all` 时用 `split/join` 全替换，否则 `String.replace`（**只替换第一处**，`:44-46`）。

`Write` 的另一条：**已存在的文件必须先读过才允许覆盖**（`write.js:24-26`）；`Write` 会创建缺失父目录（`:27`）。两条一起构成「先读后改」闸门。

### 6.2 一条要修正的 v1 缺口：CRLF 必须被当作事实说出来

【源码】Read 用 `split('\n')` 切行、Edit 用**字节精确**的 `content.split(old_string)` 匹配，两边都**不做换行规范化**。于是在 CRLF 文件上：Read 返回的行尾带着 `\r`（因为 `split('\n')` 只切 `\n`），而**模型看不见它**；模型按看到的内容拼出一个 LF 结尾的 `old_string` → 匹配 0 次 → 报「not found」。v1 的报错文案还会把模型引向「你猜了内容」（`edit.js:16`），而真实原因是**行尾**。

P5 决定草案：**保持字节精确、不做任何换行规范化**（自动规范化会让「替换了什么字节」变得不可预测，也与「日志=事实」冲突），但 **Read 的返回必须把行尾风格作为可判定事实告知**（例如 `[file uses CRLF line endings]`），并且 Edit 的「找不到」报错要把「文件是 CRLF、你的 `old_string` 里没有 `\r`」作为**最可能的原因**说出来。这不是新功能，是把一条已存在的失败形态说清楚。

### 6.3 「先读后改」闸门在 v2 的落点（**评审已裁定：取 A**）

v1 的闸门是 `ctx.readSet`：一个**内存** `Set`，建在 `agent/src/init.js:12`，子 agent 各自一份（`subagent.js:71`）。它不进日志、不随会话恢复。

v2 的两条事实让它变得不平凡：① 「日志是事实来源，回放必须与实时状态逐字段相等」有测试钉住（`02-kernel.md:6`）；② 但**今天 `tool.finished` 不带工具入参**（`events.ts:78-90` 只有 `callId`/`name`/`ok`/`output`/`facts`），而 `path` 只在 `ActionRequest` 里构造、明确「不必进日志」（ADR-027）。

两个候选：

| 方案 | 代价 | 结果 |
|---|---|---|
| **A. 由日志派生**（`reduce` 从 `tool.finished` 里 name=`Read` 且 `ok` 的事实重建「已读文件」集合） | 必须让 `tool.finished` 带上 **canonical `path`**（新字段 → 三处编译期硬失败）；同时给审计一个路径抓手 | 「先读后改」在恢复会话后**依然成立**，回放等价自动满足 |
| **B. 内存集合**（照搬 v1 的结构，放进 `TurnDeps` 或组合根） | 零契约改动 | 会话重开后闸门消失：**同一个文件先读后改的规则在恢复后静默失效** |

**推荐 A**，理由与 ADR-033 让 `facts` 进日志同源：「重构不出来的事实必须进日志」。闸门的用途正是防止盲改，而盲改在恢复会话的场景下风险一样大。**评审已裁定取 A（2026-10-18）**：改的是事件形状而不是工具内部，代价被接受；落成 **ADR-049**，实现见 T1（§14.2）。**B 被否决**，理由如上表：它让同一条规则在恢复会话后静默消失。

### 6.4 待验证

- **Windows 上 Edit 的 CRLF 行为本轮未实测**（本机就能测，属于 P5 的实现任务，不是调研缺口）。P5 出口标准已点名「CRLF 用例」。
- `replace_all` 在「`old_string` 是空串」时的行为：v1 没拦，`content.split('')` 会**在每个字符间**插入 `new_string`。**未验证**是否可达（模型可能发空串），但这是一个应被显式拒绝的输入。

---

## 7. 问题六：只读工具是否并发

- **现状【源码】**：`run-turn.ts:95` 是 `for (const call of calls)`，逐个 `runCall` 并逐个 `emit`。
- **已有决策【源码】**：`02-kernel.md:67` 写着「**工具串行执行**。旧版并发执行 + 按序组装结果，带来了大量复杂度。v2 先串行，正确性优先；确有需要的只读工具并发放在 **P5** 再定，并且必须有测试证明结果顺序」。
- **为什么不能简单并发**（P5 必须写进决定里，否则会被下一个实现者重新尝试）：审批与状态跃迁是**逐调用的顺序事实**——`policy.decided` → `turn.transitioned('awaiting_approval')` → `approval.requested` →（人工等待）→ `approval.answered` → `awaiting_tools`（`run-turn.ts:326-374`）。并发发起多个 `ask` 会让 `Session.state.grants` 的归约顺序与用户的回答顺序脱钩，`approval.answered.key` 也只能事后对账。**只读、且不触发 `ask` 的调用**才具备并发前提，而那需要一个「先裁决再决定是否并发」的两阶段实现。
- **决定草案**：**P5 保持串行**，把并发列为「有实测收益需求时再立项」（并记入 §12），并把上面那段理由写进 `02-kernel.md` 的对应位置，免得后人重复论证。

---

## 8. 问题七：Bash 与执行网关的接线（含两个契约缺口）

### 8.1 Bash 应当是薄壳【源码】

v1 的 `bash.js` 有 199 行，其中 1–25 行是常量、**26–137 行全是沙箱编排**（分类、探测、私有临时目录、策略→argv、降级判断、审计）、138–197 行是真正执行。而**沙箱编排这一整段在 P2 已经落成 `adapters/sandbox/*` 与 `adapters/process.ts`**（`03-policy-and-execution.md` 的「进程执行网关」「沙箱执行器」两节）。P5 的 Bash 应该只剩三件事：**构造 `ProcessSpec`**（argv 经 `PlatformPort` 的 shell 解析、cwd、env、`timeoutMs`、`outputCap`、`SandboxProfile`）→ **`ProcessPort.run`** → **把 `ExecutionFacts` 原样回填到 `ToolResult.facts`**（`ports/index.ts:50-56` 明说这个字段存在就是为了这一步）。

三条要照搬的既有结论：① 退出码非零**不是**工具失败（`bash.js:37` 的语义：结果里报告，模型自己解读）；② 超时（前台默认 60s / 上限 600s，`bash.js:16-17`）；③ **后台任务不属 P5**——`run_in_background` 在 v2 无对应物（属 P7 的后台任务模块），P5 的 Bash 应当**显式拒绝**该参数并说明，而不是静默忽略（`bash.js:129-137` 的实现依赖 `ctx.background`）。

### 8.2 缺口一：`SandboxProfile` 从哪来【源码】

`ProcessSpec.sandbox` 是**必填**（`ports/process.ts:101`），默认值由 `defaultSandboxProfile()` 给（`ports/process.ts:207-218`：`light` / `network: 'off'`）。而配置层 `CowcatConfig` 今天**只有 `rules`**（`policy/config.ts:37-38`），没有 sandbox/network 键。

决定草案：**P5 定键与解析、P6 在组合根装配**。P5 交付「从配置得到 `SandboxProfile` 的纯函数」（`policy/sandbox-defaults.ts` 已有 `DEFAULT_READ_DENY` / `DEFAULT_WRITE_DENY` / `DEFAULT_HOME_READ_ALLOW` 可复用），Bash 工具**接收一个已解析的 profile 或一个解析器**，自己不认识配置分层。

### 8.3 缺口二：`network: 'ask'` 的授予**没有载体**（本文件第二个必须评审的契约问题）

- 端口里 `SandboxNetwork = 'off' | 'ask' | 'on'`（`ports/process.ts:34`）。
- 给用户的提示文案已经承诺了机制：`use network "off" (the default) or "ask", which grants it **per approved command**`（`adapters/sandbox/executor.ts:157`）。
- 但审批结果**传不到工具**：`ToolPort.run(input, signal)`（`ports/index.ts:61`）只有两个参数，`runCall` 也是 `tool.run(call.input, signal)`（`run-turn.ts:377`）。裁决落在日志与 `session.state.grants` 里，工具读不到。
- 于是今天在 `ask` 档上，**Bash 只能把 `ask` 当 `off` 用**——而它同时会对用户说「这会在批准后授予网络」。这正是 ADR-016 说的「不降级、并且要说清楚」，只不过这次的「说清楚」变成了一句**实现不了的承诺**。

三个候选：

| 方案 | 形态 | 代价 |
|---|---|---|
| **A. `ToolPort.run` 增第三参数**（审批上下文，例如 `{ networkApproved: boolean }`） | 工具能知道「这次调用被批准了什么」 | 改端口形状 → 需 ADR；所有实现与测试替身要跟着改 |
| **B. 组合根在调用前解析 profile** | 不改端口 | 审批发生在 `runTurn` 内部（逐调用），组合根在**调用之前**不知道裁决结果——除非把「ask 一律按 off」写死，那就是降级 |
| **C. 让 Bash 自己发起网络授权** | —— | 等于把审批从内核搬进工具，推翻 P3 的整个决策链（ADR-031/032） |

三者的取向差别不在「能不能做到」，而在**代价放在哪一层**；A 的取向与 `ToolResult.facts` 一致：**内核把「做了什么决定」交给执行方，执行方把「实际做了什么」交回来**。**评审已裁定取 A（2026-10-18）**：接受改端口形状，形态即「新增一个只描述本次授予的第三参数」，语义边界如上（**不传规则、不传意见**）。落成 **ADR-051**，实现见 T1（§14.2）。降级方案（`ask` 档显式拒绝并说明「尚未接线」）随之**不再需要**——但那条纪律本身不撤销：任何情况下都不得默默当 `off`。

### 8.4 待验证

- `PlatformPort` 的 shell 解析（ADR-018）如何在 `ProcessSpec.argv` 上组合成一条真实命令：v2 的 `argv` 是**数组**且 `NodeProcess` 明确**不经过 shell**（`adapters/process.ts:17-19`），所以「`command` 字符串 → `argv`」这一步必须在 Bash 工具里完成，用的是 `PlatformPort` 的 shell 候选与 `commandFlag`。**本轮未读 `adapters/shell.ts` 的调用面，标【未验证】**；这条属于 P5 实现前的技术确认，不是决策缺口。

---

## 9. 问题八：工具入参校验放哪

- **v1 的做法【源码】**：`ToolRegistry.validate(name, input)` 在**调用前**用一份**简化 JSON Schema 子集**（`type`/`required`/`properties`/`items`/`enum`/`minItems`/`maxItems`）校验，失败即拒绝（`agent/src/tools/registry.js:29-34, 37-79`）。注意它需要**手写第二份形状**（`input_schema`），这正是 §3 要消灭的东西。
- **v2 的现状【源码】**：模型的 JSON 直接进 `tool.run(call.input, signal)`，`runCall` 只保证「抛出会变成 `ok: false`」（`run-turn.ts:376-381`）。
- **决定草案**：**校验在工具内**，用**同一份 zod schema**（`schema.safeParse(input)`）：失败时返回 `ok: false` 且 `output` 里给出**字段路径与原因**（zod 的 issue 列表），成功时把 `parse` 的结果传给实现（因此工具实现拿到的是**已校验的类型**，不需要再断言）。
  - 理由：① 只有一份 schema（§3.4 单一来源）；② 内核与 `runTurn` 不需要新增校验分支，`tool.finished` 的形状不变；③ 「模型发出的参数不是事实」这件事落在**工具**这一层最自然——它是唯一知道入参语义的地方。
  - **不做**：不在 `runTurn` 里校验。`runTurn` 只知道 `ToolSpec.inputSchema` 这份 **wire** 形态（一份 JSON Schema 对象），在核心里再实现一次 JSON Schema 校验等于把 zod 的能力在错误的层重写一遍，而内核还禁止 import zod（`eslint.config.js:36-38`，ADR-009）。

---

## 10. 对 P5 五项范围的具体影响

| 范围（`dev-plan-v2.md:421-427`） | 本文件的影响 |
|---|---|
| 1. 工具定义 API：名称、风险等级、zod 入参、执行函数 | **接口已在，P5 不扩形状**（§2.4）。新增的是「声明 → wire schema」的派生器（§3.4）与「入参校验在工具内」的约定（§9）。风险等级用已有的 `ToolRisk` 四值：Read/Glob/Grep = `read`，Write/Edit = `write`，Bash = `exec`，TodoWrite = **`write`**——它把 Agent 自己声明的待办写进持久文件（v1 是 `~/.cowcat/todos/<session>.json`，`todo.js:20-24`），**不是只读** |
| 2. 核心工具：Read、Write、Edit、Glob、Grep、Bash（经 ProcessPort）、TodoWrite | 七个都能落（§2、§8），但 **Read 要砍到文本**：v2 的 `Message` 联合类型**没有附件概念**（`kernel/messages.ts:30-38`），所以 v1 Read 的图像/PDF/notebook 三个分支在 v2 无处安放 → 明确**推迟 P7**（范围 5 已把 notebook/PDF/图像划出 P5）。**TodoWrite 的存储位置**需要定：v1 写在 `~/.cowcat/todos/<session>.json`（`todo.js:9-24`），v2 的等价物应是**会话日志的一部分**还是外部状态文件？**本文件未决**，见 §12 |
| 3. Edit 的精确替换语义与 v1 一致；先用测试固定行为 | 五条规则逐条确认（§6.1）。**新增**：CRLF 必须作为事实告知（§6.2）；`old_string` 为空串要显式拒绝（§6.4） |
| 4. 只读工具并发策略：默认串行；要并发必须有测试证明顺序 | **P5 保持串行**，并把「为什么」写进架构文档（§7） |
| 5. Notebook、PDF、图像等文档类工具不在 P5，作为 P7 的模块 | 与 §13 的归类表一致；**图像/PDF 多一层障碍**：不是「不在 P5」，是**v2 契约里没有附件通路**，属 P7 的契约工作 |

---

## 11. 需要落的文档与 ADR

> 评审通过后逐条落成 ADR（工作规则 2），实现随 P5 的任务拆分走（工作规则 3）。编号沿用 ADR 表的下一号（当前到 ADR-046）。**六条的完整条目文本（可直接贴进 ADR 表）在 §15。**

| 建议编号 | 决策 | 一句话理由 |
|---|---|---|
| **ADR-047** | **核心工具住 `src/adapters/tools/`，不给 lint 开第二个例外**；工具定义以 zod 为单一来源，wire 形态由 `z.toJSONSchema({ io:'input', target })` 机械派生，**剥 `$schema`**，并以**编写约定**禁掉 `const`/`propertyNames`/`type` 数组/联合与 nullable（§2.4、§3.4） | 分层规则的价值在于**没有例外**；厂商接受度未实测，所以决定的是**机制**而不是那一个 target 值 |
| **ADR-048** | **`ToolResult` 增结构化截断事实，并带进 `tool.finished`**（可空，`null` = 未上报），沿用 `ProcessPort` 的 `truncated`/`dropped` 口径；`output` 里的人可读尾注照旧保留（§4.5） | 「可判定事实必须能被审计看到」（ADR-033）；同一概念只能有一种算术（`OutputTail` 的注释） |
| **ADR-049** | **`tool.finished` 增 canonical `path?`**，「先读后改」闸门**由日志派生**（`reduce` 重建已读集合），恢复会话后闸门依然成立（§6.3） | 「重构不出来的事实必须进日志」（ADR-033 同源）；内存集合在恢复后静默失效 |
| **ADR-050** | **Glob/Grep 保持纯 JS**，但必须 ①尊重 `.gitignore`（语义子集显式、缺失即上报）②支持早退；**ripgrep 仅作 P7 可选后端**（§5.4） | 实测显示瓶颈是「访问了不该访问的树」，不是算法；引入外部可执行文件要经 ProcessPort 并新增平台分支 |
| **ADR-051** | **审批结果必须有载体**（`network: 'ask'` 的「按已批准的命令授予」）：给 `ToolPort.run` 增加一个**只描述本次授予**的上下文参数（形态已由评审裁定，见 §8.3）；**不得把 `ask` 静默当 `off`** | 端口文案已在向用户承诺这个机制；`ToolPort.run` 今天拿不到裁决 |
| **ADR-052** | **入参校验在工具内**（同一份 zod schema，失败 → `ok: false` + 字段级原因），内核不新增校验分支（§9） | 只有一份 schema；内核禁止 import zod（ADR-009） |
| 文档 | `01-layers.md`：`adapters` 职责加「工具实现」；`02-kernel.md`：把「工具串行 + 为什么不能简单并发」写实（现有一句话在 `:67`）；`03-policy-and-execution.md`：端口表把 `ToolPort` 那行从「工具 P5」改成落地后的链接 | 工作规则 5（文档与代码同 PR） |

**注（评审已裁定，2026-10-18）**：本文件的两个实测脚本（`tools/p5-json-schema-probe.mjs`、`tools/p5-glob-grep-probe.mjs`）按 `AGENTS.md` 的约定**不进 lint 门禁、不进发布包**。它们属于「调研的证据入口」而不是「源码」，**裁定随本调研 PR 一起留下**（P4 的教训正是「关于行为的结论没有一条是实测」）；后续改动它们时按同一约定处理，**不要把它们搬进 `packages/`**（那会让它们进 lint 门禁与发布包）。

---

## 12. 待验证清单（汇总）

| # | 项 | 现状 | 何时能闭 |
|---|---|---|---|
| 1 | **厂商侧对 JSON Schema 子集的接受度**（`$schema`、`type` 数组、`anyOf`、`$defs`/`$ref`、`propertyNames`） | **零实测**（无凭据/端点）。已用「禁用词汇」的约定把风险压到接近零 | P6 组合根接真实端点后，用一个带联合/可选/默认值的探针工具各打一次两家（§3.5） |
| 2 | `.gitignore` 子集够不够（与 `rg --files` 的文件数对齐） | 未做 | P5 实现前，两棵树各跑一次（§5.5） |
| 3 | Windows 上 Edit 的 CRLF 行为 | 未实测（本机可测） | P5 的实现任务，出口标准已点名 |
| 4 | `old_string` 为空串时的行为 | 未验证 | P5 实现时显式拒绝并测试 |
| 5 | **TodoWrite 的状态存哪**（日志内 vs 外部文件 vs 纯事件） | **未决** | P5 任务拆分时定为一个小 ADR |
| 6 | `command` 字符串 → `argv` 的组合面（`adapters/shell.ts` 的调用形状） | **未验证** | P5 实现前的技术确认 |
| 7 | 只读并发的实际收益（是否需要立项） | 未测 | 有真实仓库上的体感证据时 |
| 8 | Linux/macOS 上的 Glob/Grep 计时 | **未验证**（本轮只有 Windows） | CI 或换机时补一次 |
| 9 | v1 套件（762 项）在本轮分支上的状态 | 未重跑 | 不影响本文件结论（不引用其数字） |

---

## 13. v1 工具全量清单与归类（P5 出口标准第 2 条）

出口标准写着「与旧版工具清单对照，缺失项都有明确的『推迟到 P7』记录」——本节就是那份对照表。

**wire 名清单**（【源码】`grep '^\s*name: '` over `agent/src/tools/*.js`，共 19 个文件、30 个静态 wire 名 + 1 类动态注册）：

| v1 文件 | wire 名 | 宿主访问【源码】 | 归类 | 依据 |
|---|---|---|---|---|
| `read.js:23` | `Read` | `node:fs`（`:8`） | **P5（砍到文本）** | 图像/PDF/notebook 三支要附件通路，v2 契约没有（§10 范围 2） |
| `write.js:5` | `Write` | `node:fs`（`:2`） | **P5** | 范围 2 |
| `edit.js:5` | `Edit` | `node:fs`（`:2`） | **P5** | 范围 2/3 |
| `glob.js:70` | `Glob` | `node:fs`（`:2`） | **P5** | 范围 2；性能见 §5 |
| `grep.js:35` | `Grep` | `node:fs`（`:2`） | **P5** | 范围 2；性能见 §5 |
| `bash.js:28` | `Bash` | `node:child_process`（`:2`）、`node:fs`/`node:os`（`:3-4`） | **P5（经 ProcessPort）** | 范围 2；薄壳化见 §8 |
| `todo.js:26` | `TodoWrite` | `node:fs`（`:3`） | **P5**（存储位置未决） | 范围 2 点名；§12 第 5 项 |
| `notebookedit.js:8` | `NotebookEdit` | `node:fs`（`:4`） | **P7** | 范围 5 明确写出 |
| `ask.js:2` | `AskUserQuestion` | — | **P6/P7**【推断】 | 面向用户的交互，v2 已有审批通道但「自由提问」是另一件事；未读全文 |
| `agent.js:2` | `Agent` | — | **P7**（子 agent） | `dev-plan-v2.md:466` |
| `webfetch.js:40` | `WebFetch` | — | **P7**（网络）【推断】 | 未在「宿主访问」grep 中命中，故按 P7 的模块表归类 |
| `websearch.js:67` | `WebSearch` | — | **P7**（网络）【推断】 | 同上 |
| `taskoutput.js:4` | `TaskOutput` | — | **P7**（后台任务） | `dev-plan-v2.md:470` |
| `taskstop.js:2` | `TaskStop` | — | **P7**（后台任务） | 同上 |
| `tasktools.js:33/106/145/278` | `TaskCreate` / `TaskGet` / `TaskUpdate` / `TaskList` | — | **P7**（后台任务） | 同上 |
| `planmode.js:9/44` | `EnterPlanMode` / `ExitPlanMode` | `node:fs`（`:6`） | **P7**（plan 模式） | ADR-032 已记该功能的既有缺口与约束 |
| `cron.js:187/249/271/293` | `CronCreate` / `CronDelete` / `CronList` / `ScheduleWakeup` | `node:fs`（`:7`） | **P7**（cron） | `dev-plan-v2.md:472` |
| `mcpresources.js:12/51/100/140` | `ListMcpResources` / `ReadMcpResource` / `SubscribeMcpResource` / `UnsubscribeMcpResource` | — | **P7**（MCP） | `dev-plan-v2.md:467` |
| `bin/cowcat.mjs:501-569` | **`mcp__<server>__<tool>`（动态）** | 经 MCP 客户端 | **P7**（MCP） | 官方 SDK 评估 + stdio 必须经 ProcessPort |

**P5 之外一律有归属**（P6 两个、P7 其余），无需「无记录缺失」。**P5 唯一被砍的是 Read 的三个分支**（图像/PDF/notebook），归属 P7 并注明**契约缺附件通路**是它真正的阻塞点。

---

## 14. P5 任务拆分（草案；2026-10-18 的三处裁定已并入）

> **这一节的效力**：它是**方案**，不是承诺。按工作规则 3（契约先于实现）与 P4 的先例（PR #36：`docs(p4): T6 决策落 ADR-045/046，并把 T6 拆成 T6a/b/c`），任务拆分随 **T0** 一起进 [`dev-plan-v2.md`](../dev-plan-v2.md) 的 `## P5` 段；在那之前权威计划仍以该文件现有的 P5 段为准。
>
> 三条贯穿全部任务的原则：① **一个 PR 一个任务**（分支名 `<type>/<topic>`，Conventional Commits 中文摘要）；② **契约先于实现**——`T1` 与 `T2` 是契约任务，它们落地之前**不写任何一个具体工具**；③ 每个任务的验收证据都要能被复跑（`npm test` / 探针 / 指定的手工命令），**"已完成"只指实际跑过**。

### 14.1 依赖关系

```
T0（ADR-047~052 + 计划落表，纯文档）
 └─ T1（契约与事件：截断事实 / canonical path / 审批载体）
     ├─ T2（工具定义 API + zod→wire schema 派生器）   ← 与 T1 可并行，但都要在 T3 之前
     │   ├─ T3a Glob + walk（.gitignore 子集）
     │   │   └─ T3b Grep（用 T3a 的 walk）
     │   ├─ T3c Read（文本 + CRLF 事实；图像/PDF/notebook 明确拒绝并指向 P7）
     │   ├─ T4  Write + Edit（消费 T1 的已读派生，含出口标准点名的边界用例）
     │   ├─ T5  Bash 薄壳（消费 T1 的审批载体 + profile 解析）
     │   └─ T6  TodoWrite（先定「状态存哪」的小 ADR）
     └─ T7（出口标准：契约测试 + 端到端 + v1 清单对照收口）
```

顺序理由（每条都是为了不返工）：**T3a 先于 T3b** 是因为 Grep 复用 Glob 的 walk，而 walk 的 `.gitignore` 语义是本阶段唯一有实现风险的一块，先把它单独做完并测透；**T3c 先于 T4** 是因为「先读后改」闸门要有 Read 才有可派生的输入；**T5 押到文件工具之后** 是因为它是唯一一个跨到进程/沙箱/审批三条既有契约的任务，先让纯文件工具把 `ToolPort` 的形状压实。

### 14.2 任务表

| 任务 | 内容 | 依赖 | 验收证据 | 状态 |
|---|---|---|---|---|
| **T0** | **决定落表**（纯文档）：本文件 §11 的六条落成 **ADR-047~052**（**可直接贴的条目文本已备在 §15**，落表即贴）；把 `## P5` 段补上本节的拆分表；三处架构文档的待改点（`01-layers` 的 `adapters` 职责、`02-kernel` 的「为什么不能简单并发」、`03` 的端口表）写进对应任务的「同 PR 改文档」项 | **六条已全部评审通过（2026-10-18）** | ADR 表链接可点、`docs/` 与其它无代码改动冲突；六条按 §15 的终稿落表 | ✅ 本 PR |
| **T1** | **契约与事件**（ADR-048/049/051）：`ToolResult` 增 `truncation`；`tool.finished` 增 `truncation`（可空）与 **canonical `path`**（可空，`null` = 未上报，与 `facts` 同形）；**按 §8.3 的裁定**给 `ToolPort.run` 增**第三参数**（只描述本次授予，例如 `{ networkApproved: boolean }`）。连带改 `adapters/schema.ts` 的解码边界、编译期等价断言、`state.ts` 的 switch 穷尽性与 `reduce`（**新增：从 `tool.finished` 派生「本会话已读文件」集合**）、`test/support.ts` 的 `tool()` 替身（第三参数随之加，默认形态不改变既有实现的行为）。**不动任何具体工具**；同 PR 改 `02-kernel.md`（并发理由） | T0 | 三处编译期硬失败按预期出现再被补齐；现有 `replaying the log reproduces the live session state exactly` 仍绿；新增：截断事实与 `path` 过 JSONL 往返、**恢复会话后「已读集合」与实时一致**、`path` 缺失时旧日志仍能解码（`null` 语义）、第三参数不破坏既有 `ToolPort` 实现与替身；测试数按实际记录（不预设） | 未开始 |
| **T2** | **工具定义 API 与 wire schema 派生器**（ADR-047/052）：`adapters/tools/schema.ts` 一个入口产出 wire JSON Schema（`z.toJSONSchema({ io:'input', target })` + **剥 `$schema`** + target 常量化）；被禁词汇（联合 / nullable / record / literal）的**执行点**；`defineTool()` 帮助函数（zod 校验 → `ok: false` + 字段级原因，**不抛**；声明 `risk` / `pathInput` / `commandInput`）。可跑一个 §3.5 的探针工具用于 P6 校准。同 PR 改 `01-layers.md`（`adapters` 加「工具实现」） | T0（可与 T1 并行） | 单元测试：可选/默认/枚举/嵌套数组的 wire 形状；`$schema` 被剥；**被禁词汇触发明确错误**；校验失败返回结构化原因且不抛；`inputSchema` 能在 `ModelRequest.tools` 里被断言（`ScriptedModel.requests`）；`tools/p5-json-schema-probe.mjs` 仍 31/31 | 未开始 |
| **T3a** | **Glob + 文件遍历**（ADR-050）：`walkFiles` 等价物 + **`.gitignore` 语义子集**（`pattern` / `dir/` / `/anchored` / `*` / `**` / `!negation`；**不支持**嵌套 `.gitignore`、全局 excludes、`core.excludesFile`，并按 ADR-016/021 的口径把限制**上报**）；保留 `node_modules` 等硬跳过；`globToRegExp`；100 命中上限 + **结构化截断事实**（T1 的字段） | T2 | 单元测试：模式与跳过语义逐条；限制项被上报；上限与尾注并存；**与 `rg --files` 的文件数对比**（§5.5 第 1 项，两棵树）作为证据写进 PR | 未开始 |
| **T3b** | **Grep**：三种模式（`content` / `files_with_matches` / `count`）、`-i` / `-B` / `-A` / `-C` / `multiline` / `type` / `glob`、单文件 1MB 与二进制跳过、250 行上限、**`files_with_matches` 与 `count` 达到 `head_limit` 时早退**（§5.2 第 3 条）、结构化截断事实 | T3a | 单元测试：三种模式 × 上下文参数；**早退有测试证明不是「读完了才截」**（计时或读取计数）；非法正则、未知 `type`、超大文件的报告；`tools/p5-glob-grep-probe.mjs` 仍 7/7 | 未开始 |
| **T3c** | **Read（文本部分）**：分页（2000 行）、5MB/20MB 两级、行号前缀、**CRLF 作为可判定事实告知**（§6.2）、目录/缺失/二进制/图像的**拒绝文案**；图像 / PDF / notebook 三个分支**不实现**，但**显式拒绝并指向 P7**（不是静默当文本读） | T2 | 单元测试：分页与边界行号；CRLF 与 LF 各一条；超限两级；拒绝文案覆盖二进制/图像/`.ipynb`；**「拒绝」有测试**，防止将来半实现 | 未开始 |
| **T4** | **Write 与 Edit**（ADR-049 的消费方）：五条替换规则照旧（§6.1）；**拒绝空 `old_string`**（§6.4）；Write 的「已存在必须先读」；**「先读后改」消费 T1 派生的集合**（恢复会话后依然成立）；Edit 的「找不到」报错把 **CRLF** 列为最可能原因。**出口标准点名的边界用例在同一 PR**（多处匹配、空匹配、CRLF、`replace_all`） | T1、T2、T3c | 单元测试逐条；**恢复会话后「未读就改」必须仍被拒绝**（这条是 ADR-049 的存在理由）；`old_string === new_string`、空串、0 次/1 次/N 次命中 | 未开始 |
| **T5** | **Bash 薄壳**：`command` → argv（经 `PlatformPort` 的 shell 解析，**不经 shell:true**）；`ProcessSpec` 组装（cwd / env / `timeoutMs` 前台 60s 上限 600s / `outputCap` / `SandboxProfile`）；调 `ProcessPort.run`；`ExecutionFacts` **原样回填** `facts`；退出码非零**不是**失败；`run_in_background` **显式拒绝并说明**（属 P7）；消费 T1 的审批上下文（`network: 'ask'` 不得静默当 `off`）。含 `SandboxProfile` 的**配置键与纯解析函数**（§8.2；组合根装配仍在 P6） | T1、T2、T0 里的 profile 决策 | 测试用**真 `NodeProcess`**（`test/**` 允许真实进程）：退出码 / stderr / 超时 / 取消 / 截断事实 / facts 回填；`run_in_background` 被拒绝；`ask` 档在未授予时**明确拒绝**而不是静默降级 | 未开始 |
| **T6** | **TodoWrite**：全量替换语义、`pending`/`in_progress`/`completed` 校验；**「状态存哪」先落一个小 ADR**（会话日志内 vs 外部文件 vs 纯事件） | T2 + 小 ADR | 单元测试：全量替换、非法状态、会话内可见；存储位置的决定与实现一致 | 未开始（**阻塞于 §12 第 5 项**） |
| **T7** | **出口标准与收口**：① **七个工具的统一契约测试**（核心六件 + TodoWrite；同一套断言逐个跑：声明 → wire schema 正确；校验失败不抛；截断事实上报；`risk` / `pathInput` / `commandInput` 与策略连通）；② Edit 边界用例全绿（出口标准第 1 条）；③ **v1 清单对照记录**（本文件 §13 直接引用，逐条给出「P5 / P7」与理由，出口标准第 2 条）；④ **端到端**：脚本化模型 + 真 `ProcessPort` + 真文件工具跑通一个「读→改→跑命令→审批→截断」的回合。同 PR 更新 `03-policy-and-execution.md` 的端口表 | T3a–T6 | 出口标准两条逐条对应到测试名；端到端一条在 Windows 与 CI Linux 上各跑过（**未跑过的标未验证**） | 未开始 |

### 14.3 范围边界（每个任务「不做什么」，防越界）

- **T1**：不加任何工具，不改 `decide`，不碰审批流程（审批只是**消费**新的上下文参数）。
- **T2**：不做具体工具的语义；`defineTool` 只提供「声明 + 校验 + wire 形态」三件事。
- **T3a/T3b**：不改文件；不引入 ripgrep（§5.4）；`.gitignore` 的实现范围**只做 §5.4 第 4 条列的那六种**。
- **T3c**：不碰图像 / PDF / notebook（v2 契约里没有附件通路，属 P7 的契约工作，§10 范围 5）。
- **T4**：不做自动换行规范化（§6.2 明确要字节精确）。
- **T5**：不做后台任务、不做私有临时目录的手工编排（那是 P2 已落地的沙箱执行器）、不在工具里读配置分层。
- **T6**：不做跨会话的任务清单、不做与后台任务的联动。
- **T7**：不新增工具（只补测试与文档）。

### 14.4 与 P5 出口标准的对应

| 出口标准（`dev-plan-v2.md:429-432`） | 由谁交付 |
|---|---|
| 核心六个工具的契约测试通过（读/写/改/Glob/Grep/Bash，加 TodoWrite 共七件） | T3a/T3b/T3c/T4/T5/T6 各自的单元测试 + **T7 的统一契约测试** |
| Edit 的边界用例（多处匹配、空匹配、CRLF）全部覆盖 | **T4**（同 PR），T7 复核 |
| 与旧版工具清单对照，缺失项都有明确的「推迟到 P7」记录 | **本文件 §13**（已备好），T7 收口时直接引用 |

## 15. T0 正文草案：ADR-047~052 的完整条目

> 用法：评审通过后**原样贴进** [`architecture/README.md`](../architecture/README.md) 的 ADR 表（表头是 `| 编号 | 决策 | 状态 |`），编号与 §11 一致。**本文件不据此改 ADR 表**（工作规则：调研 PR 不改 ADR）。每条都自带证据与行号，读 ADR 表的人不需要打开本文件；需要展开的推理在 §2–§9。
>
> **评审定稿（2026-10-18）：六条全部通过**，状态列一律写「已决定（P5 调研，评审通过）」。其中三处曾列为本文件待评审项，裁定已并入正文：**ADR-049** 取「由日志派生」（§6.3 的 A，事件形状改动已被接受）；**ADR-051** 取「给 `ToolPort.run` 加第三参数」（§8.3 的 A），降级方案不再需要；两个探针脚本随本调研 PR 留下（§11 注）。
>
> 若评审要求把某条拆开或合并，**编号要连着 §11、§14 一起改**，不要只改一处。

### ADR-047

```
| ADR-047 | **核心工具的实现住 `src/adapters/tools/`，且不给分层禁令开第二个例外**（lint 事实：`eslint.config.js:67-68` 把 `node:child_process` / `node:fs` / `node:os` 的禁令施加于 `src/**/*.ts` 却 `ignores` 了 `adapters`/`kernel`/`policy`/`ports`，所以新建 `src/tools/` 会让 Read/Write/Glob/Grep 连 `node:fs` 都 import 不了）。**否决**三条替代：给 lint 开第二个例外（规则的价值在于没有例外，且已被 `tools/lint-probe.mjs` 钉住）；把 `FsPort` 扩成完整文件系统端口（它今天只有 `canonical`/`samePath`/`kindOf`/`exists` 四个方法 `ports/fs.ts:30-46`，而 ADR-017 把它的职责定为**路径身份**——文件读写不是身份问题）；归入 `modules` 层（`01-layers.md:13` 对 modules 的定义是「以能力形式注册，**不被内核认识**」，而核心工具必须被内核认识：`ToolSpec` 要发给模型、`risk` 要参与裁决）。**工具定义的单一来源是 zod，wire 形态机械派生**：`z.toJSONSchema(schema, { io: 'input', target })` 在一处产出、两个协议共用（适配器只读 `spec.inputSchema`，`model-openai.ts:272-284`）；**剥掉 `$schema`**（纯元数据、对模型无用、是唯一「可能被厂商侧校验器拒绝却毫无收益」的键）；**用 `io: 'input'`**（模型提供的是入参；实测下带 `.default()` 的字段因此正确地变成可省，而 output 模式下它仍进 `required`）。**厂商侧接受度零实测，所以决定的是机制而不是那一个值**：【实测】四种 target 产出**形状不同**——联合与 nullable 在 draft-2020-12 下是 `"type": ["string","number"]`、在 `openapi-3.0` 下才是 `anyOf` + `nullable`，`draft-04` 丢 `propertyNames` 且 `literal` 退成 `enum`；因此工具 schema 的**编写约定**禁用四类词汇：联合 / nullable、`z.record`、`z.literal`、`z.date()` 一族（后者本就抛错）。**约定优于事后转换**：四条约定能被测试立刻发现违反，转换却要覆盖 4×N 的差异矩阵。**否决** `unrepresentable: 'any'`（它把「写了一个模型收不到的类型」静默变成「接受任意值」，与 ADR-044 的「不发明策略」相反）。`target` 与「是否剥 `$schema`」是**一处常量**，厂商实测的校准在 P6 组合根第一次真连端点时做（`research/p5-tools.md` §3.5） | 已决定（P5 调研，评审通过） |
```

### ADR-048

```
| ADR-048 | **输出截断是结构化事实，且随 `tool.finished` 进日志**。① `ToolResult` 增 `truncation`（`truncated` / `dropped` / 原因），**算术沿用已有的一处实现**：`ProcessPort` 的 `truncated` + `dropped {stdout, stderr}`（`ports/process.ts:160-167`）与 `OutputTail` 的「`dropped` 永远是 `total - kept`——两个计数器早晚互相矛盾」（`adapters/output-tail.ts:40-42`）。② `tool.finished` 增 `truncation`，**可空而非可选**、`null` = 工具未上报，与 `facts` 完全同形（`events.ts:84-89`）——「只给了 2000 行」与「这个工具不截断」是两件不同的事实。加字段会连带触发三处编译期硬失败（`adapters/schema.ts` 的 `discriminatedUnion`、`state.ts` 的 switch 穷尽性、编译期等价断言），按 ADR-031/041 的先例**这是特性而不是障碍**；v2 日志从未发布，**不升 `schemaVersion`**（ADR-019）。③ `output` 里的人可读尾注**照旧保留**（Read 的 `[showing lines a-b of N]`、Glob 的 `[N match(es), truncated to first 100]`）：同一事实、两个读者、两种渲染，`p2-ports.md` §2.3 已为进程输出定过同样的口径。**否决**三条：只写尾注（审计只能正则解析散文，而 `tool.finished.output` 是唯一通路 `run-turn.ts:97-107`）；把 `facts` 放宽成 `Record<string, unknown>`（把一个有名字、可被审计逐条解释的契约变成杂物袋）；新增 `tool.truncated` 事件（截断是**同一份结果的属性**，不是独立到达的事实——与 ADR-041 让用量单独立事件的理由正好相反） | 已决定（P5 调研，评审通过） |
```

### ADR-049

```
| ADR-049 | **`tool.finished` 带 canonical `path`，「先读后改」闸门由日志派生**。`tool.finished` 增 **`path`（可空，`null` = 未上报）**，由 `run-turn.ts` 在构造 `ActionRequest` 的同一处产出（该处的 path **已经过 `FsPort.canonical`**，ADR-017/ADR-027）；`reduce` 由此维护「本会话已读文件」集合——Read 成功即登记，Write 的「已存在必须先读」与 Edit 的「读过才允许改」（旧版语义见 `agent/src/tools/write.js:24-26`、`agent/src/tools/edit.js:30-32`）消费它。**为什么必须进日志**：旧版把闸门放在内存（`agent/src/init.js:12` 的 `ctx.readSet`），而 v2 的性质是「回放必须与实时状态逐字段相等」（`02-kernel.md:6`）——内存集合会让**恢复会话后闸门静默失效**，同一条「不许盲改」的规则在新会话里悄悄消失。理由与 ADR-033 让 `facts` 进日志同源：**重构不出来的事实必须进日志**。**顺带**给审计一个路径抓手（ADR-033 的审计行今天只能靠工具名与入参）。**否决**：内存集合（零契约改动，但恢复后闸门失效）；新增 `read.file` 事件（同一事实两个家，`reduce` 还得处理二者矛盾）。代价与 ADR-048 同：三处编译期硬失败。**评审已裁定取本方案（2026-10-18）**：改事件形状的代价被接受，B 被否决 | 已决定（P5 调研，评审通过） |
```

### ADR-050

```
| ADR-050 | **Glob/Grep 保持纯 JS，但必须尊重 `.gitignore` 并支持早退；ripgrep 只作 P7 的可选后端**。【实测】本次在三棵树上量过（`tools/p5-glob-grep-probe.mjs`，7/7 结构性断言）：`cowcat`（634 文件）与 `ClaudeCode_dev`（740 文件）下「走 + 读 + 逐行正则」是**百毫秒级**（warm 时 740 文件 161ms），**算法不是瓶颈**；真正的成本是**访问了不该访问的树**——本仓 walk 到 634 个文件而 `rg --files` 只有 359，父目录 `AIProjects` 上纯 JS walk 访问 **414,839** 条路径（11.0s）而 `rg --files` 只列 3,181。旧版的硬跳过只有四个目录名（`agent/src/tools/glob.js:6`），完全不看 `.gitignore`。因此：① walk **尊重 `.gitignore` 语义子集**（`pattern` / `dir/` / `/anchored` / `*` / `**` / `!negation`），**不支持**嵌套 `.gitignore`、全局 excludes、`core.excludesFile`，且**限制必须上报**（ADR-016/021 的口径：说不出来的限制不能静默消失）；② **`files_with_matches` / `count` 达到 `head_limit` 即停**——旧版只在 `count`/`content` 里有 `break outer`，`files_with_matches` 分支只有 `continue`（`agent/src/tools/grep.js:139` 对比 `:119`/`:142`），于是要 5 个文件名也要整树读完，而它恰好是默认模式；③ **不引入 ripgrep**：它是外部可执行文件、按 ADR-014 必须经 `ProcessPort`，于是又多一条「探测-真跑-分类失败」的平台分支（ADR-018 为 shell 已经付过一次这个成本），本机 92ms 与 11s 的对比**口径不同**（rg 跳过隐藏目录与 ignore 目录），且 ADR-005 的依赖准绳是「是否承担协议或安全责任」——加速不是。**否决**只修早退不修 `.gitignore`（解决不了主因）、为一个文件格式引入第三方 glob 库（那三条语义边界必须是显式决定，不能顺手实现） | 已决定（P5 调研，评审通过） |
```

### ADR-051

```
| ADR-051 | **审批结果必须有载体：`ToolPort.run` 增加一个只描述「本次授予」的上下文参数**。缺口是两条事实对不上文案：`adapters/sandbox/executor.ts:157` 已经对用户承诺 `network: 'ask'`「grants it per approved command」，而 `ToolPort.run(input, signal)` 只有两个参数（`ports/index.ts:61`）、`runCall` 也只传两个（`run-turn.ts:377`），裁决只落在日志与 `session.state.grants` 里——**工具读不到**。于是今天在 `ask` 档上 Bash 只能把它当 `off` 用，同时对用户说它会在批准后生效：**一句实现不了的承诺**，正是 ADR-016 那条纪律要防的形态。决定：给 `ToolPort.run` 增加第三个参数，**只携带「本次调用被授予了什么」**（例如 `{ networkApproved: boolean }`），**不带规则、不带意见、不带策略**——方向与 `ToolResult.facts` 一致：内核把「做了什么决定」交给执行方，执行方把「实际做了什么」交回来。**不得把 `ask` 静默当 `off`**。「`ask` 档一律显式拒绝并说明」曾是过渡备选，2026-10-18 裁定**因端口改动被接受而不再需要**——但它依据的底线（拒绝要说明、不得无声降级）保留为一般纪律。**否决**：组合根在调用前解析 profile（裁决发生在 `runTurn` 内部且逐调用，组合根在调用之前不知道结果——除非把 `ask` 写死成 `off`，那就是降级）；让工具自己发起网络授权（等于把审批从内核搬进工具，推翻 ADR-031/032 的整条链）。**评审已裁定取本方案（2026-10-18）**：加一个只描述「本次授予」的第三参数，降级方案不再需要；**「不得默默当 `off`」这条纪律不随之撤销** | 已决定（P5 调研，评审通过） |
```

### ADR-052

```
| ADR-052 | **工具入参校验在工具内，用同一份 zod schema**：`safeParse(input)` 成功则把 `parse` 的结果交给实现（实现拿到**已校验的类型**，不必再断言），失败返回 `ok: false` 且 `output` 里给出**字段路径与原因**。理由：① 只有一份 schema（ADR-047 的单一来源）；② 内核与 `runTurn` 不新增校验分支、`tool.finished` 形状不变（`run-turn.ts:376-381` 已保证工具抛出会变成 `ok: false`，但抛出会丢掉「哪个字段错了」的结构）；③ 「模型发出的参数不是事实」落在**工具**这一层最自然——它是唯一知道入参语义的地方。**否决**在 `runTurn` 里按 `ToolSpec.inputSchema` 再校验一遍：内核禁止 import zod（`eslint.config.js:36-38`，ADR-009），那等于把一份 JSON Schema 校验器在错误的层重写。旧版对照：`agent/src/tools/registry.js:29-34` 的调用前校验要求每个工具**手写第二份 `input_schema`**（`:37-79` 的简化子集：`type`/`required`/`properties`/`items`/`enum`/`minItems`），正是本阶段要消灭的双份定义 | 已决定（P5 调研，评审通过） |
```

### 落表时的写法约定

- **状态列**：六条在工作落地前一律写「已决定（P5 调研，评审通过）」（2026-10-18 定稿，与 ADR-038 的形状一致）；每条实现完成后按 P4 的写法补成「**已落地（P5 Tx）**」，并在该条末尾加一句指向本文件对应小节。
- **顺序**：按编号追加在表尾（当前表尾是 ADR-046），不打乱既有行。
- **T0 的其余交付**（与 ADR 表同 PR）：`## P5` 段补上 §14.2 的任务表；把 §14.3 的「不做什么」并入各任务的描述；把三处架构文档的待改点登记到对应任务的「同 PR 改文档」项（`01-layers` 随 T2、`02-kernel` 随 T1、`03` 端口表随 T7）。

## 附录 A：本次实测脚本与用例

| 脚本 | 覆盖 | 本次结果 |
|---|---|---|
| `tools/p5-json-schema-probe.mjs` | zod → JSON Schema 的 31 个断言：`$schema`、对象闭合、required 与 optional、enum、`const`、联合（type 数组 vs openapi 的 `anyOf`）、nullable、判别联合 `oneOf`、record 的 `propertyNames`、`$ref`/内联/递归、不可表达类型抛错、`unrepresentable:'any'`、`io:'input'` 的 required/additionalProperties 差异、description 通路 | **31/31 通过**（zod 4.6.7） |
| `tools/p5-glob-grep-probe.mjs` | walk 的跳过行为（不进 `node_modules`、**进 `dist/`**）、Glob 的 MAX_RESULTS 与总计行、`globToRegExp` 成本、Grep 两种模式的冷/热计时、`head_limit` 不早退、与 `rg --files` 的文件数对比 | **7/7 通过**（3 棵树；计时为测量值） |

两者都是开发期脚本：不进 lint 门禁、不进发布包（`AGENTS.md`；`tools/check-tarball.mjs` 是发布守卫）。

跑法：

```bash
node tools/p5-json-schema-probe.mjs
node tools/p5-glob-grep-probe.mjs                      # 默认测本仓
node tools/p5-glob-grep-probe.mjs "F:\WorkSpace\AIProjects"
```

## 附录 B：v1 证据索引（本文件引用到的行）

| 文件:行 | 内容 |
|---|---|
| `agent/src/tools/read.js:18-21, 79-96` | 2000 行 / 5MB / 20MB 上限与分页尾注 |
| `agent/src/tools/read.js:8, 56-77` | 读文件、字节嗅探、二进制与 notebook 分支 |
| `agent/src/tools/edit.js:27-49` | 五条替换规则与写入 |
| `agent/src/tools/write.js:21-31` | 先读后写、创建父目录 |
| `agent/src/tools/glob.js:5-6, 51-68, 87-103` | MAX_RESULTS、四个硬跳过目录、walk 与过滤 |
| `agent/src/tools/grep.js:6-7, 100-164` | 1MB 单文件上限、250 行上限、`files_with_matches` 无早退 |
| `agent/src/tools/bash.js:16-20, 50-198` | 超时常量、沙箱编排、`maxBuffer: 10MB`、后台分支 |
| `agent/src/tools/todo.js:9-24, 54-66` | todo 文件位置与全量替换语义 |
| `agent/src/tools/registry.js:29-34, 37-79` | 调用前的简化 JSON Schema 校验 |
| `agent/src/init.js:12`、`agent/src/subagent.js:71` | `readSet` 的两个创建点 |

## 附录 C：上游出处

- **C-1** zod 官方文档 `z.toJSONSchema()` 的 `ToJSONSchemaParams`（`target` / `metadata` / `unrepresentable` / `cycles` / `reused` / `uri` 的默认值与取值）：<https://zod.dev/json-schema>（经 Context7 `/websites/zod_dev` 检索）
- **C-2** 同一页：`io: 'input'` 时不设置 `additionalProperties`；`z.looseObject()` / `z.strictObject()` 的差异
- **C-3** 同一页：**不可表达类型清单**与 `unrepresentable: 'any'` 的行为（含 `.default()` 值的处理）

**上游仍缺**：OpenAI 与 Anthropic 各自对 `parameters` / `input_schema` 的关键字支持范围。本轮**未取得**可引用的一手出处（无端点、未检索对应文档库），故 §3.5 的四条全部是【推断】。
