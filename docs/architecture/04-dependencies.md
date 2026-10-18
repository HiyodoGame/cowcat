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
| `openai` | `^7.36.0`（当前 7.36.0） | **运行时**：OpenAI 兼容协议的模型适配器（ADR-036） | P4 T2 引入。engines `node >=22.0.0` 与包一致；**实测零运行时依赖**，6 个 peer 全部 `optional: true` 故不会自动安装。**`maxRetries: 0`**：ADR-039 的重试策略由适配器自己实现（T5），留着 SDK 自带的两次重试会让两条策略同时生效。边界同样由 lint 强制（`no-restricted-imports` 的第三条 pattern，与 zod 分开写是为了让报错指向「跨了端口边界」而不是别的理由），`tools/lint-probe.mjs` 已验证它会报错 |
| `fast-check` | `^4.10.2`（当前 4.10.2） | 开发：属性测试 | 用例见 `test/property.test.ts`。种子固定在测试里（`COWCAT_PROPERTY_SEED` 可覆盖），失败输出自带 `{ seed, path }` 与收缩后的 counterexample |

运行时依赖：**3 个**（`zod`、`openai`、`@anthropic-ai/sdk`）。上限 6，每引入一个都要有 ADR。

**口径已定（评审，2026-10-18）：数直接依赖。** 上限 **6 不变**——P4 之后为 **3 / 6**。理由：传递依赖不是我们的选择，「每一个都必须有 ADR」这句在传递依赖上无从执行；而判断标准 1（协议与安全责任）要求的是**引入方说明自己带进来了什么**，不是给每个传递依赖立一份 ADR。

**传递依赖已核实（P4 T3 履行了这条承诺）**：`@anthropic-ai/sdk` 的 7 个依赖树成员里，**4 个真的进运行时、3 个是纯类型层**（详见上表该行）。若将来有人改口径为「数整棵树」，这 3 个是可以争辩的余地——它们已被证明运行时零加载。**但注意**：依赖树实测为 **10 个包**，其中 **3 个**（`json-schema-to-ts`、`ts-algebra`、`@babel/runtime`）已证明运行时零加载，能否靠打包/裁剪把它们去掉不在本阶段的范围内。

但引入方**要登记**传递依赖并核实它们**是否真的进运行时**——这一条在 T3 装 `@anthropic-ai/sdk` 时落实，清单见上表 `@anthropic-ai/sdk` 行。**已知的可疑项**：`json-schema-to-ts` 是类型层库（运行时应为零负担）、`@opentelemetry/api` 默认是空实现门面。若 T1 实测发现某个传递依赖真的在运行时被加载且带分发负担，**按判断标准 4 重新评估，而不是当作没看见**。

**边界纪律**（ADR-009）：`zod` 只允许出现在 `src/adapters/`。日志解码是适配器的职责，内核／策略／端口三层必须只看到类型化的事件。这条由 lint 强制——`eslint.config.js` 里给 `zod` 单独加了一条 `no-restricted-imports` pattern，**不能**把它并进 `node:*` 那一组，否则报错文案会指向「运行时相关」这个错误的原因。

内核的事件联合类型与适配器的 schema 是同一个格式的两份手写描述，因此用**编译期等价断言**钉住（`test/schema.test.ts`）：两份一旦漂移就构建失败，而不是等到某天把内核自己写的日志报成「损坏」。

## 计划中的依赖（按阶段引入，引入时各写一条 ADR）

