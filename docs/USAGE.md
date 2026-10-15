# CowCat 使用说明

CowCat 是一个跑在你自己终端里的 CLI 编程 Agent（国产模型适配的 Claude Code 代替版）。零运行时依赖，Node >= 20。

## 安装与全局启动

```bash
# 方式一：把 <repo>/bin 加入 PATH（shim 用脚本自身位置解析路径，仓库放哪都行）
export PATH="<repo>/bin:$PATH"
cowcat --version

# 方式二：npm link（agent/ 自带 bin 字段）
cd agent && npm link
```

Windows 下 `bin/cowcat.cmd` 提供同款入口。

## 配置

CowCat 内置一份从 models.dev 蒸馏的预置目录（`agent/assets/providers.json`，209 个 provider / 907 个模型，仅保留 anthropic 与 openai 两种协议的 provider）。配置按层合并，后者覆盖前者：

```
默认值 < 预置目录 < ~/.cowcat/config.json < 项目 .cowcat/config.json（从 cwd 向上找最近一个）
        < 环境变量（COWCAT_*，过渡期 CC_* 仍有效）< CLI 参数（-m/--model）
```

核心字段是复合模型引用 `model: "provider/model"`；provider 条目与预置同 id 时**深合并**（补丁式），新 id 则新增自定义 provider。

```bash
cowcat setup     # 预置目录驱动的交互向导：过滤选 provider → 选模型 → 读 key → 确认写入
cowcat doctor    # 逐项 ✓/✗：model 引用可解析 / protocol / baseURL / API key（点名缺哪个 env 变量）/ 模型在目录内 / 连通性探测
```

向导里输入过滤词缩小列表、编号选择；`✓` 标记已配置的 provider（apiKey 已存或其环境变量已存在）；选 `custom` 走自定义端点流程（protocol 二选一 + 自由 baseURL）。非交互环境（stdin 无输入）自动按当前环境变量写入。`/setup` 在会话内重跑向导并热生效。

### ~/.cowcat/config.json 示例

```jsonc
{
  // 复合引用；切换模型也可在会话内 /model（TUI 弹窗）或直接改这里
  "model": "deepseek/deepseek-chat",
  "small_model": "deepseek/deepseek-flash",   // compact 摘要用的轻量模型（可选）

  // provider 补丁：与预置同 id 深合并；apiKey 支持 {env:VAR} / {file:相对路径} 替换
  "providers": {
    "deepseek": {
      "apiKey": "{env:DEEPSEEK_API_KEY}"
    },
    // 新 provider：protocol 必填（anthropic|openai），有 baseURL 时默认 openai
    "my-gateway": {
      "protocol": "openai",
      "baseURL": "https://gw.example.com/v1",
      "apiKey": "{file:creds.txt}",            // 相对本配置文件目录
      "env": ["MYGW_KEY"]                       // 追加环境变量名到探测链
    },
    // canonical 别名：克隆 kimi-code-plan-cn 的定义再修补
    "kimi-office": {
      "canonical": "kimi-code-plan-cn",
      "apiKey": "sk-..."
    },
    // 模型级补丁：扩充目录、覆盖显示名/上限、disabled 下架预置模型
    "anthropic": {
      "models": {
        "claude-sonnet-5-5": { "disabled": true },
        "my-fine-tune": { "name": "My Fine-tune", "limit": { "context": 200000, "output": 8192 } }
      }
    }
  },

  "maxTokens": 32000,           // 单次回复上限
  "maxContextTokens": 100000    // 估算 token 超过即触发自动 compact（上下文分母优先用目录 limit.context）
}
```

apiKey 解析顺序：`providers.<id>.apiKey` → 旧扁平 `apiKey`（自动迁移，见下）→ 该 provider 的环境变量链（预置 env 名 + 用户 `env` 追加）中第一个非空值。模型校验只在**无自定义 baseURL** 时强制——自建网关可服务任意模型名，目录管不着。

环境变量（`COWCAT_*` 优先，`CC_*` 过渡兼容）：`COWCAT_PROVIDER`、`COWCAT_BASE_URL`、`COWCAT_API_KEY`、`COWCAT_MODEL`（接受 `"provider/model"` 复合引用，裸模型名按当前 provider 解析）、`COWCAT_SMALL_MODEL`、`COWCAT_MAX_TOKENS`、`COWCAT_CACHE=off`。未配置 API key 时交互启动跳过连通性探针并打印配置引导。Kimi Code 端点：`COWCAT_PROVIDER=anthropic COWCAT_BASE_URL=https://api.kimi.com/coding COWCAT_MODEL=kimi-for-coding`。

