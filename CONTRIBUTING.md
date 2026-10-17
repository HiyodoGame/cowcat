# 参与开发

> 分支与 PR 流程、提交约定、CI 门禁、发布批次。命令在 Git Bash / PowerShell 下都可用。

## 1. 基本约定

- **`main` 只通过 PR 合入**。分支命名：`feat/<主题>`、`fix/<主题>`、`docs/<主题>`、`chore/<主题>`（例：`fix/hook-epipe`）。
- 提交信息用 Conventional Commits，**摘要写中文**：`fix(hooks): 修 hook 子进程提前退出时的 EPIPE 崩溃`。
- 一个 PR = 一个可讲清楚的改动（或一个批次）；版本号只在**发布批次**里动。
- 改动前先读根目录与 `agent/`、`packages/cowcat/` 里的既有文档，沿用现有约定，不自作主张换风格。

## 2. 一次改动怎么走

```bash
# 1) 从最新的 main 开分支
git switch main && git pull
git switch -c fix/hook-epipe

# 2) 改、测、提交（pretest 会跑 ESLint）
cd agent && npm test                  # v1 CLI（P8 切换前仍在发布）
cd ../packages/cowcat && npm test     # v2 内核（pretest = tsc build + ESLint，测试跑 dist/）
cd ../..
git add -A && git commit -m "fix(hooks): 修 hook 子进程提前退出时的 EPIPE 崩溃"

# 3) 推分支并开 PR（PR 模板会自动带出自检清单）
git push -u origin fix/hook-epipe
gh pr create --fill --base main

# 4) 等 CI，全绿才合
gh pr checks --watch && gh pr merge --squash --delete-branch
```

> 分支保护是 `strict` 的（要求分支基于最新 main）。若期间 main 前进过，合并会被拒
> （`not mergeable: the head branch is not up to date`）。此时：
> ```bash
> gh pr update-branch <n> && gh pr checks <n> --watch && gh pr merge <n> --squash --delete-branch
> ```
>
> 本地先看一眼：`gh run list --workflow=ci.yml --limit 3` / `gh run view <id>`。

## 3. 两个代码线

| 目录 | 测试命令 | 说明 |
|---|---|---|
| `agent/`（v1 CLI） | `cd agent && npm test` | `pretest` 先跑 ESLint。**P8 切换前只收安全修复，不收功能** |
| `packages/cowcat/`（v2 内核） | `cd packages/cowcat && npm test` | `pretest` = `tsc` build + ESLint（strictTypeChecked），测试跑的是 `dist/` 编译产物 |

改动落在哪条线，取决于任务：v1 只做安全修复，新功能进 v2。判断依据见
[`docs/dev-plan-v2.md`](docs/dev-plan-v2.md) 的阶段总览。

## 4. CI 门禁

| job | 内容 | 何时 | 必过 |
|---|---|---|---|
| `packages/cowcat · node 22 · ubuntu-latest` | v2 内核：`npm test`（build + ESLint + 测试） | 每个**非草稿** PR + 每次合入 main | ✅ |
| `packages/cowcat · node 22 · windows-latest` | v2 内核在 Windows 上 | 同上 | ✅ |
| `test · node 22 · macos-15`（`CI (macOS)`） | v1 在 macOS 上 + Seatbelt 真实内核断言（G1/G2/G3、私有临时目录、项目里 `rm` 仍可用） | 同上 | ✅ |
| `package whitelist` | `node tools/check-tarball.mjs`：`npm publish` 会传的东西是否越界 | 同上 | ✅ |
| `test · node 22 · ubuntu-latest` | v1 `agent/`：`npm test` + bubblewrap/AppArmor | 每个非草稿 PR；未触及时作业内步骤跳过 | ✅ |
| `test · node 22 · windows-latest` | v1 在 Windows 上（`.cmd` shim / 路径 / MCP stdio 依赖平台行为） | 每个非草稿 PR，**且仅当 `agent/` 或 `ci.yml` 有改动** | ❌ |
| `test · node 24 · ubuntu-latest` | v1 的 Node 24 兼容 | 同上 | ❌ |

**必过检查的规则只有一条：必须是「每个非草稿 PR 都上报」的作业。** 一个只在部分 PR 上出现的必过检查，会把没触发它的那些 PR 全部卡死——所以 v1 的 Windows 与 Node 24 两条腿虽然每个 PR 都跑（公开后 Actions 免费），但**不进必过列表**：`scope` 作业可能判定 `agent/` 未改动而跳过它们。反过来，v2 的 Windows 腿与 macOS 腿没有任何跳过条件，所以它们是必过的。

几条约定，改之前先读完再动：

