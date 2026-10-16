# 系统级 Bash 沙箱：威胁模型与实施方案（2026-10-16）

**状态：待评审** —— 动手前请先看 §11 的六个决策点。
**上游输入**：`docs/sandbox-research-2026-10-16.md`（调研报告，所有外部论断带来源；本文只引用它，不引入新来源）。
**本文只做设计**（威胁模型 + 架构 + 分期 + 验收），不含代码改动。

---

## 0. 摘要

**推荐路线：v1 自研薄封装，第三方后端留插槽。**

| 平台 | v1（Phase 1–2） | 说明 |
|---|---|---|
| Linux | **自研 bubblewrap 后端**（系统二进制，无随包 native 依赖） | 最小文件视图 + 凭据路径隐藏 + 网络默认关闭 |
| macOS | **自研 Seatbelt 后端**（`sandbox-exec`，系统自带） | `(deny default)` 白名单 + 网络默认关闭 |
| Windows | **明确不支持**，preflight 明说 + 引导 WSL2 / Docker Sandboxes | 自研需 native 助手（见 §4.3），成本与收益不匹配 |
| 第三方后端（`@anthropic-ai/sandbox-runtime` / `@microsoft/mxc-sdk`） | Phase 4 决策 | 先跑 §8 的验证项拿实测数据，再决定是否替换/补充 |

**五条不变式**（任何实现都必须满足，违反即为设计回退）：

1. **边界由操作系统强制**，不由字符串匹配、不由环境变量、不由提示词。
2. **模型不能解除自己的沙箱**：没有任何"模型可控的关闭参数"；关闭只能由用户显式操作，且写审计（依据：调研 §2.1 Ona 实测 —— Claude Code 自行 `dangerouslyDisableSandbox`；§2.2 Cymulate 配置层逃逸）。
3. **读限制优先于写限制**（依据：调研 §2.5/§2.6 —— 沙箱只拦写不拦读时，一次 `cat ~/.ssh/id_rsa` 的输出就回到模型上下文）。
4. **网络不靠环境变量代理**（依据：调研 §2.5 —— Codex Windows「unelevated + 网络关」被 Node 直连绕过）。
5. **违规必须让模型看见原因**（依据：调研 §2.1 —— 不给原因，模型会去拆边界）。

**明确不承诺**（写进对外威胁模型）：抵御本机已有的 root / 同机恶意进程、提示注入本身（调研 §5.4 的三要素与 CaMeL/设计模式论文）、内核 0day、microVM 级隔离。

---

## 1. 威胁模型

### 1.1 资产

| 资产 | 为什么值钱 | light 档现状（`src/sandbox.js`） |
|---|---|---|
| 凭据文件（`~/.ssh/*`、`~/.config/gh/hosts.yml`、`~/.git-credentials`、Windows Credential Manager） | 直接换取对远端仓库/云资源的访问 | **完全可读**（仅 env 被脱敏） |
| 环境变量里的 token（`*_TOKEN`/`*_KEY`/`*_SECRET`） | 同上，且是主流泄漏路径 | `sanitizeEnv` 已剥离（`sandbox.js:71`），但**这是唯一被覆盖的一项** |
| 私有文档（合同、证件、客户数据；本项目已有"私有内容不外发"的既定决策） | 合规/隐私事故，且"读一次即进上下文" | 可读 |
| 项目源码与 `~/.cowcat` 自己的状态（会话、记忆、crons、审计） | 改这些等于改 agent 的行为/权限 | 可写 |
| 宿主系统（服务、开机项、其它项目） | 持久化与横向移动 | 可写 |
| 我们的 MCP server 凭据与本地 socket | 工具链授权 | MCP 进程在沙箱外（§5.4） |

### 1.2 对手与能力

| 对手 | 能力 | 本方案是否覆盖 |
|---|---|---|
| 第三方依赖/构建脚本（`npm install` 的 postinstall、`curl \| sh`） | 任意代码执行，跑在我们的 uid 下 | ✅ 覆盖（v1 主要目标） |
| 被提示注入的 agent | 用**合法工具**做不该做的事（读凭据、外联）；会尝试绕边界 | ⚠️ 部分：边界我挡，注入本身不解决（调研 §5.4） |
| 模型自身的"绕过"行为 | 换路径执行被禁二进制、`/proc/self/root`、动态链接器 `mmap` 载入、要求关闭沙箱 | ✅ 边界层覆盖；**前提是模型没有解除开关**（不变式 2） |
| 恶意仓库内容（`.git/config` 的 `filter.*.clean`、hooks、`.env`） | 在**沙箱外**被我们的自动流程执行 | ⚠️ 见 §5.5（v1 是明确列出 + 收敛触发路径，不是全挡） |
| 同机其它进程 / 本机 root | 直接读我们的内存与文件 | ❌ 明确 out-of-scope |
| 内核 0day | 逃逸进程级沙箱 | ❌ out-of-scope（要走 microVM，见 §4.4） |

### 1.3 信任边界（必须先厘清，否则方案会被误解成"全套隔离"）

