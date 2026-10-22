# `1.0.0-beta.2` 反馈期验收清单

> 目标：判断 `1.0.0-beta.2` 是否稳定到可以把 npm `latest` 从 v1 `0.15.0` 切到 1.0.0。
> 范围：**已发布的 beta 产物**，不是源码单元测试的替代品。
> 记录日期用绝对日期；没实际跑过的项不要勾。

## 0. 基本规则

- 安装/验证一律指定官方 registry：`--registry=https://registry.npmjs.org`。本机默认的 npmmirror 有同步延迟，`npx @beta` 可能仍解析到上一版。
- 任何会改配置或写仓库的测试，优先用临时 `COWCAT_HOME` 或临时目录。
- **不要贴 key**：反馈里只写环境变量名，不写值。
- 每个问题记录：版本、平台、Node、`COWCAT_HOME` 类型、复现命令、预期/实际、证据（doctor 输出、会话 id、错误行）。
- 优先级：**P0** 数据丢失/密钥泄漏/锁不释放/沙箱绕过；**P1** 主要路径不可用；**P2** 体验、文案、性能。

## 1. 安装与配置迁移

### 1.1 安装

```bash
R=https://registry.npmjs.org
npm i -g @corescense/cowcat@beta --registry=$R
cowcat --version
cowcat doctor
```

- [x] `cowcat --version` = `1.0.0-beta.2`
- [x] `doctor` 没有因缺配置崩溃；未配置模型时是 `not-configured` 而不是 FAIL
- [x] `cowcat setup --preset anthropic/claude-sonnet-5-5 --print` 能输出 v2 配置且不落盘

### 1.2 v1 配置迁移（先在临时 home）

```bash
TEST_HOME=$(mktemp -d)
cp ~/.cowcat/config.json "$TEST_HOME/"
COWCAT_HOME="$TEST_HOME" cowcat setup --migrate
COWCAT_HOME="$TEST_HOME" cowcat doctor
```

- [x] 生成 `config.json.bak`
- [x] 新配置不含 `apiKey` 值，只含 `apiKeyEnv`
- [x] `model.preset` / `model.providers` 形状正确
- [x] `mcp.json` 的 `mcpServers` 进入 `mcp.servers`；含 `env` 的条目有明确警告
- [x] `permissions` 未静默丢弃，有警告
- [x] `doctor` 的模型、endpoint、key 行正确
- [x] 把 `.bak` 还原后，v1 原文件仍可用（回滚演练）

确认后再对真实 home 执行一次，并保留备份。

### 1.3 从源码

- [x] protocol → cowcat → tui → cli 依次构建成功
- [x] `node packages/cli/dist/src/cli/main.js --version` 正确
- [x] `none` 配置下 `doctor` 通过

### 1.4 本轮记录（2026-10-21，`1.0.0-beta.2`）

- 【已发布产物】`npx --yes --registry=https://registry.npmjs.org @corescense/cowcat@beta --version` → `1.0.0-beta.2`。Node 24 下会出现 `@opentui/core` 的 `EBADENGINE` 警告，那是 TUI 的 Node ≥ 26.4 门槛，不影响 `run` / `serve` / `doctor`
- 【已发布产物】空 `COWCAT_HOME` 的 `doctor` → 通过；模型行是 `未配置（not-configured）`，不是 FAIL
- 【已发布产物】迁移演练：临时 home + 合成的 v1 配置（内联 `apiKey`、`permissions`、未知键）与含 `env` 的 `mcp.json`
  - 生成 `config.json.bak`；新配置只有 `apiKeyEnv`，`sk-…` 与 `SECRET` 均不在文件里
  - 警告逐条给出：内联 key、`permissions` 不迁移、未知键、mcp `env` 不迁移
  - 回滚：`.bak` 还原后 `doctor` 仍通过（v1 兼容读取，内联 key 只在内存）
- 【源码】protocol → cowcat → tui → cli 依次构建通过；`--version` = `1.0.0-beta.2`；空配置 `doctor` 通过

## 2. 真实编码任务

准备 2–3 个平时真的会做的任务，不要用 hello world。

- [x] 读 3–5 个文件后改一处代码：Read → Edit 正常
- [ ] 未读文件时 Edit/Write 被闸门挡住（本轮模型总是先读，未自然触发；由 `packages/cowcat/test/*` 的写前读用例覆盖）
- [x] Grep/Glob 找到符号后再改
- [x] 需要审批的 Bash：
  - [x] 不加 `--yes`：被拒绝，模型看到拒绝原因
  - [x] 加 `--yes`：执行并返回输出
