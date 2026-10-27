# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-27（全项目审查驱动的正确性与性能优化）**。
> 交接时仓库状态：**`fix/review-optimization` 分支，基线 main @ `fc41d89`，改动未提交**；四包全绿（TUI 需 Node 26）；ADR-168~170 已落表。
>
> **证据分级**：**【源码】**读代码；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（v2 跑 `dist/`）；**【CI 远端】**GitHub Actions；**【真机】**真实模型 API / 真实 git 跑出的验收记录；**【上游】**官方文档/上游源码；**【推断】**未实测，不作为决策依据。

---

## 1. 本批完成

按“正确性 → TUI 性能 → 会话 I/O → 结构与文档”顺序实施，所有行为修复均先写回归测试并确认原实现失败。

| 类别 | 内容 | 结果 |
|---|---|---|
| 配置写入 | `provider.set` 按配置文件串行完整读—改—写；唯一临时文件；`dirname` | 20 并发写入全部保留；Windows 不再产生 `config.jso` |
| usage | ADR-169：`model.usage/message` 可选 `invocation`；同调用累计值替换、跨调用累加；assistant 消息补齐锚点 | 修复 Anthropic 用量/缓存翻倍及上下文重复估算；旧日志兼容 |
| 侧栏 | 成本复用 `costOf/formatCost`；变更组改称“CowCat 变更”；Panel 用主题 token | 修复成本放大 100 万倍；自定义主题实测生效 |
| TUI 性能 | `entry-cache.ts` 按 entry 与真实依赖缓存；思考只在换行边界可证等价时缩短，否则完整 wrap | 最终探针：frameOf 100 轮 176.17→0.09ms，200 轮 352.27→0.16ms；思考 tick 26.07→20.40ms；含空白/CJK 尾部逐行等价有回归 |
| 会话 I/O | ADR-170：索引读有界头尾；`EventStore.readAfter`；打开优先快照+增量；host.close 保存快照 | 普通索引不再全读；快照打开不再 `readAll`；损坏/超长记录仍全量回退 |
| `@` 候选 | attach 改异步遍历，generation 丢弃迟到结果 | attach 不等待目录扫描，旧会话结果不覆盖新会话 |
| 发布 | tarball 安装检查增加隔离 `COWCAT_HOME` 的 doctor（当前 Node + Node 26.12） | `--install` 实测通过，无模型/密钥需求 |

## 2. 测试基线

| 包 | 通过 | 说明 |
|---|---|---|
| cowcat | 932/948 | 16 skip 平台既有项；新增 provider、usage、索引/快照/宿主回归 |
| protocol | 47/47 | 无变化 |
| tui | 200/200 | **Node 26.12.0**（`npx --yes node@26.12.0 --test dist/test/`） |
| cli | 41/41 | 无变化 |

探针与守卫：`lint-probe` 全过、策略 16/16、`tui-perf-probe` 已复测、`check-tarball --install` 含 doctor 通过。**CI 三平台为权威门。**

## 3. 本批 ADR

- **ADR-168** 双栏组件化布局：结构化 Panel spec、page 全宽，补上 #226 的决策记录。
- **ADR-169** usage invocation：原始事实全留痕，账单同调用取最后值，锚点随 assistant 消息补齐。
- **ADR-170** 会话读取分层：索引有界头尾、快照+`readAfter` 增量回放、host.close 尽力保存快照。

## 4. 未验证 / 风险（登记，不声称已解决）

- **产物级验收**：本批 tarball 与 doctor 已验，但 beta-checklist 中真实模型、真实终端 30 分钟、各平台项仍需按清单执行，不能以单测全绿替代。
- **`readAfter` 的边界**：Jsonl 流式跳过旧事件，减少解码与常驻内存，但仍需顺序读取文件；不宣称完全消除磁盘 I/O。
- **真实 Anthropic 累计用量**：已用真实协议夹具与内核/TUI 测试固定语义，未在本批调用付费端点复测。
- **P3 挂起**：`!` 前缀直跑 bash、Ctrl+V 图片粘贴。
- **MemoryPort ADR 草案**仍待评审（`docs/architecture/adr-memory-port-draft.md`）。

## 5. 下一步建议

1. 在分支评审后合入本批，再推进 beta.5 与 beta-checklist 的产物级验收。
2. 若会话规模继续增长，为 Jsonl 增加字节水位/索引，进一步减少 `readAfter` 的顺序 I/O。
3. P3 两项按需排期；MemoryPort 草案评审沿用现有编号续排。

## 6. 构建与测试（不变）

```bash
cd packages/cowcat && npm test        # pretest = tsc + ESLint；改完必须跑这个
cd packages/protocol && npm test
cd packages/tui && npm test           # 本机用 npx --yes node@26.12.0 --test dist/test/
cd packages/cli && npm test
```

探针：`node tools/lint-probe.mjs`、`node tools/policy-decide-probe.mjs`、`node tools/check-tarball.mjs --install`、`node tools/tui-perf-probe.mjs`。