| 边界 | 谁在里面 | 现状 | 本方案 |
|---|---|---|---|
| **Bash 工具及其子进程** | 模型生成的命令、它拉起的整棵进程树 | light 档（护栏） | ✅ **就是这一层** |
| 我们自己的进程内工具（Read/Edit/Write/Grep/Glob） | 我们的 JS，输入是模型输出 | 权限系统管 | ❌ 不在本沙箱范围（与 Claude Code 一致：它的沙箱也只覆盖 Bash 与子进程） |
| hooks / statusline 自定义命令 | 用户配置的命令（非模型生成） | 完整权限 | ❌ v1 范围外，§5.4 说明 |
| MCP server（stdio） | 第三方代码 | **完整权限** | ❌ v1 范围外，Phase 3 可选加固（srt 的旗舰用例就是沙箱化 filesystem MCP） |
| 模型出口（发给 API 的内容） | 上下文 | 靠"私有文档不外发"的既定策略 | ❌ 不同边界，但**读限制直接降低这里的暴露面**（不变式 3） |

### 1.4 in-scope / out-of-scope

**in-scope（v1 要挡住的具体行为）**
- 沙箱内进程**写**项目允许根之外（含 `~/.cowcat`、其它项目、系统目录）。
- 沙箱内进程**读**凭据路径（`~/.ssh`、`~/.config/gh`、`.git-credentials`、`.env` 等）。
- 沙箱内进程**默认无网络**（DNS/TCP/HTTP 一致，不看客户端是否尊重代理）。
- 沙箱内进程**改不了自己的策略**（策略文件在沙箱外、不可写、不可读）。
- 被拒的操作**有可见反馈**（UI + 审计 + 给模型的一句可执行建议）。

**out-of-scope（要写进对外文档，别含糊）**
- 本机已有 root、同机恶意进程、物理访问。
- 提示注入的**决策**本身（我们能限权，不能让它不被骗）。
- 内核/浏览器引擎 0day；进程级沙箱共享内核（调研 §2.8）。
- hooks/statusline/MCP 的完全隔离（v1 不承诺，Phase 3 再说）。
- Windows 原生（v1 明确不支持）。

### 1.5 三个"读-出-进上下文"的通道（为什么读限制优先）

1. 沙箱内命令的 stdout **回到模型上下文** → 下一次模型请求即外泄（调研 §2.6）。
2. 允许写的位置（项目内）→ 落盘成文件，后续被其它工具带走。
3. 允许联通的 host（哪怕只有白名单）→ 直接外发。
→ 因此默认策略是**读限制（deny-then-allow）**、写限制、网络关闭三者同时生效，而不是只做写限制。

### 1.6 为什么必须区分「护栏」与「边界」

现有 light 档的自我描述是"护栏不是安全边界"（`src/sandbox.js:1-32` 文件头威胁模型），这个诚实定位**必须保留**。system 档才是边界，且它的强度也只在 §1.4 in-scope 范围内成立。UI 与文档里三档要分别标注，不能让用户以为开了 light 就安全了。

---

## 2. 目标与非目标（可验收）

| # | 目标 | 验收判据（三平台可执行） |
|---|---|---|
| G1 | system 档下沙箱内命令**写不到**允许根之外 | `echo x > /tmp/cowcat-probe` → 失败；项目内写成功；`~/.cowcat/state.json` 写失败 |
| G2 | system 档下沙箱内命令**读不到**凭据路径 | `cat ~/.ssh/id_rsa`、`cat ~/.config/gh/hosts.yml` → 失败（EPERM 或 ENOENT）；项目内读正常 |
| G3 | system 档下**默认无网络** | `curl -sS https://example.com`、`node -e "fetch('https://example.com')"` → 都失败（不依赖代理变量） |
| G4 | 被拒操作**有可执行反馈** | UI 显示违规摘要；审计新增记录；给模型的一句建议（如"这是沙箱限制，需用户放行网络/路径"） |
| G5 | 模型**无法**解除沙箱 | 无模型可控的解除参数；模型请求关闭只能走到用户审批；审批结果写审计 |
| G6 | 失败**明确**，不静默降级 | preflight 失败的平台上 `/sandbox system` 明确报错（默认退回 light 并在 UI 标注"未生效"） |
| G7 | 不显著破坏正常开发 | system 档下项目内 `npm test`（依赖已装）、`git status/commit`、`node`/`python` 脚本可正常跑；`npm install` 类联网命令走"按命令放行网络"（用户审批）后可用 |
| G8 | 有回归集 | 调研 §2 的逃逸案例变成可重复用例（§8.2），进 CI（能跑的平台）与 live 脚本（其余） |

**非目标**：替代权限系统（`permissions.allow/deny/ask`）；覆盖 Read/Edit/Write；提供 microVM 级隔离；Windows 原生支持（v1）。

---

## 3. 档位设计

### 3.1 三档语义

