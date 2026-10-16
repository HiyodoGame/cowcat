# 02 内核：事件、日志、Turn 状态机

## 核心约定

1. **持久化的只有事实**。`KernelEvent` 联合类型中的每一项都是已经发生的事实（一个回合开始了、模型给出了一条消息、某个工具调用的结果是什么）。
2. **状态是事件的归约结果**。`reduce(state, event)` 是纯函数；`replay(events)` 得到的状态必须与实时运行时的状态逐字段相等。这条性质有测试（`replaying the log reproduces the live session state exactly`）。
3. **先落盘，后应用，再通知**。`Session.emit` 的顺序是：`store.append` → `reduce` → 通知监听者。监听者永远看不到日志里没有的事实。
4. **瞬时增量不落盘**。模型逐 token 的 `model.delta` 只通过 `SessionUpdate` 推给前端，不进日志；最终的 `model.message` 才是事实。否则一个长回复会产生上千条无意义的日志行。

## 事件表

| 类型 | 含义 | 归约到状态 |
|---|---|---|
| `turn.opened` | 用户输入开始一个回合 | 新建 turn（idle），追加 user 消息 |
| `turn.transitioned` | Turn 状态变迁 | 更新 turn 状态（校验 from/to 合法，否则视为日志损坏） |
| `model.message` | 模型一次完整输出（文本 + 工具调用） | 追加 assistant 消息 |
| `policy.decided` | 对某次工具调用的策略裁决 | 不改消息，但入日志，供审计 |
| `tool.finished` | 工具结果（成功或失败） | 追加 tool 消息 |

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

## 已知的未决项（进入 P1 处理）

- 日志没有版本头，只有每行的字段结构。P1 增加会话头事件与 schema 版本号。
- 没有单写者锁：两个进程同时打开同一会话会互相覆盖序号。P1 用文件锁解决。
- 没有快照：长会话回放成本线性增长。P1 设计快照点，但快照只是加速，不是事实来源。
- 解码只做 `JSON.parse` 与行号报错，没有结构校验。P1 用 zod 在解码边界校验。