项目级配置：在仓库任意层级放 `.cowcat/config.json`（如锁定团队统一模型），从 cwd 向上取最近一份；家目录那份是全局层，不会被误当项目配置。

运行时状态（installId、trustedProjects、mcpTrusted、theme、statusLine、hooks、permissions）独立存放在 `~/.cowcat/state.json`——config.json 只放配置。

### 从旧版本迁移

旧扁平配置无需改动，加载时自动归一化：`{provider, baseURL, apiKey, model}` 中的端点字段会作为补丁打到对应 provider 条目上，裸模型名在其 provider 的目录内校验（不在目录会报清晰的 ConfigError 并提示可用模型）。下次 `cowcat setup` 写入时会落成新 schema（复合引用 + providers 补丁），残留的 state 字段自动搬进 state.json。想加目录里没有的 provider？在 `providers` 里新增条目（protocol + baseURL + apiKey）即可，`= 自建网关` 场景不受模型校验限制。

## 日常使用

```bash
cowcat                          # 交互 REPL
cowcat "阅读 src/index.js 并说明它做了什么"   # 一次性任务（--print 直接打印结果）
cowcat -p "..."                 # 非交互打印模式：审批自动拒绝（绝不等待 stdin），权限受阻退出码 2
cowcat -y "..."                 # 自动批准所有工具（谨慎）
cowcat -c                       # 恢复本项目最近一次会话（--continue）
cowcat --resume                 # 列出本项目全部会话，输入编号恢复
cowcat --resume <file.jsonl>    # 恢复指定会话文件
```

