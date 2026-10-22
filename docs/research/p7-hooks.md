# P7 专项调研：Hooks（Claude Code hooks.json 兼容）

日期：2026-10-22 · 状态：调研（只出决定草案与 ADR 清单，不改 ADR 表、不改源码）

## 1. 问题与范围

dev-plan P7 行：**触发时机、失败语义、是否经过策略；出生即兼容 Claude Code hooks.json 格式的取舍（D3，生态迁移成本归零）**。依赖 P3（已交付）。

本调研回答：v1 兼容 CC hooks 的哪个子集、挂在哪些时机、执行与失败语义、trust 门、进不进日志、配置从哪些文件读。

非目标：prompt/agent 类型 handler（要模型参与）；`if` 字段（权限规则语法挂接，另立 ADR）；plugin/skill frontmatter 注册 hooks（CC v2.1 新能力）；HTTP/MCP tool handler；Stop block「让模型继续工作」的交互（需要改回合状态机）。

## 2. 结论摘要（决定草案）

| # | 草案 | 一句话理由 |
|---|---|---|
| D1 | hooks 是**宿主侧副作用**，不是内核事件。内核只类型依赖新端口 `HooksPort`，在固定时机调用；实现在 host/adapters（经 ProcessPort 起 shell，ADR-014 纪律） | 与 approval 桥同构（kernel 问、host 答）；执行要 node 进程，内核三层禁 `node:*` |
| D2 | **不经 policy.decide**；但 project 层 hooks 过 **trust 门**（未信跳过 + warning），user 层不 gate | MCP 服务器先例【源码】`host/config.ts:70-74`：用户配置的进程不走模型工具策略，但 project 来源要 trust；hooks 是同样性质的用户配置代码执行 |
| D3 | v1 事件子集六个：**PreToolUse（可 deny）、PostToolUse（可改写输出/旁注）、UserPromptSubmit（可注入上下文/可拒prompt）、Stop、SessionStart、PreCompact**（后三个 v1 只观察） | 覆盖 CC 最高频用法（block-rm 类防护、lint 反馈、会话初始化）；Stop block 要改状态机、SessionEnd 我们没有 close 事件，都留后续 |
| D4 | handler 类型**只执行 `type:"command"`**；http/mcp_tool/prompt/agent 与 `if`/`async`/`once`/`shell`/`onFailure` 字段解析但**不生效，doctor 汇总汇报** | skills 的 `HONORED_FIELDS`/`ignoredFields`/doctor 三件套先例【源码】`adapters/skills.ts:17-29,187-197`、`cli/doctor.ts:197-199`；不静默忽略是同一规矩 |
| D5 | stdin/stdout 契约照 CC：stdin 喂 JSON（common 字段 + 事件字段）；exit 0 + 单行 JSON 输出（`additionalContext`/`hookSpecificOutput.permissionDecision`/`decision:"block"`+`reason`/`updatedToolOutput`）；**exit 2 = 阻断**（PreToolUse 拒调用、UserPromptSubmit 拒 prompt，stderr 作原因）；其它非零与超时 = 非阻断失败 | 逐字兼容让生态脚本零修改【上游】code.claude.com/docs/en/hooks（2026-10-22 抓取的现行规范） |
| D6 | **改变模型可见事实的必须进日志，纯观测的不进**：PreToolUse deny → 复用 `tool.finished ok:false output="blocked by hook: …"`（重放一致）；PostToolUse `updatedToolOutput` → `tool.finished.output` 记改写后文本（日志=模型所见）；UserPromptSubmit `additionalContext` → 新事件注入 user 消息（同 `instructions.loaded` 模式）；观测型 hooks（SessionStart/Stop/PreCompact）失败经 `turn.noted` 摘要，不刷日志 | 与 ADR-078 ④「模型可见的干预要可重放」同一纪律；观测全量进日志会每轮刷事件 |
| D7 | 配置来源五个文件：`~/.claude/settings.json`（user）、`<项目根>/.claude/settings.json` 与 `.claude/settings.local.json`（project，需 trust）、`~/.cowcat/config.json` 与项目 `cowcat.json` 的 `hooks` 段（同格式，分别 user/project 层）；全部**叠加执行**（CC 合并语义就是不移除） | 直接读 CC 自己的 settings 文件 = 迁移成本归零（D3 本意）；cowcat 自家配置文件给不留 CC 目录的项目用；项目根 = 含 `.git` 的目录（`projectRootOf` 先例） |
| D8 | 执行语义：串行；cwd = 会话 cwd；env = 宿主 env + `CLAUDE_PROJECT_DIR`（`${CLAUDE_PROJECT_DIR}` 占位符同时做文本替换）；sandbox = 会话解析的 profile（`resolveSandboxProfile`）；超时默认 **60s**（bash v1 先例），`timeout` 字段生效、clamp 1..600 | 工具调用本就串行（runCall 串行【源码】`run-turn.ts:317`），并行无收益；60s 是仓库既有先例数字 |