| 包 | 阶段 | 角色 | 当前判断 |
|---|---|---|---|
| `@anthropic-ai/sdk` | `^0.135.0`（当前 0.135.0） | **运行时**：Anthropic 原生协议的模型适配器（ADR-036） | P4 T3 引入。**它自带传递依赖，实测结论如下**（这是引入方必须说明「带进来了什么」）：依赖树里 7 个包，**只有 4 个真的进运行时**——`@opentelemetry/api`（9 个运行时文件引用，含 `client.js`；不注册 provider 时是空门面）、`standardwebhooks`（仅 `resources/beta/webhooks.js`，却**在 import 时就被解析**）、`fast-sha256` 与 `@stablelib/base64`（`standardwebhooks` 的下游）；**另外 3 个是纯类型层，运行时完全不加载**——`json-schema-to-ts`、`ts-algebra`、`@babel/runtime`（源码扫描零命中 + 解析钩子 in `not resolved`）。取证方法：`registerHooks` 解析钩子记录 import 时真正被解析的裸模块，并对运行时 `.js`（排除 `.d.ts`）做源码扫描。`maxRetries: 0`，理由同 `openai` |
| `@opentui/core` | P6（当前 0.6.6） | **运行时：仅前端包**（`packages/tui/`）：TUI 渲染（ADR-056） | **不进内核包的依赖计数**（内核仍是 3 / 6）。判断标准 4（跨平台分发负担）在此**显式豁免一次**：它带 8 个平台的原生核心（`@opentui/core-{win32,darwin,linux}-{x64,arm64}` + 两个 musl），并要求 `node >=26.4.0`——换掉的是整块渲染与图片协议的自研量。**锁版本**；`engines.node` 变化等于我们的门槛变化。平台二进制缺失时**显式报错**，不静默降级。**T1 实测（2026-10-19）**：`0.6.6` 可安装（12 个包 / 8 秒），`@opentui/core-win32-x64` 内含 `opentui.dll`（5.06 MB）；Node **26.12.0 不需要** `--experimental-ffi`（只在 stderr 打警告），而 **Node 24 上该 flag 是启动期硬错误**——门槛是真的。取证与结论见 [`06-frontend.md`](06-frontend.md) 的「T1 前提验证」一节 |
| `@modelcontextprotocol/sdk` | P7 | MCP | 候选。协议层不手写。版本与 API 稳定性在 P7 核对 |

## 明确不引入的

| 候选 | 不引入的原因 |
|---|---|
| 捆绑 `ripgrep` 二进制 | 原生二进制的跨平台分发（Windows、macOS 签名、鸿蒙）成本高。P5 用纯 JS 遍历实现 Grep，ripgrep 只作为检测到时的可选加速 |
| `tree-kill` 等进程树库 | 进程树终止的平台逻辑很短（POSIX 进程组、Windows `taskkill /T`），且它是关键的安全路径，自己写并测试比依赖一个小众库更可控 |
| `vitest` / `jest` | `node:test` 已足够，且零依赖。若 P6 的前端测试确有需要再评估 |
| 打包器（esbuild / rollup） | 保持 tsc 直出，npm 包内是可读的 JS 与 source map，便于审计，也便于出问题时看堆栈 |

## TUI 的依赖选择（P6，已定：ADR-056）

旧版 TUI 是自研的（`agent/src/tui/` 下 21 个文件，含 wcwidth、Markdown、语法高亮、区域刷新；其中 `ui.js` 一个文件 **82 KB**）。P6 调研比较了自研、ink 与 opentui，**结论是采纳 `@opentui/core`**（opencode 的渲染器：Zig 原生核心 + TS 绑定、flexbox、原生图片支持），代价被显式接受：

| 代价 | 处置 |
|---|---|
| `engines.node >=26.4.0`（实测 `@opentui/core@0.6.6`；Node v26.4.0 于 2026-06-24 发布） | **前端是独立 workspace 包**（`packages/tui/`），它声明自己的 `engines` 与一条 Node 26 的 CI 腿；**内核包保持 Node ≥ 22 不变**。**T1 实测**：26 线当前 v26.12.0 可用，且**无需** `--experimental-ffi` |
| 8 个平台的原生核心走 `optionalDependencies` | 缺失时**显式报错**，不静默降级到「没有 TUI」 |
| 一个更新频繁的原生库 | 锁版本；`engines.node` 的变化等于我们的门槛变化，升级前先在 CI 验证 Node 腿 |
| 与「零运行时依赖」的距离 | 判断标准 4（跨平台分发负担）**被显式豁免一次**，理由是它换掉的是整块渲染与图片协议的自研量；内核侧依赖数（3 / 6）**不受影响**，因为 opentui 只出现在前端包内 |

调研中同时核实的**不引入项**：`@opentui/react` / `@opentui/solid`（先用命令式 renderable，引入渲染器是第二个决定）；ink（与「事件流 → view model」的既有输入模型不匹配，且图片协议仍要自己写）。

## 与「依赖最小化」的关系

ADR-005 的意思是：**依赖不是敌人，无人维护的手写协议才是**。v2 接受少量高质量依赖，换取更少的自研协议代码与更清晰的边界。每一个依赖都要能回答「替换它需要改哪些适配器」。
