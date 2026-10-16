# P1 调研：内核加固与工程基线

> 依据 [dev-plan-v2.md](../dev-plan-v2.md)「工作规则 1」：每个阶段开始前先做调研，回答阶段内的开放问题，列出被否决的方案及理由。
> 本文件回答 P1 的三个开放问题，并给出它们对 P1 六项范围的具体影响。
> 最后更新：2026-10-17。状态：**调研完成，已评审修订（r2）**。

## 证据标注约定

每一条判断都标出它的来源，避免把推测当成结论（工作规则 6）：

- **【实测】** 本次在本机或 npm registry 上实际跑过，命令与结果见正文或附录
- **【上游】** 来自上游官方文档、发布说明或包元数据
- **【未验证】** 尚未实测，不得作为决策依据

本版（r2）撤销了 r1 的三条结论，撤销理由与原始实验保留在 §3.7「本节修订记录」——被推翻的实验连同它为什么被推翻一起留着，比删掉更有用。

---

## 0. 结论摘要

| 问题 | 结论 | 依据 |
|---|---|---|
| zod 4 / valibot / typebox 取舍 | 采用 **zod 4.6.7**，只出现在解码边界 | §2 |
| 单写者锁：`O_EXCL` 够不够、要不要 pid 存活检测 | `O_EXCL` 认领可靠；pid 存活检测用于**诊断与安全指引**；**恢复默认走显式动作，不做自动接管**——`unlink` 与 `rename` 两种自动接管原语都有构造性反例 | §3 |
| TypeScript 7 是否迁移 | **P1 不迁移**，锁定 6.x；阻塞点是 lint 工具链，不是编译器 | §4 |

三条纠正前提的发现：

1. **TS 7 的编译器本身可用**：用本仓库原样的 `tsconfig.json`，TS 7.0.2 编译通过并跑通全部 22 项测试【实测】。先前「7.x 兼容性未核实」的顾虑在编译器这一侧可以排除，卡住的是 typescript-eslint。
2. **锁要防的不是日志行被撕裂**，而是 `seq` 的读-改-写竞态。因此「append 是原子的」不能作为不加锁的理由（§3.1）。
3. **自动恢复无法做到无竞态**（本版最重要的修正）：附录 C 用构造出的交错时序证明，无论是「`unlink` 后重建」还是「`rename` 仲裁」，都会让两个进程同时认为自己持有锁。因此 P1 的默认恢复路径是显式动作（§3.3、§3.7）。

---

## 1. 验证环境

| 项 | 值 |
|---|---|
| 平台 | `win32`（Windows） |
| Node | `v24.18.0`（`npm 11.16.0`） |
| CI 门禁腿 | Node 22 · Linux（调研当时为 `ubuntu-latest`；2026-10-17 起因 Ubuntu 26.04 迁移钉到 `ubuntu-24.04`） |
| 仓库状态 | 实验基线 `main = 18cfd83`；本文件经 PR #27 合入。`docs/HANDOFF.md` 是本机交接件（从未入库，见其正文自述），引用它时请自行取其副本 |

**平台差异提示**：本次全部实验都在 Windows + Node 24 上完成，而 CI 门禁腿是 Node 22 · Linux。锁的行为是操作系统级的（`O_EXCL`、`unlink`、`rename`、pid 存活），Windows 的实测结论**不能直接迁移到 Linux**，§3.6 列为待验证项。

实验脚本（未入库，可复现；源码见附录）：

| 脚本 | 内容 | 附录 |
|---|---|---|
| `lock-probe.mjs` | 单进程原语：`wx` 重复创建、`kill(pid,0)`、持有中 `unlink`、`rename` 覆盖、并发 append | 附录 A |
| `lock-takeover-ab.mjs` | 统计式 A/B：屏障同步的 5 竞争者，自然时序与 200ms 陈旧窗口 | 附录 B |
| `lock-takeover-constructed.mjs` | **构造式反例**：强制「先判死 → 别人合法拿到锁 → 再执行动作」的交错 | 附录 C |
| `ts7probe/` | TS 7.0.2 编译 + 跑测试 | §4.2 |
| `ts7lintprobe/` | TS 7.0.2 与 typescript-eslint 共存 | §4.3 |

