# P7 专项调研：记忆续篇·经验蒸馏（D10，写路闭环）

> 状态：调研 PR（只出决定草案与 ADR 清单，不改 ADR 表、不改源码）。
> 日期：2026-10-23。依据：
> - dev-plan-v2 P7 模块表：「任务后后台蒸馏回写 AGENTS.md / skills（**写入闸门**（与信任模型的交互）；衔接 ADR-075~078（D10 页）」；
> - frontier-survey §4.5/§5（D10 行）：「ACE 的 Reflector/Curator 回路；**写入必须过信任闸门**（把 ADR-030 的『未信任不注入』对称扩成『未信任不回写』，回应 prompt injection」。

## 证据分级

沿用仓库纪律：**【源码】**给 `文件:行`；**【上游】**官方文档；**【推断】**未实测，不作决策依据。

## 1. 结论先行

D10 交付**一条对称的写路闭环**：新工具 `Remember` 让模型把经验沉淀为
AGENTS.md 段落或 skill 文件，写入前经过与读取侧镜像的信任闸门
（未信任不回写）+ 既有审批桥（ask 时展示目标与内容预览）。
**内核零改动、零新事件**——审计链完全复用 `approval.requested/answered` +
`tool.finished`。后台蒸馏（reflect turn）以 user config 显式 opt-in 提供，
默认关（成本是用户的决定）。

## 2. 现状盘点【源码】

| 资产 | 位置 | 状态 |
|---|---|---|
| 指令读取链 | `ports/instructions.ts` `InstructionSource.chain(cwd, {userGlobal})`；user-global = `~/.cowcat/AGENTS.md`（ADR-075） | 只读 |
| 读取侧信任闸 | `decideInstruction` → `skipped-untrusted` + `describeInstructionSkip`（ADR-030） | 只影响读 |
| skills 读取 | `ports/skills.ts`：layers `user`/`project`（**trust 只适用 project**，ADR-114），origins `cowcat`/`claude` | 只读 |
| 审批桥 | askApproval（`host.ts`）；`approval.requested` 带 `reason`/`command`/`path`/`dimensions`（ADR-129 ⑦） | 复用 |
| unattended 语义 | ask 在 unattended 自动 refuse（ADR-129 ⑤） | 写路天然安全 |
| 路径身份 | ADR-017：路径身份只在 FsPort 里算 | 束缚地基 |
| hooks | v1 子集：`stop`/`session-start`/`pre-compact` 等（ADR-121~123），无 session-end | 外部反射可用 `stop` |
| turn.noted | 内核现成 note 事件（note kind + message） | 备用 |
| skill frontmatter | 未承认键由 `doctor` 报告（ADR-115） | 防特权走私现成 |

**写路现状：零。** 没有任何组件能写 AGENTS.md / skills——这正是
「未写尾注」的落点。

## 3. 决定草案

### E1 写入面：`Remember` 工具，四个目标

input `{target, content, mode?, name?, description?}`：

| target | 落点 | mode |
|---|---|---|
| `instructions-user` | `~/.cowcat/AGENTS.md` | `append`（默认）/ `rewrite-cowcat-section`（`<!-- cowcat:memory -->` 标记段，有则换无则加） |
| `instructions-project` | `<cwd>/AGENTS.md` | 同上 |
| `skill-user` | `~/.cowcat/skills/<name>/SKILL.md` | 整文件写（建或换），frontmatter 仅 `name`/`description` |
| `skill-project` | `<cwd>/.cowcat/skills/<name>/SKILL.md` | 同上 |

- 单次 caps：指令内容 ≤ 8KB，skill ≤ 32KB，`description` ≤ 1024
  （沿用 skills spec 天花板【源码 ports/skills.ts:24】）。
- 模型侧工具描述必须写明「写入会进入未来会话的 prompt——只沉淀真正的
  经验，不要写临时状态」（写路的产品语义）。
- **不做的**：任意路径写（不是 Write 的替代品）、删除/移动（v1 不做破坏性
  操作，纠错靠 `rewrite-cowcat-section` 与整文件替换）、会话层 memory
  （session 层是易失配置层，不是记忆载体）。

### E2 闸门：risk='write' 审批 + 信任对称

