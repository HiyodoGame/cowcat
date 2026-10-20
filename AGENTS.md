# AGENTS.md

本文件给 coding agent 的工作说明。人类向的概览在 `README.md`，当前状态与下一步在 `docs/HANDOFF.md`。

## 仓库里有四个包，没有第二棵代码树

| 包 | 内容 | 说明 |
|---|---|---|
| `packages/cowcat/` | 内核（TypeScript strict → ESM，Node ≥ 22），`@corescense/cowcat-core` | 事件溯源会话、策略、端口、工具、组合根；**新能力一律进这里** |
| `packages/protocol/` | headless 协议，`@corescense/cowcat-protocol` | JSON-RPC over stdio、内存传输、宿主端口 |
| `packages/tui/` | 渲染器，`@corescense/cowcat-tui` | opentui，Node ≥ 26.4 |
| `packages/cli/` | 可执行文件，`@corescense/cowcat` | bin + 子命令表 + `doctor` |

v1 的 `agent/` 已在 P8 删除，不要再从历史里恢复它或复制其中代码。

## 构建与测试

```bash
cd packages/cowcat && npm test        # pretest = tsc build + ESLint，测试跑 dist/
cd packages/protocol && npm test
cd packages/tui && npm test           # 需要 Node >= 26.4（opentui）
cd packages/cli && npm test           # 依赖 protocol → cowcat → tui 已构建
```

`file:` 依赖是 junction：npm 不装也不构建目标，消费者腿要自己按依赖顺序构建。

**探针**（开发期脚本，不进 lint 门禁、不进发布包）：

```bash
node tools/lint-probe.mjs             # 分层禁令逐条验证
node tools/policy-decide-probe.mjs    # 裁决矩阵
node tools/tui-api-probe.mjs
node tools/check-tarball.mjs          # 发布白名单；--install 会装 tarball 并跑 --version
```

## 分层禁令（**由 lint 强制，不是约定**）

- `src/kernel/`、`src/policy/`、`src/ports/` **禁止 import `node:*`** —— 这三层必须与宿主运行时无关
- `zod` **只允许出现在 `src/adapters/`**
- 内核只能**类型依赖**端口（`verbatimModuleSyntax`）
- 所有子进程**只经 `ProcessPort` 启动**（ADR-014）；路径身份**只在 `FsPort` 里算**（ADR-017）
- `packages/tui` 不 import 内核；`packages/cli` 不直接 import `@opentui/*`

违反会被 ESLint 拦下。`node tools/lint-probe.mjs` 会逐条验证这些规则**真的会报错**。

## 提交与 PR

- **main 不可直推**。走分支 + PR，分支名 `<type>/<topic>`（`feat/`、`fix/`、`docs/`、`chore/`、`test/`、`ci/`、`refactor/`）
- 钩子需要每克隆一次手动启用：`git config core.hooksPath .githooks`。**没启用则守卫静默失效**
- 提交信息用 Conventional Commits，**摘要写中文**：`type(scope): 中文摘要`
- `docs/` 与代码**同 PR**（工作规则 5）；契约性决策先落 `docs/architecture/README.md` 的 ADR 表**再**实现（工作规则 3）

## 写文档的约定

`docs/research/*.md` 是各阶段开工前的调研，有一套证据标注纪律，**沿用不发明**：

- **【源码】** 直接读到实现，给 `文件:行号`
- **【实测】** 本次跑出来的，给脚本名与用例号
- **【上游】** 来自官方文档
- **【推断】** 未实测的推论，**不得作为决策依据**

「已验证」只指实际跑过的结果。调研只出决定草案与 ADR 清单，**不在调研 PR 里改 ADR 或源码**。

## 安全与仓库卫生

- **不要提交**：`.keys.env`、内部会话日志、逆向/抓包素材、他人代码的逐字提取物
- `tools/check-tarball.mjs` 是发布白名单守卫；它检查四个包的 tarball，不允许残留 `file:` 依赖
- 版本号**只在发布批次里**改（四个 `package.json` 与 `tools/pack-release.mjs` 的 `VERSION` 一起改）
- v1 的 `~/.cowcat/config.json` 以兼容模式读取（ADR-089）；兼容层计划只服务 P8 后一个发布周期

## Windows 上的坑（踩过的）

本机是 Windows + Git Bash，CI 是 Linux/macOS/Windows 三平台：

- **`git commit -m "…"` 带引号会被截断** → 用 `git commit -F <文件>`
- **`import('F:\\...')` 会被 ESM loader 拒绝**（`ERR_UNSUPPORTED_ESM_URL_SCHEME`）→ 用 `pathToFileURL(p).href`
- **PowerShell 的 `Get-Content` / `Select-String` 行号在中文密集的 UTF-8 文件上不可靠**（按 ANSI 码页解码会把部分 `\n` 当尾字节吞掉，行被合并）。要准确行号用 `read`/`rg`，或 `node -e` 数
- 嵌套引号会破坏复杂内联命令 → **写脚本文件**。`node -e "..."` 里再套引号在 PowerShell 下**必然**被改写（实测三次），不要试第二次
- 仓库统一 LF（`.gitattributes`），CRLF 的 shell 脚本在 POSIX 上会硬失败

## 别碰的东西

- **CI 的配额形状是刻意设计的**（`ci.yml` 顶部有长注释）：draft PR 不跑任何检查，部分腿按改动路径过滤。**不要随手加 job**
- `docs/archive/` 是历史档案（v1 与旧架构），**不是现行规范**
- 现行规范是 `docs/dev-plan-v2.md` + `docs/architecture/`；与代码冲突时**以代码和测试为准**，并在同一 PR 里修文档