| 维度 | `off` | `light`（默认，现状） | `system`（新增） |
|---|---|---|---|
| 执行方式 | 直接 `exec` | 直接 `exec` | 经后端包装（bwrap / `sandbox-exec`） |
| 读 | 全开 | 全开 | **deny-then-allow**：默认只读项目 + 系统目录，凭据路径强制拒绝（deny 更具体者优先） |
| 写 | 全开 | 全开 | **allow-only**：默认仅项目可写（`denyWrite` 优先，例如项目内 `.env`） |
| 网络 | 全开 | 全开 | **默认关闭**；按命令审批可开（v1 只有两态，无域名白名单） |
| env | 原样 | 凭据形状变量剥离 + `sandbox.envDeny` 扩展 | 同 light（**再加**：把代理类变量清成已知值，避免"假代理"误导） |
| 策略来源 | — | 静态启发式（`classifyCommand`，`sandbox.js:115`） | 静态启发式 + **OS 策略**；启发式退居"提示/审批"用途 |
| 审计 | — | 一行 JSONL（`sandbox.js:149`） | 同 light + `mode`/`backend`/`violations` 字段（§5.6） |
| UI 角标 | `· unsandboxed` | `· sandboxed (light)` | `· sandboxed (system · bwrap)` |
| 失败策略 | — | 危险命令 fail-closed（`sandbox.js` 头部契约） | 后端不可用 → 按 `failOpen` 决定（§4.2），**任何降级都在 UI 标注** |

### 3.2 配置 schema（向后兼容）

现状：`config.sandbox` 是字符串 `'off' | 'light'`，**但注释明确允许对象形式** `{ envDeny: [...] }`（`config.js:74-77`），而读取侧 `sandboxFor()` 只做字符串比较（`sandbox.js:172-176`）。因此：

```jsonc
// ~/.cowcat/state.json（键 'sandbox' 已在 STATE_KEYS，config.js:52）
"sandbox": "system"                      // 简写：等价于 { mode: "system" } 全默认
// 或：
"sandbox": {
  "mode": "system",                      // 'off' | 'light' | 'system'
  "envDeny": ["FOO_TOKEN", "/^BAR_/"],   // 现有能力，保留
  "read":  { "deny": ["~/.ssh", "~/.config/gh", "**/.env"], "allow": [] },
  "write": { "allow": [".", "~/worktrees"], "deny": [".env", ".git/hooks"] },
  "network": "off",                      // 'off' | 'ask'（按命令审批）| 'on'（不推荐，等价 light）
  "failOpen": true,                      // 后端不可用时：true=退回 light 并在 UI 标注；false=命令直接失败
  "backend": "auto"                      // 'auto' | 'bwrap' | 'seatbelt' | 'none'（调试/强制用）
}
```

要点：
- **一处读取改动**：`sandboxFor()` 从"字符串比较"改为"归一化对象"，其余调用点（`tools/bash.js:44`、`tui/ui.js:372-379`）不变。
- 默认值写进 `config.js` 的 `defaults` 注释块，保持"默认仍是最保守的 light"。
- 不引入新的 state 键（复用 `sandbox`），避免状态迁移。

### 3.3 `/sandbox` 交互

- `/sandbox`（无参数）→ 显示**当前生效**档位 + 后端 + preflight 结论摘要（例如"system 已请求，但本机 bwrap 不可用（AppArmor 限制），当前实际为 light"）。
- `/sandbox off|light|system` → 切换；切到 system 时**先跑 preflight**，不可用则明确拒绝并给出修复建议（§4.2），**不静默接受**。
- 切换写入审计（新字段 `decision: 'mode-change'`）+ 状态栏/Bash 卡角标即时更新（`tui/ui.js` 已经是每次渲染读 `getConfig()`，见 `tui/ui.js:372-379`）。

---

## 4. 平台策略与能力矩阵

### 4.1 矩阵

| 平台 | 后端 | 依赖 | preflight 探测 | 失败时 |
|---|---|---|---|---|
| Linux | `bwrap` | 系统包（Ubuntu: `bubblewrap`；Fedora: `bubblewrap`） | `which bwrap` + 试跑 `bwrap --unshare-all --ro-bind / / true`（探 userns 是否被 AppArmor 拦） | 按 `failOpen` |
| macOS | `sandbox-exec` | 系统自带 | `which sandbox-exec` + 试跑空 profile | 按 `failOpen` |
| WSL2 | 同 Linux | 同 Linux | 同上 | 按 `failOpen` |
| Windows（原生） | — | — | 直接返回"不支持" | 见 §4.3 |
| 容器/CI | 视宿主 | — | 同上 | 按 `failOpen` |

**环境坑（调研 §7）**：Ubuntu 24.04+ 的 AppArmor 限制无特权 userns，bwrap 直接起不来（需给 `/usr/bin/bwrap` 加 profile，25.04 已自带）；RHEL9/Rocky9（内核 5.14）无可用 Landlock 且 bwrap 绑 CA 路径会失败。→ preflight 必须**分类报因**（"bwrap 不存在" / "userns 被限制" / "其它"），并把修复命令写进错误文案（Ubuntu 的 profile 片段、`apparmor_parser -r`、或临时 `sysctl`）。

### 4.2 失败策略（配置项 `failOpen`，默认 `true`）

| 场景 | `failOpen: true`（默认） | `failOpen: false` |
|---|---|---|
| 用户显式切到 system 但后端不可用 | 退回 light 执行，**Bash 卡角标显示 `unavailable → light`**，并在该轮输出顶部给一行提示 | 该命令**拒绝执行**并报错（`/sandbox` 切换时也直接拒绝） |
| system 档运行中后端崩了 | 同上（并审计） | 拒绝执行 |

