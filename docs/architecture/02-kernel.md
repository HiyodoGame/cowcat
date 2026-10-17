# 02 内核：事件、日志、Turn 状态机

## 核心约定

1. **持久化的只有事实**。`KernelEvent` 联合类型中的每一项都是已经发生的事实（一个回合开始了、模型给出了一条消息、某个工具调用的结果是什么）。
2. **状态是事件的归约结果**。`reduce(state, event)` 是纯函数；`replay(events)` 得到的状态必须与实时运行时的状态逐字段相等。这条性质有测试（`replaying the log reproduces the live session state exactly`）。内核在记录模型给出的工具调用时会对入参做一次 JSON 规范化——日志是 JSON，而 `JSON.parse('-0')` 真的会产生 `-0`、`JSON.stringify(-0)` 是 `"0"`，不规范化这条性质就会对**真实可达**的输入静默失效。无法规范化的入参（`BigInt`、循环引用）以明确原因让回合失败。
3. **先落盘，后应用，再通知**。`Session.emit` 的顺序是：`store.append` → `reduce` → 通知监听者。监听者永远看不到日志里没有的事实。
4. **瞬时增量不落盘**。模型逐 token 的 `model.delta` 只通过 `SessionUpdate` 推给前端，不进日志；最终的 `model.message` 才是事实。否则一个长回复会产生上千条无意义的日志行。

## 事件表

| 类型 | 含义 | 归约到状态 |
|---|---|---|
| `session.opened` | 会话创建，携带日志格式版本与创建者的 CowCat 版本 | 校验它是首条事件；不产生消息（见「会话头与 schema 版本」） |
| `turn.opened` | 用户输入开始一个回合 | 新建 turn（idle），追加 user 消息 |
| `turn.transitioned` | Turn 状态变迁 | 更新 turn 状态（校验 from/to 合法，否则视为日志损坏） |
| `model.message` | 模型一次完整输出（文本 + 工具调用） | 追加 assistant 消息 |
| `policy.decided` | 对某次工具调用的策略裁决 | 不改消息，但入日志，供审计 |
| `approval.requested` | 向用户提出的审批问题（工具名、命中的规则、理由） | 不改消息。**写在问之前**，所以停在审批上的日志能说清在等什么 |
| `approval.answered` | 审批的回答：`{ callId, key, verdict: once\|always\|reject, by: user\|policy\|timeout }` | `always` 时把 `key` 追加进 `grants` |
| `tool.finished` | 工具结果（成功或失败） | 追加 tool 消息 |

**`grants` 是从日志归约出来的，不是旁边的另一份状态**（ADR-031 决定 3）。这正是让「回放能够复现实时会话」这句话对授权也成立的原因：重开会话拿回它的授权，因为拿回了它的事件。授权**只活在本次会话内**——永久规则要先有撤销机制（ADR-026），那还不存在。

**`by: 'policy'`** 不是人也不是超时：它是本次会话早先的一个 `always` 让后来的同一次动作通过。显式记下来是为了让日志诚实——否则日志里会出现一个 `ask` 后面工具直接跑了、中间没有任何回答，读起来像内核忽略了自己的裁决。

`model.delta` 不在日志联合类型里，类型系统层面就无法误写入（`StreamDelta` 与 `KernelEvent` 分开定义）。

## Turn 状态机

```
idle ──► requesting ──► streaming ──► finishing ──► completed
              ▲             │
              │             ▼
              └──── awaiting_tools ◄──► awaiting_approval
                            │
                 （任一非终态）──► cancelled / failed
```

- 合法跃迁表在 `kernel/turn.ts` 的 `TRANSITIONS` 中，逐条有测试。
- 终态（`completed` / `cancelled` / `failed`）没有出边。
- 「工具结束后回到 `requesting`」是循环的唯一回路：工具结果进入消息历史，下一次模型调用看得到。
- 非法跃迁抛 `IllegalTransitionError`；回放时遇到非法跃迁抛错而不是静默修正，因为那说明日志被破坏。

## 回合执行（`runTurn`）