- [x] 同一会话继续追问 3 轮以上，上下文不丢
- [ ] `Ctrl-C` 取消后 `sessions resume` 能继续，锁已释放
- [x] 没有重复读同一文件、工具调用死循环或上下文爆掉

每个任务记录：会话 id、用到的工具、失败点、模型是否理解工具错误。

### 2.1 本轮记录（2026-10-21，已发布 `1.0.0-beta.2`）

环境：Windows / Node 24.18 / `npx --registry=https://registry.npmjs.org @corescense/cowcat@beta` / 临时 `COWCAT_HOME` / 临时 git 仓库（4 个源文件、2 个测试、`AGENTS.md`，预置一个 `add` 写成减法的 bug）。

- 【会话 `sess_71fd4692-b866-4374-87f9-c192022785ab`，4 轮，`--yes`】17 次工具调用：Glob 1 / Grep 1 / Read 4 / Edit 7 / Bash 4。4 次读取对应 4 个不同文件，**无重复读**；`instructions.loaded` 1 次（`AGENTS.md`，`trigger=start`）；最终 `npm test` 5/5 通过，`git diff --stat` 与模型自述一致（4 个文件、+19/−3）
  - 任务：① 跑测试定位并修 `add` ② 加 `multiply` 与测试 ③ 总结会话改动（未调用工具）④ Grep 找 `slugify` 后加 `reverseWords` 与测试
- 【会话 `sess_393fba16-a412-4d90-a15e-448e5190f7b9`，新会话，不加 `--yes`】Bash 被拒，工具返回 `rejected by user`，模型据此说明「命令被拒绝、没有测试结果可报告」——拒绝原因确实到达了模型
- 未验证：`Ctrl-C` 取消后 `sessions resume`；未读写入闸门（模型每一步都先读，未自然触发）


## 3. 长会话、压缩与子 agent

这一组是当前验证最薄、但对 `latest` 决策最重要的部分。

- [x] 连续 10+ 轮，触发一次上下文压缩
- [x] 压缩后 `AGENTS.md` 指令仍然生效（问一个只有项目规则能答的问题）
- [x] 压缩后最近修改的文件仍在上下文里，能继续编辑
- [x] `Task` + `explore`：只读、报告可用
- [x] `Task` + `general`：能完成一个隔离子任务
- [x] 取消父回合后，子会话有 `cancelled` 终结事实，且没有残留锁
- [x] `sessions list` 默认折叠子会话；`--all` 能列出

看日志里的 `context.compacted`、`subagent.started` / `subagent.finished`、`turn.transitioned`。

### 3.1 本轮记录（2026-10-21，已发布 `1.0.0-beta.2`）

环境：临时 git 仓库（`src/a.js`、`src/b.js`、`src/config.js`、`src/notes.md` + 一个测试 + `AGENTS.md`），临时 `COWCAT_HOME`。`AGENTS.md` 里埋了一个只有它能回答的暗号 `CONVENTION-OK`。

**怎么在 12k 内触发压缩**：内置 preset 的 `context` 是 1,000,000，真推满不现实。用配置里的自定义 preset 把 `limits.context` 设成 12000（后降到 5000），协议、内核、压缩代码路径都不变——只有触发阈值变了。这是测试配置，不代表产品默认值。

- 【会话 `sess_7e93b192-f463-4d08-8c98-6b03a4341bbe`，14 轮】第 1–10 轮每轮「读两个源文件 + 在 notes.md 追加一行」，上下文涨到约 7.4k tokens；第 11 轮仍低于阈值；第 12 轮开始触发压缩：
  - `context.compaction.started` → `context.compacted`（`trigger=auto`、`throughSeq=85`、`dropped=24`、`shadowed=24`、摘要 1543 字符）→ `context.compaction.finished ok=true`
  - 紧接着 `instructions.loaded` 第二次出现，`trigger=refresh`——压缩把指令影子化后，同一回合把它放回去了（ADR-078 ①）