## 3. 取证方式与局限

- 【上游】code.claude.com/docs/en/hooks 2026-10-22 全文抓取（4216 行缓存在本机 tool-output）：事件表、matcher 语法、handler 字段、exit code 语义、PostToolUse `updatedToolOutput`、配置位置、settings 合并与 trust 规则均引自该文档。
- 【源码】本仓库由探索代理逐条取证（文件:行号见 §5）。
- 局限：CC 的 exit 2 在 Stop 上「让模型继续」的交互细节文档有描述但我们 v1 不做；dsh 的 hooks-claude-code 桥（frontier-survey §2.1 第 3 条）未取一手源码，不依赖它。
- 【推断】标注处未实测。

## 4. 上游形状（【上游】CC hooks 规范要点）

- **事件全表**（v2.1，30+ 个）：SessionStart/End、Setup、UserPromptSubmit、UserPromptExpansion、PreToolUse、PermissionRequest/Denied、PostToolUse、PostToolUseFailure、PostToolBatch、Notification、SubagentStart/Stop、TaskCreated/Completed、Stop、StopFailure、PreCompact/PostCompact、PreModelSwitch/PostModelSwitch、Elicitation(Result)、MessageDisplay、FileChanged、CwdChanged、DirectoryAdded、ConfigChange、InstructionsLoaded、WorktreeCreate/Remove、TeammateIdle。
- **matcher 语义**：仅 `[A-Za-z0-9 _,-]` 字符 → 精确串或 `|`/`,` 列表；含其它字符 → JS 正则（`RegExp.test`，不锚定）。各事件匹配的字段不同（工具事件对 `tool_name`；PreCompact 对 `manual|auto`；SessionStart 对 `startup|resume|clear|compact|fork`）。
- **handler 类型五种**：command / http / mcp_tool / prompt / agent。command 分 exec 形（有 `args`，无 shell）与 shell 形（无 `args`，走 shell）。
- **exit code 语义**：0 = 成功，stdout 若以单个 JSON 对象开头按 JSON output 解析（`additionalContext`、`systemMessage`、`hookSpecificOutput` 事件字段）；2 = **阻断**（按事件分语义：PreToolUse 拒调用、UserPromptSubmit 拒 prompt、Stop 让模型继续）；其它非零 = 非阻断错误（stderr 给用户看，动作照走）；超时 = 取消，输出作废。默认超时 command/http/mcp_tool 600s、prompt 30s、agent 60s。
- **PreToolUse 决策**：`hookSpecificOutput.permissionDecision: "deny" + permissionDecisionReason` → 拒调用并把原因给模型。
- **PostToolUse 决策**：`decision:"block"` + `reason` → 原因旁注在工具结果旁（模型仍见原文）；`updatedToolOutput` → 替换模型看到的输出（工具已执行，文件副作用已发生——文档明说）。
- **配置位置**：`~/.claude/settings.json`（user）、`.claude/settings.json`（project，可提交）、`.claude/settings.local.json`（project 本地，gitignore）；条目**跨层合并不互删**；project hooks 在未 trust 的文件夹不跑。
- 路径占位符：`${CLAUDE_PROJECT_DIR}`（会话起始项目根）、`${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}`；同时导出为进程环境变量。

## 5. 本仓库现状（【源码】）

### 5.1 工具管线与挂接点

- `runCall`【源码】`kernel/run-turn.ts:725-892`：Task 预检 → spec 查找 → risk → ActionRequest（`fs.canonical` 算 path）→ `policy.decided` 落事件 → deny 短路 → read-before-write 门 → ask 审批分支 → 执行 `tool.run`（L873-886）。
- **PreToolUse 挂点 = L873 之前**（deny/审批已收敛，拿得到 decision/request）；**PostToolUse 挂点 = runCall 返回后、`todo.updated`/`tool.finished` emit 前**（`run-turn.ts:330-337`）。
- 结果改写通道：`tool.finished.output` 直接折叠成模型的 tool 消息（`state.ts:238-260`）——hook 改写 `result.output` 即改写模型所见。
- UserPromptSubmit 挂点 = `runTurnBody` 入口、`openTurn` 之前（`run-turn.ts:257-275`）；SessionStart = `Session.create`（`session.ts:80-87`）；PreCompact = `compact.ts:156` 前；Stop = `transition('completed')` 处（`run-turn.ts:313-317`）。

