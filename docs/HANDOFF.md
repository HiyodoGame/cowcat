# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-17**（P2 T6 合并之后）
> 交接时仓库状态：`main` = `361a333`，工作区干净

---

## 1. 本次实际做了什么

**只做了 P2 T6**（PR #12，squash 合并 → `361a333`）。P2 的 T1–T5 是更早的会话做的，**不要记在本次账上**。

三个部分：

**① 前沿文献调研**（用户要求的前置）→ `docs/research/p2-sandbox-literature.md`
`websearch` 集成返回 HTTP 402，改用 arXiv API 直查（`export.arxiv.org/api/query`）。七篇相关文献，两处改变了做法：

- **The Same Zero**（[2610.04504](https://arxiv.org/abs/2610.04504)）：Verification Autonomy Levels，命题是「zero is an outcome, not a guarantee」。→ 把 G1/G2/G3 的证明等级标注为 **L2 客观事实，不是保证**，写进测试文件头与架构文档。
- **Overeager Coding Agents**（[2605.18583](https://arxiv.org/abs/2605.18583)）：范围扩张是与逃逸并列的第四类授权问题；实测仅移除 prompt 授权声明，即使越界率从 0.0% 升到 **17.1%**。→ 新增一条测试断言「范围内破坏**确实能发生**」，钉住沙箱的边界。

**② G1/G2/G3 完整矩阵** → `packages/cowcat/test/sandbox-enforcement.test.ts`
12 条真后端用例（Linux/macOS 真跑，Windows 按平台 skip）。两条原则贯穿全部断言：断言落在**语义**上（宿主文件不存在、内容未泄漏），不落在**信号**上；每条失败信息自带退出码、stderr 和**实际生效的 argv/profile**。

**③ 两条真机腿挖出四个真问题**（T6 的实际价值——写完测试不等于跑过测试）

| # | 问题 | 性质 |
|---|---|---|
| 1 | 私有临时目录没走 canonical 化：`mkdtemp` 结果直接进 Seatbelt 的 `(subpath …)`，不经 `resolveEntries` | macOS 上沙箱自己的 TMPDIR **不可写** |
| 2 | 遍历符号链接需要对 **SYMLINK vnode** 的读权限；profile 只授了 DIRECTORY 的 metadata | **任何人会写的绝对路径全部 EPERM**，而 profile 看起来完全正确 |
| 3 | `existsSync` 在 `statSync` 与 `readFileSync` 都 EPERM 的路径上返回 **true** | 隔离断言的探针本身是坏的 |
| 4 | 自己两个测试 bug：`unlinkSync` 返回 undefined 导致 `&&` 短路；`node()` 只加一次 `require("fs")` | 测试自身 |

问题 2 的排查过程本身值得留着：**中途误判成「`subpath` 匹配字面路径」，实现了「每条路径发两种拼写」，跑 CI 仍然 EPERM**。把两组变量分开跑（六个变体）才拿到答案。双拼写已删除——零收益，而每条 deny 都要手工复制两份，漏一处就是绕过。该否决由一条测试钉住。

---

## 2. 当前状态

### 已验证 —— 真机（CI 实跑，两条腿都拿到证据）

| 腿 | 后端 | 结果 |
|---|---|---|
| `packages/cowcat · node 22 · ubuntu-latest` | bubblewrap 0.9.0 + AppArmor profile | **219 pass / 0 fail / 0 skipped** |
| `packages/cowcat · node 22 · macos-15` | seatbelt | **219 pass / 0 fail / 0 skipped** |

两条腿的探测裁决（CI 日志原文）：

```
linux: verdicts: [{"name":"bwrap","usable":true,"reason":"ok","detail":"/usr/bin/bwrap","fix":null,"hardening":["disable-userns"]}]
macos: backends: [{"name":"seatbelt","usable":true,"reason":"ok","detail":"/usr/bin/sandbox-exec","fix":null,"hardening":[]}]
```

**这顺带关掉了一个悬案**：T5 遗留的「AppArmor profile 生效后 `--disable-userns` 是否可用」不再是推断——CI runner 上实测 `hardening: ["disable-userns"]`，即**加固确实生效**。

### 已验证 —— 本机（Windows）

`npm test` 219 项 / 0 失败 / 15 skipped（skip 的都是需要真后端的沙箱用例）。

### 平台设置（单独核对过）

分支保护 `required_status_checks` 实为 **6 条**，本次未改动：

```
test · node 22 · ubuntu-latest          packages/cowcat · node 22 · ubuntu-latest
packages/cowcat · node 22 · windows-latest   packages/cowcat · node 22 · macos-15
test · node 22 · macos-15              package whitelist
```

PR 上报的作业共 9 条（多出 `test · node 24 · ubuntu-latest`、`test · node 22 · windows-latest`、`scope · does the legacy agent/ change?`），后 3 条不阻塞合并。

### 项目状态

- `packages/cowcat` = `@corescense/cowcat-core` `0.0.0` `private: true` —— **从未发布**，v2 格式未对外，`schemaVersion` 升格问题尚未发生。
- **P2 六个任务（T1–T6）全部完成并合并**。测试 69 → 219。
- 旧 `agent/` 树**本次未改动**：`agent/test/sandbox-{linux,macos}.test.mjs` 最后一次改动是 PR #21（`4fc20cc`），早于整个 v2 工作。删除留给 P8。
- `docs/changelog.md` 的 0.16.0 条目写的是**旧树**路径（`src/sandbox/backends/seatbelt.js`），描述的是旧实现，**不是 v2**。v2 未发布所以未进 changelog，这是预期状态。

---

## 3. 项目唯一下一步

**P3：策略、配置与审批协议。**

范围见 [`dev-plan-v2.md`](dev-plan-v2.md) 的 `## P3`。要点：

1. 配置 schema（zod）、分层加载与合并、错误报告带文件与路径
2. 路径信任模型（工作区是否受信任、信任记录如何持久化；旧版 `agent/src/trust.js` 有结论可参照）
3. 规则集从默认规则扩展为可配置规则，保留 `deny > ask > allow` 与「未命中即 ask」
4. 审批：`approval.requested` / `approval.answered` 作为事件进日志，支持无人值守显式开关
5. 审计：作为事件的消费者，而不是内核内的分支

出口标准：策略的全部裁决都能由配置表达，无需改代码；无人值守下所有 `ask` 要么按显式规则放行、要么拒绝并留审计。

**按工作规则 1，P3 开工前先写 `docs/research/p3-policy.md`。**

**从 P2 带到 P3 的具体接口债**：`worktree 兄弟目录`作为额外写路径传入的接口留到 P3 接入 worktree 时接（现在不自动纳入写策略）。

---

## 4. 关键决策

| 决策 | 内容 | 出处 |
|---|---|---|
| 三个端口方法保持同步 | `ProcessPort` / `FsPort` / `PlatformPort` | ADR-017 |
| 会话头记 shell **不升 `schemaVersion`** | v2 格式从未发布（`private: 0.0.0`） | ADR-018 |
| bwrap 加固**单独探测** | 不带 flag 判可用；带 `--disable-userns --assert-userns-disabled` 判加固。加固失败则**不带加固执行并上报限制**，不拒绝 | ADR-020 |
| macOS `network: 'on'` 拒绝 | 新增 `SandboxRequestRefusedError`，不复用 `SandboxUnavailableError`；两种拒绝消息必须不同 | ADR-021 |
| **Seatbelt 需要 SYMLINK metadata** | `/var`、`/etc`、`/tmp` 是符号链接，遍历需要 SYMLINK vnode 读权限。补 `file-read-metadata (vnode-type SYMLINK)` | **ADR-022** |
| 私有 `/tmp` 固定 2 GiB + `--perms 1777` | 实测默认是内存的一半（19.5 GiB）且 0755 | ADR-021 |
| **不生成双拼写规则** | 实测无效，且把 deny 面扩大一倍（漏同步即绕过） | T6 测试钉住 |
| 隔离断言不用 `existsSync` | 它在 `statSync`/`readFileSync` 都 EPERM 处返回 true | T6 测试钉住 |

---

## 5. 踩坑（都是这次真花时间换来的）

**关于测量**

1. **一次 CI 循环的信息量 ≫ 一次推理。** 问题 2 靠六个变体一次跑完定位；纯靠读代码我先后猜错了两次（「literal 路径」「双拼写」）。
2. **失败的断言必须自带现场。** 加进 argv/profile 之后，「EPERM」和「这行不在 allow 列表里」才成为两个可区分的 bug。
3. **`existsSync` 是坏探针。** 它在两个不同的失败原因下都给出误导答案——一次是策略没生效（返回 true），一次是遍历失败（返回 false）。
4. **「错因通过」比失败更危险。** 那条断言在 `/var` 遍历失败时一直是绿的，策略从没被问过。

**关于实验设计（自己踩自己的）**

5. **一次只改一个变量。** 第一轮把「双拼写」和「SYMLINK 规则」混在一起测，六组数据全废。
6. **基线 profile 自己得先能跑。** 实验里 node 自己起不来（`OpenSSL configuration error`），那测的是缺 note 7 根规则，不是被测现象。
7. **验证脚本的语法错误会伪装成被测现象。** 三轮实验里有一轮每一轮都报同一个无关的 shell 语法错误。

**关于工具**

8. PowerShell 嵌套引号会破坏复杂内联命令 → **写脚本文件**（`node <file>`）。
9. `git commit -m "…"` 带双引号会被截断 → **`git commit -F <文件>`**。
10. `npx tsc` 输出被 `execFileSync` 吞掉会给出假的「通过」→ **读 `err.stdout`**，或用 TypeScript 编译器 API 直接取 `parseDiagnostics`（还能顺带看到「错误其实在第 352 行」这种偏移信息）。
11. 删除源文件后 `dist/` 里的旧 `.js` 会继续被测到 → 顺手清 `dist/test/`。
12. 手写 patch 脚本时漏一个 `}` 会让模板串不闭合，解析器一路吞到下一个反引号，**报错位置离真凶很远**（真凶在 352 行，报在 372 行）。

---

## 6. 未验证 / 待确认

### 已实测但**未在生产**验证

- 全部沙箱证据都来自 **CI runner**，不是生产机器。runner 的内核、AppArmor profile、bubblewrap 版本都可能与用户机器不同。
- bubblewrap 证据来自 `--privileged` 的 `ubuntu:24.04` 容器（本地实验）与 `ubuntu-latest` runner。**WSL2 没有 Ubuntu 24.04 的 AppArmor userns 限制**，所以 AppArmor 相关结论只能由 CI 腿给出——本次已拿到（`hardening: ["disable-userns"]`）。

### 已知缺口（**不声称已解决**，逐条对应 [`dev-plan-v2.md`](dev-plan-v2.md) 的 T6 缺口清单）

1. **没有 seccomp 过滤** —— 目前最大的加固缺口。bwrap 支持 `--seccomp FD`，但需要一份编译好的 BPF 程序 + 允许清单维护策略。记为 R1。依据 SysComb（[2608.26871](https://arxiv.org/abs/2608.26871)）
2. **G1/G2/G3 停在 L2** —— 没有可判定的完备性论证。换平台或内核变更都可能让断言失效而**没有一个测试变红**
3. **macOS 上读面外路径的「存在性」可被观察、内容不可** —— Node 的 `existsSync` 返回 true 而 `statSync`/`readFileSync` 是 EPERM。这是 agent 可用的小侧信道，已写进限制项。**未单独测裸 `access(2)`**，不宣称更多
4. **root 调用者下还剩哪些隔离未量化** —— 文件权限不再保护（`uid_map` 恒等映射），但挂载与网络隔离仍在
5. **`setsid()` 逃逸仍是推断** —— 附录 B 实证它能逃，但「前台超时孤儿」一类无样本
6. **worktree 兄弟目录未自动纳入写策略** —— P3 接
7. **`pwsh` 分支未验证** —— T2 只在 Windows 上确认了探测逻辑，没在真实 PowerShell 会话里跑过完整路径
8. **终止记录没有「失败原因」字段**

### 需要下一位核对的差异（保留，不以记忆覆盖证据）

- `docs/changelog.md` 0.16.0 声称「效果与 Linux 侧一致：**宿主临时目录对沙箱不可见**」。那是**旧实现**（`agent/src/sandbox/`）。v2 的实测更精确：**内容不可见，存在性可观察**。两者不是同一份实现，但如果旧实现也是用 `existsSync` 验证的，那条旧声明同样经不起检验——**待确认，不在本次改动范围内**。
- `dev-plan-v2.md:52` 写着「Windows 腿仅在 main 运行，尚无可核对的真实运行记录」。本次 PR #12 里 `packages/cowcat · node 22 · windows-latest` **在 PR 上跑过且通过**。该行已过时，未改（属于 P1 段落）。

---

## 7. 关键文件

| 路径 | 内容 |
|---|---|
| [`dev-plan-v2.md`](dev-plan-v2.md) | **权威计划**。P2 的出口标准与缺口清单在 T6 段 |
| [`architecture/README.md`](architecture/README.md) | ADR-001~022 |
| [`architecture/03-policy-and-execution.md`](architecture/03-policy-and-execution.md) | 沙箱分层、拒绝语义、bwrap 挂载顺序、Seatbelt 符号链接遍历 |
| [`research/p2-sandbox.md`](research/p2-sandbox.md) | **实测**报告。§4.1–§4.10 十条实测发现 |
| [`research/p2-sandbox-literature.md`](research/p2-sandbox-literature.md) | **外部证据**。与实测分开，因为可信度来源不同 |
| `packages/cowcat/test/sandbox-enforcement.test.ts` | G0/G1/G2/G3 + 边界 + 可解释性 |
| `packages/cowcat/src/adapters/sandbox/backends/seatbelt.ts` | 纯 SBPL 生成。文件头八条实测语义 |
| `packages/cowcat/src/adapters/sandbox/backends/bwrap.ts` | 纯 argv 生成。挂载顺序是承重的 |
| `packages/cowcat/src/adapters/sandbox/executor.ts` | 后端选择、两种拒绝、私有临时目录生命周期 |
| `.github/workflows/ci.yml` / `ci-macos.yml` | 三条 `packages/cowcat` 腿；Linux 腿有一步打印探测裁决 |