1. **规则通路**：`Remember` 是普通工具，risk `write`（path = 目标文件），
   走 decide() 的 deny/ask/allow 规则——用户可对整个工具 deny
   （`{"name":"Remember","verdict":"deny"}`），workspace 可 scoped allow。
2. **信任对称（ADR-030 镜像）**：`*-project` 目标额外要求 workspace 已信任；
   未信任 → **工具返回 ok:false 专属输出**（原因 + 「`/act` 信任后可重试」），
   照 ADR-130 拒绝可见的成例，不静默、不伪造成功。user 目标不受此限
   （写的是用户自己的家目录）。
3. **unattended**：ask 自动 refuse（ADR-129 ⑤ 现成语义）→ 无人值守时写路
   自然关闭，模型收到拒绝并可向用户解释。
4. **审批展示**：approval.requested 的 `path` = 目标文件、`reason` = 模型说明
   + 内容预览（截 ~1500 字符）。完整 content 已在 `model.message` 的
   toolCalls 里进日志【源码】——审计链不缺字节。

### E3 通路形状：adapter 工具 + host 组合根，内核零改动

- `adapters/tools/remember.ts`：纯工具实现，构造时注入
  `{fs, paths, trust: () => boolean}`——信任谓词由 host 从 FileTrustStore
  快照给出（host.ts 已有 `trustStore` 与 trust 应用逻辑，ADR-028）。
- 审批交互**不在工具里**：工具在 `execute` 里做目标解析/信任检查/尺寸检查，
  信任不过直接返回拒绝输出；信任过了就真正写文件——**risk write + path
  已由 run-turn 的 decide() 在 execute 之前拦下 ask**（与 Write/Bash 同构）。
- 零新事件：`approval.requested/answered`（ask 通路自动产生）+
  `tool.finished`（ok/output 完整记录写入结果）已是全链事实。
- 依赖方向干净：工具只经 FsPort 写（ADR-017 身份归 FsPort；`..` 逃逸被
  目标枚举天然消掉——没有自由路径参数）。

### E4 prompt injection 回应（frontier-survey D10 行的核心关切）

1. **读闸的镜像即写闸**：ADR-030 说「未信任不注入，因为 AGENTS.md 是命令
   执行入口」；D10 补对称句「**未信任不回写**」——同一文件的两端受同一
   信任模型保护。注入者想让模型把恶意指令写进 `AGENTS.md`，必须先过
   workspace 信任 + 用户审批两道。
2. **写入内容永久视为不可信内容**：它进入未来 prompt 时仍受 ADR-030
   读取闸保护（未信任的 workspace 里，沉淀的段落同样不注入）。
3. **frontmatter 特权走私无效**：skill 只承认 `name`/`description`，
   其余键 doctor 报告不承认（ADR-115 现成）。
4. **审批不可批量豁免**：`always` grant 只认精确 approvalKey
   （ADR-129 ③）——用户对一次写入点 always，不会静默放行后续不同内容
   的写入？⚠️ 注意：approvalKey 按 name+path 计算（toolGrantKey 精确化后），
   对 Remember 意味着「同一路径的后续写入不再询问」——这是 grant 的既有
   语义，写路与之一致，但要在 ADR 里**显式写出**（写路 always 的宽放程度
   由用户规则控制，默认 ask）。

### E5 后台蒸馏：reflect turn，显式 opt-in

- user config 加 `memory: { reflect: 'off' | 'on' }`，**默认 off**。
  project/session 层携带 → 警告并丢弃（照 ADR-134 otel 的成例：成本开关
  是用户的决定，工作区不得替用户花模型钱）。
- `on` 时：一个用户回合完成（terminal completed）后，host 自动起一个
  **受限反射回合**——输入为固定模板（「回顾本会话已完成的工作，若有可复用
  经验，用 Remember 沉淀；没有就直说没有」），工具集收窄为仅 `Remember`
  （与 subagent 按 role 收窄工具同一机制【源码 host.ts】），模型照常走
  写路闸门（ask → 用户审批）。反射回合是日志里的一次正常 turn（诚实入史）。
- **不反射的条件**：unattended（审批无人答，反射必失败）、plan mode、
  会话已关闭、上一个 turn 失败/取消。连续回合防重入（一次一个反射回合）。
- 实现注记【推断】：host.startTurn 是公开 API（input 来自客户端）；反射
  回合走内部 runTurn 路径，工具收窄需要与 `spawnSubagent` 同款手段，
  实现时确认 startTurn 内部能否覆盖 tools——若需小改 host 内部编排则接受
  （不动内核）。