- 【压缩后指令】第 13 轮问「提到约定必须带什么暗号」，回答 `CONVENTION-OK`
- 【压缩后最近文件】第 14 轮禁止 `Read`、直接 `Edit` 往 `src/notes.md` 追加，成功（模型记得最后一行是「第12轮完成。」）
- 【explore 子 agent】3 轮、只读，报告覆盖 `src/` 四个文件与依赖关系，子会话 `sess_6d432bef-1405-4429-b9c4-522cb8403baf`，父级 `subagent.finished ok=true state=completed`
- 【general 子 agent】子会话 `sess_2172bcdc-d77a-4cb4-93dd-368a1eb48ccc`，3 轮；它尝试用 `node -e` 实证被拒（子 agent 无人可问，ADR-081 ③），如实说明后改为静态分析，并给出边界问题清单
- 【取消父回合】`serve` 探针在 `subagent.started` 后 1.5s 发 `turn.cancel`：父级 `cancelled`（reason `aborted while a sub agent was running`）、父日志 `subagent.finished ok=false state=cancelled`、子日志终止于 `cancelled`；`serve` 正常退出后 `sessions/` 下**无 `.lock` 文件**
- 【列表折叠】`sessions list` 只显示父会话；`--all` 显示两个子会话并标注父会话 id

注意：探针第一次查锁是在 `serve` 还活着时，看到 `.lock` 属正常持有；改成进程退出后再查才是这条验收点的正确测法。


## 4. TUI 与 MCP

### 4.1 TUI（Node ≥ 26.4）

```bash
npx --yes node@26.12.0 "$(npm root -g)/@corescense/cowcat/dist/src/cli/main.js" tui
```

- [ ] 对话流、工具卡、审批卡、待办、命令面板可用
- [ ] 工具卡折叠/展开；大段输出不卡死
- [ ] 中文/宽字符对齐正常
- [ ] 调整窗口大小后布局正常
- [ ] `Ctrl-C` 退出后会话锁释放
- [ ] 真实终端连续使用 30 分钟，无崩溃、无残留进程

### 4.2 MCP

用一个真实 stdio 服务器（例如 `@modelcontextprotocol/server-everything`）：

- [x] `tools/list` 出现在模型工具表中，命名是 `mcp__<server>__<tool>`
- [x] 一次 `tools/call` 成功，结果进入对话
- [x] 未受信工作区的项目层 `mcp.servers` 被跳过，并说明原因
- [x] 服务器中途退出：调用失败、**不自动重启**
- [x] `turn.cancel` 后服务器进程被终止
- [x] 已知不阻塞项：`list_changed` / 分页在真实服务器上很难自然触发，记录即可

### 4.3 本轮记录（2026-10-21，已发布 `1.0.0-beta.2`）

- 服务器：`@modelcontextprotocol/server-everything`（本地安装，入口 `command: "node"` + `dist/index.js`；刻意避开 Windows 的 `npx` / `.cmd` 入口缺口）
- 【会话 `sess_e0180077-5a3b-4fa8-95c4-0601bb144d7b`】模型调用 `mcp__everything__echo`，返回 `Echo: mcp-ok`，结果进入对话——命名与 `tools/call` 两条都成立
- 【未受信项目层】在仓库里写 `cowcat.json` 增加 `projonly` 服务器、用没有 `trust.json` 的临时 home 跑 `doctor`：`mcp 1 个：everything（未受信跳过 1 个）`，跳过与原因都可见
- 【进程】`run` 结束后按命令行匹配 `server-everything` 的 `node` 进程数为 0
- 【服务器中途退出，会话 `sess_7c5b61e9-1675-4d56-9726-13dc80260c60`】用自写的 mini server（`die` 不回答直接退出）：第一次 `mcp__mini__die` → `ok=false`，输出 `MCP server exited (exit code 0)`；紧接着 `mcp__mini__echo` → 输出 `MCP server exited (exit code 0); no restart is attempted (ADR-087 ②)`
- 【`turn.cancel`，会话 `sess_2b47fd80-fd8f-4018-947e-31096ff587d9`】用 `cowcat serve` + 协议脚本驱动：`approval.respond once` 后工具进入 60s 的 `sleep`，4 秒后发 `turn.cancel`。结果：`tool.finished ok=false`、输出 `MCP request tools/call was cancelled`；终端 `cancelled`；按命令行匹配的 mini server 进程数 **1 → 0**（取消前 1，取消后 0）
- 协议提醒（这次踩到的）：`session.create` **不订阅事件**，必须再调 `session.open` 才会收到 `event` 通知（`packages/protocol/src/server.ts:203`）
- 未验证：服务器中途退出的「失败且不重启」；`turn.cancel` 后进程被终止（两条都需要可控的会崩溃服务器或协议级取消）