脚本位于 `%TEMP%\opencode\`。实现 PR 落地后由正式的锁测试取代。

---

## 2. 问题一：zod 4 / valibot / typebox 取舍

### 2.1 候选事实【实测】

版本、peer 依赖与近一周下载量均取自 npm registry（2026-10-17）；下载量区间 2026-10-06 ~ 10-12。

| 包 | 版本（`latest`） | peer 依赖 | 近一周下载 | 定位 |
|---|---|---|---|---|
| `zod` | 4.6.7 | 无 | 346,947,379 | 类型由 schema 推导；第一方 JSON Schema 转换内置 |
| `@sinclair/typebox` | 0.34.52 | 无 | 117,065,682 | JSON Schema 是原生表示（schema 字面量即 JSON Schema），类型由 schema 推导 |
| `valibot` | 1.5.0 | `typescript >=5` | 22,500,645 | 模块化 API，主打体积与 tree-shaking |

### 2.2 四个评判维度

dev-plan 明确了「bundle 体积无关紧要，关心类型推导质量与错误信息」，所以按下面四条评测。

**① 错误信息质量（P1 出口标准要求「定位到行号与字段」）**

- zod【上游】：`error.issues[]` 每项含 `path` / `code` / `expected` / `message`；另有 `z.prettifyError()` 直接给出带 `→ at username` 缩进的可读文本，`z.treeifyError()` 给出与 schema 同构的嵌套对象。
- valibot【上游】：`safeParse` 返回 `issues`，配 `v.flatten()` / `v.summarize()` / `v.getDotPath()`。
- 两者都能满足「行号 + 字段路径」。zod 的 `prettifyError` 开箱即可用于 CLI 展示，省一层自己的格式化代码。

**② JSON Schema 转换（P5 要用：工具入参 schema 要给模型）**

- zod【上游】：**内置** `z.toJSONSchema()`，默认输出 `additionalProperties: false`，并提供 `{ io: "input" }` 模式——对「模型传参」这个方向语义正确（转换/默认值不会被当成必填）。
- valibot【实测】：有**官方独立包** `@valibot/to-json-schema@1.8.0`（描述为 "The official JSON schema converter for Valibot"）。所以差异是「**内置 vs 多一个依赖**」，不是「有 vs 无」。
- typebox【上游】：JSON Schema 就是它的原生表示，这一项它最强。

**③ 类型推导方向**

- zod / valibot / typebox 三者都是 **schema 优先**：schema 是唯一真相源，类型由它推导（`z.infer` / `v.InferOutput` / `Static<>`）——「写一次，同时得到校验与类型」，正是 04-dependencies.md 里「避免类型与校验各写一份」想要的形态。
- 【未验证】：三者在**本仓库真实 schema 上**的推导质量与错误文本，没有做横向改写对比（见 §2.7）。

**④ 依赖与耦合**

- zod / typebox 无 peer 依赖；valibot 要求 `typescript >=5`（当前 6.x，不影响）。
- zod 是**运行时依赖**，占 04-dependencies.md「不超过 6 个」的额度之一，必须配 ADR。

### 2.3 决定：采用 zod 4.6.7

理由按证据强度排列（本节刻意不给「决定性差异」这类措辞——三条理由都没有强到那个程度）：

1. **JSON Schema 转换内置**，省掉 P5 与模型交互时的一个额外依赖；valibot 需要它的官方转换包，typebox 则反向偏重 JSON Schema 优先的 API 风格。
2. 错误信息满足 P1 出口标准，且 `path` 是数组，拼「行号 + 字段」是直白的。
3. 近一周下载量比 valibot 高一个数量级，出问题时可查到的先例更多。

三者的能力差异**小于 r1 的表述**：真正的分野是「用起来顺手」而非「能不能做到」。这个选择是合理的，但不是唯一正确答案；若将来 schema 数量大幅增长、或 JSON Schema 保真成为硬要求，应重估（§2.6）。

### 2.4 边界纪律（必须靠 lint 强制，否则会被违反）

04-dependencies.md 的立场是 zod「只用于边界：配置文件、模型响应、工具入参、日志解码」。但 01-layers.md 的 lint 规则**只拦 `node:*`**，拦不住 `import { z } from 'zod'`。如果不补规则，内核里迟早会出现 zod schema，边界就废了。

具体动作（P1 实现 PR）：

- `eslint.config.js` 里现有的 `no-restricted-imports` 是**单个 pattern**（`group: ['node:*', 'fs', ...]` + 一条 node 相关的 message）。**不能**往这个 group 里追加 `zod`——报错文案会变成 node 那条，指向错误的原因。
- 正确做法：**新增一个独立 pattern**，`group: ['zod', 'zod/*']`，配自己的 message（指向本决定与 ADR-009）。
- schema 落位：**`src/adapters/`**。日志解码是适配器的职责（04-dependencies.md:31 的立场），把 schema 放进 kernel 即便技术上可行也违反该立场。

### 2.5 类型漂移的防护

内核的 `KernelEvent` 是手写 TS 联合类型，适配器的 zod schema 是另一份。两份必然漂移，所以用**编译期等价断言**钉住：

```ts
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// 漂移即编译失败（test/ 里，不属于发布产物）
const _schemaMatchesKernel: Equals<z.infer<typeof kernelEventSchema>, KernelEvent> = true;
```

这条断言是「schema 校验通过的事件，一定是内核认识的事件」这一性质的静态保证；运行时性质由 P1 的属性测试覆盖。

### 2.6 被否决的方案

| 方案 | 否决理由 |
|---|---|
| valibot | 体积与 tree-shaking 的优势在 Node CLI 上无意义（dev-plan 已明说 bundle 无关紧要）；错误信息能力与 zod 相当；JSON Schema 需要多一个依赖。**保留重估条件**：schema 数量或 JSON Schema 保真需求上来时重估 |
| typebox | JSON Schema 优先的 API 风格会让 P1 日志解码与 P3 配置的写法偏离既有内核风格；生态体量约为 zod 的三分之一。**保留重估条件**：若工具 schema 成为核心且需要严格 JSON Schema 保真，重新评估 |
| `zod/mini` | 微优化，本场景无收益，徒增 API 差异 |
| 自研校验器 | 事件联合有 5+ 种形状、配置与工具入参还在后面。依赖判断标准 2 的前提是「几十行」，这里远超 |

### 2.7 待验证

- 三个候选在**本仓库真实 schema 上**的推导质量与错误文本对比（§2.2 ③）。
- zod 引入后对 `tsc` 编译耗时的影响（当前本地 build 是秒级，先记录基线再对比）。

---

## 3. 问题二：单写者锁

### 3.1 先纠偏：要防的是什么

02-kernel.md 的表述是「两个进程同时打开同一会话会互相覆盖序号」。对照代码，`Session.emit` 里：

```ts
seq: this.#state.lastSeq + 1,   // src/kernel/session.ts:49
```

`#state` 来自 `replay`。所以真实失败模式是 **`seq` 的读-改-写竞态**：

```
进程 A: replay -> lastSeq = N ┐
进程 B: replay -> lastSeq = N ┘  两者都写 N+1
```

**具体危害**（对照代码逐条列出，而不是笼统说「序号重复」）：

1. **回合被静默覆盖**。`Session.openTurn` 的守卫是「已有未终态 turn 就抛错」（`session.ts:67`），它读的是**自己那份** replay 状态。两个写入者各自 replay 到同一个状态、都认为上一回合已终态、都通过守卫、都 emit `turn.opened`；而 `reduce` 的 `turn.opened` 分支**不校验是否已有未终态 turn，直接覆盖**（`state.ts:26-33`）——第一个回合静默消失，两条 user 消息都留在 `messages` 里。
2. **合法操作被误判为日志损坏**。第二个写入者 emit 的 `turn.transitioned` 带着自己看到的 `from`，回放时与真实状态不符，`state.ts:38-40` 抛 `corrupt log`。也就是说：**一个写入者会把另一个写入者的正常操作变成「日志损坏」**。
3. **`lastSeq` 重复或乱序**。`reduce` 只是把 `event.seq` 赋给 `lastSeq`（`state.ts:24`），不校验单调性。

**一处需要纠正的 r1 说法**：r1 写「`seq` 是唯一可用来排序的字段」，这与代码不符——`replay` 是 `events.reduce`（`state.ts:58-59`），按数组的**物理顺序**归约，从不用 `seq` 排序。给定物理行序，回放是确定的。危害是上面三条，不是「回放不唯一」。

**关键推论：append 的原子性救不了它。** 即使每一行都完整落盘，上面三条依然发生。缠住临界区的是「replay → 计算 seq → append」这整段跨多次 IO 的过程，而不是单次 append。

### 3.2 实测

| # | 实验 | 结果 | 结论 | 附录 |
|---|---|---|---|---|
| A | 8 个进程同时 `open(lock,'wx')` 抢同一路径 | `CLAIMED=1` / `REFUSED=7` | `O_EXCL` 是可靠的跨进程**认领**原语 | A |
| B | `process.kill(pid, 0)` | 自身 `alive`；不存在的 pid → `ESRCH` | 存活检测可用；`EPERM` 必须当作「活着」 | A |
| C | 持有句柄期间 `unlink` 锁文件 | **`OK`**（Windows） | **不能用「文件存在」当持有判据**；持有判据只能是文件内容里的 pid | A |
| D | `.tmp` 写入后 `rename` 覆盖已存在文件 | `OK` | 只证明**单进程**的 rename 覆盖语义，**不能**证明并发互斥（r1 在此处过度解读） | A |
| E | `unlink` 一个已不存在的文件 | `ENOENT` | 清理动作必须容忍 | A |
| F | 6 个进程 × 150 次 ~2KB 并发 append | 900/900 行可解析，0 撕裂 | append 未见撕裂；但这与锁要防的东西无关（§3.1） | A |
| G | 统计式 A/B：5 竞争者、屏障同步、自然时序 | naive **0/6** 破裂、rename **0/6** 破裂 | 两种协议的破绽**无法靠自然调度复现** | B |
| H | 同 G，但把「判死 → 动作」强行拉开 200ms（模拟进程被调度出去） | naive 0/5、rename 0/5（另有一次同参数的早期运行抓到 rename `1/5`：`claims=2`，一个进程 `LOST`） | 是概率事件，**不可靠**，不足以支撑任何结论 | B |
| I | **构造式反例**：强制「先判死 → 另一个进程合法拿到锁 → 再执行动作」的交错 | naive `claims=2`、rename `claims=2`，**两者都破裂**，合法持有者报告 `STILL_HELD=false` | **两种自动接管原语对同一类交错都没有防御** | C |