理由：本项目的既有契约是"沙箱坏了降级为无沙箱，而不是 agent 不能跑命令"（`src/sandbox.js:31-32`）。但**降级必须可见**——这是与 Copilot 在 Windows 上静默全权限运行的区别（调研 §7.8 反面教材）。

### 4.3 Windows（v1 明确不支持，理由与后续路线）

**为什么 v1 不做**：Windows 上没有单一原语可用（调研 §4.4），可行方案都需要**在纯 JS 之外**做事：
- 写受限令牌 + 合成 SID（OpenAI Codex Windows 沙箱的方案）→ 需要 `CreateRestrictedToken`/`CreateProcessAsUser` 等 Win32 调用，Node 里要么写 native addon，要么依赖 srt/MXC 这样的现成件；
- 专用账户 + WFP 出口围栏（Anthropic srt 的方案）→ 创建本地账户与 WFP 过滤器**很可能需要管理员**（**待核实**：srt README 未直说，见 §8.1-2）；
- MXC（AppContainer）→ 引入 `@microsoft/mxc-sdk`（native 资产），且其 README 声明当前 profile 不应视为安全边界（**待核实原文**）。

**v1 行为**：`system` 在 Windows 上视为不可用 → 按 §4.2 处理，并在文案里给出两条**可执行的**替代（不是泛泛的"去用虚拟机"）：
```
本平台暂不支持系统级沙箱（Windows 原生）。
可选：① WSL2 内运行 cowcat（沙箱用 bubblewrap）；
      ② 把 cowcat 跑在 Docker Sandboxes 里：sbx run <agent>
```
**Phase 4 再定终局**（§6、§11-5），候选顺序：评估 srt 的 Windows 路径 → 评估 MXC → 若都不成，长期保持"不支持 + 引导"。

### 4.4 要更强隔离时的外置路径（不做进 v1，但文档要写）

想抗内核 0day / 跑真不可信代码 → 用 microVM 承载整个 agent（Docker Sandboxes 每实例一 microVM、自带 Docker 守护进程、宿主侧代理注入凭据；或本地 microsandbox/libkrun）。我们**不重复实现**，只提供指引（调研 §4.5）。

---

## 5. 架构设计

### 5.1 模块划分

```
agent/src/sandbox.js            （保留，扩为门面：模式归一化 + 策略解析 + 审计，保持现有导出兼容）
agent/src/sandbox/
  probe.js                      preflight：平台探测、后端可用性、失败分类、结果缓存（进程内 + 会话级）
  policy.js                     把配置 + cwd + 平台归一化成"后端无关策略对象"（读/写/网络/env）
  violations.js                 违规收集、归因（commandId）、净化（控制字符/长度上限）、格式化
  proxy.js                      Phase 3：HTTP CONNECT + SOCKS5 白名单代理（v1 不建）
  backends/bwrap.js             Linux：argv 生成 + stderr 解析
  backends/seatbelt.js          macOS：SBPL 生成 + 违规文案
  backends/none.js              "不支持"后端（统一返回带原因的不可用）
```

原则：**产品面（配置/档位/审计/UI）是我们的，后端可替换**（Phase 4 换 srt/MXC 时只换 backend）。

### 5.2 接入点

- 现在：`BashTool.execute()` 里 `classifyCommand` → 危险则拦（fail-closed）→ `sandboxEnv` → `exec(input.command, {cwd, env, timeout, ...})`（`tools/bash.js:44-69`）。
- 改为：把"要执行的命令"抽象成 `{ file, args, env, cwd }`：
  - `off`/`light` → `file = shell`（现状：`exec` 走 shell）；
  - `system` → `file = bwrap` / `sandbox-exec`，`args` 由 backend 生成，命令作为 `--` 之后的 argv 传入（**不再经 shell 拼接**，顺带消掉一类引号注入）。
- **后台任务路径必须同改**：现在 `ctx.background.start(input.command, {...})`（`tools/bash.js:55-58`）接收命令字符串；要让它接收 `{file, args}`（或统一走一个 `spawnCommand()` 抽象）。**待核实**：`background` 模块的既有签名与是否用 shell（需读该模块后定改法）。
- 输出解码保持不变（`decodeOutput`，`tools/bash.js:76-77`）；超时/`maxBuffer` 语义不变。

### 5.3 策略语义（这是最容易做错的地方）

| 项 | 默认 | 优先序 |
|---|---|---|
| 读 | 项目 + 系统目录可读；`~` 下其余不可见；凭据路径**强制拒绝** | deny 更具体者优先（`denyRead: ["**/.env"]` 在 `allowRead: ["."]` 之内仍然被拒）——**与 srt 的语义一致**（调研 §6 引用其 README） |
| 写 | 仅项目可写 | allow-only；`denyWrite` 优先（`.env`、`.git/hooks`、策略文件所在目录） |
| 网络 | 关 | allow-only；`network: 'ask'` 时按命令审批 |
| env | 同 light | light 的脱敏继续生效 |