- 会话保存在 `~/.cowcat/projects/<项目slug>/<时间戳>.jsonl`，文件头部记录 cwd。
- 启动时自动从 cwd 向上查找 `COWCAT.md` → `AGENTS.md` → `CLAUDE.md`（第一个命中），作为项目指令注入 system prompt。
- 内置 28 个工具：Read（文本/**图片/PDF/notebook**）/ Edit / **NotebookEdit** / Write / Glob / Grep / Bash / TodoWrite / AskUserQuestion / Agent / **WebFetch**（抓 URL，HTML 转可读文本）/ **WebSearch**（DuckDuckGo 免费搜索，支持域名过滤）等，另有 MCP 动态注册的工具。

## 读图 / PDF / Notebook

`Read` 不只读文本：

| 文件 | 行为 |
|---|---|
| 图片（png/jpeg/gif/webp） | 作为图片块交给模型，返回 `[image] a.png — image/png, 1200x800, 234.5 KB (attached for the model)`；上限 5MB |
| PDF | Anthropic 协议走原生 `document` 块；OpenAI 兼容协议走 best-effort 文本抽取（带质量门，抽不出可读文本时明确报错而不是喂乱码）；上限 10MB |
| `.ipynb` | 按单元格渲染（`--- cell [n] type ---` + 编号源码 + `--- output [n.m] ---`）；输出里的图片只标注大小，不上传 |
| bmp / tiff / ico / avif / heic | 明确拒绝，提示先转换 |

- **图片字节不进会话文件**：Read 只登记「引用（绝对路径 + 媒体类型 + 大小 + token 估算）」，真正读盘发生在发请求那一刻。这样会话 JSONL、`/export`、compact 摘要、`/context` 都不会被 base64 撑爆；文件事后被删或变大，该附件自动降级成一行文字占位（`[image unavailable: …]`），不会让整个请求失败。
- **视觉能力门控**：按 `assets/providers.json` 里模型的 `attachment` 标记判断。目录标记 `attachment: false` 的模型，Read 直接拒绝并说明两条出路（`/model` 换视觉模型 / `COWCAT_VISION=force` 强制尝试）；模型不在目录里则先尝试，上游报错会被翻译成「该模型可能不支持图片输入」的提示；也可用 `COWCAT_VISION=off` 主动关闭。**注意**：抽不出的 PDF、被拒绝的图片都以 tool_result 报错回给模型，模型可以据此换路径。
- 图片按 Anthropic 的 `宽×高/750` 估算 token 并计入 `/context`（**长边先按 Anthropic 规则缩到 1568px 再计**，否则 4K 截图会被高估数倍）；PDF 按页数估算。
- 图片、PDF、notebook 都是**整份读**，`offset`/`limit` 对它们无效（返回里会注明）。

`NotebookEdit` 按 cell 索引修改 notebook：

```
NotebookEdit(notebook_path, cell_index, edit_mode=replace|insert|delete, new_source?, cell_type?)
```

- `insert` 把新单元格放在 `cell_index` 处（原单元格顺延），`cell_index` 等于单元格总数时追加到末尾；`delete` 删除该索引。
- insert/delete 之后后续索引会移动，工具返回里会提示「re-Read the notebook」。
- 改 `cell_type` 为 code 会保留一个空 `outputs`（重新运行是模型/内核的事），改成非 code 会丢弃过期的 outputs/execution_count。
- 与 Edit 一样要求「先 Read 后写」；走审批卡（diff 以**渲染后的单元格**形式展示）、写前 checkpoint、plan 模式拒绝、acceptEdits 档自动接受。

## REPL 斜杠命令

| 命令 | 作用 |
|---|---|
| `/init` | 用一次只读 LLM 调用探索项目并起草 COWCAT.md，确认后写入 cwd |
| `/setup` | 就地重跑配置向导并热生效（下一次对话即用新 key/模型，无需重启） |
| `/rewind` | 列出文件检查点（Edit/Write 前自动快照），确认后回滚代码+对话 |
| `/compact [指令]` | 压缩上下文；可带自定义压缩指令透传给 summarizer |
| `/cost` | 本会话统计：轮数/工具数/真实 usage 累计（input/output/cache 分开）+ 额度消耗参考（估算） |
| `/status` | 版本/provider/脱敏 baseURL/模型/权限模式/信任状态/上下文占用% |
| `/export [文件]` | 会话导出为可读 markdown（走审批） |
| `/fork [名称]` | 会话分叉：复制 session 为新会话，原会话不受影响 |
| `/todos` | 查看当前 todo 列表 |
| `/theme dark\|light` | 切换 ANSI 配色，立即生效并持久化 |
| `/panel` | 开关右侧信息面板（Context 用量/模型/权限模式/MCP/todos；同 ctrl+b，<100 列自动隐藏），两条路径都会把开关状态持久化到 state.json |
| `/sandbox off\|light` | Bash 沙箱档位切换（默认 light：secret 脱敏 env + 命令分级 + `~/.cowcat/audit.log` 审计；护栏而非安全边界），持久化 |
| `/plan` / `/act` | Plan（只读探索+出计划）与 Act（执行）模式切换 |
| `/diff` | 展开本回合各文件的完整 diff |
| `/output` | 查看最近一次 Bash 的完整输出 |
| `/model <名>` | 切换模型 |
| `/clear` / `/exit` | 清会话 / 退出 |

审批提示支持 `y` / `n` / `always`（always 记住同类操作）。危险命令会高亮警告。

## 记忆系统

启动时自动把以下来源注入 system prompt（标注 `# Memory (<层级>: <路径>)`，同一文件只注入一次）：

- **user 级**：`~/.cowcat/CLAUDE.md`
- **项目级**（从 cwd 向上逐级，止于 home/盘符根）：`CLAUDE.md`、`.cowcat/CLAUDE.md`、`.cowcat/rules/*.md`（多文件按文件名排序）
- 既有项目指令（`COWCAT.md` → `AGENTS.md` → `CLAUDE.md` 首个命中）保留，与新体系合并去重

规则：单文件超 10000 字符截断；文件不存在一律跳过、不自动创建；`COWCAT_DISABLE_MEMORY=1` 跳过全部记忆加载。`/memory` 交互选择层级并打印路径+内容（文件不存在则创建带模板头的文件，用外部编辑器编辑）；`/memory add <一行文字>` 直接追加到 project 级（走审批）。

## 权限规则

`~/.cowcat/config.json` 的 `permissions: { allow: [], deny: [], ask: [] }` 配置持久规则，语法：

```
Bash                    # 整个工具
Bash(npm run test)      # 命令精确匹配
Bash(npm run test:*)    # 前缀匹配（边界为空格/冒号/斜杠，也命中裸命令）
Edit(src/**)            # 路径工具支持 glob
```

优先级 **deny > ask > allow > 默认行为**；**yolo 模式下规则不生效**。加载时逐条校验，坏规则跳过并中文告警（带第几条与原因），不阻断启动。`/permissions` 查看三列与语法；`/permissions add <allow|deny|ask> <规则>` 与 `/permissions remove <列> <序号>` 在线增删、立即持久化生效。

## 目录信任

首次在某个目录启动时，CowCat 会询问 `Trust the files in <cwd>? [y/N]`：

- **y**：cwd 写入 `~/.cowcat/state.json` 的 `trustedProjects`，以后该目录直接放行。
- **n / 回车**：不写入，本次会话进入只读 plan 模式（状态栏 `mode: plan [受限]`）；`/act` 需再确认一次"Trust this folder for this session?"才会放行（仅本次）。
- `-p` 非交互：不提问，未信任目录一律按只读处理（写工具自动拒绝）；`-y` 不覆盖信任。

## 测试与抓包调试

```bash
cd agent && node --test 'test/**/*.test.mjs'   # 全量测试
bash tools/run-ccagent-kimi.sh "..."           # 走日志代理的 live 冒烟（抓包在 logs/cowcat-capture/）
```

详见 `agent/test/e2e-proxy.md`。

## hooks

在 `~/.cowcat/state.json` 的 `hooks` 字段配置，8 个事件：`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`UserPromptSubmit`、`Stop`、`SessionStart`、`SessionEnd`、`PreCompact`。