### 5.2 进程与策略

- `ProcessSpec = { argv, cwd, env, stdin?, timeoutMs?, outputCap?, sandbox }`（`ports/process.ts:92-102`）；shell 装配先例 `bash.ts:135-144`（argv 不经 shell 字符串，ADR-014/018）；MCP 起进程不经 policy 先例 `host/config.ts:65-94`（trust 门 + env 剥离 + 汇总 warning）。
- sandbox profile 组合根解析一次（`host.ts:216` `resolveSandboxProfile`，默认 `light/network off`）。
- trust：`isTrusted` 精确目录匹配（`policy/trust.ts:60-62`），`~/.cowcat/trust.json`；同一 `workspaceTrusted` 布尔喂 rules/instructions/skills/MCP（`host.ts:207-213`）。

### 5.3 会话生命周期空白

- **Session close 无事件**（`session.ts:97-100` 只释放锁）——SessionEnd 无从挂起，v1 不做。
- resume（`Session.open`）无事件——SessionStart 只在 create 时触发，matcher 恒为 `startup`；文档说明。

### 5.4 兼容模式与可复用件（skills 先例）

- `HONORED_FIELDS` + `frontmatterSchema = z.looseObject` + `ignoredFields` 计算（`adapters/skills.ts:17-29,37-48,187-197`）；doctor 逐行汇报（`cli/doctor.ts:197-199`）。
- 配置加载三层（user `~/.cowcat/config.json` / project `cowcat.json` / session `--config`）`host/config.ts:13-17,117-137`；config schema `z.strictObject({ rules, sandbox, model, mcp })`（`adapters/config.ts:110-128`）——**strict，加 `hooks` 段是 schema 变更**（ADR-123 的输入）。
- 项目根 = 含 `.git` 的目录（`instructions.ts:84-89`）。
- 超时先例：bash 60s 默认 / 600s 上限（`bash.ts:16-18`）；审批 300s（`run-turn.ts:25`）。

### 5.5 新事件的改动清单（`tool.repeat-detected` 先例，T-A 刚走过）

`kernel/events.ts`（union 分支）→ `kernel/state.ts`（reduce case）→ `adapters/schema.ts`（discriminatedUnion 分支，absent-tolerant 按需）→ tui `project.ts` + `copy.ts` → cli `oneshot.ts`；**protocol 零改动**（wire 是 looseObject 透传，`protocol/src/notifications.ts:32-42`）。

## 6. 决定草案（给 ADR 的输入）

| 项 | 草案 | 备选（被否/待定） |
|---|---|---|
| 挂接架构 | 新端口 `HooksPort`（kernel 类型依赖）：`run(event: HookEventInput) → HookOutcome`；host 实现，配置/trust/进程全在组合根 | kernel 直接调执行器：违反禁 `node:*`；hooks 纯观测不进内核：PreToolUse deny 是模型可见干预，必须在管线内 |
| 是否过策略 | 不过 policy.decide；project 层 trust 门 | 全量过审批：用户自己配的脚本再问一遍是噪音，MCP 先例已否 |
| deny 的日志 | 复用 `tool.finished ok:false`（output 带 `blocked by hook:` 前缀），不重写执行事实——工具确实没跑，facts 为 null 天然正确 | 新事件 `hook.blocked`：多一个事件类型，收益只是审计多一句话，否 |
| updatedToolOutput 的日志 | `tool.finished.output` 记**改写后**文本（=模型所见）。原始输出不在日志——与 CC 一致（其 telemetry 也记原始但日志不保证） | 双份记录（原始+改写）：事件 schema 变更，v1 不值 |
| additionalContext | 新事件 `hooks.context-added { text }` 折叠成 user 消息（ADR-078/instructions.loaded 同构），replay 零依赖 | 合并进 `turn.opened.input`：用户原话被改写，审计差，否 |
| 观测 hooks 失败 | `turn.noted` 摘要（既有机制，ADR-093），不进 messages | 每败一个事件：刷日志 |
| settings.local.json 的层 | project 层（同 CC：物理上在项目目录，trust 门前不跑） | user 层（gitignore 所以个人）：CC 明确 project 文件 trust 后才跑，兼容优先照 CC |
| 不认识的 hook 事件名 | doctor 汇报、不执行 | 启动 warning：每会话刷，否 |
| `${CLAUDE_PLUGIN_ROOT}` | 不替换（v1 无 plugin），doctor 见即汇报 | 静默透传：脚本必然失败，不如明说 |