**具体默认值（v1 提案，需实测调优）**：
- `write.allow`：会话 cwd；**以及 worktree 的同级目录**（`worktree.js:38` 把 worktree 建在项目同级 `<name>-cowcat-<slug>` → 不加上这条，system 档下 worktree 会话直接不可用）；`/tmp` 下的会话临时目录。
- `read.deny`（强制，且优先于 allow）：`~/.ssh`、`~/.config/gh`、`~/.git-credentials`、`~/.cowcat`、`~/.aws`、`~/.gnupg`、`**/.env`、`**/.env.*`。
- `read.allow`：项目目录 + 工具链常见只读路径（`/usr`、`/bin`、`/lib*`、`/etc/ssl`、`/etc/resolv.conf`…）。**待核实**：`~/.gitconfig`、`~/.cache`、`~/.npm` 这类"开发必需品"要不要默认放行——放行会削弱隔离，不放行会破坏 `git commit`/`npm` 的常规使用；建议 v1 **默认放行 `~/.gitconfig`、`~/.npm`、`~/.cache`，凭据类路径始终拒绝**，并用 §8.2 的回归集验证没有把 token 路径带进来。
- **实现手段（Linux）**：`bwrap` 里用"隐藏"而不是"拒绝"——`--tmpfs ~/.ssh`（目录内容不可见）、`--ro-bind /dev/null <file>`（文件变空）。macOS 侧用 SBPL 的 `(deny file-read* (subpath …))`。**待核实**：SBPL 的 allow/deny 具体优先序（`(deny default)` + 更具体 deny 是否压过 allow）——以 srt 的实现为准抄语义，别自己推。

### 5.4 MCP / hooks / statusline（v1 范围外，但必须写明）

- 三家主流 agent 把 MCP 留在沙箱外（调研 §3），我们同样：**MCP server 拿完整权限**。v1 在文档与 `/status` 里明说这一点。
- Phase 3 候选：MCP server 的 spawn 也走 system 后端（更窄策略：只读项目 + 只连它需要的 host）。srt 的旗舰用例正是沙箱化 filesystem MCP，可参考其做法。
- hooks/statusline 是**用户配置**的命令（不是模型生成），优先级更低；同样 Phase 3 再评估。

### 5.5 沙箱外执行与元数据（从调研 §2.3/§2.4 抄来的教训）

1. **我们自己的 git 自动调用必须在沙箱里做，或者先清洗 `.git/config`**（`CVE-2026-19593`：打开仓库即触发 `filter.*.clean`）。→ 处置：v1 在 system 档下，凡由我们发起的 git 子进程也走同一后端；无法覆盖的路径在文档里列出。
2. **可执行名解析顺序**：不要把"会被沙箱外解析的可执行名"落在沙箱内可写目录里（Codex 的 `node.bat` 案例）。→ 处置：system 档下我们 spawn 后端二进制时用**绝对路径**，并把 cwd 设为项目（不放宽 PATH 解析），同时把这条写进回归集（§8.2-c）。

### 5.6 违规反馈与审计格式

- 收集：Linux 解析 `bwrap` stderr（`bwrap: …`）+ 我们注入的探针；macOS v1 用通用文案，Phase 3 再读系统违规日志（**待核实**：srt 走的 sandbox violation log store 需要什么权限）。
- 归因：一次工具调用一个 `commandId`（我们已有工具调用 id），避免长命令前缀相同导致串台（srt 的 100 字符 key 教训，调研 §6）。
- 净化：控制字符/不可见字符替换、长度上限（srt 用 500 字符），再进 UI 与模型上下文。
- 审计（沿用 `~/.cowcat/audit.log` 的 JSONL，`sandbox.js:149`）新增字段：
  ```jsonc
  { "ts":"…", "tool":"Bash", "cwd":"…", "mode":"system", "backend":"bwrap",
    "network":"off", "risk":"low", "decision":"run|blocked|mode-change",
    "violations":[{"kind":"fs-read|fs-write|net|unix-socket","target":"…"}],
    "command":"…" }
  ```
  `decision: 'mode-change'` 用于记录 `/sandbox` 切换（不变式 2 的留痕要求）。

### 5.7 逃生门（业务决策）

- **不加**任何"模型可控的解除参数"（Claude Code 的 `dangerouslyDisableSandbox` 是反例，调研 §2.1）。
- 模型可以**请求**：走现有的审批卡机制（"该命令需要项目外写入/需要网络，是否以 system 档放宽一次？"），用户同意则**只对该次调用**放宽策略，并写审计。
- 用户可以直接 `/sandbox light|off` —— 这是用户的权威，但必须留痕。

---

## 6. 分阶段实施计划

