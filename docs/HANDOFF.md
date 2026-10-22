# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾（或用户要求做会话收尾）重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-22（P7 第三个模块 Hooks 全链路收尾）**。
> 交接时仓库状态：**`main` = `25800aa`，工作区干净；最新发布仍为 `v1.0.0-beta.3`（本批次未发版）。**
>
> **证据分级**：**【源码】**读代码；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（v2 跑 `dist/`）；**【CI 远端】**GitHub Actions；**【真机】**真实模型 API 跑出的会话日志；**【上游】**官方文档/上游源码；**【推断】**未实测，不作为决策依据。
>
> **归属**：本会话产出为 **#153~#163**（工具结果治理 + Hooks 两个 P7 模块全链路；更早的 Skills #147~152 同属本会话前半）；TUI/后台任务/beta.3（#93–#145）属于前序会话。

---

## 1. 本次会话做了什么

三个 P7 模块，各自走完整链路「专项调研 → ADR → 实现 → post-merge 审查修复 → 真机验收」：

### Skills（#147~#152，已完成）

- 调研 → ADR-114~117 → T1/T2 实现 → 审查修复（#151，3 P1 + 5 P2）→ **T4 真机验收（#152）**：glm-5.3-flash 自然触发 2/2。
- 要点：四类目录一层扫描；catalog 预算 min(8KB, 2%)；`Skill` 工具无 pathInput、正文 ≤32KB；catalog 作为 `skills.loaded` 事件进日志。

### 工具结果治理 T-A（#153~#157，已完成）

- 调研 → ADR-118~120 → T1~T3 实现（#155）→ 审查修复（#156，**1 P0**：同轮 `[A,A,B]` 时提醒打断 wire 配对毒化日志——改轮末统一注入；2 P1 + 4 P2）→ **T5 真机验收（#157）**：三机制全触发、零 400、cacheRead 88%–99%。
- 要点：tool clearing 是派生视图（最近 2 条全保 + 占位符 + 附件停发）；spill 50KB 适配器层外置（bash/read/notebook）；repeat 防护轮末批量提醒进日志。

### Hooks（#159~#163，已完成）

- 调研（#159）→ ADR-121~123 落表（#160）→ T1~T4 实现（#161）→ 审查修复（#162，**5 P1 全为 CC 兼容硬偏差**：stdin 事件名 PascalCase、顶层 decision 双格式读取、additionalContext 位置、tool 事件 context 被丢弃、输出无上限；+ 8 P2）→ **T5 真机验收（#163）**。
- 要点：
  - **ADR-121**：hooks 是宿主侧副作用——`HooksPort` 内核只类型依赖；不过 policy.decide、project 层过 trust 门（MCP 先例）；exit 0/2/其它/超时语义；60s 超时、会话 sandbox、串行；port 抛错经 `runHooksSafely` 兜底成 note（不杀回合）。
  - **ADR-122**：v1 六事件（PreToolUse deny / PostToolUse 改写+note / UserPromptSubmit 注入+拒 prompt / Stop、SessionStart、PreCompact 观察）；command-only；stdin CC 形状（PascalCase 事件名、不给 permission_mode）；决策读双格式（顶层现行 + hookSpecificOutput 旧形态）；日志纪律：deny 复用 `tool.finished ok:false`、改写记模型所见、context 走 `hooks.context-added`（tool 事件的轮末批量注入）。
  - **ADR-123**：五配置源（`~/.claude/settings.json`、`~/.cowcat/config.json` hooks 段、项目 `.claude/settings.json`/`settings.local.json`/`cowcat.json` hooks 段）叠加执行、user→project、先 deny 者胜、跨文件相同 handler 去重；doctor 三要素（handler 数/跳过数/不生效清单）。
- T5 真机：临时受信项目配 CC 文档形态的 block-rm hook，模型跑 `rm -rf` 被拦、确认文件仍在、给出替代方案；日志 `tool.finished ok=false blocked by hook: …` 与 ADR-122 ④ 一致；doctor 行三要素齐全。

## 2. 测试基线（本机全绿）

| 包 | 通过 | 跳过 | 说明 |
|---|---|---|---|
| cowcat | 777 | 16 | 含 tool-clearing/spill/tool-repeat/hooks 新测试 |
| protocol | 43 | 0 | 本批次未改 |
| tui | 104 | 0 | **必须 `npx --yes node@26.12.0 --test dist/test/`**；本机 Node 24 跑是 16 个 FFI 假失败 |
| cli | 31 | 0 | 含 doctor hooks 行 |

