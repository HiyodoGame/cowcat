# 参与开发（分支与 PR 流程）

> 适合单人开发、但希望改动**有记录、可回溯、且经过 CI** 的用法。所有命令在 Git Bash / PowerShell 下都可用。

## 1. 基本约定

- **`main` 只通过 PR 合入**。分支命名：`feat/<主题>`、`fix/<主题>`、`docs/<主题>`、`chore/<主题>`（例：`fix/hook-epipe`）。
- 提交信息用 Conventional Commits，**摘要写中文**：`fix(hooks): 修 hook 子进程提前退出时的 EPIPE 崩溃`。
- 一个 PR = 一个可讲清楚的改动（或一个批次）；版本号只在**发布批次**里动。

## 2. 一次改动怎么走

```bash
# 1) 从最新的 main 开分支
git switch main && git pull
git switch -c fix/hook-epipe

# 2) 改、测、提交（pretest 会跑 ESLint）
cd agent && npm test
cd ..
git add -A && git commit -m "fix(hooks): 修 hook 子进程提前退出时的 EPIPE 崩溃"

# 3) 推分支并开 PR（PR 模板会自动带出自检清单）
git push -u origin fix/hook-epipe
gh pr create --fill --base main

# 4) 等 CI，并且**只在全绿时才合**：&& 让失败的 checks 直接中断这一步
gh pr checks --watch && gh pr merge --squash --delete-branch
```

> ⚠️ 分支保护是 `strict` 的（要求分支基于最新 main）。若期间 main 前进过，合并会被拒
> （`not mergeable: the head branch is not up to date`）。此时先更新分支、等新的一轮
> checks、再合：
> ```bash
> gh pr update-branch <n> && gh pr checks <n> --watch && gh pr merge <n> --squash --delete-branch
> ```

本地想先看一眼 CI 结果：`gh run list --workflow=ci.yml --limit 3` / `gh run view <id>`。

## 3. CI 门禁是什么

`.github/workflows/ci.yml` 在 `push`（main）与**每个 PR**上跑：

| job | 内容 |
|---|---|
| `test · node 20/22/24 · ubuntu-latest` | `npm ci` → `npm test`（`pretest` 含 ESLint） |
| `test · node 22 · windows-latest` | 同上（产品在 Windows 上使用，`.cmd` shim / 路径 / MCP stdio 依赖平台行为） |
| `package whitelist` | `node tools/check-tarball.mjs`：`npm publish` 会传的东西是否越界 |

live 脚本（`agent/test/live/*`）**不进 CI**：它们需要真实 API key 或真实 MCP server，属于发布前手工跑的验证。

## 4. 发布批次

发布走同一个流程，只是多几步（详见 `docs/PUBLISH.md`）：

1. PR 里带上 `docs/changelog.md` 的新版本段落（先标「未发布」）与 `agent/package.json` 版本号；
2. PR 合入 main 后，另开一个小 PR 摘掉「未发布」标记 → 合入；
3. 本地 `git tag -a vX.Y.Z && git push origin vX.Y.Z`（tag 推送不受分支规则限制）；
4. `npm publish`（需要 2FA）→ 核对 registry 的 `dist.shasum` 与本地 `npm pack` 一致；
5. 用 `docs/PUBLISH.md` 的 checklist 收尾（CI 绿、白名单守卫、隔离安装演练）。

## 5. 本地的 pre-push 守卫（可选，推荐）

服务端的分支保护在**私有免费仓库上不可用**（见 §6），所以仓库自带一个客户端守卫：

```bash
# 一次性启用（把 hooks 指向仓库里的 .githooks/）
git config core.hooksPath .githooks
```

启用后，`git push` 到 `main` 会被拦下并提示走 PR；确实需要直推时用 `git push --no-verify`（故意绕过，自己负责）。
它只拦分支推送，**不拦 tag 推送**，所以发布流程不受影响。

## 6. 服务端强制保护：已启用（GitHub Pro）

仓库升级到 **GitHub Pro** 后，`main` 的保护已挂上（此前私有免费仓库下 API 直接 403）。当前配置：

| 项 | 值 |
|---|---|
| 必须走 PR | ✅（直推 main 会被服务端拒绝） |
| 必须通过的检查 | `package whitelist`、`test · node 20/22/24 · ubuntu-latest`、`test · node 22 · windows-latest` |
| 要求分支基于最新 main（strict） | ✅ |
| 需要批准数 | 0（单人开发；PR 是流程载体，不强制他人批准） |
| 强制管理员同上 | ✅（对自己也生效） |
| 允许强推 / 删除分支 | ❌ / ❌ |

实测证据（绕过本地钩子直推 main）：

```
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: - Changes must be made through a pull request.
remote: - 5 of 5 required status checks are expected.
```

重新应用 / 修改（`docs/PUBLISH.md` 与本节同步维护这份配置）：

```bash
# 当前配置（JSON 见仓库历史或按上表构造）
gh api -X PUT repos/:owner/:repo/branches/main/protection --input protection.json

# 临时放开（例如 CI 自身坏了、需要紧急直推）：删掉保护后再重新应用
gh api -X DELETE repos/:owner/:repo/branches/main/protection
```

**代价与取舍**：`strict: true` 意味着每次 main 前进后，其它 PR 都要 `gh pr update-branch` 并重跑一轮 checks（约 3 分钟）。单人仓库如果觉得这个开销大于收益，可以把 `required_status_checks.strict` 改成 `false`（仍要求检查通过，但不要求分支最新）——语义上会放松「测过的就是你合的那棵树」这条保证。

**本地仍保留 pre-push 钩子**（§5）：服务端保护已经能拦住直推，但钩子能在你敲下命令时就给出提示，且离线/异常状态下也是第一道防线。tag 推送不受分支保护影响，发布流程照旧。