| 阶段 | 内容 | 交付物 | 验收 | 可独立发版 |
|---|---|---|---|---|
| **Phase 0**（低风险，建议立刻做） | 只读探针基线 + preflight + 平台矩阵落地 | `agent/test/live/sandbox-probe.mjs`（测：能否读 `~/.ssh`、能否读 `gh` 令牌文件、env 里能否看到 `*_TOKEN`、能否直连外网、能否在项目外写）；`sandbox/probe.js`；`cowcat doctor` 增加一节 | 探针在 light 档下能给出"现状允许什么"的对照数据；preflight 在三平台给出分类结论 | ✅（无行为变化，仅诊断） |
| **Phase 1** | 档位/配置/策略贯通 + Linux bwrap 后端（**网络默认关**，`network:'ask'` 按命令放行） | `sandbox/policy.js`、`backends/bwrap.js`、`sandboxFor()` 归一化、`/sandbox system`、Bash 卡角标、审计字段 | G1/G2/G3/G5/G6 在 Linux 上通过；G7（项目内 `npm test`、`git status/commit`）通过 | ✅ |
| **Phase 2** | macOS Seatbelt 后端 + 违规反馈打磨 + 对外威胁模型文档 | `backends/seatbelt.js`、违规净化与文案、`docs/` 威胁模型更新 + ROADMAP/USAGE | G1–G3 在 macOS 通过；G4/G8 通过 | ✅ |
| **Phase 3** | 网络白名单（按域名代理）+ macOS 违规日志 + MCP 可选沙箱化 | `sandbox/proxy.js`、MCP spawn 后端接入、`network.allowedDomains` | 白名单生效（含"客户端不认代理也能拦住"的用例）；MCP 用例可用 | ✅ |
| **Phase 4** | Windows 路线决策与落地；后端替换评估（srt/MXC） | 决策记录 + 对应实现或明确的"不支持"结论 | Windows 上要么有可验证的边界，要么有明确指引（G6） | ✅ |

依赖关系：Phase 0 → 1 → 2 顺序；Phase 3/4 可并行；Phase 4 需要 Phase 0 的实测数据（§8.1）。

---

## 7. 与现有实现的差异清单（改动面预估）

| 文件 | 改动 |
|---|---|
| `agent/src/sandbox.js` | 模式归一化（字符串/对象）、`system` 分支、审计字段扩展；保留现有导出与 fail-open 契约 |
| `agent/src/sandbox/*`（新） | 见 §5.1 |
| `agent/src/tools/bash.js` | 抽象 `{file,args}`；system 档走后端；后台任务路径同改 |
| `agent/src/config.js` | `sandbox` 的对象形式默认值/校验（**不新增 state 键**） |
| `/sandbox` 命令实现 | 增加 `system` 档、显示生效档位与 preflight 结论、切换审计 |
| `agent/src/tui/ui.js` | 角标按"实际生效档位 + 后端"渲染（现在只判断 `=== 'light'`，`tui/ui.js:372-379`） |
| `agent/src/slashlist.js` | 帮助文案（现在写死"off 或 light"，`slashlist.js:43`） |
| `docs/` | ROADMAP 威胁模型段、USAGE、本方案与调研文档互链 |
| `agent/test/` | 单元（策略归一化/argv 生成/净化）+ 逃逸回归集（§8.2） |

**不改**：权限系统（`permissions.js`）、Read/Edit/Write、hooks 语义、MCP 协议。

---

## 8. 验证计划

### 8.1 调研 §9 的 8 条待验证项 → 具体步骤

| # | 项 | 步骤 | 期望/判据 |
|---|---|---|---|
| 1 | `@anthropic-ai/sandbox-runtime` 可用性 | `npm view @anthropic-ai/sandbox-runtime engines version dist.unpackedSize`；隔离目录安装并 `srt "curl example.com"` | 明确：支持哪些 Node、体积、是否需管理员（Linux 是否需要 bwrap 之外的依赖） |
| 2 | srt 的 Windows 路径是否需管理员 | 读其 `windows-sandbox-utils.ts` + 文档；在**非管理员** PowerShell 里试 `srt cmd /c echo hi` | 记录失败模式与提示文案 |
| 3 | `@microsoft/mxc-sdk` | `npm view @microsoft/mxc-sdk engines version dist.unpackedSize`；试跑 README 的 Node 片段；核对 README 关于"安全边界"的原句 | 明确 Node 版本、平台资产、README 原句是否如 Riptides 所述 |
| 4 | 本机/CI 的 bwrap 与 userns | WSL2 内：`which bwrap`、`bwrap --unshare-all --ro-bind / / true`；CI（ubuntu-latest）同样跑一遍 | 记录 Ubuntu 24.04 的失败文案与 AppArmor profile 修复后是否通过 |
| 5 | light 档实测基线 | 跑 Phase 0 探针（`agent/test/live/sandbox-probe.mjs`） | 得到"升级前"对照：能否读凭据、能否外联 |
| 6 | spawn 的 cwd 解析顺序 | Win/mac/Linux 各在 cwd 放一个 `node.bat`/`node`，用相对名 spawn，看是否被优先解析 | 复现或排除（决定是否要固定绝对路径） |
| 7 | 代理方案对开发的影响 | system 档 + 白名单下跑 `npm install`、`git push`（ssh 与 https）、`node -e fetch` | 记录哪些客户端必须改（Node fetch 不走代理是已知项） |
| 8 | 性能开销 | 100 次 `true`/`echo`：off vs light vs system（各后端）计时；再跑并行 4 路工具 | 结论写进方案与 USAGE（不要引用别人的数字） |

### 8.2 逃逸/绕过回归集（把调研 §2 的案例变成用例）

