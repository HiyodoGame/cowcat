# 04 依赖策略

## 原则

旧版的隐含目标是「零运行时依赖」。这个目标在个人工具时期合理，但作为长期分发的 npm 产品，它把协议实现、安全相关代码、解析器的维护责任全部压到了自己身上。例如旧版手写了 Anthropic 与 OpenAI 的 SSE 解析、MCP 客户端（`mcp.js` 758 行）、PDF 解析（`pdfobj.js` / `pdfcmap.js` / `pdftext.js` 共 683 行）。

v2 的判断标准不是「依赖多少」，而是下面四个问题：

1. **它承担的是协议还是安全责任？** 是，则优先采用官方维护的库：协议会变，手写的实现会悄悄过期。
2. **它是纯工具函数吗？** 是，则自己写（几十行的东西不值得一个依赖）。
3. **它能否被端口隔离？** 能，则依赖只出现在适配器里，替换成本可控。
4. **它是否有跨平台的分发负担？** 有（原生二进制、需要编译的插件），则除非不可替代，否则避免。

运行时依赖的上限：**不超过 6 个**，每一个都必须有 ADR。开发依赖不设上限，但必须进 CI。

## 已安装的依赖（已核对版本）

| 包 | 版本 | 角色 | 选择依据 |
|---|---|---|---|
| `typescript` | 6.0.3 | 开发：编译与类型检查 | **P1 结论：不迁移**（调研 §4）。TS 7.0.2 的编译器本身可用——用本仓库原样的 `tsconfig.json` 编译通过并跑通全部测试，tsconfig 也已经是 TS 7-ready；阻塞点是 typescript-eslint 的 peer 范围仍为 `>=4.8.4 <6.1.0`，且 TS 7.0 不提供编译器 API。**重估条件（三条同时满足）**：peer 范围包含 7.x；届时用本仓库跑通 `npm test`；迁移前先在 6.x 上打开 `stableTypeOrdering` 把行为差异暴露出来。另记：引入 zod 后本地 `tsc` 由约 0.63s 涨到约 1.8s（≈3×，单机测量），这让「本地 build 已经够快」这个前提变弱——见调研 §4.5 |
| `@types/node` | ^22 | 开发：类型 | 与最低运行时 Node 22 对齐，避免用到 22 没有的 API 却通过了类型检查 |
| `eslint` | 10.13.0 | 开发：lint | 与仓库既有 lint 栈一致 |
| `typescript-eslint` | 8.71.2 | 开发：TS 规则 | 使用 `strictTypeChecked`；测试目录对 `no-floating-promises` 与 `require-await` 放宽（见 eslint.config.js 注释） |
| `zod` | `^4.6.7`（当前 4.6.7） | **运行时**：日志解码的结构校验 | 只允许出现在 `src/adapters/`，由 lint 单独一条 pattern 强制。JSON Schema 转换内置，省掉 P5 与模型交互的一个依赖。选型对比、被否决的方案与保留的重估条件见 [../research/p1-kernel.md](../research/p1-kernel.md) §2 |
| `fast-check` | `^4.10.2`（当前 4.10.2） | 开发：属性测试 | 用例见 `test/property.test.ts`。种子固定在测试里（`COWCAT_PROPERTY_SEED` 可覆盖），失败输出自带 `{ seed, path }` 与收缩后的 counterexample |

运行时依赖：**1 个**（`zod`）。上限 6，每引入一个都要有 ADR。

**P4 已定再引入 2 个直接依赖（ADR-036）**：`openai` 与 `@anthropic-ai/sdk`，届时直接依赖为 **3 个**。但 `@anthropic-ai/sdk` 自带传递依赖，**实测整棵树为 10 个包**（见上表 `@anthropic-ai/sdk` 与 `openai` 行）。所以「上限 6」的计量口径必须写明是**直接依赖**还是**整棵依赖树**——本表此前没说过，而两种口径给出相反的结论（3 未超限 / 10 超限）。**这条在 T1 之前要有定论**，否则「每个依赖都要有 ADR」这句在传递依赖上无从执行（传递依赖没有 ADR）。

**边界纪律**（ADR-009）：`zod` 只允许出现在 `src/adapters/`。日志解码是适配器的职责，内核／策略／端口三层必须只看到类型化的事件。这条由 lint 强制——`eslint.config.js` 里给 `zod` 单独加了一条 `no-restricted-imports` pattern，**不能**把它并进 `node:*` 那一组，否则报错文案会指向「运行时相关」这个错误的原因。

内核的事件联合类型与适配器的 schema 是同一个格式的两份手写描述，因此用**编译期等价断言**钉住（`test/schema.test.ts`）：两份一旦漂移就构建失败，而不是等到某天把内核自己写的日志报成「损坏」。

## 计划中的依赖（按阶段引入，引入时各写一条 ADR）

| 包 | 阶段 | 角色 | 当前判断 |
|---|---|---|---|
| `@anthropic-ai/sdk` 与 `openai` | P4 | 模型协议 | **已定采用（ADR-036）**。版本实测：`openai@7.36.0`（engines `node >=22.0.0`，与包一致；**零运行时依赖**，6 个 peer 全部 `optional: true` 故不自动安装）、`@anthropic-ai/sdk@0.135.0`。**依赖预算要重新算**：在仓库外隔离目录实测 `npm i zod@4.6.7 openai@7.36.0 @anthropic-ai/sdk@0.135.0` → **added 10 packages**（直接 3：zod/openai/sdk；传递 7：`standardwebhooks`→`fast-sha256`/`@stablelib/base64`、`json-schema-to-ts`→`@babel/runtime`/`ts-algebra`、`@opentelemetry/api`）。**「上限 6」到底数直接依赖还是数整棵树，本表此前没有说明，现在必须明确**——按整棵树算是 10（超限），按直接依赖是 3（未超限）。另需在 T1 核实这 7 个传递依赖里**哪些真在运行时被加载**（`json-schema-to-ts` 是类型层库、`@opentelemetry/api` 默认是空实现）。 |
| `@modelcontextprotocol/sdk` | P7 | MCP | 候选。协议层不手写。版本与 API 稳定性在 P7 核对 |

## 明确不引入的

| 候选 | 不引入的原因 |
|---|---|
| 捆绑 `ripgrep` 二进制 | 原生二进制的跨平台分发（Windows、macOS 签名、鸿蒙）成本高。P5 用纯 JS 遍历实现 Grep，ripgrep 只作为检测到时的可选加速 |
| `tree-kill` 等进程树库 | 进程树终止的平台逻辑很短（POSIX 进程组、Windows `taskkill /T`），且它是关键的安全路径，自己写并测试比依赖一个小众库更可控 |
| `vitest` / `jest` | `node:test` 已足够，且零依赖。若 P6 的前端测试确有需要再评估 |
| 打包器（esbuild / rollup） | 保持 tsc 直出，npm 包内是可读的 JS 与 source map，便于审计，也便于出问题时看堆栈 |

## TUI 的依赖选择（P6 前的 gate）

旧版 TUI 是自研的（`agent/src/tui/` 下 21 个文件、约 4700 行，含 wcwidth、Markdown、语法高亮、区域刷新）。是否继续自研、还是改用 ink 这类 React 终端渲染库，不在本轮决定。P6 开始前需要做一轮渲染性能与终端兼容的实测调研，并以 ADR 记录结论。

## 与「依赖最小化」的关系

ADR-005 的意思是：**依赖不是敌人，无人维护的手写协议才是**。v2 接受少量高质量依赖，换取更少的自研协议代码与更清晰的边界。每一个依赖都要能回答「替换它需要改哪些适配器」。