## 7. 需要落的 ADR（草案）

| ADR | 主题 |
|---|---|
| ADR-121 | hooks 定位与执行：宿主侧副作用、`HooksPort`、不经 policy/过 trust 门、ProcessPort + 会话 sandbox + 60s 超时、串行、失败语义（exit 0/2/其它/超时）与 `turn.noted` 可见性 |
| ADR-122 | v1 兼容子集与进出契约：六事件、command-only、matcher 语法、`if` 等字段不生效清单、stdin JSON 形状、`${CLAUDE_PROJECT_DIR}`、deny/改写/上下文注入的**日志可重放纪律**（哪几种效果进日志、怎么进） |
| ADR-123 | 配置来源与合并：五文件清单、层归属、trust 门、叠加执行顺序、cowcat config schema 加 `hooks` 段（zod 边界不变）、doctor 汇报义务 |

## 8. 任务拆分

| 任务 | 内容 | 出口标准 |
|---|---|---|
| T1 | `ports/hooks.ts`（端口类型）+ `adapters/hooks.ts`（执行器：settings 解析、matcher、占位符替换、ProcessPort 调用、exit/JSON 解析）+ 单测（FakeProcess 先例 `bash.test.ts:57-72`） | deny/改写/上下文/失败四形状；matcher 三形态（精确/列表/正则）；占位符替换；超时 clamp |
| T2 | host 接线（五文件加载、trust 门、组合根注入）+ `host/config.ts` schema 加 `hooks` 段 + 单测 | project 未信跳过 + warning；user 层恒跑；五源叠加 |
| T3 | kernel 挂接：`run-turn.ts` 四处（PreToolUse/PostToolUse/UserPromptSubmit/Stop）+ `compact.ts`（PreCompact）+ `hooks.context-added` 事件三件套（events/state/schema）+ `tool.finished` 的 hook deny 路径 + 单测（runRoundTrip 先例） | deny 后工具未执行且重放一致；改写后日志=模型所见；注入消息 replay 深比较 |
| T4 | doctor hooks 行（来源/跳过/不生效清单）+ TUI notice + cli stderr 行（copy 中英） | doctor 汇报三要素；前端不显示 unsupported |
| T5 | 真机验收：临时受信项目配 `.claude/settings.json` block-rm hook，让模型跑 `rm -rf` 类命令 → 观察 deny；PostToolUse lint hook 改写输出；记录写回本文件 §11 | 真机会话日志可复查 |

## 9. 待验证

1. **glm 等模型对 deny 的反应**【推断】：hook deny 的 reason 以 `ok:false` 工具结果呈现，模型会读原因改道——与 policy deny 同形状，预期一致，T5 实测。【须实测】
2. **matcher 正则的 JS 语义**【推断】：CC 用 `RegExp.test`（不锚定），我们照用 `new RegExp(m).test(name)`；异常正则（如 `(`）视为永不匹配 + doctor 汇报。【须实测（单测覆盖）】
3. **观测 hook 拖慢回合**【推断】：SessionStart/Stop 每次 fork 进程，60s 超时上限兜底；真机量化 T5。【须实测】
4. **cowcat.json `hooks` 段与 CC 文件的优先级**【推断】：同层叠加、执行顺序 user→project；若同事件同 matcher 的 deny hook 在两个文件都配，都跑（先 user 后 project），先 deny 者胜。T1 前定死写入 ADR-123。
5. **stdin JSON 里给哪些字段**【推断】：CC common 字段我们全给（session_id/transcript_path/cwd/hook_event_name/permission_mode?）——我们没有 permission_mode 概念，v1 给 `"default"` 还是不给，T1 前定死（倾向不给：宁缺毋假）。【须裁决】→ **2026-10-22 已裁决**：不给（宁缺毋假），已写入 ADR-122 ③。

## 11.1 #161 审查校准与已知偏差（2026-10-22，全部已处理或文档化）

审查（code-reviewer/k3）结论：无 P0；5 P1 + 14 P2。P1 全部修复（#162），要点：