| 用例 | 期望 |
|---|---|
| a. 换路径执行被禁二进制（`/proc/self/root/usr/bin/npx` 类） | 不依赖路径黑名单 → 仍受文件系统策略约束 |
| b. cwd 内同名可执行（`node.bat`） | 沙箱外解析不受影响 / 沙箱内不能借此逃出 |
| c. `.git/config` 注入（`filter.*.clean`） | system 档下我们的 git 调用在沙箱内 → 不能执行任意二进制；或明确记录为已知缺口 |
| d. 读 `~/.ssh/id_rsa`、`~/.config/gh/hosts.yml` | 失败 |
| e. 环境变量 `*_TOKEN` 可见性 | 不可见（light 的 `sanitizeEnv` 已覆盖） |
| f. 网络：`curl`、`node fetch`、`nc`、DNS 查询 | 全部失败（不看代理） |
| g. 项目外写：`/tmp`、`~/.cowcat`、兄弟目录 | 失败；worktree 同级目录按策略可写 |
| h. 自行解除沙箱（模型侧无参数；用户审批路径） | 模型无法触发；用户审批路径有审计 |
| i. Unix socket（Docker socket、ssh-agent） | 默认拒绝（Linux 侧靠 seccomp 或路径不可见；macOS 靠 SBPL） |

---

## 9. 风险与回退

| 风险 | 影响 | 处置 |
|---|---|---|
| 上游变动（srt 是 research preview；MXC GA 早期） | 采用它们时会被迫跟进 | v1 不依赖它们；策略层与后端解耦（§5.1） |
| 环境限制（Ubuntu 24.04 AppArmor、RHEL9 内核） | 后端不可用 | preflight 分类 + 可复制粘贴的修复命令；`failOpen` 可控 |
| 性能开销（每命令 +数十 ms） | 高频命令体验变差 | system 是**可选档**；§8.1-8 量化后再定是否给"只对危险命令用 system"的策略 |
| 破坏正常开发（npm install/git push/Node fetch） | 用户直接关掉沙箱 | G7 作为硬验收；网络用 `ask` 而不是死关；文档给"哪些命令需要放行网络" |
| Windows 体验落差 | 用户以为有沙箱 | UI 明确标注（`unavailable → light`）+ 可执行替代路径 |
| 违规文案误导（把"沙箱拒绝"说成"命令写错了"） | 模型反复试错/拆边界 | 违规净化 + 明确措辞（参考 srt 的 `deniedDomainReasons`，给模型"那就改用 X"的指引） |

---

## 10. 本方案与既有承诺的一致性

- ROADMAP 里"轻量 Bash 沙箱（light 档）…护栏不是安全边界…系统级沙箱（容器/命名空间）仍未做"→ 本方案正是把"仍未做"落地，且**不改变 light 档的定位**。
- 既有契约"沙箱坏了降级为无沙箱，而不是 agent 不能跑命令"（`src/sandbox.js:31-32`）→ 由 `failOpen` 保留，但强制"降级可见"。
- "私有公开文档边界"（只把公开文档发给 API）→ system 档的读限制是这条的产品化延续。

---

## 11. 需要拍板的决策点

> **2026-10-16 已拍板：六项全部按推荐。** 即：档位名 `system`（默认仍 `light`）／v1 覆盖 Linux+macOS、Windows 明确不支持并给指引／网络 v1 默认关 + 按命令审批／第三方后端 Phase 4 再定（先跑验证项）／Windows 终局先评估 srt → 再 MXC → 都不成就长期"不支持 + 引导"／违规信息进上下文（只进类别 + 目标路径 + 一句建议）。

| # | 决策 | 推荐 | 备选 | 影响面 |
|---|---|---|---|---|
| 1 | 第三档命名与默认 | **`system`**，默认仍 `light` | `strict`（易与 permissions 的 strict 混淆） | 配置/文档/UI |
| 2 | v1 平台范围 | **Linux + macOS；Windows 明确不支持 + 引导** | 等 Windows 一起做（周期大幅拉长） | 交付时间、Windows 用户体验 |
| 3 | 网络 v1 语义 | **默认关 + `ask` 按命令审批**（不做域名白名单） | 直接上代理白名单（Phase 3 提前，工作量大） | 体验 vs 隔离强度 |
| 4 | 是否引入第三方后端 | **Phase 4 再定**（先跑 §8.1-1/2/3） | 现在就绑 srt 或 MXC | 依赖策略（现为零运行时依赖） |
| 5 | Windows 终局 | **先评估 srt → 再 MXC → 都不成就长期"不支持 + 引导"** | 自研 native 助手（写受限令牌） | 最大不确定性，建议按此顺序验证 |
| 6 | 违规信息是否进模型上下文 | **进，但只进"类别 + 目标路径 + 一句建议"**（净化 + 长度上限） | 只进 UI 不进上下文（模型会反复试错） | 模型行为与体验 |

---

## 12. 下一步

拍板 §11 后，从 **Phase 0** 开始（零行为变化、可立刻验证）：探针基线 + preflight + `cowcat doctor` 诊断节。Phase 0 的产出同时就是 §8.1-1/2/3/4 的实测数据来源，做完再回到 §11-4/5 做后端决策。

**2026-10-16 更新（Phase 0 已落地）**：