```
openTurn(input)
loop:
  streaming  → 消费模型 chunk，发 delta（瞬时），收尾写 model.message
  无工具调用 → finishing → completed，返回
  有工具调用 → awaiting_tools
               对每个调用：policy.decided →（ask 则 awaiting_approval → 回 awaiting_tools）→ 执行 → tool.finished
               → requesting，继续循环
任意异常/取消 → 若 signal.aborted 则 cancelled，否则 failed；reason 写进 transition
```

几条有意的取舍：

- **工具串行执行**。旧版并发执行 + 按序组装结果，带来了大量复杂度。v2 先串行，正确性优先；确有需要的只读工具并发放在 P5 再定，并且必须有测试证明结果顺序。
- **工具抛错不等于回合失败**。工具错误变成 `ok: false` 的 tool 消息，模型可以看到并自行恢复。只有模型调用本身失败，或取消，才让回合失败。
- **拒绝审批不是错误**。被用户拒绝的调用返回 `rejected by user` 给模型，模型可以换一种做法。

## 取消

`AbortSignal` 从 `runTurn` 穿到模型调用与工具调用。取消发生时：

- 尚未调用模型：直接 `cancelled`，模型一次都不调用（有测试）。
- 流式过程中：流被打断后检查 `signal.aborted`，抛出内部 `TurnAborted`，转 `cancelled`。
- 工具执行中：工具自己应当响应 signal；工具抛出的异常若发生在取消之后，按取消处理而不是工具失败。

## 会话的打开与恢复

`Session.open(deps, id)` 读取全部事件并回放，得到与关闭前完全一致的状态，包括未结束回合的 turn 状态。注意：**回合不会自动续跑**。打开一个停在 `awaiting_approval` 的会话，内核只恢复状态，由前端决定是重新询问还是把它标记为取消。这避免了「重启后悄悄执行了一个从未被批准的操作」。

## 单写者锁

> ADR-010。完整推导（含被否决的方案与构造式反例）见 [../research/p1-kernel.md](../research/p1-kernel.md) §3。

- **锁的生命周期是整个会话**，不是单次写入：`open` / `create` 认领，`close()` 释放。`EventStore` 对此一无所知——锁是独立端口 `LockPort`（登记见 [03-policy-and-execution.md](03-policy-and-execution.md)），这样内存存储不必伪造锁语义。
- **认领只经 `open(lock, 'wx')`**（`<sessionId>.jsonl.lock`，与日志同目录），它是唯一的原子仲裁点。`EEXIST` 后读锁文件里的 pid，用 `process.kill(pid, 0)` 判存活：成功或 `EPERM` 都算活着。
- **默认不自动接管**。持有者活着或已死，`acquire` 都抛 `LockHeldError`，区别只在 `guidance`：活着时提醒先关掉对方，已死时提示确认无占用后 `--force-unlock`。`--force-unlock` 是**显式且带审计**的动作，P1 只到「错误指引 + 记录」，CLI 入口属 P6。
- **顺序：先认领锁，再读日志。** 反过来的话，读到状态之后、写入之前会有窗口让另一个写入者插进来，而我们持有的就是陈旧状态——正是这套机制要防的事。`open` / `create` 在失败路径上必须释放锁，否则本进程的活 pid 会把自己挡在门外。
- **`close()` 之后禁止 `emit`**（抛 `session is closed`）。锁是「同一会话只有一个写入者」这条不变量的实现，若关锁后还能写，不变量就废了。强制放在 `Session` 内而不是留给调用方，理由与「锁归 `Session` 所有而非组合根」相同。
- 判活遇到除 `ESRCH` 外无法解读的错误码**一律视为活着**：拒绝打开是可恢复的（有显式接管路径），静默共享一把活锁不可恢复。

**残余风险**（P1 明示而不消除，展开见调研 §3.6）：

- 把 `--force-unlock` 或手工删除作用在**活锁**上，持有者无感知，于是出现两个写入者。文件存在性保护不了持有者——`test/lock.test.ts` 有一条测试专门把这个事实固定下来。
- pid 复用：`startedAt` 与 `hostname` 仅作诊断信息，不参与判死决定。
- NFS / SMB / 同步盘上 `O_EXCL` 语义不可靠；会话目录默认落本机磁盘，**不承诺网络卷安全**。