实验 I 的时序是确定性的，两种协议输出完全相同：

```
ATTACKER_DECIDED stale=true | HOLDER_CLAIM true | ATTACKER_CLAIM true
  | HOLDER_STILL_HELD false | ATTACKER_STILL_HELD true
```

**结论：自动接管（无论 `unlink` 重建还是 `rename` 仲裁）无法保证互斥。** 这两条不是「一个对一个错」，而是同一个病：**基于一次读取做出的「陈旧」判断，在真正动手时可能已经过期**。`rename` 的原子性只保证「只有一个进程能移动这个路径」，不保证「移动的是你以为的那个文件」——它不校验内容（POSIX `rename` 同样如此，所以这不是 Windows 的问题）。G/H 说明自然调度下极难碰到；I 说明碰到就一定坏。

### 3.3 决定：协议

锁文件为 `<sessionId>.jsonl.lock`（与日志同目录），内容为 JSON：

```json
{ "pid": 58024, "nonce": "<随机>", "hostname": "<主机名>", "startedAt": "<进程启动时间>" }
```

协议七条：

1. **认领只经 `open(lock, 'wx')`**。这是唯一的原子仲裁点（实验 A）。
2. `EEXIST` → 读锁内容判 pid：`kill(pid, 0)` 成功或抛 `EPERM` → **活着** → 抛 `LockHeldError`（含 pid、锁路径、以及「确认无进程占用后可用 `--force-unlock`」的指引）。
3. `ESRCH` → **已死** → **默认不自动接管**：同样抛错，但错误信息说明持有者已死、提示 `--force-unlock`。理由见实验 I。
4. `--force-unlock` 是**显式且带审计**的动作：执行前**再**做一次 pid 存活检测，删除后写入审计记录（P3 落地前先记 stderr 与事件）。**严禁把它写成自动流程**。
5. **释放**：校验 nonce 后 `unlink`（容忍 `ENOENT`，实验 E）。进程崩溃留下的锁由第 2、3 条的报错路径暴露，而不是被静默接管。
6. `startedAt` 与 `hostname` **仅作诊断信息**，不参与判死决定（理由见 §3.6 的 pid 复用）。
7. **可选自动恢复（P1 不做，列为后续实测项）**：若要自动恢复，需满足 pid 已死 **且** 锁文件 mtime 超过阈值，并在动作后**校验自己搬走的文件 nonce 是否等于当初观察到的那一个**，不等则回滚。这条针对实验 I 的失败模式，但**不能宣称已解决**——校验与动作之间仍有窗口。两点实现约束：**删除被挪走的陈旧文件是独立的清理动作**（须容忍 `ENOENT`），不属于仲裁的一部分；接管方若在删除前崩溃会留下 `lock.stale.<nonce>` 残渣，需要一条「启动时清理本会话目录下的 `.stale.*` 且跳过仍被占用的」的清理规则，否则会随崩溃次数累积。

回答计划里的问题「`O_EXCL` 锁文件是否足够，是否需要 pid 存活检测」：

- `O_EXCL` 解决「谁先到」，**单独使用不够**：异常退出留下的锁没有任何机制会清理它。
- **需要 pid 存活检测，但它在这里的用途是「诊断与安全指引」，不是「自动接管」**。没有它，崩溃留下的锁与正在使用的锁无法区分，后续每次打开都只能笼统失败；有了它，才能给出「持有者已死，可用 `--force-unlock`」这种可执行的指引。

### 3.4 端口形态与必须一并修改的 API

`EventStore` **不改**，保持 `append` / `readAll` 两个方法；锁作为独立端口：

```ts
export interface SessionLock {
  release(): Promise<void>;
}

export interface LockPort {
  acquire(sessionId: string): Promise<SessionLock>;
}

// acquire 失败时抛出的错误，含诊断与指引所需字段
export class LockHeldError extends Error {
  readonly pid: number | null;
  readonly lockPath: string;
  readonly guidance: string;
}
```

- **由 `Session` 持有**：`SessionDeps` 增加 `lock: LockPort`，`Session.open` / `Session.create` 认领，新增 `Session.close()` 释放。
- **`LockHeldError` 的落位与传播**：定义在 `src/ports/index.ts`（与 `LockPort` 同处，端口同时声明操作与它的失败类型；该模块只含普通 TS，无 `node:*`）。传播路径固定为「适配器抛 → `Session.open` / `create` 不捕获、原样上抛 → 前端（P6）捕获后渲染 `guidance`」。端口层不提供「检查是否被锁」的查询方法，避免调用方绕开 `acquire` 做判断。
- 理由：「同一会话只有一个写入者」是 **Session 的不变量**，不是调用方的礼貌。交给组合根（P6 的 CLI）意味着不变量无人强制，一旦出现第二个调用点（TUI + headless 协议同时在线）就会破。
- **必须一并修改的 API（r1 漏了）**：`Session.create` 目前是**同步**方法（`session.ts:27`），要塞进 `Promise` 返回的 `acquire`，必须改成 `async`；连带 3 处同步调用点要加 `await`：`test/store.test.ts:18`、`test/turn.test.ts:30`、`test/turn.test.ts:188`。
- 测试替身：`support.ts` 加 `noopLock`（不检查，保持既有测试语义）与 `exclusiveLock`（进程内 `Map`，模拟 `EEXIST` 语义，供锁行为与 `LockHeldError` 的测试）。

被否决：把锁塞进 `JsonlEventStore` 内部。锁的生命周期是「会话存活的整段时间」，绑到 `append` / `readAll` 这类瞬时方法上无法表达；而且会强迫内存替身 `MemoryEventStore` 也实现锁语义。

### 3.5 被否决的锁方案