## 5. 平台差异（有条件才做）

- [ ] macOS：`light` 与 `system`（Seatbelt）各跑一次 Bash
- [ ] Linux：`light` 与 `system`（bubblewrap）各跑一次 Bash
- [ ] Windows：Git Bash 与 `cmd` 下各跑一次只读命令
- [ ] Windows `.cmd` / `npx` 形式的 MCP 入口（已知缺口，记录，不作为 beta 门槛）
- [ ] 不同 Node：22 跑 `run/serve/doctor`；26.4+ 跑 `tui`

## 6. 反馈记录格式

```text
版本：cowcat --version
平台 / Node：
COWCAT_HOME：临时目录 / 真实 home
复现命令：
预期：
实际：
证据：doctor 输出 / 会话 id / 关键日志（不要贴 key）
优先级：P0 / P1 / P2
```

建议开 GitHub issue，标签 `beta` + `p0`/`p1`/`p2`；没有标签权限时先记到 `docs/beta-feedback.md`。

## 7. 切换 `latest` 的门槛

满足以下全部条件再改 `latest`：

1. 真实 home 的 `setup --migrate` 成功，且 `.bak` 回滚演练通过。
2. 3 个真实编码任务无 P0/P1。
3. 一次长会话压缩后，指令与最近文件仍生效。
4. 一次真实 MCP 服务器调用成功（list + call）。
5. TUI 在真实终端连续用 30 分钟无崩溃、无锁残留。

结果记录：

| 门槛 | 日期 | 结果 | 证据 / issue |
|---|---|---|---|
| 配置迁移 + 回滚 | | | |
| 3 个真实编码任务 | | | |
| 长会话压缩 + 指令 | | | |
| 真实 MCP 调用 | | | |
| TUI 30 分钟 | | | |

## 8. 已知缺口（不作为 beta 门槛）

- CLI 的 `latest` 仍是 v1 `0.15.0`；beta 用 `@beta`。
- v1 项目 `.cowcat/config.json`、`state.json` 不自动迁移。
- `setup` 是非交互 flags，没有向导式问答。
- Windows `.cmd` / `npx` 形式的 MCP 入口未支持。
- 真实 MCP 服务器的 `list_changed` / 分页未触发。
- 三个 support 包的 `latest` 仍停在 beta.1（CLI 用精确版本依赖，不影响安装）。
- `system` 沙箱在 Windows 上被显式拒绝（设计如此）。
- **`Shift+Enter` 换行依赖终端**：只有实现 kitty 键盘协议的终端才能把它与回车分开。2026-10-22 实测的验收终端（Tabby Terminal，Electron + xterm.js）对 `Shift+Enter` 发的是单个 `0d`（即回车本身），因此该终端上 `Shift+Enter` 会直接发送消息；换行请用 `Ctrl+J`（无条件可用）或 `Alt+Enter`（老终端编码成 `ESC CR`，见 ADR-104 ⑥、#140）。**终端渲染之外的形态不受此限**：桌面端 / Web 端能拿到完整的 keyboard 事件，`Shift+Enter` 到那时再实现（已由用户 2026-10-22 决定，不在 beta 内做）。

## 9. 结果汇总

| 日期 | 轨道 | 结果 | 证据 | issue |
|---|---|---|---|---|
| 2026-10-21 | 安装/迁移 | 通过（§1.1–§1.3，已发布 beta.2 + 源码） | §1.4（临时 home 的迁移与回滚；真实 home 已是 v2，未重复迁移） | — |
| 2026-10-21 | 编码任务 | 通过（4 轮同一会话 + 1 次拒绝路径；§2.1） | 测试 5/5、无重复读、`instructions.loaded` 1 次 | — |
| 2026-10-21 | MCP | 通过（list 命名 + call + 崩溃不重启 + cancel 杀进程；§4.3） | `mcp__everything__echo` → `Echo: mcp-ok`；`die` 后第二次调用报 no restart；cancel 前后进程 1→0 | — |
| 2026-10-21 | 长会话/子 agent | 通过（14 轮，第 12 轮压缩；§3.1） | `context.compacted` + `instructions.loaded(refresh)`；压缩后暗号与最近文件仍可用；父子取消后无锁 | — |
| | 编码任务 | | | |
| | 长会话/子 agent | | | |
| | TUI | | | |
| | MCP | | | |
| | 平台 | | | |