```json
{
  "hooks": {
    "PreToolUse": [
      { "type": "command", "command": "node ~/.cowcat/hooks/guard.js", "timeout": 10 },
      { "type": "http", "url": "https://hooks.example.com/audit", "async": true }
    ],
    "Stop": [{ "type": "command", "command": "notify-send 'cowcat done'", "once": true, "async": true }]
  }
}
```

- `command`：经 shell 执行，stdin 收到 JSON 事件载荷（工具名/输入/输出/会话路径/cwd）；stdout 非空或非 0 退出会让 **PreToolUse 拒绝该工具调用**（首行作为原因回灌模型）；超时默认 60s 后 SIGKILL。
- `http`：POST JSON；2xx 放行，4xx 拒绝（body 首行为原因），网络错误放行但打印警告。
- `once` 执行一次后自动从配置移除；`async` 不阻塞主流程；hook 执行不弹审批；`COWCAT_DISABLE_HOOKS=1` 全关。
- `/hooks` 查看，`/hooks disable|enable <事件> <序号>` 开关，`/hooks test <事件>` 手动触发并打印载荷与结果。

## MCP

配置写在 `~/.cowcat/mcp.json`（user 级）或项目 `.cowcat/mcp.json`（项目级同名 server 覆盖）：

```json
{ "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "env": {} },
    "remote":     { "url": "https://mcp.example.com/sse" }
} }
```

启动时依次连接（单 server 失败不拖垮整体）；工具动态注册为 `mcp__<server>__<tool>`，并可用权限规则预授权/预拒绝（如 `/permissions add allow mcp__filesystem__read_file`）。首次连接新 server 需交互批准，信任记录在 state.json 的 `mcpTrusted`——**按机器记、跨项目共享**（与目录信任不同，不绑定具体项目）；`-p` 等非交互模式不会弹出批准，未信任的 server 一律跳过（需预置 state.json 才能使用）。`/mcp` 查看状态与工具数，`/mcp reconnect <名>` 重连；CLI 退出时统一关闭所有 server 进程（POSIX：SIGTERM，宽限期后 SIGKILL；Windows：`taskkill /T` 回收整棵进程树）。

**平台注意**