**组合根的一条约束**：`JsonlEventStore` 与 `FileLockPort` 必须指向**同一个目录**，否则锁保护的不是那份日志。目前靠调用方遵守，P6 的组合根会把它固定下来。

**测试落点**：单进程内的协议分支在 `test/lock.test.ts`；跨进程争抢（8 个进程同时认领）与「持有者被硬杀后的恢复指引」在 `test/lock-cross-process.test.ts`。后者是 `packages/cowcat` 里唯一 spawn 子进程的文件——锁本来就是跨进程原语，只在单进程内测等于没测核心场景。

## 会话头与 schema 版本

> ADR-012。以下裁决已落地并有测试（`test/header.test.ts`）；逐行的结构校验（zod）已由 P1 落地。

- 首条事件固定为 `session.opened`（`seq = 1`），字段 `{ schemaVersion, cowcatVersion, shell }`。**不额外存 `createdAt`**：`EventBase` 已有 `ts`，由 `emit` 用 `clock.now()` 填写，同一件事不存两份。
- **`shell` 记录的是实际执行命令的解释器**（P2 T2，ADR-019）：`{ kind, executable }` 两个字段，注入路径同 `cowcatVersion`（`SessionDeps.shell`，由 `PlatformPort.resolveShell()` 提供）。不记录 `baseArgs`/`commandFlag`——它们由 `kind` 推导，记两份就多一处会走样的地方。理由是**可复现**：一份只说「这些命令跑过」却不说在哪个 shell 里跑的日志，事后无法重放。
- **只在创建时写入，`open` 只读校验、不回写**。否则重新打开会试图再写一次 `seq = 1`。
- `reduce` 在该事件不是首条（`lastSeq !== 0`）时抛错，与其他损坏判定一致。
- **`schemaVersion` 是内核常量**（`kernel/schema-version.ts`），它描述的是日志格式契约，归内核所有。**`cowcatVersion` 由组合根注入**（`SessionDeps.cowcatVersion`，来源是 `package.json`）——内核读不了文件系统（ADR-003 的 lint 禁令），所以它必须被告诉。
- **分工：适配器做结构校验，内核做版本兼容判定。**
  - 适配器的 schema 对 `schemaVersion` 用整数而非字面量。写成 `z.literal(1)` 会让「版本 2 的日志」报成「字段不匹配」，指向错误的原因；而 zod 默认忽略多余字段，所以「只是加了字段的新版本」能穿过结构校验、被版本判定拦下——这正是我们要的路径。
  - 内核在 `Session.open` 的 `replay` 之前调用 `assertSupportedSchemaVersion`，报错信息列出支持的版本号。

日志形态的裁决表：

| 情形 | 裁决 |
|---|---|
| 文件不存在 | `open` 拒绝（会话不存在）；`create` 是唯一的起点 |
| 文件存在但没有任何非空行 | **损坏**：「缺少会话头」（覆盖 0 字节与纯空行） |
| 首行不是 `session.opened` | 损坏：日志必须以头开始 |
| `schemaVersion` 不在支持列表 | 内核报明确版本错误，列出支持版本 |
| `create` 的目标已有事件 | **拒绝**：「会话已存在」 |
| 头里缺必填字段（如 `shell`） | 损坏：报出字段路径（`shell: Invalid input: …`）。zod 侧必填，因此**没有**「旧日志缺这个字段」的分支——见 ADR-019 |

**为什么 `open` 拒绝空日志，而不是返回一个空状态**：`open` 不写头（见上），所以若它对空日志返回一个可用状态，调用方接着 `emit` 就会在没有任何头的文件里写下 `seq = 1`，产出一份**再也打不开**的日志——首行不是头，按上表即损坏。让 `create` 成为唯一的入口，这条路就断了。

**为什么 `create` 要检查已存在**：同一个 id 上 `create` 两次会写出两条 `seq = 1`，靠 `reduce` 的「头必须是首条」兜住是**延迟失败**——要到重新打开时才炸，而那时日志已经写坏。在写入前拦住，代价只是 `create` 多一次读。

