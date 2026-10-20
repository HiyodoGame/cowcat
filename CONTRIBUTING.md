# 参与开发

> 分支与 PR 流程、提交约定、CI 门禁、发布批次。命令在 Git Bash / PowerShell 下都可用。

## 1. 基本约定

- **`main` 只通过 PR 合入**。分支命名：`feat/<主题>`、`fix/<主题>`、`docs/<主题>`、`chore/<主题>`（例：`fix/approval-race`）。
- 提交信息用 Conventional Commits，**摘要写中文**：`fix(host): 早到的审批答案不再丢失`。
- 一个 PR = 一个可讲清楚的改动（或一个批次）；版本号只在**发布批次**里动。
- 改动前先读根目录与 `packages/*/` 里的既有文档，沿用现有约定。

## 2. 一次改动怎么走

```bash
git switch main && git pull
git switch -c fix/approval-race

# 改、测、提交（pretest 会跑 build + ESLint）
cd packages/cowcat && npm test
cd ../packages/cli && npm test
git add -A && git commit -F <消息文件>

git push -u origin fix/approval-race
gh pr create --fill --base main
gh pr checks --watch && gh pr merge --squash --delete-branch
```

> 分支保护是 `strict` 的（要求分支基于最新 main）。若期间 main 前进过，合并会被拒
> （`not mergeable: the head branch is not up to date`）。此时：
> ```bash
> gh pr update-branch <n> && gh pr checks <n> --watch && gh pr merge <n> --squash --delete-branch
> ```

## 3. 四个包

| 目录 | 包名 | 测试命令 |
|---|---|---|
| `packages/cowcat/` | `@corescense/cowcat-core` | `cd packages/cowcat && npm test`（pretest = tsc + ESLint，测试跑 `dist/`） |
| `packages/protocol/` | `@corescense/cowcat-protocol` | `cd packages/protocol && npm test` |
| `packages/tui/` | `@corescense/cowcat-tui` | `cd packages/tui && npm test`（Node ≥ 26.4） |
| `packages/cli/` | `@corescense/cowcat` | `cd packages/cli && npm test`（先构建 protocol → cowcat → tui） |

v1 的 `agent/` 已在 P8 删除。接手一个进行中的阶段，先读 [`docs/HANDOFF.md`](docs/HANDOFF.md)；它是快照，冲突时以 [`docs/dev-plan-v2.md`](docs/dev-plan-v2.md) 为准。

## 4. CI 门禁

| job | 内容 | 必过 |
|---|---|---|
| `packages/cowcat · node 22 · ubuntu-latest` | 内核 `npm test` | ✅ |
| `packages/cowcat · node 22 · windows-latest` | 内核在 Windows | ✅ |
| `packages/cowcat · node 22 · macos-15`（`CI (macOS)`） | POSIX shell 选择 + Seatbelt 探测 | ✅ |
| `packages/protocol · node 22 · ubuntu-latest` | 协议 `npm test` | ✅ |
| `packages/tui · node 26 · ubuntu-latest` / `windows-latest` | 渲染器 `npm test` | ✅ |
| `packages/cli · node 22 · ubuntu-latest` | 可执行文件 `npm test` | ✅ |
| `package whitelist` | 打包四包、安装 tarball、跑 `cowcat --version` | ✅ |

规则只有一条：**必过检查必须是「每个非草稿 PR 都上报」的作业**。草稿 PR 不跑任何检查；`ready_for_review` 会重新触发。

几条约定：

- **Linux 腿钉 `ubuntu-24.04`**：`ubuntu-latest` 迁移到 26.04 的窗口里，同一个提交可能落到两个镜像；沙箱测试装不上 bubblewrap 时是 skip 而不是 fail，镜像漂移会让覆盖静默关闭。job **name** 仍写 `ubuntu-latest`，因为 required check 按 job name 匹配。
- **Node 20 已删除**（2026-04-30 EOL）。
- **macOS 单独一个 workflow**：Seatbelt 与 POSIX shell 选择只有那里能真实验证。
- **真实端点/live 检查不进 CI**：需要 key 或真实 MCP server，属发布前手工验证。

## 5. 本地 git 钩子（可选，推荐）

```bash
git config core.hooksPath .githooks
```

| 钩子 | 拦什么 | 故意绕过 |
|---|---|---|
| `pre-commit` | 在 `main` 上提交 | `git commit --no-verify` |
| `pre-push` | 向 `main` 推送（含删除该分支） | `git push --no-verify` |

## 6. 发布批次

详见 [`docs/PUBLISH.md`](docs/PUBLISH.md)：

1. PR 里带上 `docs/changelog.md` 的新版本段落、四个 `package.json` 的版本号与 `tools/pack-release.mjs` 的 `VERSION`；
2. 合入 main 后另开一个小 PR 摘掉「未发布」标记；
3. `git tag -a vX.Y.Z && git push origin vX.Y.Z`；
4. `node tools/check-tarball.mjs --install` 通过后，从四个暂存目录 `npm publish`（需要 2FA）；
5. 核对 registry 的 `dist.shasum` 与本地 `npm pack` 一致，并在干净环境安装验证。

## 7. 服务端分支保护

`main` 的保护已启用：必须走 PR、必须通过上述必过检查、要求分支基于最新 main（strict）、批准数 0、管理员同上、不允许强推与删除分支。

**v1 的 `scope` 作业与三条 legacy 检查已随 `agent/` 删除；分支保护里的旧 contexts 需要在仓库设置里同步移除**（这是仓库设置，不由代码改动完成）。

## 8. 给外部贡献者

- 涉及行为变化的请先开 issue 描述意图。
- **不要提交**：API key、token、`.keys.env`、内部会话日志、抓包素材、他人代码的逐字提取物。
- 安全问题请走私密通道，见 [`SECURITY.md`](SECURITY.md)。
