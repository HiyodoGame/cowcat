## 这个 PR 做了什么

<!-- 一到两句：改了什么、为什么（对齐 docs/ROADMAP.md 的批次，或 docs/dev-plan-v2.md 的阶段）。 -->

## 自检清单

- [ ] `cd agent && npm test` 全绿（`pretest` 会先跑 ESLint）
- [ ] `cd packages/cowcat && npm test` 全绿（`pretest` = tsc build + ESLint）
- [ ] CI 全绿（必过三项：`packages/cowcat · node 22`、`test · node 22`、`package whitelist`）
- [ ] 有用户可见变化时，`docs/changelog.md` 的版本段落已更新（新版本段落先带「未发布」标记）
- [ ] 有行为/用法变化时，`docs/USAGE.md` 已同步
- [ ] 批次性改动已在 `docs/fix-plan-*.md` 记录（做什么、为什么、验证证据、未做项）
- [ ] 没有把密钥、内部会话日志、抓包/提示词素材、他人代码的逐字提取物提交进仓库
- [ ] 版本号仅在**发布批次**里变更（`agent/package.json`）

## 验证证据

<!-- 贴关键命令与结果（测试计数、CI 运行链接、真实冒烟结论）。区分「已验证」与「推测」。 -->

## 平台与代价

<!-- 这次改动是否平台敏感（Windows / macOS / Linux）？如果是，本机之外有没有验证过？ -->