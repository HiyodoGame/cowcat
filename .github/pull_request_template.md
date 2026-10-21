## 这个 PR 做了什么

<!-- 一到两句：改了什么、为什么（对齐 docs/dev-plan-v2.md 的阶段或 ADR）。 -->

## 自检清单

- [ ] `cd packages/cowcat && npm test` 全绿（`pretest` = tsc build + ESLint）
- [ ] `cd packages/cli && npm test` 全绿
- [ ] 改动触及协议/TUI 时，对应包也跑过测试
- [ ] CI 全绿（四个包 + `package whitelist`）
- [ ] 有用户可见变化时，`docs/changelog.md` 已更新（新版本段落先带「未发布」标记）
- [ ] 契约性变更先更新 `docs/architecture/README.md` 的 ADR 表，再改代码
- [ ] 没有把密钥、内部会话日志、抓包/提示词素材、他人代码的逐字提取物提交进仓库
- [ ] 版本号仅在**发布批次**里变更（四个 `package.json` + `tools/pack-release.mjs` 的 `VERSION`）

## 验证证据

<!-- 贴关键命令与结果（测试计数、CI 运行链接、真实冒烟结论）。区分「已验证」与「推测」。 -->

## 平台与代价

<!-- 这次改动是否平台敏感（Windows / macOS / Linux）？如果是，本机之外有没有验证过？ -->