| 方案 | 否决理由 |
|---|---|
| `flock` / `fcntl` 咨询锁 | Node 不暴露 `flock`，需要原生模块 → 违反 04-dependencies.md「避免原生二进制的跨平台分发负担」 |
| `proper-lockfile` 4.1.2 | 它用 **`mkdir`**（而非 `O_EXCL`）做原子认领，靠 mtime 周期刷新判陈旧（默认 10s、下限 5s），被侵占时走 `onCompromised`（默认 `throw` → 进程退出）。它的 README **明确列出自己检测不到的两种情形**，第一种就是「锁文件被手工删除后别人立刻拿到锁」——恰好印证 §3.6 的风险。否决理由：① 它的模型是「超时即认为可接管」，与本文档「明确报错、由人决定」冲突；② 默认 throw 杀进程的策略我们不要；③ 约 80 行代码不值得一个运行时依赖（判断标准 2）。**保留的引用**：它直接论述了「`O_EXCL` 在 NFS 上破损」，可作为 §3.6 那句的出处 |
| `async-mutex` 0.5.0 | 进程内互斥，跨进程无效——正是本问题要防的场景 |
| 只依赖 append 原子性 / 只对 `append` 加锁 | 见 §3.1：防不住 `seq` 竞态与回合覆盖；且 `append` 级的锁覆盖不了「replay → 算 seq → append」这段临界区 |
| 超时判陈旧（不删锁文件） | 长回合（模型流式 + 工具执行 + 审批等待）可能合法地超过任何超时值，误判等于制造并发写入 |

### 3.6 残余风险与待验证

**残余风险**（P1 不消除，只明示）

- **误删活锁 → 静默双写**。实验 C 证明持有者**无法**用文件存在性保护自己；`--force-unlock` 或人工删除一旦作用在活锁上，持有者无感知，新进程 `open('wx')` 成功，两个写入者并存。`proper-lockfile` 的 README 也把这一类列为「检测不到」。对策：`--force-unlock` 必须先做存活检测，并在错误信息与文档中写明这一点。
- **pid 复用**。Node 没有 API 能查「他人进程的启动时间」（Windows 需原生 API，Linux 需读 `/proc/<pid>/stat`），而**同主机** pid 复用时 `hostname` 也没有区分力。因此 `startedAt` 降级为**诊断信息**，P1 **接受保守误拒绝**（报错 + 人工指引），不宣称防住 pid 复用。
- **网络 / 同步文件系统**。`O_EXCL` 在 NFS 上的语义不可靠（`proper-lockfile` README 有明确论述）。P1 立场：会话目录默认落本机磁盘，**不承诺网络卷安全**。

**待验证**

1. 在 Linux / macOS 上重跑实验 A、B、C、E、I。尤其 **I 必须在 POSIX 上确认同样成立**（推论是成立的：`rename` 在 POSIX 上原子但不做内容比较），以及实验 C 的 `unlink`-while-held 行为在 POSIX 上是否不同。
2. 会话目录位于 NFS / SMB / 同步盘时的行为。
3. 加锁后测试总数（出口标准要求「测试数增长」），含 `LockHeldError` 与 `exclusiveLock` 替身的测试。
4. 若将来要做 §3.3 第 7 条的可选自动恢复：mtime 阈值与 nonce 校验的实现与实测。

### 3.7 本节修订记录（r1 → r2）

保留被推翻的结论与推翻它的理由。

| 撤销 | r1 的结论 | 为什么撤销 |
|---|---|---|
| 1 | 「实验 B 证明幼稚的 `unlink` 后重建会删掉活锁」 | 原脚本（`lock-probe2.mjs`）的 child 在 takeover 模式下 `open('wx')` 之后**立即 `close()`，从不持有锁**，因此 `4/4 TOOK_OVER` 可以由「依次接管一个接一个已经退出的持有者」解释，`unlink` 删活锁这一环根本没被触及。改用 `claims` / `stillHeld` 度量（附录 B）后，该现象无法复现 |
| 2 | 「用 `rename` 做接管仲裁可解决上述问题」 | `rename` 不校验内容，移动的是**当时在那个路径上的任何文件**。附录 C 给出对 naive 与 rename **同样成立**的构造式反例。此缺陷与平台无关（POSIX `rename` 原子但不做 CAS） |
| 3 | 「`seq` 是唯一可用来排序的字段，序号重复导致回放不唯一」 | `replay` 按物理顺序 `reduce`，从不用 `seq` 排序（`state.ts:58-59`）。危害已按 §3.1 改写为「回合被静默覆盖 / 合法操作被误判为损坏 / `lastSeq` 乱序」 |

三条撤销都不改变「需要单写者锁」这个结论，改变的是**恢复路径的设计**（从「自动接管」改为「默认显式恢复」）。

---

## 4. 问题三：TypeScript 7 是否迁移

### 4.1 事实【实测 + 上游】

| 项 | 事实 |
|---|---|
| registry 版本 | `typescript` `latest=7.0.2`、`rc=7.0.1-rc`、`next=7.1.0-dev.20261016.1` |
| TS 7 分发形态 | 主包 **2,497,498 字节**，靠 20 个 `@typescript/typescript-<platform>` 可选依赖分发平台原生二进制（含 `win32-x64`、`win32-arm64`、`linux-x64`、`darwin-arm64` 等） |
| TS 6 分发形态 | **24,346,827 字节** 纯 JS |
| `typescript-eslint` | `latest=8.71.2`，**没有 v9**（dist-tags 仅 `latest` / `canary=8.71.3-alpha.7` / `rc-v8`） |
| `typescript-eslint` peer | `typescript: >=4.8.4 <6.1.0`（canary 同范围） |
| 上游支持窗口 | typescript-eslint 官方文档：支持范围 `>=4.8.4 <6.1.0`，镜像 DefinitelyTyped 的两年窗口【上游】 |
| TS 7.0 的 API | 发布说明：「TypeScript 7.0 不带 API。我们预期 7.1 提供一个**新的、不同的** API」；并点名「有些工具（如 typescript-eslint）期望通过 peer 依赖直接 import typescript」【上游】 |
| 官方过渡方案 | npm alias 并存：`"typescript": "npm:@typescript/typescript6@^6.0.2"`（提供 `tsc6`）+ 另一个别名指向 `typescript@^7.0.2`【上游】 |
| `@typescript/typescript6` | `6.0.2` 存在，`bin: { tsc6 }`【实测】 |
| 博客里的 `@typescript/native` | **registry 上 404**——那只是个可自取的 alias 键名，不是真实包【实测】 |

### 4.2 实测：TS 7 的编译器本身可以用

在临时目录装 `typescript@7.0.2` + `@types/node@^22`，**用仓库原样的 `tsconfig.json`**：

```
npx tsc -p tsconfig.json          -> exit 0
npx tsc -p tsconfig.json --noEmit -> exit 0
node --test "dist/test/**/*.test.js" -> tests 22 / pass 22 / fail 0
```

`.d.ts` 与 source map 均正常产出。

**所以「TS 7 能不能编译我们」的答案是可以，产物还能跑通全部测试。** 阻塞点不在编译器。

### 4.3 阻塞点：lint 需要 TS 6 的编译器 API

在临时目录同时装 `typescript@7.0.2` 与 `typescript-eslint@8.71.2`，`npm install` 直接失败：