- **旧套件按需运行**：`scope` 作业比较 PR 基准与当前提交，只有 `agent/` 或 `.github/workflows/ci.yml` 变化才跑。**作业名保持不变**，所以分支保护不用改；无法比较时（手动触发、新分支、基准缺失）一律运行——宁可多跑，不靠猜测跳过。
- **草稿 PR 不跑任何检查**：草稿本来就不可合并。迭代循环（提交 → 看结果 → 改 → 再推）是运行次数的主要来源，这是单项最大的节省。
- **Linux 腿钉 `ubuntu-24.04`**：`ubuntu-latest` 自 2026-10-19 起逐步迁移到 Ubuntu 26.04。迁移期同一个提交可能落到两个镜像，而本门禁要在 Ubuntu 上装 `bubblewrap` + AppArmor profile，**装不上时沙箱测试是 skip 而不是 fail** —— 镜像漂移会让覆盖静默关闭而必过检查保持绿色。所以钉镜像。job **name** 仍写作 `ubuntu-latest`：required check 按 job name 匹配，改名必须与分支保护的 contexts 在同一窗口一起改。
- **Node 20 已从矩阵删除**：官方 lifecycle 于 2026-04-30 EOL，测它等于宣称兼容一个不再收安全更新的运行时。要恢复请先想清楚支持承诺。
- **macOS 单独一个 workflow**（`.github/workflows/ci-macos.yml`，`macos-15`）：它是 Seatbelt 后端唯一能做**真实内核断言**的地方（`test/sandbox-macos.test.mjs` 的 G1/G2/G3、私有临时目录、项目里 `rm` 仍可用）。仓库公开前它因为 10 倍计费而只在触及沙箱的 PR 上跑、且不进必过检查；公开后分钟免费，路径过滤已去掉，改为**每个非草稿 PR + 每次合入 main 都跑**，并进入必过检查——这样 Seatbelt 的断言第一次进了合并门禁。
- **live 脚本（`agent/test/live/*`）不进 CI**：它们需要真实 API key 或真实 MCP server，属发布前手工验证。

## 5. 本地 git 钩子（可选，推荐）

服务端分支保护已经启用（见 §7），本地钩子是**更早的一道防线**：它在错误动作发生时就提示，而不是等推送被拒。

```bash
git config core.hooksPath .githooks
```

| 钩子 | 拦什么 | 故意绕过 |
|---|---|---|
| `pre-commit` | 在 `main` 上**提交**（常见成因：`gh pr merge --delete-branch` 会把工作区切回 `main`，接着直接改文件提交） | `git commit --no-verify` |
| `pre-push` | 向 `main` **推送**（含删除该分支） | `git push --no-verify` |

`pre-commit` 允许 detached HEAD（rebase / bisect 就是那个样子）。`pre-push` 只拦分支推送、**不拦 tag**，所以发布流程不受影响。

## 6. 发布批次

发布走同一个流程，只是多几步（详见 [`docs/PUBLISH.md`](docs/PUBLISH.md)）：

1. PR 里带上 `docs/changelog.md` 的新版本段落（先标「未发布」）与 `agent/package.json` 版本号；
2. PR 合入 main 后，另开一个小 PR 摘掉「未发布」标记 → 合入；
3. 本地 `git tag -a vX.Y.Z && git push origin vX.Y.Z`（tag 推送不受分支规则限制）；
4. `npm publish`（需要 2FA）→ 核对 registry 的 `dist.shasum` 与本地 `npm pack` 一致；
5. 用 `docs/PUBLISH.md` 的 checklist 收尾（CI 绿、白名单守卫、隔离安装演练）。

## 7. 服务端分支保护

`main` 的保护已启用：必须走 PR、必须通过 §4 的三项必过检查、要求分支基于最新 main（strict）、需要批准数 0（单人开发时 PR 是流程载体）、强制管理员同上、不允许强推与删除分支。

```bash
# 修改/重新应用（构造与本节同步）
gh api -X PUT repos/:owner/:repo/branches/main/protection --input protection.json
# 临时放开（例如 CI 自身坏了、需要紧急直推）
gh api -X DELETE repos/:owner/:repo/branches/main/protection
```

**取舍**：`strict: true` 意味着 main 前进后其它 PR 都要 `gh pr update-branch` 并重跑一轮 checks。单人仓库若觉得这个开销大于收益，可以把 `required_status_checks.strict` 改成 `false`（仍要求检查通过，但不要求分支最新）——代价是放松「测过的就是你合的那棵树」这条保证。

## 8. 给外部贡献者

- **先看 issue 再动手**：小修与文档改进可以直接 PR；涉及行为变化的请先开 issue 描述意图，避免白做。
- **不要提交这些东西**：API key、token、`.keys.env`、内部会话日志、抓包素材、他人代码的逐字提取物。仓库根目录的 `.gitignore` 已覆盖常见路径，PR 模板的自检清单里也有对应项。
- **测试是硬要求**：修 bug 附回归用例（能复现原缺陷的那种），加功能附覆盖新路径的用例。「本机跑绿」不等于「已验证」——本项目里 skip 的测试曾经掩盖过测试自身的 bug，请在 PR 描述里区分「已跑过」与「推测」。
- **改动范围要克制**：不顺手重排无关代码、不统一无关的格式。一个 PR 一件事。