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
cd agent && npm test                  # 旧版 CLI（P8 前仍在）
cd ../packages/cowcat && npm test     # v2 内核
cd ../..
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

仓库是**私有 Pro 计划**（每月 3000 分钟包含额度），计费倍率 **Linux 1x / Windows 2x / macOS 10x**。2026-10-16 实测：一天的普通 PR 工作（68 次 CI）烧掉约 **795 计费分钟**＝单月额度的 26%。最大两项是 Windows 腿（33%）与 Node 版本腿（31%）。**所以门禁的形状由配额决定：**

| job | 内容 | 何时 | 必过 |
|---|---|---|---|
| `packages/cowcat · node 22 · ubuntu-latest` | v2 内核：`npm test`（build + ESLint + 测试） | 每个**非草稿** PR + 每次合入 main | ✅ |
| `package whitelist` | `node tools/check-tarball.mjs`：`npm publish` 会传的东西是否越界 | 同上 | ✅ |
| `test · node 22 · ubuntu-latest` | 旧版 `agent/`：`npm test` + bubblewrap/AppArmor | **仅当 `agent/` 或 `ci.yml` 有改动**（见下） | ✅ |
| `packages/cowcat · node 22 · windows-latest` | v2 内核在 Windows 上 | **只在合入 main 时** | ❌ |
| `test · node 22 · windows-latest` | 旧版在 Windows 上（`.cmd` shim / 路径 / MCP stdio 依赖平台行为） | **只在合入 main 且 `agent/` 有改动时** | ❌ |
| `test · node 24 · ubuntu-latest` | 旧版 Node 24 兼容 | **只在合入 main 且 `agent/` 有改动时** | ❌ |

**旧套件按需运行**：`scope` 作业比较 PR 基准与当前提交，只有 `agent/` 或 `.github/workflows/ci.yml` 有变化才跑旧套件。作业名不变，所以分支保护不需要改；未跑时作业保留并以成功结束（内部步骤跳过）。无法比较时（手动触发、新分支、基准提交缺失）一律运行——宁可多跑，不靠猜测跳过。P8 删除旧 `agent/` 时，这些作业一并删除。

**v2 内核的 Windows 腿只在 main 跑**：它的测试在本机只需几秒，单次成本主要是 checkout 与 setup。先保守放 main，等实测耗时后再决定是否上 PR。

2026-10-16 实测（main `1f7389a`，run [38967790242](https://github.com/HiyodoGame/cowcat/actions/runs/38967790242)）：该腿墙钟 **54s**，按 2x 倍率约 **1.8 计费分钟**（估算，非账单实测）。这就是上句等待的那个数，据此**维持 main only**：一次 main 推送只付一次，而挂到每个非草稿 PR 上会随 PR 频率反复付——按本节记录的 68 次/天粗算约 122 计费分钟/天，单月即超过 3000 的包含额度。PR 频率降到个位数/天时可以重新评估。

**草稿 PR 不跑任何检查**：草稿本来就不可合并，而 `ready_for_review` 会触发一次完整运行（`types` 里显式列了它，否则转正式稿就永远拿不到门禁）。迭代循环（提交 → 看结果 → 改 → 再推）是运行次数的主要来源，这是单项最大的节省。

**Windows 移出 PR 门禁的取舍**：Windows 回归仍会在每次合入 main 时被抓住，但可能已经合进去了。我们认为「一个平台的回归晚一天发现」比「每月额度在两天内耗尽、CI 全面停摆」划算。若某次改动确实平台敏感，临时把 `if:` 去掉即可。

**Node 20 已从矩阵删除**：官方 lifecycle 于 **2026-04-30 EOL**（nodejs.org/en/about/previous-releases），测它等于宣称兼容一个不再收安全更新的运行时。要恢复请先想清楚支持承诺。

**node_modules 直接走 `actions/cache`**（key 含 lock 文件哈希），依赖变动自然 miss 并回落到 `npm ci`。

**macOS 单独一个 workflow**（`.github/workflows/ci-macos.yml`，`macos-15`）：它是 Seatbelt 后端唯一能做**真实内核断言**的地方（`test/sandbox-macos.test.mjs` 的 G1/G2/G3）。macOS 按 10 倍计费——实测 27 次触发共 79 计费分钟（占当天 10%），墙钟只有 ~20 秒，倍率却不是——所以它**只在触及沙箱的非草稿 PR 上跑**，**不在 main 推送时自动跑**，另留 `workflow_dispatch` 手动触发。它**不在必过检查里**：一个只是有时才上报的 required check 会把所有没触发它的 PR 卡死。

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
| 必须通过的检查 | `package whitelist`、`test · node 22 · ubuntu-latest`、`packages/cowcat · node 22 · ubuntu-latest`（2026-10-17 加入第三项，v2 内核进入门禁；旧套件的收敛过程与配额账见 §3） |
| 要求分支基于最新 main（strict） | ✅ |
| 需要批准数 | 0（单人开发；PR 是流程载体，不强制他人批准） |
| 强制管理员同上 | ✅（对自己也生效） |
| 允许强推 / 删除分支 | ❌ / ❌ |

实测证据（2026-10-16 绕过本地钩子直推 main；当时必过检查为 2 项，现为 3 项，同样的拒绝现在会显示 `3 of 3`）：

```
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: - Changes must be made through a pull request.
remote: - 2 of 2 required status checks are expected.
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