```
npm error ERESOLVE unable to resolve dependency tree
npm error Found: typescript@7.0.2
npm error Could not resolve dependency:
npm error peer typescript@">=4.8.4 <6.1.0" from typescript-eslint@8.71.2
```

这不是我们的配置问题，而是**上游时序问题**：typescript-eslint 依赖编译器 API 工作，而 TS 7.0 不提供 API，peer 范围也把 7.x 排除在外。

### 4.4 决定：P1 不迁移，保持 `typescript` 6.x（当前 6.0.3）

**迁移触发条件**（三条同时满足才重新评估）：

1. typescript-eslint 的 peer 范围包含 7.x（或出现支持 TS 7 的新主版本）；
2. 届时用本仓库跑通 `npm test`（build + lint + 测试）；
3. 迁移前先在 6.x 上打开 `stableTypeOrdering` 跑一遍——TS 7 该选项恒为 `true` 且不可关闭，先在 6.x 上把行为差异暴露出来，而不是在 7.x 上排查。

**额外收获：本仓库的 tsconfig 已经是 TS 7-ready 的。** TS 7 的破坏性默认变更（`strict` 默认 `true`、`types` 默认 `[]`、`rootDir` 默认 `./`、`module` 默认 `esnext`）本仓库**都已显式设置**（`strict: true`、`types: ["node"]`、`rootDir: "."`、`module: NodeNext`），也没有用到被移除的选项（`baseUrl`、`target: es5`、`downlevelIteration`、`moduleResolution: node|node10|classic`）。将来迁移时 tsconfig 不需要改动。

### 4.5 若将来要「编译快、lint 留在 6」的并存方案

官方 alias 写法（键名可自取，因为 `@typescript/native` 并不存在）：

```json
{
  "devDependencies": {
    "typescript": "npm:@typescript/typescript6@^6.0.2",
    "typescript7": "npm:typescript@^7.0.2"
  }
}
```

收益是 build / typecheck 提速（上游报 8–12×）。

**P1 不采用**：本地 build 目前是秒级，收益不足以换来「两套编译器 + 两份 `tsc` 语义」的复杂度。等 build 时间成为实际痛点再评估。真要用时，`npx tsc` 到底指向哪个包需要实测确认【未验证】。

### 4.6 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 直接升级 TS 7 并用 `--legacy-peer-deps` 绕过 | 绕过 peer 检查不改变「7.0 没有 API」这一事实，lint 会在运行时失败 |
| 降级或去掉 typescript-eslint | lint 是 P0 已建立的门禁（含 kernel 的 `node:*` 禁令），不能为编译器版本让步 |
| 现在就上并存方案 | 见 §4.5 |

---

## 5. 对 P1 六项范围的具体影响

| P1 范围 | 调研带来的具体决定 |
|---|---|
| 1. 会话头事件 | `session.opened` 作为**首条事件**（`seq = 1`），字段 `{ schemaVersion, createdAt, cowcatVersion }`；**`create` 时写入，`open` 时只读校验——头不参与后续重写**，避免重复写入 `seq = 1`。`readAll` 先校验头再逐行解码；未知版本明确报错并列出支持的版本号。包为 `private` 0.0.0 且从未发布 → **不写迁移路径**（ADR-004 已定不保留旧版兼容） |
| 2. zod 解码校验 | 每行 `safeParse`；失败抛 `corrupt session log <id>.jsonl at line N: <字段路径>: <message>`（字段路径由 `issue.path` 拼接）；schema 落在 `src/adapters/`；lint **新增独立 pattern** 把 zod 挡在 kernel / policy / ports 之外（§2.4）；测试用 `Equals` 断言钉住 schema 与 `KernelEvent` 等价（§2.5） |
| 3. 单写者锁 | §3.3 的协议（**默认不做自动接管**）+ §3.4 的 `LockPort` / `LockHeldError`；`Session.create` 改 `async` 并修 3 处调用点；新增 `Session.close()` |
| 4. 快照 | 原子替换用 `.tmp` + `rename`（实验 D 只保证单进程语义）；快照必须记录它覆盖到的 `lastSeq` 与 schema 版本，与头部校验共用一套逻辑；**快照不改变锁的必要性**——锁保护的是 `seq` 的读-改-写，快照只是回放加速 |
| 5. 属性测试 | `fast-check` 4.10.2【实测】，无 peer 依赖，devDependency（不受「6 个运行时依赖」上限约束，但**仍需 ADR**，见 §6）；两条性质：「回放等于实时状态」「非法跃迁一律被拒绝」；种子固定并打进失败输出（出口标准要求种子可复现） |
| 6. CI | 调研结论不改变 `ci.yml` 的分级；`packages/cowcat` 的 Windows 腿仍待 main 上的首次真实运行 |

---

## 6. 需要落的文档与 ADR

`dev-plan-v2.md:74` 明确要求「依赖 ADR：zod、fast-check」，因此两个依赖各一条 ADR。

| 动作 | 内容 |
|---|---|
| 新增 ADR-009 | 采用 zod 4 作为边界校验库，含「只在适配器层」的约束与对应的 lint pattern |
| 新增 ADR-010 | 会话单写者锁协议：`O_EXCL` 认领 + pid 存活检测用于诊断 + **默认显式恢复、不做自动接管**；记录附录 C 的反例作为该决定的核心依据 |
| 新增 ADR-011 | 采用 fast-check 作为属性测试框架（开发依赖，随 `npm test` 进 CI） |
| 更新 02-kernel.md | §未决项四条在 P1 落地后转「已解决」；事件表增加 `session.opened` |
| 更新 04-dependencies.md | 「已安装」表补 zod 与 fast-check；`typescript` 行补 P1 结论（不迁移，阻塞在 typescript-eslint 的 peer 与 TS 7.0 无 API）；「计划中」表移除 zod / fast-check |
| 更新 architecture/README.md | ADR 表登记 009、010、011 |
| 修正 dev-plan-v2.md | 阶段总览里 P0 仍写「进行中」、P1「未开始」，实际 P0 已随 `dca0d31` 合入，需要更新状态 |
| 本文件 | 随 P1 实现 PR 补一节「实现后的偏差记录」 |

---

## 7. 待验证清单（汇总）

