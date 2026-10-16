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

# 4) 等 CI（改动 CI 配置本身时尤其要看）
gh pr checks --watch

# 5) 绿了再合（squash 保持 main 线性，并删除远端分支）
gh pr merge --squash --delete-branch
```

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

## 6. 服务端强制保护：现状与三条路

GitHub 的 branch protection / rulesets 在**私有仓库 + 免费计划**下不可用，API 会直接回：

```
Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)
```

因此「`main` 禁止直推 + 必须 CI 绿才能合并」目前只能靠 §5 的客户端守卫与自觉。想变成**服务端强制**，三选一：

| 方案 | 代价 | 说明 |
|---|---|---|
| **仓库转公开** | 免费，但全部历史与后续代码公开 | 转公开即可开启 branch protection + rulesets。转之前确认历史里没有内部资料（本仓库 `.keys.env` 从未进过历史，`analysis/`、`artifacts/` 均被 gitignore） |
| **升级 GitHub Pro** | 约 $4/月 | 私有仓库也能开 branch protection + rulesets，仓库继续私有 |
| **维持现状（客户端守卫 + CI 可见）** | 免费 | 门禁靠自觉：CI 在 PR 上跑、本地 pre-push 拦主分支；对单人开发通常够用 |

选定后，服务端保护可以用一条命令挂上（把检查项按 CI 的 job 名列出）：

```bash
gh api -X PUT repos/:owner/:repo/branches/main/protection \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=package whitelist' \
  -f 'required_status_checks[contexts][]=test · node 22 · windows-latest' \
  -f 'enforce_admins=true' \
  -f 'required_pull_request_reviews[required_approving_review_count]=0' \
  -F 'allow_force_pushes=false' -F 'allow_deletions=false'
```