- 为什么默认 off：后台模型调用是真实花费；且无人值守时审批无意义。
  `stop` hook（ADR-122）已给外部 reflector 留口——想接自己的蒸馏
  pipeline 的用户不需要等本产品做自动机。

### E6 TUI/CLI 面

- 审批卡：现有卡渲染 subject/justification（ADR-129 ⑦ + #180 审查的
  C0/C1 剥离）——Remember 的 path/reason 天然落位，预期零改动；
  T2 时实测验证【推断→待实测】。
- doctor：可选新增「skills 里有 cowcat 沉淀的 skill」计数——不做，
  scope 控制。
- CLI：无新子命令。配置即入口。

## 4. ADR 清单（待落表）

- **ADR-135 Remember 写入面**：四目标/mode/caps/整文件 skill 写/不做清单
  （无自由路径、无删除、无会话层 memory）。
- **ADR-136 信任对称与审批语义**：project 写需 trust（拒绝输出形态照
  ADR-130）；unattended 关闭写路；approvalKey/always 在写路的宽放语义
  显式化；注入回应四条款。
- **ADR-137 后台蒸馏（reflect turn）**：config `memory.reflect`（user 层
  only，默认 off）；触发条件与不反射条件；受限回合的形状；成本归属。

## 5. T 计划

| 任务 | 内容 | 验收 |
|---|---|---|
| T1 | `adapters/tools/remember.ts` + 构造注入 + caps + 信任拒绝输出 + config schema `memory` 块 | 单测：四目标写入/rewrite 段/拒绝未信任/尺寸拒绝/逃逸消于目标枚举；config 层警告 |
| T2 | host 接线（tools 表 + trust 谓词）+ reflect turn（config on 时）+ host 级测试 | ask 走真审批桥（ScriptedModel 全程）；unattended 不反射；project 未信任拒绝 |
| T3 | 审批卡渲染实测 | TUI 测试或真机截图确认 path/reason/预览在位 |
| T4 | 真机验收：glm 交互一轮引导其 Remember 一次 + 橡皮图章审批 + 验证文件落盘 + 新会话注入可见 | 验收记录入 §8 |

## 6. 风险与待验证

- **【推断】** approvalKey 对 Remember 的计算形状（name+path）要在 T2 用
  测试钉住，尤其 `always` 后对同路径不同内容的宽放——ADR-136 写明确认。
- **【推断】** reflect turn 的工具收窄若要求 startTurn 内部签名变化，评估
  对 protocol/TUI 的影响面后再动。
- **【推断】** TUI 卡对 `reason` 长文本（预览截 1500 字符）的换行/截断——
  80 列约束下过长的预览可能被截得没意义；T3 实测后定预览上限。
- skill-project 写入会在 workspace 出现 `.cowcat/skills/` 新目录——与
  `.gitignore` 的关系不处理（用户版本控制自治），ADR 注明。
- 已有日志兼容性：零新事件，无 schemaVersion 问题。

## 8. 实现期校准（T1~T2，随实现 PR 落）

- **信任门位置（对调研 E2 的修正）**：调研草案把信任门放在工具内——但 risk=write 的 ask 先于 execute，未信任工作区会先弹一个必然失败的审批。修订为**两层**：host 在未信任时注入条件 deny 规则（`when: {tool: 'Remember', command: '<target>'}`，deny 优先于 ask 且与位置无关），ask 之前拒绝、输出含原因与信任指引；工具内信任门保留，兜住 Escalate 申诉推翻 deny 后的重试（不可申诉）。ADR-136 ② 已按此修订。
- **approvalKey 载体（对 E4/ADR-136 ⑤ 的修正）**：ADR-027 规定工具声明保持 data-only（pathInput/commandInput 是字段名），为给 approvalKey 一个 name+目标 粒度而加内核 preflight 钩子违背该决定。修订为借用 `commandInput: 'target'`——目标枚举本来就是要展示给用户的 subject，approvalKey 退化为 name+target（对某目标 always = 该目标后续写入不再问），卡面 subject = 目标。ADR-136 ④⑤ 已按此修订。
- **反射回合的完成监视器**：挂在 startTurn 的 settled 上、仅在非 reflect 时安装——用安装与否而非 flag 时序做重入防护（flag 的 finally 与 settled.then 存在微任务竞态）。reflect 变体收窄：tools=仅 Remember，无 subagents/skills/hooks/planReview/escalation（不留「hook→prompt→turn」无人观察环路）。
- 新增测试 13 个（remember 6 单测 + host 6 集成 + config 层警告覆盖在 host 用例）。