1. ~~Linux / macOS 上重跑锁实验 A、B、C、E、I~~ **部分已解决（P1 T3）**：A（`wx` 的 `EEXIST`）、B（`kill(pid, 0)` 判活）、C（删除活锁对持有者不可见）与「默认不自动接管」已由 `test/lock.test.ts` 在 CI 的 **Linux 腿**（Node 22 · ubuntu-24.04）上真实执行，不是本机 Windows 的结论外推。实验 I 的构造式反例针对的是**自动接管**，本实现不实现自动接管，故无对应测试。**macOS 未覆盖。**
2. 会话目录位于 NFS / SMB / 同步盘时的锁行为。
3. 三个 schema 库在本仓库真实 schema 上的对比（§2.7）。
4. zod 引入后对 `tsc` 编译耗时的影响。
5. 本次全部实测在 Node 24 上；CI 门禁腿是 Node 22，需以 CI 结果为准。
6. ~~`packages/cowcat` 的 Windows 作业在 main 上的真实耗时~~ —— **已验证**（2026-10-16，main `1f7389a`，run [38967790242](https://github.com/HiyodoGame/cowcat/actions/runs/38967790242)）：**54s**、success，是该作业在 main 上的第一条真实记录。

---

## 8. 实现后的偏差记录

> 工作规则 6：区分「已验证」与「推测」。本节记录实现落地时与本文档结论不一致的地方及原因，随每个 P1 任务的 PR 追加。

| 任务 | 偏差 | 原因 |
|---|---|---|
| T1 会话头 | 头字段由 `{ schemaVersion, createdAt, cowcatVersion }` 改为 `{ schemaVersion, cowcatVersion }`（§5 行1 的原字段集合） | `EventBase` 已有 `ts`，由 `emit` 用 `clock.now()` 填写；`createdAt` 是同一事实的第二份副本，两者不一致时无法判断以谁为准 |
| T1 会话头 | 裁决表更正：新增「`create` 的目标已有事件 → 拒绝」，并把「文件不存在 → 空状态」改为「`open` 拒绝（会话不存在）」 | 原表述开了一条把日志写坏的路：`open` 不写头（正确决定），却允许在空日志上继续 `emit`，于是写出无头日志；而首行不是头即损坏，该日志**永久打不开**。实现时发现，随 T1 一并修正 ADR-012 |
| T1 会话头 | 「首行不是 `session.opened`」当前由内核判定，适配器只判「存在但没有任何非空行」 | zod 在 T2 才引入。T2 落地后逐行结构校验（含首行）归适配器，内核保留版本兼容判定，§2.4 的分工不变 |
| T3 单写者锁 | `LockHeldError` 增加 `sessionId` 字段（§3.4 的字段集合是 `pid` / `lockPath` / `guidance`） | 消息里要点名是哪个会话，捕获方也不必自带 id |
| T3 单写者锁 | 新增「`close()` 之后禁止 `emit`」 | §3.4 只要求 `close()` 释放锁。但锁是「同一会话只有一个写入者」这条不变量的实现，若关锁后仍可写，不变量就废了；理由与「锁归 `Session` 所有而非组合根」是同一条 |
| T3 单写者锁 | §3.3 第 5 条「校验 nonce 后 `unlink`」实现为：nonce 不匹配、或锁文件内容读不出时**静默不删** | 删掉无法证明归属的锁会把会话交给两个写入者；且「释放」不该以副作用失败告终 |
| T3 单写者锁 | 「持有者已死」分支的测试用超大 pid（`2147483647`）而不是 spawn 一个子进程 | 本机实测该 pid 返回 `ESRCH`，与崩溃进程留下的 pid 走同一条分类路径；避免为一条测试给 `packages/cowcat` 引入子进程（`ci.yml` 头部把「no child processes」列为该作业便宜的原因之一） |

**T1 的验证证据**：`packages/cowcat` 的 `npm test` 由 22 项增至 **30** 项（build + ESLint + 测试全通过，本机 Windows / Node `v24.18.0`）。新增 `test/header.test.ts` 覆盖：头作为首条事件写入、磁盘往返后头仍在、`create` 重复被拒、`open` 不存在被拒、无头日志被拒、未知 `schemaVersion` 报错（含 `found` 与 `supported` 字段）、空文件判损坏、同一日志里的第二个头判损坏。

**T3 的验证证据**：`npm test` 由 30 项增至 **41** 项（同上环境全通过）。新增 `test/lock.test.ts`（11 项）覆盖：锁文件内容（`pid` / `nonce` / `hostname` / `startedAt`）、同进程二次认领被拒（断言 `pid` 与 `lockPath` 而非文案）、死锁被拒且指引与活锁可区分、内容无法解读的锁被拒且不猜持有人、释放可重复且真正释放、不删不属于自己的锁、删除活锁对持有者不可见、同一会话不能开两次、失败的 `open` 不泄漏锁、`close()` 后拒绝写入、`exclusiveLock` 替身。**这些测试在 CI 的 Linux 腿上真实执行**，因此 §7 第 1 条的一部分由本任务的 CI 运行给出结论。

---

## 附录 A：单进程原语探针（`lock-probe.mjs`）

```js
import { open, unlink, writeFile, mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const dir = join(tmpdir(), `cowcat-lock-probe-${randomUUID()}`);
await mkdir(dir, { recursive: true });
const out = [];
const record = (name, value) => out.push(`${name}: ${value}`);

// 1. O_EXCL via the 'wx' flag: does a second create fail with EEXIST?
const lock = join(dir, 'session.lock');
const fh1 = await open(lock, 'wx');
record('wx/granted', true);
let second = 'NO ERROR';
try {
  const fh2 = await open(lock, 'wx');
  await fh2.close();
} catch (error) {
  second = `${error.code}`;
}
record('wx/second-create', second);

// 2. Can another process observe the holder via pid liveness?
record('kill(self,0)', (() => { try { process.kill(process.pid, 0); return 'alive'; } catch (e) { return e.code; } })());
const unlikelyPid = 0x7ffffff0;
record('kill(dead-pid,0)', (() => { try { process.kill(unlikelyPid, 0); return 'alive'; } catch (e) { return e.code; } })());
record('kill(pid 1,0)', (() => { try { process.kill(1, 0); return 'alive'; } catch (e) { return e.code; } })());

// 3. Write the holder's pid into the lock.
await writeFile(lock, String(process.pid), { flag: 'w' });
record('lock-content', await readFile(lock, 'utf8'));

// 4. Windows: can the lock file be unlinked while a handle is still open?
let unlinkWhileOpen = 'OK';
try {
  await unlink(lock);
} catch (error) {
  unlinkWhileOpen = `${error.code}`;
}
record('unlink-while-held', unlinkWhileOpen);
await fh1.close();

// 5. Stale-lock recovery: after the holder closed, is unlink possible?
let unlinkAfterClose = 'OK';
try {
  await unlink(lock);
} catch (error) {
  unlinkAfterClose = `${error.code}`;
}
record('unlink-after-close', unlinkAfterClose);

// 6. Atomic replace by rename (single process only).
const target = join(dir, 'snapshot.json');
await writeFile(target, 'old');
await writeFile(`${target}.tmp`, 'new');
let renameOverwrite = 'OK';
try {
  await rename(`${target}.tmp`, target);
} catch (error) {
  renameOverwrite = `${error.code}`;
}
record('rename-overwrite', `${renameOverwrite} -> ${renameOverwrite === 'OK' ? await readFile(target, 'utf8') : ''}`);

// 7. Concurrent append from one process.
const log = join(dir, 'log.jsonl');
const line = (n) => JSON.stringify({ n, pad: 'x'.repeat(2000) }) + '\n';
await Promise.all(Array.from({ length: 40 }, (_, i) => writeFile(log, line(i), { flag: 'a' })));
const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
let intact = 0;
for (const l of lines) { try { JSON.parse(l); intact++; } catch { /* torn */ } }
record('concurrent-append', `${intact}/${lines.length} lines parse`);

console.log(out.join('\n'));
console.log(`platform: ${process.platform}, node: ${process.version}`);
```

输出（本机）：

```
wx/granted: true
wx/second-create: EEXIST
kill(self,0): alive
kill(dead-pid,0): ESRCH
kill(pid 1,0): ESRCH
lock-content: 58424
unlink-while-held: OK
unlink-after-close: ENOENT
rename-overwrite: OK -> new
concurrent-append: 40/40 lines parse
platform: win32, node: v24.18.0
```

## 附录 B：统计式 A/B（`lock-takeover-ab.mjs`）

所有竞争者由屏障同时释放，因此它们在同一瞬间读到同一把陈旧锁。`staleDelayMs` 是「做出判死决定」与「执行动作」之间被迫消耗的时间，用来模拟进程在这两者之间被调度出去。`claims` 是认为自己持有锁的进程数，正确协议必须恒为 1。

```js
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const dir = join(tmpdir(), `cowcat-takeover-${randomUUID()}`);
await mkdir(dir, { recursive: true });
const script = join(dir, 'child.mjs');

await writeFile(script, `
import { appendFile, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
const [mode, lockPath, journal, holdMs, startAtRaw, staleDelayMs, jitterMs] = process.argv.slice(2);
const hold = Number(holdMs);
const startAt = Number(startAtRaw);
const staleDelay = Number(staleDelayMs);
const jitter = Number(jitterMs);

const log = (line) => appendFile(journal, line + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (t) => { const d = t - Date.now(); if (d > 0) await sleep(d); };

const claim = async () => {
  try {
    const fh = await open(lockPath, 'wx');
    await writeFile(fh, String(process.pid));
    await fh.close();
    return true;
  } catch { return false; }
};

const holderState = async () => {
  let raw = null;
  try { raw = (await readFile(lockPath, 'utf8')).trim(); } catch { return 'gone'; }
  const pid = Number(raw);
  if (!Number.isFinite(pid)) return 'unparseable';
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return error.code === 'EPERM' ? 'alive' : 'dead'; }
};

await waitUntil(startAt);

let done = false;
for (let attempt = 0; attempt < 8 && !done; attempt++) {
  if (await claim()) {
    await log('CLAIM ' + process.pid);
    await sleep(hold);
    let mine = false;
    try { mine = (await readFile(lockPath, 'utf8')).trim() === String(process.pid); } catch { /* gone */ }
    await log((mine ? 'STILL_HELD ' : 'LOST ') + process.pid);
    if (mine) await unlink(lockPath).catch(() => {});
    done = true;
    break;
  }

  const state = await holderState();
  if (state === 'gone') continue;
  if (state === 'alive') { await log('REFUSED_ALIVE ' + process.pid); done = true; break; }

  // Decision: the holder is dead. Now lose the CPU before acting on it.
  if (jitter > 0) await sleep(Math.random() * jitter);
  if (staleDelay > 0) await sleep(staleDelay);

  if (mode === 'naive') {
    // Delete and recreate. The file at this path may have been replaced by a
    // live holder between the read above and this unlink: the decision is stale.
    await unlink(lockPath).catch(() => {});
  } else {
    // Arbitrate by moving the path away; only one process can move it. But this
    // moves whatever file is there, without checking whether it is still the
    // stale one that was decided about.
    await rename(lockPath, lockPath + '.stale.' + process.pid + '-' + attempt).catch(() => {});
  }
}
`, 'utf8');

const run = (mode, lockPath, journal, holdMs, startAt, staleDelay, jitter) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [script, mode, lockPath, journal, String(holdMs), String(startAt), String(staleDelay), String(jitter)],
      { stdio: 'ignore' },
    );
    child.on('close', () => resolve());
  });

const CONTENDERS = 5;
const HOLD_MS = 600;

const trial = async (mode, staleDelay, jitter) => {
  const lockPath = join(dir, `${mode}.lock`);
  const journal = join(dir, `${mode}.log`);
  await writeFile(lockPath, String(0x7ffffff0)); // seeded stale lock: a pid that cannot exist
  await writeFile(journal, '');
  const startAt = Date.now() + 900; // every child boots and waits at the barrier
  await Promise.all(
    Array.from({ length: CONTENDERS }, () => run(mode, lockPath, journal, HOLD_MS, startAt, staleDelay, jitter)),
  );
  const lines = (await readFile(journal, 'utf8')).split('\n').filter(Boolean);
  return {
    claims: lines.filter((l) => l.startsWith('CLAIM ')).length,
    stillHeld: lines.filter((l) => l.startsWith('STILL_HELD ')).length,
    lost: lines.filter((l) => l.startsWith('LOST ')).length,
    refused: lines.filter((l) => l.startsWith('REFUSED_ALIVE ')).length,
    timeline: lines.join(' | '),
  };
};

const CONFIGS = [
  ['naive', 0, 8, 6],
  ['rename', 0, 8, 6],
  ['naive', 200, 0, 5],
  ['rename', 200, 0, 5],
];

const report = [];
for (const [mode, staleDelay, jitter, reps] of CONFIGS) {
  const runs = [];
  for (let i = 0; i < reps; i++) runs.push(await trial(mode, staleDelay, jitter));
  const broken = runs.filter((r) => r.claims !== 1).length;
  report.push(
    `${mode.padEnd(6)} staleDelay=${String(staleDelay).padStart(3)}ms jitter=${jitter}ms reps=${reps}  ` +
      `broken=${broken}/${reps}  claims=[${runs.map((r) => r.claims).join(',')}]  ` +
      `stillHeld=[${runs.map((r) => r.stillHeld).join(',')}]  lost=[${runs.map((r) => r.lost).join(',')}]`,
  );
  const bad = runs.find((r) => r.claims !== 1);
  report.push(`       ${bad ? 'BROKEN sample timeline' : 'neutral sample timeline'}: ${(bad ?? runs[0]).timeline}`);
}

console.log(report.join('\n'));
console.log(`platform: ${process.platform}, node: ${process.version}`);
await rm(dir, { recursive: true, force: true }).catch(() => {});
```

输出（本机）：

```
naive  staleDelay=  0ms jitter=8ms reps=6  broken=0/6  claims=[1,1,1,1,1,1]  stillHeld=[1,1,1,1,1,1]  lost=[0,0,0,0,0,0]
       neutral sample timeline: CLAIM 61900 | REFUSED_ALIVE 32908 | REFUSED_ALIVE 27640 | REFUSED_ALIVE 13328 | REFUSED_ALIVE 63388 | STILL_HELD 61900
rename staleDelay=  0ms jitter=8ms reps=6  broken=0/6  claims=[1,1,1,1,1,1]  stillHeld=[1,1,1,1,1,1]  lost=[0,0,0,0,0,0]
       neutral sample timeline: REFUSED_ALIVE 21008 | CLAIM 27472 | REFUSED_ALIVE 63156 | REFUSED_ALIVE 7588 | REFUSED_ALIVE 65332 | STILL_HELD 27472
naive  staleDelay=200ms jitter=0ms reps=5  broken=0/5  claims=[1,1,1,1,1]  stillHeld=[1,1,1,1,1]  lost=[0,0,0,0,0]
       neutral sample timeline: CLAIM 31564 | REFUSED_ALIVE 27644 | REFUSED_ALIVE 61308 | REFUSED_ALIVE 66096 | REFUSED_ALIVE 65684 | STILL_HELD 31564
rename staleDelay=200ms jitter=0ms reps=5  broken=0/5  claims=[1,1,1,1,1]  stillHeld=[1,1,1,1,1]  lost=[0,0,0,0,0]
       neutral sample timeline: CLAIM 27776 | REFUSED_ALIVE 5336 | REFUSED_ALIVE 64612 | REFUSED_ALIVE 26304 | REFUSED_ALIVE 37400 | STILL_HELD 27776
platform: win32, node: v24.18.0
```

**这个脚本的价值是它的否定结果**：自然调度下两种协议都不破裂，说明「统计式复现」这条路不足以支撑结论。另有一次同参数（`rename`、200ms、5 轮）的早期运行抓到过 `1/5` 破裂（`claims=[1,1,1,2,1]`，一个进程 `LOST` 了自己的活锁）——说明破绽存在但概率很低，因此需要附录 C 的构造式证明。

## 附录 C：构造式反例（`lock-takeover-constructed.mjs`）

统计式实验只能靠运气撞到竞态。TOCTOU 缺陷更该用**构造**来证明：强制那个协议无法防御的交错——一个进程做出「持有者已死」的判断，然后在**另一个进程已合法取得锁之后**才执行动作。

强制时序：

1. 父进程写入一把陈旧锁（pid 不可能存在）
2. 攻击者读到它，判定 `stale`，然后停住
3. 父进程移除这把陈旧锁；合法持有者正常认领并持有
4. 攻击者醒来，对一个**已经过期**的判断执行动作：`naive` 删锁，`rename` 把锁挪走
5. 攻击者认领成功——此时两个进程都认为自己持有锁

```js
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const dir = join(tmpdir(), `cowcat-constructed-${randomUUID()}`);
await mkdir(dir, { recursive: true });
const script = join(dir, 'child.mjs');

await writeFile(script, `
import { appendFile, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const [role, mode, lockPath, journal, goPath] = process.argv.slice(2);

const log = (line) => appendFile(journal, line + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (path, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error('timeout waiting for ' + path);
    await sleep(5);
  }
};

const claim = async () => {
  try {
    const fh = await open(lockPath, 'wx');
    await writeFile(fh, String(process.pid));
    await fh.close();
    return true;
  } catch { return false; }
};

const owns = async () => {
  try { return (await readFile(lockPath, 'utf8')).trim() === String(process.pid); } catch { return false; }
};

if (role === 'attacker') {
  // Read the holder, decide it is dead, then park until the trap is set.
  const raw = (await readFile(lockPath, 'utf8')).trim();
  let alive = true;
  try { process.kill(Number(raw), 0); } catch (error) { alive = error.code === 'EPERM'; }
  await log('ATTACKER_DECIDED stale=' + String(!alive));
  await waitFor(goPath);

  // Act on a decision that is now stale.
  if (mode === 'naive') {
    await unlink(lockPath).catch(() => {});
  } else {
    await rename(lockPath, lockPath + '.stale.attacker').catch(() => {});
  }
  const gotIt = await claim();
  await log('ATTACKER_CLAIM ' + String(gotIt));
  if (gotIt) {
    await sleep(700);
    await log('ATTACKER_STILL_HELD ' + String(await owns()));
  }
} else {
  await waitFor(goPath + '.ready'); // the parent has cleaned away the seeded lock
  const gotIt = await claim();
  await log('HOLDER_CLAIM ' + String(gotIt));
  await writeFile(goPath, 'go');
  await sleep(700); // long enough to overlap with the attacker's critical section
  await log('HOLDER_STILL_HELD ' + String(await owns()));
}
`, 'utf8');

const spawnChild = (role, mode, lockPath, journal, goPath) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [script, role, mode, lockPath, journal, goPath], { stdio: 'ignore' });
    child.on('close', () => resolve());
  });

const scenario = async (mode) => {
  const lockPath = join(dir, `${mode}.lock`);
  const journal = join(dir, `${mode}.log`);
  const goPath = join(dir, `${mode}.go`);
  await writeFile(lockPath, String(0x7ffffff0)); // seeded stale lock
  await writeFile(journal, '');

  const attacker = spawnChild('attacker', mode, lockPath, journal, goPath);
  await new Promise((r) => setTimeout(r, 1200)); // attacker has read and parked

  await unlink(lockPath); // the stale lock is cleaned away
  await writeFile(`${goPath}.ready`, ''); // release the holder
  const holder = spawnChild('holder', mode, lockPath, journal, goPath);

  await Promise.all([attacker, holder]);
  const lines = (await readFile(journal, 'utf8')).split('\n').filter(Boolean);
  const claims = lines.filter((l) => l.includes('_CLAIM true')).length;
  const stillHeld = lines.filter((l) => l.includes('_STILL_HELD true')).length;
  return { mode, claims, stillHeld, timeline: lines.join(' | ') };
};

const report = [];
for (const mode of ['naive', 'rename']) {
  const r = await scenario(mode);
  report.push(
    `${r.mode.padEnd(6)} claims=${r.claims} stillHeld=${r.stillHeld}  ` +
      `${r.claims === 1 ? 'OK (mutual exclusion held)' : 'BROKEN (mutual exclusion violated by construction)'}`,
  );
  report.push(`       timeline: ${r.timeline}`);
}

console.log(report.join('\n'));
console.log(`platform: ${process.platform}, node: ${process.version}`);
await rm(dir, { recursive: true, force: true }).catch(() => {});
```

输出（本机）：

```
naive  claims=2 stillHeld=1  BROKEN (mutual exclusion violated by construction)
       timeline: ATTACKER_DECIDED stale=true | HOLDER_CLAIM true | ATTACKER_CLAIM true | HOLDER_STILL_HELD false | ATTACKER_STILL_HELD true
rename claims=2 stillHeld=1  BROKEN (mutual exclusion violated by construction)
       timeline: ATTACKER_DECIDED stale=true | HOLDER_CLAIM true | ATTACKER_CLAIM true | HOLDER_STILL_HELD false | ATTACKER_STILL_HELD true
platform: win32, node: v24.18.0
```

两种协议的输出逐字相同：`claims=2`，合法持有者最终 `STILL_HELD=false`。这是 §3.3「默认不做自动接管」的全部依据。