- 交付物：`agent/src/sandbox/probe.js`（后端探测与失败分类）、`cowcat doctor inspect` 新增 `[sandbox]` 节、`agent/test/live/sandbox-probe.mjs`（走真实 `BashTool` 的只读基线）、单测 `agent/test/sandbox-probe.test.mjs`（注入式，不依赖宿主装没装 bwrap）。
- **本机（Windows）基线数据**：`~/.ssh`（10 项条目）与 `gh` 令牌文件（88 字节）在 `off`/`light` **两档都可读**；外网可达（`example.com` → 200）；`~/.cowcat` 可写（意味着沙箱内进程能改我们自己的配置与审计 —— §5.7 要防的正是这个）；`light` 档唯一拦住的一项是 env 中 TOKEN 形状的变量。→ Phase 1 的验收就按"这三项必须被拦"来定。
- 平台结论：本机 `win32` → `unsupported-platform`，探测给出的替代路径是 WSL2 / Docker Sandboxes（与 §4.3 一致）。
- 仍未做：§8.1 的 1/2/3/4 项（srt 与 MXC 的可用性实测）留待 Phase 4 决策前跑；本机没有 WSL2 环境，bwrap 的真实探测需在 Linux/WSL2 上执行。

**2026-10-16 更新（Phase 1a 已落地，Phase 1b / Phase 2 未做）**：

- 档位贯通：新增 `system` 档，默认仍是 `light`；配置沿用既有 `sandbox` 键（字符串或对象），`{envDeny}` 兼容。策略在 `src/sandbox/policy.js`（读 deny-then-allow、写 allow-only、网络默认关、`failOpen`）。
- Linux 后端：`src/sandbox/backends/bwrap.js`（纯 argv，**workspace 读档从空根只 bind 允许面**；拒绝路径用 `--tmpfs` / `--ro-bind /dev/null` 隐藏；写拒绝回绑只读；网络关用 `--unshare-net` 而非环境变量）。
- 违规反馈与 UI 诚实：`src/sandbox/violations.js` + Bash 卡角标显示**实际生效**档位（`system · bwrap` / `NOT sandboxed (system unavailable)`）+ `/sandbox` 显示探测结论与修复命令、切换写审计。
- 测试：`test/sandbox-system.test.mjs` 26 条纯逻辑；`test/sandbox-linux.test.mjs` 6 条真实拦截断言（无 bwrap 时按分类 skip）；CI Linux 腿安装 bubblewrap 并按本文档的 AppArmor 步骤加载。
- **验证状态**：已在 CI 的**真实 Linux**（ubuntu-latest，node 20/22/24）通过全部 6 条拦截断言——G1（项目外写不落到宿主）、G2（宿主 home 与宿主 /tmp 的文件都不可达，且错误里点明是沙箱）、G3（Node 的 fetch 也被拦，证明网络控制不依赖代理环境变量）、凭据路径隐藏、审计字段。本机 Windows 上同一套断言按分类 skip（`no bwrap backend on win32`）。
- **CI 首跑抓到两个真问题**（这就是"CI 作为权威验证"的收益，本地 6 条断言全 skip 时它们是看不见的）：① 默认写集含宿主临时目录，在私有 `--tmpfs /tmp` 之后又把宿主 `/tmp` 绑回来，于是宿主 `/tmp` 重新可见可写；② G1 的断言口径写错了——沙箱必须在空根里合成 `/home/<user>` 才能挂载允许的 home 文件，"在沙箱内写 home 必失败"这个前提本身不成立，正确的不变量是"宿主文件系统未被改动"。两处均已修，并补了单测（策略默认写集**不含**宿主 tmpdir）。
- **已知抖动**：两条 TUI 定时测试（`toast` 15–60ms 窗口、`chrome` 的 15ms 等待）在高负载 runner 上会偶发失败，与本功能无关（重跑即过）；顺带把 Bash 角标改成 probe-free（light/off 不再触发探测），避免在帧渲染里同步 spawn 进程。
- 仍未做：macOS Seatbelt（Phase 2）、Windows 原生（Phase 4：不支持 + 引导，或评估 `@anthropic-ai/sandbox-runtime` / `@microsoft/mxc-sdk`）、glob 路径规则（收集进 `unsupported` 并提示）。

**2026-10-16 更新（Phase 1b 与 0.15.0 发布）**：

- Phase 1b 已落地：`network: 'ask'` 现在是**按命令审批**——只有用户在这次审批里点头的那条命令拿到网络命名空间，且只对该次调用生效；粘性只来自权限层的显式 `always`；**yolo 下 `ask` 等同 `off`**（不问 = 不给）。卡片对需要联网的命令标注 `[needs network: sandbox]`，审计记录该次实际网络态。端到端断言已在 CI 真实 Linux 通过（未批准的 fetch 失败、批准的 fetch 得到 200、审计连续 `off`/`on`）。
- **0.15.0 已发布（2026-10-16）**：Phase 0/1a/1b 随 `v0.15.0` 上线（tag `v0.15.0` → `9ff23ae`；registry `dist.shasum = 7c6fc55d042effdaeb24c496a36448202387b9ad`、`fileCount = 107`）。发布前演练与发布后核对（官方源隔离安装、包内 probe 平台判定、CMap 自检）全部通过，记录见 `docs/fix-plan-2026-10-15.md` 第十八轮的「发布结果」。