- stdin `hook_event_name` 用 PascalCase（CC 脚本按它分支，kebab-case 会让多事件脚本全部失配）。
- CC 现行决策格式是**顶层** `{decision, reason}`（UserPromptSubmit/PostToolUse）；`hookSpecificOutput.permissionDecision` 是 PreToolUse 的较旧形态。两处都读、文档形态优先。
- `additionalContext` 文档位置在 `hookSpecificOutput` 内，顶层旧拼写也读（fallback）。
- tool 事件的 context outcome 原先被内核丢弃（与端口契约矛盾）——现收集到轮末批量注入（ADR-120 ② 同款防 wire 配对断裂教训）。
- hook spec 加 outputCap 100K（bash 同款）；context/rewrite 文本按 CC 的 10K 上限截断。

修复的 P2：exitCode null（cancel/信号杀死）不再当成功解析（防半截 JSON 变假 deny）；内核四处 port 调用全经 runHooksSafely（port 抛错 → note，不杀回合/调用）；SessionStart 失败改投会话日志（原 warnings 是死信）；PostToolUse block 无 rewrite 时 reason 以 note 效果附在原输出旁；跨文件相同 handler 去重（CC「runs once」）；deny 路径查 abort；exit≠0 失败行带 env 剥离计数。

**已知偏差（有意为之，非缺陷）**：

1. `updatedToolOutput` 收 string 或 `{output}`，不是 CC 的工具形状对象；`tool_response` 是 `{ok, output}` 而非工具原生形状——结构性偏离，脚本跨工具复用时需知晓。
2. UserPromptSubmit 纯文本 stdout 不注入（CC 当作 system reminder 给模型）——v1 只做 additionalContext。
3. `${CLAUDE_PROJECT_DIR}` 文本替换在 Windows 路径（反斜杠/空格）下脆弱——env 通道（`CLAUDE_PROJECT_DIR` 环境变量）已正确设置，Windows 上推荐 exec 形 + env。
4. trust 判定在 cwd、hook 文件来自 projectRoot 祖先目录——与 skills/instructions 同一先例（未信目录里的任何项目层内容都不加载）；hooks 载荷是指令这一点使风险高于文本类载荷，若真机出现「只信任了子目录却在跑父目录 hooks」的意外，再收紧为对 projectRoot 判定。

## 12. T5 真机验收记录（2026-10-22）

**结论：PreToolUse deny 链路真机端到端通过，doctor 汇报正确。**

### 环境

- 模型：`zai-coding-plan/glm-5.3-flash`（真实 API），`cowcat run --yes`
- 内核版本：#162 合并后（含审查修复）
- 场景：临时受信项目配 `.claude/settings.json`（CC 原生格式）→ `matcher: "Bash"` 的 PreToolUse hook，脚本 `.claude/hooks/block-rm.cjs` 读 stdin JSON、命令含 `rm -rf` 时输出 `hookSpecificOutput.permissionDecision: "deny"`——**照抄 CC 文档 block-rm 形态**（`${CLAUDE_PROJECT_DIR}` 占位符 + JSON 决策），零 cowcat 专属改写

### 结果

1. **doctor**：hooks 行输出「1 个 handler（1 个文件）；doctor 不执行 hook」+ 来源明细 `pre-tool-use (Bash) ← …/.claude/settings.json`——三要素齐全（ADR-123 ④）。
2. **deny 真机触发**：prompt 让模型 `rm -rf ./notes.txt` → 模型报告「被项目配置的安全钩子拦截」、主动确认文件仍在、给出三个替代方案（mv 到回收站/清空内容/用户自己删）——行为教科书级。会话日志（`sess_7d65c383…`）seq 14：`tool.finished Bash ok=false "blocked by hook: destructive rm is blocked by the project hook"`，seq 25 模型 Read 验证文件存在——**日志事实与 ADR-122 ④ 完全一致，重放可复现**。
3. **零配置迁移成本验证**：settings.json 与脚本均按 CC 文档形态书写即生效（D3 的本意，实测成立）。

### 未覆盖 / 边界

- PostToolUse 改写与 additionalContext 注入只有内核级测试，真机未触发（需要模型配合产出特定输出，性价比低）。
- UserPromptSubmit 拒 prompt 真机未触发（同上）。
- 观测 hook（Stop/SessionStart/PreCompact）真机开销未量化【推断：每次 fork 一个进程，60s 上限兜底；真机量化列为后续】。