- **Windows**：`"command": "npx"`（或 `npm`/`yarn` 等其他 `.cmd` shim）会被自动转交 `cmd.exe /c` 启动——Node 不能直接 spawn `.cmd`，直接调用会得到 `spawn npx ENOENT`。绝对路径与 `.exe` 仍走原路径，不受影响。这类启动方式下 server 是 `cmd → npx → node` 的孙进程，因此关闭时必须用 `taskkill /T`；直接用 `"command": "cmd", "args": ["/c", "npx", ...]` 写进配置也可以，同样会被整树回收。
- server 启动即失败时，报错会带上它**最后一行 stderr**（例如 `Missing API key`、`unknown option`），不再只有 `server exited (code 1)`。
- MCP 工具一般按**非只读**处理：未信任目录下 `-p` 会锁进只读 plan 模式，此时 MCP 工具调用会被拒绝（先信任目录，或交互 `/act`）。这是有意为之——MCP 工具是任意 RPC，可能写入。唯一的例外是**读取类**工具 `ListMcpResources` / `ReadMcpResource`（只读，plan 模式下照常可用）；`SubscribeMcpResource` / `UnsubscribeMcpResource` 会改 server 侧订阅状态，仍需授权。

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `COWCAT_MCP_TIMEOUT` | 60000 | 单次请求超时（ms），连接与调用各自计时 |
| `COWCAT_MCP_CONNECT_BUDGET` | 120000 | 整个连接阶段的总预算（ms）：预算用尽后剩余 server 直接跳过，单个挂死 server 也受剩余预算约束，不会各自等满单次超时 |
| `COWCAT_MCP_KILL_GRACE` | 3000 | POSIX 下 SIGTERM 到 SIGKILL 的宽限期（ms），用于让 server 收尾 |
| `COWCAT_MCP_LOG_LEVEL` | info | 连接时向 server 请求的日志级别（`logging/setLevel`）；server 未声明 logging 能力则不发该请求 |
| `COWCAT_MCP_STREAM_RETRY_MS` | 1000 | server→client 长连接断开后的首次重连延迟（ms），之后指数退避、上限 30s |
| `COWCAT_MCP_STREAM_ATTEMPTS` | 5 | 长连接连续重连失败多少次后放弃（只报一次错误） |

**真实 server 联调**（可选，需要联网）：`agent/test/live/` 下有 6 个针对官方 server/SDK 的实测脚本（真实文件系统 server、真实 Streamable HTTP session、keep-alive 与「应答后不关流」的服务器、resources/prompts 对照、server→client 通道与断线复播、CLI 端到端），不在 `npm test` 里，用法见 `agent/test/live/README.md`。

**当前支持的 MCP 能力**：tools（`mcp__<server>__<tool>`）、静态 resources（`ListMcpResources` + `ReadMcpResource` → `resources/list` + `resources/read`）、resource templates（`ListMcpResources` 里以 `template <uriTemplate>` 列出，模板本身不可枚举，用具体 URI 交给 `ReadMcpResource`）、prompts（作为斜杠命令暴露，见下）、资源订阅（`SubscribeMcpResource` / `UnsubscribeMcpResource` → `resources/subscribe` / `resources/unsubscribe`）、server→client 通道（见下）。

**MCP prompts 即斜杠命令**：连接的 server 若提供 prompts，启动时会发现并列成 `/mcp__<server>__<prompt>`，可在斜杠菜单里补全、在 `/help` 的「MCP prompts」段看到参数提示。参数按 `prompts/list` 里声明的顺序**位置对应**（`/mcp__fake__greet <name>` → `arguments.name`），缺必填参数会本地报错、不会发出请求。prompt 返回的多条 message 会展平成一条 user 消息（非 user 角色会加 `[assistant]` 之类的标签，不冒充模型说的）。

**server→client 通道**（Streamable HTTP 用 `GET` + SSE 长连接；stdio 本来就在同一条管道上收）：

- **logging**：连接时若 server 声明 logging 能力，会发一次 `logging/setLevel`（级别取 `COWCAT_MCP_LOG_LEVEL`，默认 `info`）——规范允许 server 在客户端没设级别时保持沉默，不发这一请求往往就永远收不到日志。之后每条 `notifications/message` 打一行 `ⓘ [server] level: …`（TUI 走 toast）。
- **`*/list_changed`**：自动重新拉取该 server 的 tools/prompts，**先注销旧 `mcp__<server>__*` 再注册**（否则 server 删掉的工具会一直留着、改了的 schema 不生效），并刷新 `/help` 与斜杠补全；短时间内的多次通知合并成一次刷新。
- **`resources/updated`**：只对**订阅过**的 URI 提示一行（带上订阅时写的 `reason`），未订阅的更新静默——server 想发什么是它的事，不该变成噪声。
- **断线重连**：长连接断开后按退避重连（首次 `COWCAT_MCP_STREAM_RETRY_MS`，之后指数增长、上限 30s、最多 `COWCAT_MCP_STREAM_ATTEMPTS` 次），并带上 `Last-Event-ID`，支持复播的 server 会补发断线期间的消息。server 回 404/405 表示它不提供该端点，客户端只探一次、不再重试。
- **server 发起的请求**：`sampling/createMessage`、`elicitation/create`、`roots/list` 一律回 `-32601 Method not found`（`ping` 回空结果）。规范要求客户端给出回应，沉默会让 server 一直等。