## 9. #192 审查校准（2026-10-23，code-reviewer/k3）

实现后审查：1 P0 + 4 P1 + 6 P2 全部处理。要点：

- **P0-1（竞态可毁日志，最值钱的一条）**：maybeReflect 未检查 `turnStarting`——带 @ 文件的 sendTurn 通过 busy 检查后、await 读文件期间，reflect 回合可插入启动，同一 Session 两个并发 runTurn，交错事件让日志**永久不可 replay**。修复：守卫加 `turnStarting` 且 reflect 启动期间同步 claim 同一把旗。
- **P1-2**：description 的 YAML 清洗不完备（反斜杠/控制字符是活注入面，手搓 quoting 不是 escaping）→ 改 `JSON.stringify`（JSON 字符串=合法 YAML 双引号标量，转义面全覆盖）。
- **P1-3**：reflect 回合占用会话，用户 sendTurn 吃通用 busy 报错。本期选**区分报错文案**（说明是后台反射、会自行解除）；评估过「用户回合到达即 abort reflect」——放弃：reflect 停在审批上时 abort 会让审批 promise 悬挂到超时。记入 HANDOFF 作未来选项。
- **P1-4（文档诚实）**：ADR-136 ④ 声称卡面有内容预览——实现没有（reason=规则原因）。修订为如实描述（无预览；内容在 toolCalls 进日志；always=该目标后续内容免展示，显式接受的产品语义）。
- **P1-5**：Escalate 兜底链与 always 宽放无语义钉。补两个集成测试：未信任 Escalate 申诉获批 → 重试 → 工具门拒、磁盘无字；trusted always 后同目标第二次写无 ask、两次内容都落盘。
- **P2 全处理**：测试文件 BOM/乱码/EOF 换行清理；空文件 append 前导空行；双标记段拒绝重写（不留孪生段）；statSync 先于读（内存尖峰防护）；skill 写 temp+rename 原子化；description min(1)（空 pitch 的 skill 永不出现）；**子代理 NEVER_GIVEN 加 Remember**（蒸馏是顶层行为，ADR-137 语义）。
- **登记未修**：reflect 回合的 usage 混入会话总额、TUI 不可区分（P2-10）——记入 HANDOFF；instructions 的 read-modify-write 不做原子化（skill 已原子）。
- **测试 +7**（host 46、remember 10）：P0 守卫伴随用例（reflect 占用时用户回合的区分拒绝 + 会话恢复可用）、Escalate 链、always 宽放、空文件、双段拒绝、description 转义、空 description。

## 10. T4 真机验收记录（2026-10-23）

**结论：全链路真机通过**（glm-5.3-flash 真实 API，`cowcat serve`，user config
`memory.reflect=on` + `zai-coding-plan/glm-5.3-flash`；驱动
`cowcat-tui-accept/t5-memory-accept.mjs`，ACCEPTANCE PASS，exit=0）。

### 结果

- glm 被引导调用 `Remember`（target=instructions-user）——**未给写入内容**，
  段落由模型自己组织；审批卡 subject 真机显示 `instructions-user`
  （commandInput 借道在真实链路可见）。
- 完成 2 个回合：用户回合 + **reflect 回合**（memory.reflect=on 后台蒸馏
  真机触发，未弹多余审批——反射模型判断没有更多可沉淀的）。
- `~/.cowcat/AGENTS.md` 落盘，内容为模型自组织的经验（「提交任何代码前必须
  先运行完整测试…」）。
- **新会话注入可见**：第二个会话只问「提交前要做什么」，glm 答出沉淀的
  经验——写路闭环到读取侧全通。

### 边界与未验

- 未信任闸门的拒绝路径有 host 集成测试钉住，真机未单独演（非风险）。
- reflect 回合的花费混入会话 usage（审查 P2-10 登记，未来 turn.noted 打标）。
- 真机未验 skill 目标写入（单测覆盖写形；frontmatter 由工具生成）。