**为什么「存在但没有任何非空行」算损坏而不是空**：`append` 总是写完整一行，本实现从不产生这样的文件，它只能是外部干扰（写入中断、磁盘问题、编辑器落空文件）的产物；报「损坏」比报「会话不存在」更接近事实。

**不写迁移路径**：ADR-004 已定不保留旧版兼容，无头日志按损坏处理，不猜测、不补写头。

## 快照

> ADR-013。以下裁决已落地并有测试（`test/snapshot.test.ts` 与 `test/property.test.ts`）。

- 定位：**回放加速，不是事实来源**。快照缺失或损坏时，全量回放必须给出相同结果——这条性质由属性测试覆盖（「任意快照点回放结果相同」）。
- 形态：`SnapshotPort`（`load` / `save`）+ `SessionSnapshot { schemaVersion, lastSeq, state }`，落在与日志同目录的 `<sessionId>.snapshot.json`，写入经 `.tmp` + `rename` 原子替换（`rename` 的原子性只保证单进程语义，不要当作并发保护）。
- `load` 用 `null` 表示「没有快照」：这是正常路径而非异常，与 `LockPort` 的 `LockHeldError` 刻意相反——「已被占用」确实是异常。
- 载入顺序：读快照 → 校验 `schemaVersion` 受支持 → 校验 `lastSeq` 不超过日志实际最大 seq → 一致则只归约 `seq > lastSeq` 的事件；任一步不符则**丢弃快照、全量回放**。
- **写入由调用方显式触发**（`Session.saveSnapshot()`），不做自动节流。自动策略（每 N 个事件 / 按体积 / 关闭时）依赖真实会话长度分布，P1 没有这类数据，现在定阈值就是拍脑袋。
- **P1 的快照不省 IO，只省归约**：`readAll` 仍会读入并解析整个日志，被省掉的是 `reduce` 与消息数组重建。要真正省 IO，需要快照额外记录字节偏移、并给 `EventStore` 增加 `readFrom(sessionId, byteOffset)`——偏移在 append-only 下是稳定的，但必须校验「该偏移处确实是行首」并处理文件被截断的情形。这属于后续一轮，不在 P1 的承诺范围内。
- 快照**不改变锁的必要性**：锁保护的是 `seq` 的读-改-写，快照只是回放加速。

**快照的校验比 §5 行4 更严一档。** 它不只校验 `schemaVersion` 与 `lastSeq` 边界，还按与日志同等的严格度做**结构校验**（同一套 zod + `Equals` 断言），并加两条廉价不变量：`state.sessionId` 必须等于请求的会话、`state.lastSeq` 必须等于信封的 `lastSeq`。理由：一个「结构上像快照、内容已经坏掉」的文件会被当成事实来源，产出的会话状态是**静默错误**，比慢糟糕得多。

**未消除的残余风险**：**结构合法但日志不认的快照**（刻意篡改，或字符串字段内的位翻转）不会被发现——快照被当作派生数据信任。要发现它，快照必须带上它所覆盖日志前缀的摘要并在载入时比对，那会改变快照形态与写入路径，记在 [../research/p1-kernel.md](../research/p1-kernel.md) §7。

## 已解决的未决项（P1）

> 会话头与快照的契约见上文；解码边界与单写者锁的结论见 [../research/p1-kernel.md](../research/p1-kernel.md)。四条都已在 P1 落地，保留原文以便看出它们原本是什么。

- ~~日志没有版本头，只有每行的字段结构~~ **已解决（P1）**：`session.opened` 是日志的首条事实，见「会话头与 schema 版本」；逐行结构校验见最后一条。
- ~~没有单写者锁：两个进程同时打开同一会话会互相覆盖序号~~ **已解决（P1）**：见「单写者锁」。注意原文说「互相覆盖序号」并不准确——真实失败模式是 `seq` 的读-改-写竞态，见调研 §3.1。
- ~~没有快照：长会话回放成本线性增长~~ **已解决（P1）**：见「快照」。原文的「成本线性增长」只被**部分**解决——P1 的快照省归约、不省 IO。
- ~~解码只做 `JSON.parse` 与行号报错，没有结构校验~~ **已解决（P1）**：`src/adapters/schema.ts` 在解码边界逐行校验，报错含行号与字段路径。