**仍未支持**：sampling / elicitation / roots（server 反向调用模型或终端，目前只回 error）、`SubscribePolling`（客户端定时轮询）、OAuth 授权的 server。详见 `docs/fix-plan-2026-10-15.md` 第七至九轮。

## 自定义 commands / agents / skills

目录约定（user 级 `~/.cowcat/` 与项目级 `.cowcat/`，项目同名覆盖 user）：

**commands** — `commands/<名>.md`：frontmatter（`---` 包围）支持 `description`、`allowed-tools`（逗号分隔，可选）、`model`（可选）、`argument-hint`（可选）；正文是 prompt 模板，`$ARGUMENTS` 会被 `/名 参数...` 的参数替换。执行即把展开后的模板作为一条 user 消息送入当前会话。与内建命令重名时内建优先；`/help` 单独列出"自定义命令"组。

**agents** — `agents/<名>.md`：frontmatter 支持 `description`、`tools`（逗号分隔白名单，不写=继承全部）、`model`；正文是该角色的 system prompt。通过 Agent 工具的 `subagent_type` 参数调用（先查自定义、再查内建 scout/plan/general/verify）。`/agents` 列出全部角色。

**skills** — `skills/<名>/SKILL.md`：frontmatter 含 `name`、`description`。按需加载：启动只在 system prompt 注入索引（名字+一句话描述）；模型用 Agent 工具的 `skill` 参数调用时，SKILL.md 正文注入子代理执行。`/skills` 列出索引。

```markdown
---
description: 审查当前改动的风险
argument-hint: [关注点]
---
请审查当前 diff，重点关注 $ARGUMENTS。
```

Agent 工具新增参数：`subagent_type`（角色名）、`skill`（技能名）、`resume`（子代理会话 JSONL 路径，续跑）、`model`、`max_turns`。

## 后台任务

Bash 工具传 `run_in_background: true` 立即返回任务 id（`已后台启动 task_xxx，用 TaskOutput 查看`）：

- **TaskOutput** `{task_id, block?, timeout?}` — 非阻塞返回当前输出快照（running: true 表示还在跑）；`block: true` 等待完成或超时。输出截断 20000 字符。
- **TaskStop** `{task_id}` — SIGKILL 并返回最终输出摘要。
- `/tasks` 列出活动任务（id/命令/时长/状态），`/tasks kill <id>` 停止。

CLI 退出时未完成的后台任务全部强杀（Windows 下整树杀灭，无孤儿进程）；超时上限仍 600s。

## 输出样式与 statusline

**output-styles**：`~/.cowcat/output-styles/<名>.md` 或项目 `.cowcat/output-styles/<名>.md`（项目覆盖同名），frontmatter 只写 `description`，正文是风格指令（如"先结论后细节"）。`/output-style` 列出（`*` 标注当前），`/output-style <名>` 热生效（下一 turn 即注入 system prompt 尾部）；默认无样式。

**statusline**：state.json 加 `statusLine: { "command": "..." }`，状态栏右侧追加该命令的首行输出。命令经 shell 执行，stdin 收一行 JSON `{"model":"...","mode":"...","ctx_pct":42,"cwd":"..."}`，2s 超时静默跳过（绝卡不住 UI）。`/statusline` 查看、`/statusline set <命令>` 设置、`/statusline clear` 恢复默认。

## REPL 键位

- **↑ / ↓**：召回本会话输入历史（编辑到一半的线会先暂存）。
- **Tab**：`/` 开头时循环补全内建+自定义斜杠命令；其它位置插入两个空格。
- **shift+tab**：act ↔ plan 权限模式切换（等价 /plan 与 /act 的来回），切走时记住当前模式、切回时恢复——`-y` 起的会话看一眼 plan 再切回来仍是 yolo，`ExitPlanMode` 得到的 acceptEdits 同样不会被静默丢掉。模式 chip 即时刷新并有 toast 提示。**未信任目录**下不生效（保持只读锁，唯一出口仍是有确认弹窗的 `/act`）。

非 TTY（管道/重定向）下键位全部静默禁用，行为不变。

## 结构化输出（-p 模式）