`tools/lint-probe.mjs` 全绿。CI 三平台绿。

## 3. 新增 ADR（本会话）

ADR-114 技能来源 · 115 frontmatter 兼容 · 116 catalog 渐进披露 · 117 `Skill` 工具契约 · 118 tool clearing · 119 spill · 120 repeat 防护 · **121 hooks 定位与信任门** · **122 hooks v1 兼容子集与日志可重放纪律**（③④ 已按 #162 审查修订）· **123 hooks 配置来源与合并**。

## 4. 未验证 / 风险（必须先看）

- **Hooks 已知偏差**（调研 §11.1，有意为之）：`updatedToolOutput` 收 string/`{output}` 非工具形状对象；UserPromptSubmit 纯文本 stdout 不注入；`${CLAUDE_PROJECT_DIR}` 文本替换在 Windows 路径脆弱（env 通道已正确，推荐 exec 形）；trust 判定在 cwd 而 hook 文件在 projectRoot 祖先（同 skills 先例，hooks 载荷更敏感，出意外再收紧）。
- **Hooks 未覆盖真机项**（调研 §12）：PostToolUse 改写/additionalContext/拒 prompt 真机未触发（内核级测试覆盖）；观测 hook（Stop/SessionStart/PreCompact）开销未量化。
- **T-A 遗留**（不阻塞）：clearing 保留窗口 2 条的长会话三档对比；大会话缓存对照；repeat 误报面观察。
- **`~/.claude/skills` 33 个技能每次进 catalog ~7.5KB**：`paseo*` 等无关技能可加 `disable-model-invocation: true`（每会话省 ~2k tokens）。
- **既有保留项**（前序会话）：`Shift+Enter` 不修（用户决定）；后台任务 Windows `taskkill /T` 未人眼验证；`cowcat trust` 不影响运行中的会话。
- 发布：下个批次会带上 Skills + T-A + Hooks 三个模块。

## 5. 开放 issue

无。

## 6. 下一步建议

1. **P7 下一个模块，用户选**：Plan 模式（多方案预览 D5 已在 dev-plan 行里）、会话体验（D8）、可观测性（D9）、审批与沙箱闭环（D7）、Cron/Worktree 等。
2. **Hooks 后续（不阻塞）**：http/mcp_tool handler、`if` 字段（挂 policy 语法）、Stop block「让模型继续」、SessionEnd（需 close 事件）、观测 hook 开销量化。
3. **发版**：三个 P7 模块攒一批发 `beta.4` 的节奏由用户定。

## 7. 会话踩坑（本会话新增）

- **PowerShell 对 UTF-8 文件用 Get/Set-Content 会按 ANSI 重编码**：中文密集文件整篇损坏且不可恢复——读写文件一律用 `read`/`write` 工具或 `[System.IO.File]::ReadAllText/WriteAllText(..., UTF8)`；需要批量替换时用 .NET 方法，别用管道 Set-Content。
- **node:test 的断言顺序坑**：`assert.deepEqual(actual, expected)` 在 node 原生测试里输出 actual/expected 与直觉相反（diff 里 `+ actual`）；看失败先看 `actual:` 行。
- **TS filter 类型谓词**（前次已记）：TS 5.5+ 推断后，filter 结果再写 `===` 判断会被 `no-unnecessary-condition` 拦——filter 直接当已收窄用。
- **给模型传嵌套引号命令必丢内层引号**（glm-5.3-flash 两次实测）：验收场景预置文件/配置，别靠模型现场拼。
- **tsc 每消息估算下限 5 tokens**：两消息会话 keepTokens=5 也会「有东西可压」——测试「无事可压」要用大 keep 窗口。

## 8. 构建与测试（不变）

```bash
cd packages/cowcat && npm test        # pretest = tsc build + ESLint，测试跑 dist/
cd packages/protocol && npm test
cd packages/tui && npm test           # Node >= 26.4；本机用 npx --yes node@26.12.0 --test dist/test/
cd packages/cli && npm test           # 依赖前三个已构建
```

探针：`node tools/lint-probe.mjs`、`node tools/check-tarball.mjs --install`。`file:` 依赖是 junction，按 protocol → cowcat → tui → cli 顺序构建。`main` 不可直推；提交信息 `type(scope): 中文摘要`，Windows 用 `git commit -F <文件>`。

真机验收素材：真实模型凭证 `~/.cowcat/config.json` preset `zai-coding-plan/glm-5.3-flash`；验收脚本与提交信息在 `C:\Users\Con_WKK\AppData\Local\Temp\cowcat-tui-accept\`。