```bash
cowcat -p --output-format stream-json "任务"        # 纯 NDJSON 事件流：system/assistant/tool_use/tool_result/result/error
cowcat -p --output-schema '{"type":"object","required":["answer"],"properties":{"answer":{"type":"integer"}}}' "..."
cowcat -p --max-turns 10 "..."                       # 回合上限，超限 exit 4
```

- `stream-json` 与启动行等装饰输出互斥，stdout 只有事件行。
- `output-schema` 用内置 mini 校验器（type/object/required/properties/items/enum/字符串长度等）；校验失败自动把错误回喂模型重写一次，仍失败 exit 3。权限受阻 exit 2。

## P2 第二波

- `/ide` — IDE 集成状态：检测到的 IDE（VS Code/Cursor/JetBrains）、JSONL 事件通道（`COWCAT_IDE_PIPE=<路径>`，扩展端 tail 该文件即可收到 `file_edited` 事件）、本会话事件数。
- `/worktree [名]` — 创建 git worktree（`../<repo>-cowcat-<名>`，分支 `cowcat/<名>`）并把会话切入；`/worktree list` 列出。Agent 工具传 `isolation: "worktree"` 可让子代理在独立 worktree 里跑。
- **lead 角色** — `subagent_type: "lead"` 的团队编排：它会按 scout/plan/general/verify 分工派发、整合报告并对结果负责（可嵌套一层子代理）。
- `cowcat -p --background "长任务"` — 后台执行：立即返回任务 id，日志与结果在 `~/.cowcat/background/<id>/`；完成时系统通知（Windows 气球提示，无 GUI 静默）。

## 全屏 TUI（0.8.0，v0.10.0 全面翻新）

在交互式真实终端（Git Bash / PowerShell / Windows Terminal / cmd）中直接运行 `cowcat` 即进入全屏界面：

- **布局**：无顶部栏；中部 transcript（帧 diff 增量重绘；工具块 spinner → ✓ / ✗ / denied 删除线三态 + 可展开折叠体，输出按行数+字符数双预算折叠保留尾部；用户消息 brand 竖线气泡；模型输出流式 markdown 渲染，回合页脚 `✻ for Ns · model`；向上滚动时底部浮现 `↓ PgDn to jump to latest` 提示）；底部输入区（metadata 行 `model · mode`（mode warning 加粗）、**左边框 composer**（`▎` brand 竖线 + raised 背景，无上下横线/右边框，空态 placeholder 每 10s 轮换，多行 Ctrl+J/shift+enter，限高 max(6, 高/3) 超出滚动），补全菜单以**内容宽度**（≤60 列）浮层紧贴输入框上方）；状态栏（左 `~/dir:branch` 或流式 spinner+`esc interrupt`；右 `tokens (pct)` · 成本 · 键位提示，窄宽度自右向左裁剪——cwd/model 不重复出现）。
- **审批**：工具请求以 PermissionPrompt 占据输入区——`△ Permission required` 头部 + 工具描述 + 编辑类工具内嵌可滚动 diff 预览 + pill 选项（Allow once / Allow always / Deny），`←→` 或 `h/l` 循环、`enter` 确认、`esc` 拒绝；同时保留一张可 ctrl+o 展开的 transcript 记录卡。
- **键位**：↑/↓ 历史（空输入时含持久化历史）、Tab/`@` `/` 触发补全浮层（前缀×2 + frecency 打分，输入框上方浮出）、shift+tab 切 plan/act、Ctrl+A/E/K/U/W、alt+F/B 与 Ctrl+←/→ 按词移动、home/end、Ctrl+J 或 shift+enter 换行、Enter 发送、行首 `!` 进入本地 shell 模式、`←→/enter/esc` 操作审批 pill、shift+↑/↓ 与 PgUp/PgDn 滚动 transcript、ctrl+o 循环展开卡片、**Esc 二次确认中断**（5 秒内再按一次才生效）、**ctrl+p** 命令面板、**ctrl+g** 最近会话列表、**ctrl+b** 开关右侧面板、**?** 键位一览、`/theme` 打开主题选择弹窗（实时预览，esc 回滚）。
- **主题**：`/theme dark|light` 语义色 token 双主题，TUI 全界面即时生效（含输入框边框、气泡、工具块配色）。
- **降级**：管道/CI、`-p`、`--output-format stream-json`、`NO_COLOR` 自动使用原线性模式；`COWCAT_TUI=off` 可强制关闭全屏；`COWCAT_ANIMATIONS=off` 关闭 spinner 动画（静态帧、无周期重绘）。
