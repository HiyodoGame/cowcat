# CowCat v2 交接

> **本文件是快照，不是活文档。** 每次阶段收尾（或按用户要求做会话收尾）重写；权威计划始终是 [`dev-plan-v2.md`](dev-plan-v2.md)，决策是 [`architecture/README.md`](architecture/README.md) 的 ADR 表。
>
> 最近一次更新：**2026-10-19（会话收尾：P6 的 T4a 2/3 后半 → T10 收口）**。
> 交接时仓库状态：**`main` = `9279e47`**（#64 合入）；当前分支 **`feat/p6-t10-closing`**（3 个提交，工作区干净，与 origin 同步，**PR #65 开着且 `CLEAN`**）。
>
> **证据分级**（沿用前几轮，逐条标注）：**【源码】**读代码/读装机类型；**【构建】**`tsc` 通过；**【本机测试】**Windows 上跑 `node:test`（cowcat/cli 用系统 Node **24.18.0**，tui 用便携版 Node **26.12.0**；v2 的测试跑在 `dist/` 编译产物上）；**【本机命令】**本机跑的其他命令（`git`、`npm`、探针脚本、PyYAML/python 校验）；**【CI 远端】**GitHub Actions 的运行结果（**只观察状态，未在本地复现**）；**【上游】**厂商文档或装机包的类型声明；**【registry】**npm registry 查询；**【推断】**未实测的推论，不得作为决策依据。
> **本会话没有真实终端、没有模型端点、没有发布动作、没有平台设置变更**：stdout 不是 TTY；`ZHIPU_API_KEY` 在本机 shell 里不存在；未调用 `opencode_console` 的任何写操作。

---

## 1. 本次会话实际做了什么

### 归属（不要记错）

- **`main` 上的 `89354a6`（#62，T4a 1/3）以及更早的提交都是前序会话的。**
- 分支 `feat/p6-t4a-host` 上的 **`884ad67` / `9672ca3` / `26b3b99`（T4a 2/3 前半：ADR-063 + 内置预设）与 `db111be`（交接文档）也是前序会话的**。本会话从 `5efffb9` 开始。
- 本会话**自己合并**了 #63、#64（用户明确要求「合 #63」「合 #64」），但 PR **#56~#62 是前序会话产出并合并的**，不算本会话的产出。

### 本次会话（2026-10-19）实际做了什么

**3 个 PR（2 合 1 开）+ 1 次交接复核**：

| PR | 内容 | 测试数（本机） | 状态 |
|---|---|---|---|
| #63 | **T4a 2/3 后半**（ADR-064：组合根与真实 `ProtocolHost`）+ **3/3**（ADR-065：`packages/cli` 与可执行文件）+ **T7 骨架**（ADR-061 主题 token、ADR-066 TUI 骨架） | cowcat 583→600、cli 19、tui 24 | 已合（`f2dbb73`） |
| #64 | **T8 卡片**（ADR-067：卡片即文本、宽度表、尾部挂载、命令表与键位）+ **T9 图片**（ADR-068） | tui 24→46、cli 19 | 已合（`9279e47`） |
| #65 | **T10 收口（自动部分）**：出口标准的两条接缝 + 人眼验收清单 | cli 19→20、lint-probe 18→21 | **开着**（`32424e8`，`CLEAN`） |

**开工第一件事是复核前序交接**（用户给的摸底报告里有 4 项「待主 Agent 验证」）：`main`/分支/PR 状态、`npm view` 的 v1 版本、`core.hooksPath`、`host/` 与 `TurnOutcome.turnId` 的缺口——四项全部核对一致，只发现「分支 3 个提交」少了文档提交（实为 4 个）。

**随后按用户指令依次推进**（每一步都在同一分支上「实现 → CI/探针 → 文档」三批提交）：

1. **T4a 2/3 后半**：`host/paths.ts`（`~/.cowcat` 布局）、`host/config.ts`（三层配置 + 组合根基线规则）、`host/host.ts`（真实 `ProtocolHost`：会话生命周期、回合、审批桥、`attachment.read`）、`adapters/{config-files,session-index,sandbox/fs-probe}.ts`；`TurnOutcome` 加 `turnId`；`packages/cowcat` 依赖 `@corescense/cowcat-protocol`。
2. **CI 与锁文件**：三条 cowcat 腿加「构建协议包」步骤；**把 cowcat 锁文件里 9 条 `registry.npmmirror.com` 改回官方 registry**（第一轮 CI 全在那 9 条上 504）。
3. **T4a 3/3**：新建 `packages/cli`（`@corescense/cowcat-cli`，**Node ≥22**），把 `bin`/子命令表/帮助/`doctor` 从 `packages/tui` 搬过来；`serve` 接真实宿主并在 `finally` 里 `host.close()`；`run`（`--yes`/`--session`）、`sessions list`、`doctor`（配置/trust/rules/sandbox/模型）全部接线；选项进表（`CommandSpec.flags`）、`COWCAT_HOME`；CLI 锁文件与 `package.json` 同步修一次。
4. **T7 骨架**：`app/{view,project,copy}.ts`（纯函数视图）、`theme/tokens.ts`（ADR-061）、`ui/{line,screen}.ts`、`components/{session-frame,transcript,status-bar}.ts`、帧快照（`test/frames.ts`）、`cowcat tui` + `sessions resume <id>` 接线（cli 建宿主 + **内存传输**，渲染器只拿 `ProtocolClient`）。
5. **T8 卡片**：`text/{width,wrap,diff}.ts`（宽度表迁移 v1 并修掉排序 + 重叠缺陷；diff 迁移 v1 的 LCS）、`ui/card.ts`、`components/{message,tool-card,approval-card,todo-panel,palette}.ts`、`app/{commands,keymap}.ts`（命令表一处两用、键位纯函数）、注入时钟（10 秒催促）。
6. **T9 图片**：`image/layout.ts`（尺寸）、`AttachmentView` 三态、`ImageSlot`（**绝对定位**覆盖卡片预留行）、`attachment.read` 取字节、异步解码的 `onLoad` 重绘。
7. **T10 收口（自动部分）**：`packages/cli/test/exit-criteria.test.ts`（真实协议事件流 → `project()`/`frameOf()`）、lint 规则「只有 `ui/screen.ts` 与 `run.ts` 碰渲染器」+ 5 条 tui 探针、`src/smoke.ts` 挪进 `test/`。

**四次用户拍板**（都在本会话内）：① T4a 2/3 后半的三个决定（落盘用 `~/.cowcat/sessions/` + `trust.json`、加 TodoWrite 免问、接信任闸门）；② 「继续」= 按 HANDOFF §3 的下一步推进（T7 → T8 → T9 → T10）；③ 「合 #63」「合 #64」；④ 「继续 T10 收口」。

---

## 2. 当前状态

### 已验证 —— 【本机测试】/【本机命令】（Windows）

- 【本机测试】`cd packages/cowcat && npm test` → **600 tests / 584 pass / 0 fail / 16 skipped**（Node 24.18.0；`pretest` = `tsc` + ESLint 通过）
- 【本机测试】`cd packages/tui && npm test` → **46 tests / 46 pass / 0 fail**（Node 26.12.0 便携版；`pretest` 通过）：`project()` 10、卡片 12、帧快照 9、宽度表 6、diff 7、T1 前提 2
- 【本机测试】`cd packages/cli && npm test` → **20 tests / 20 pass / 0 fail**（Node 24.18.0）：3 条 spawn 真实 `cowcat serve` 进程、1 条**出口标准接缝测试**（真实协议回合 → 前端渲染）、其余为分发/选项/`doctor`/`sessions`/`run`
- 【本机命令】`node tools/lint-probe.mjs` → **21 条探针全过**（四个包）：cowcat 10、protocol 3、tui 5、cli 3
- 【本机命令】`node tools/tui-api-probe.mjs` → **16/16**（Node 26.12.0）：确证 `content`/`fg`/`attributes`/`wrapMode`/`placeholder` 有 setter、`remove` 存在、`captureSpans()` 给逐行 span 与颜色、**`'default'` 不是颜色名**、`InputRenderable.onSubmit` 是死代码
- 【本机命令】`node tools/tui-smoke.mjs` → **7/7**：真实 `cowcat tui` 进程起得来、**画得出帧**、Ctrl-C **退出 0**、**不留会话锁**
- 【本机命令】`node tools/check-tarball.mjs` → passed（v1 `@corescense/cowcat@0.16.0`，109 files / 294,794 bytes；本会话中段跑过一次）
- 【本机命令】CI 的 YAML 用 PyYAML 校验：**11 个 job**（新增 `cli`），**已有 job 的 `name` 逐字未变**，三条 cowcat 腿 + cli 腿都在安装前构建 `file:` 依赖
- 【本机命令】ADR 表用脚本校验：**68 行、无重复 id、无粘连行**（本会话修过两次「编辑吃掉下一行行首」的事故，见 §5 第 28 条）
- 【registry】`npm view @corescense/cowcat version` → **`0.15.0`**（本会话复核；`agent/package.json` 已是 `0.16.0`，**该版本尚未发布**）

### 已验证 —— 【CI 远端】（只观察状态，未在本地复现）

- #63、#64、#65 每轮都是 **13 项检查 pass**（另有 2 项 `skipping`，是 `scope` 过滤的 legacy 腿，按设计如此）：legacy 四条、`packages/cowcat` 三腿 + macOS Seatbelt 腿、`packages/protocol`、`packages/tui` 两条、`packages/cli`、`package whitelist`、`scope`
- **帧快照在 ubuntu 与 windows 上同时通过**（含 `image` 那一幕）→ 逐字节快照跨平台一致
- 第一轮 #63 曾有**三条 cowcat 腿一起红**：`registry.npmmirror.com` 504（`ts-algebra` 等 9 条 `resolved`），卡 ~5 分钟才超时；改成官方 registry 后全绿
- #65 第一轮**两条 tui 腿红**：新 lint 规则抓到了 `src/smoke.ts` 与 `src/run.ts`（见 §5 第 27 条），修完第二轮全绿

### 项目状态

- **P5 完成**（T0–T7，七个核心工具已交付）；**P6：T1~T10 落地**——自动部分完成，**只剩真实终端上的人眼验收**（§3）
- 四个包：`packages/protocol`（Node ≥22）、`packages/cowcat`（Node ≥22，内核 + 组合根）、`packages/tui`（Node ≥26.4，渲染器）、`packages/cli`（Node ≥22，可执行文件）；`protocol` 被另外三个以 `file:` 依赖（**junction：不装依赖、不构建**）
- `packages/cowcat` / `packages/cli` / `packages/tui` / `packages/protocol` 都是 `private: true`、`0.0.0`，**从未发布**；`schemaVersion` 仍是 **1**（ADR-019）
- **运行时依赖 3 / 6 不变**（`zod`、`openai`、`@anthropic-ai/sdk`）；`packages/cowcat` 与 `packages/cli` 新增的都是**同仓库 `file:` 链接**，按 ADR-064 ⑤ 不计入这份第三方预算；`packages/cli` 的唯一第三方依赖是 `zod`（子命令表 schema）
- `cowcat` 六个动词：`tui` / `serve` / `run` / `sessions list|resume` / `doctor` **可用**；**`setup` 未接线**（配置的写入路径）
- **平台 / 工作区设置本会话未变更**：未调用 `opencode_console` 的任何写操作。若需确认工作区设置与模型开关，**请单独核对**，不要以本文件为据

---

## 3. 项目唯一下一步

**把 PR #65 合掉，然后做真实终端上的人眼验收**（清单在 `architecture/06-frontend.md` 的「T10 收口」一节，8 条）。做完之后 P6 才算收口，`dev-plan-v2.md` 才能从「T10 收口」翻成「P6 完成」，之后才是 **P7**（逐个模块调研，见 `dev-plan-v2.md` 的 P7 表）。

**人眼验收要用的启动条件**：Node **≥26.4** 的 `node`（系统 24 跑不了 `tui` 动词）、`COWCAT_HOME` 可指向临时目录、配置里写 `{"model":{"preset":"bigmodel/glm-5.3-flash"}}` 并 export `ZHIPU_API_KEY`——顺带把「真实模型请求零实测」那条补上。

**8 条清单的要点**（细节见 `06-frontend.md`）：① 一帧对齐 + **80 列**；② 流式闪烁与跳动；③ 审批 `y`/`n`/`always` 与 **10 秒催促**；④ 图片三级回退（kitty / 半块 / 元信息）；⑤ **`a=q` 的答复会不会漏进键盘输入**；⑥ Ctrl-C 后终端恢复、无残留 `.lock`；⑦ **缩放**（没有监听 resize 事件）；⑧ 长对话停在最新（只挂尾部，**没有滚动回看**）。

---

## 4. 关键决策（本会话落表）

P6 的 ADR 表见 [`architecture/README.md`](architecture/README.md)（**ADR-001~069**）。**本会话新增 6 条**（063 是前序会话的）：

| ADR | 一句话 |
|---|---|
| **064** | **组合根**：`~/.cowcat/sessions/<id>.jsonl` 扁平面 + `trust.json` + 三层配置（用户 → 项目 → `--config`）；组合根加一条 `TodoWrite` 免问的 `allow`（ADR-034 把这条留给它）；**信任闸门**（ADR-028）真正落地；`ProtocolHost` 实现住 `packages/cowcat/src/host/`；配置在构造时读、**模型在首次回合时建**；`attach` 的「先订阅再读日志、缓冲到重放之后补发」；**审批桥的键是 `ActionRequest.callId`**（更正上一版「不带 id」的记载）；`attachment.read` 只服务本进程见过的路径 |
| **065** | **可执行文件**：`packages/cli` 的 Node 门槛是 **22**（内核/协议的下限），**不是渲染器的 26.4**——把 26.4 写在 `bin` 上正是 ADR-062 否掉方案 B 时反对的事；渲染器门槛落在 `tui` 动词、在 import 渲染器**之前**检查；**选项进表**；**`run` 的审批策略**是「立刻逐条拒绝，`--yes` 才放行」；**`COWCAT_HOME`** 是进程事实不是配置层；`doctor` 现在真的查配置/trust/rules/sandbox/模型（**只有 `mode: system` 缺后端才是 FAIL**） |
| **061** | **主题 token**：色值只来自品牌指南 §3.1，组件只说语义名；`text` 用终端默认色（`RGBA.defaultForeground()`——`'default'` 会被警告并画成品红）；明暗切换与用户主题文件**不做** |
| **066** | **TUI 骨架**：**单进程 + 内存传输**（cli 建宿主与 server，渲染器只拿 `ProtocolClient`）→ `packages/tui` 结构上不可能 import 内核；`project()` 只吃 `WireEvent`、同日志同视图、**未知事件第一次出现记一行**、`policy.decided` 不显示；`components` 产出 `Line[]`；帧快照**限 ASCII 与框线**（CJK 宽度单独用 cell 数断言） |
| **067** | **卡片即文本**：卡片是字符串（不是嵌套 renderable），所以换行自己做（`text/wrap.ts`）；**宽度表是我们的**：迁移 v1 的 `wcwidth.js` 并把「未排序」+「两表重叠」两个缺陷**结构性**修掉（合并成一张有序不相交的表，两条性质都有断言）；**尾部挂载**而不是 `ScrollBox`（滚动条吃列、`stickyStart` 不生效）；命令表一处两用；键位点纯函数；注入时钟 |
| **068** | **图片**：三级回退与能力探测**交给渲染库**（`ImageRenderable` 的 `protocol: 'auto'` → kitty / sixel / blocks，**没有 iTerm2**）；我们负责**尺寸 / 位置 / 三态**；图片不是一行文本（帧规格里独立一路），**必须绝对定位**（flex 子元素会推到卡片外）；字节只经 `attachment.read`；异步解码要 `onLoad` 重绘 |

---

## 5. 踩坑（本会话真花时间的）

1. **Windows 的 `git commit -m "…"` 带引号会被截断** → 全程用 `git commit -F <文件>`（`write` 工具写消息文件）。
2. **PowerShell 拒绝 POSIX 链式写法**：`git status …; echo … || …` 直接 `ParserError`（`||` 在本版本无效）。拆成单条命令。
3. **控制台把 UTF-8 显示成乱码不等于文件坏了**：`git diff` 里 `—`/`③` 显示成 `�?`，与「真被写坏」长得一样。判据是**字节**：用 `read` 工具读回、用 `python` 比较 PR body 的哈希/长度、用 PyYAML 逐字比对 job 名。
4. **`git push`「Exited with code 1」是假警报**：git 把进度写到 stderr，PowerShell 当成错误。看输出里的 `abc..def branch -> branch` 即可。
5. **`edit` 的 `oldString` 若以整行开头、而我替换成了「另一行的开头」，会吃掉下一行**——本会话**三次**踩（两处文档行首粘连、ADR-065 的正文挂到 ADR-066 行尾）。修法：用脚本核对结构（ADR 表：68 行、无重复 id、无粘连），并在改动后**读回来**。
6. **`assert.equal` 会窄化类型**，随后的 `?.`/`??` 被 lint 判为多余（`no-unnecessary-condition`）。解法：整对象 `deepEqual`，或先取局部变量 + `assert.ok(x !== undefined)`。
7. **`no-non-null-assertion` 让 DP 无处可躲**：`lengths[i]![j]!` 被禁 → 改成扁平 `Uint32Array` + 一个 `at(i,j)` 助手（`?? 0`），顺带少一次分配。
8. **删源文件必须清 `dist/`**（AGENTS.md 的老坑，本会话又踩）：`test/lines.test.ts` 删了但 `dist/test/lines.test.js` 还在，跑出 1 项失败；`smoke.ts` 挪进 `test/` 后同样要清。
9. **期望帧不能放在 `dist/` 里**：第一版把快照写成 `test/fixtures/*.txt`，而测试跑在 `dist/test/`，文件落进 `dist/`（下一次 build 清掉、git 永远看不到）→ 改成编译进产物的 `test/frames.ts`。
10. **帧快照必须真的看一眼**（最值钱的一课）：第一版渲染出的帧里**状态条与输入行画在同一行**（两行文字逐字符交错，`saysthe realnthing;`），因为 `TextRenderable` 没给 `height: 1` 时列布局不给它留行。`toContain(...)` 那类断言会让它通过。
11. **`ScrollBox` 有两个坑**（都只有读帧才发现）：它在最后一列画**垂直滚动条**（那是卡片没有的一列 → 卡片折行、右边框被 `█` 覆盖）；`stickyStart: 'bottom'` **没生效**（长对话视口停在开头，命令面板整块看不见）。改成普通 Box + 按 `height - 4` 挂尾部。
12. **卡片边框算术错一格**：`╭─ title suffix fill ╮` 里 suffix 自带前导空格，却又减了一次 1 → 有 suffix 的卡片 47/48 格。抓到它的是「每张卡每一行正好 `width` 格」的**不变量**测试；肉眼看帧几乎发现不了。
13. **拆掉渲染器之后还 `draw()` 会杀掉进程**：`client.closed` 的回调在 `runTui` 的 finally 之后触发，撞已销毁的 scene → 抛异常 → **进程非 0 退出、并跳过 `host.close()` 留下会话锁**。修法：`disposed` 标志 + cli 侧把 `host.close()` 放进 `finally`。**只有 spawn 真实进程才看得见。**
14. **图片不能当 flex 子元素塞进卡片**：追加进列会画到卡片**外面**并把下面内容顶下去。正解是 `position: 'absolute'` + `top`/`left` **覆盖**预留行。
15. **`ImageRenderable` 是异步解码的**：首帧没有像素 → `onLoad` 里 `requestRender()`，否则空闲会话里图片**永远不出现**；测试里要 `renderOnce()` → `flush()` → 再 `renderOnce()`。
16. **探针全过 ≠ 包级 lint 过**：新 lint 规则只跑了 `lint-probe`（全过）就提交，CI 的 tui 腿立刻红——`src/smoke.ts`（测试辅助）与 `run.ts`（`createCliRenderer`）都在 `src/` 里。修法不是加豁免：`smoke.ts` 挪进 `test/`，`run.ts` 是正当豁免，规则改成「两个文件、各有其职」。**加规则后必须跑 `npm run lint`。**
17. **`file:` 依赖是 junction，npm 不装也不构建**：消费者腿要自己 `npm --prefix ../protocol ci && run build`；`packages/cli` 的腿因此是「protocol → cowcat → tui」三步。
18. **`npm ci` 之前要重生成锁文件**：删依赖（`cowcat-tui`）后没重跑 `npm install`，锁文件仍留链接 → CI 报不同步。本机 `npm install` 一次即修（100 包 / 8s）。
19. **`registry.npmmirror.com` 的 9 条 `resolved` 是前序遗留**（P4 装两个 SDK 留下的），改回官方 registry 后 CI 才绿。`integrity` 未动。
20. **`TextRenderable` 的 `attributes` 是位掩码**，`fg` 只认颜色名/hex；`InputRenderable` 的 `onSubmit` 是死代码（用 `on('enter')`）；`remove` 收的是 renderable 不是 id。
21. **Node 门槛要写在需要它的那一层**：一开始照 `06-frontend.md` 的图给 `packages/cli` 定 `>=26.4`，`doctor` 在本机 Node 24 上立刻 FAIL，而 `serve`/`run`/`doctor` 在 24 上完全能用。
22. **测试里连着调两次「隔离 home」的 helper**：第二个覆盖第一个的 `COWCAT_HOME`，会话写进别处，断言去第一个目录找（ENOENT）。
23. **测试里「事件没到」不一定是宿主不转发**：三处用例忘了先 `session.open`，宿主因此没有订阅者（按设计如此）。
24. **抓日志/写脚本时不要用 PowerShell 内联 python**：嵌套引号必坏（`AGENTS.md` 原话）。写 `.py` 文件再跑；控制台编码印不出的字符先落盘再 `read`。

---

## 6. 未验证 / 待确认

### 本会话新增（**不要读成「不成立」**）

1. **没有任何真实终端证据**（**P6 唯一的剩余项**）：刷新率、闪烁、**kitty / sixel 的原生图片渲染**、`a=q` 的答复是否漏进键盘输入、Ctrl-C 后的终端恢复、缩放、80 列可读——全部未测。自动部分能证明的只是「起得来、画得出字符帧（blocks 回退）、退出 0、不留锁」。
2. **一次真实模型请求都没跑过**：`tools/glm-smoke.mjs` 只走到前置检查（本机 shell 里没有 `ZHIPU_API_KEY`），按设计以 2 退出且**什么都没发**。`cowcat run` / `cowcat tui` 的整条回合只在**宿主层**用注入模型验证过。
3. **帧快照刻意不含宽字符**：逐字节快照只有 ASCII 与框线（CJK 的字宽跨平台一致性没有实测过），CJK 的**单元格**宽度用渲染器自己的 span 宽度断言。ubuntu/windows 一致的是 ASCII 那几幕（含 `image` 的 blocks）。
4. **`packages/cli` 的 spawn 测试只在 ubuntu 腿跑**：claude 腿是 ubuntu-only（理由：协议自己的 spawn 测试已在两条 tui 腿覆盖两个平台）。本机（Windows）跑过 3 条 spawn 用例，全过。
5. **会话日志不记 cwd，也不记模型**：`session.opened` 只有 `schemaVersion`/`cowcatVersion`/`shell`；所以 `cowcat run --session` / `sessions resume` 用**当前**目录，TUI 状态条也**说不出是哪个模型**。补它们要动事件 schema（一条 ADR + 编译期硬失败三处），本会话刻意没做。
6. **`session.list` 的 `lastSeq` 来自「非空行数」**（依赖 `JsonlEventStore`「一行一事件、seq 从 1 连续」的不变量，而该不变量只在 `readAll` 时校验）。手改过的日志可能被列错。
7. **`packages/cli` 与 `packages/protocol` 尚未进分支保护的 required 列表**：两者都按「非草稿 PR 必跑」上报（所以**可以**设为 required），但改仓库设置是用户的事。
8. **`cowcat setup` 未接线**；**预览模态、滚动回看、Plan/Act 双模式、语法高亮**都没做（理由写在 `06-frontend.md` 的待办里）。Plan/Act 是**策略层**的概念（v2 的 kernel/host 目前没有 mode），不是组件的活。
9. **`doctor` 不查渲染器的原生二进制**（刻意）：它在 `packages/tui/node_modules`（`file:` 是 junction），从 cli 探会得到**假 FAIL**；渲染器门槛只报「本机 Node 是否满足」。
10. **本会话未重跑 `packages/protocol` 的测试**：该包本会话未改动（42 项是前序会话的数，CI 的 protocol 腿通过）。
11. **平台 / 工作区设置未变更、也未核对**（未调用 `opencode_console` 的写操作）。

### 前序遗留、本会话**未复现**

1. **macOS flake（两个，同一病根：用真实时间等再断言时间相关结果）**：`agent/test/chrome.test.mjs:47`（`sleep(15)` 后断言光标序列）、`agent/test/toast.test.mjs:34`（`duration: 30` + `sleep(60)`）。都在冻结的 `agent/` 树里；**只改测试确定性**需要用户点头，不由主 Agent 顺手带。
2. **ADR-034 的位置**（ADR 表不严格单调；新 ADR 一律追加表末）——本会话又追加了 061/067/068/066/065 在尾部，**表尾顺序是 065 之前有 061/067/068/066**。
3. **ADR-044 仍未收到显式认可**——P5 的 047/052、P6 的 055/058 都**引用**了它。
4. `agent/src/llm/presets.js:2` 指向的 `tools/distill-providers.mjs` **不在仓库里**（209 家 catalog「怎么更新」仍未定）。
5. **v1 的 `agent/` 套件（762 项）本会话未跑**。

### 证据与记忆的差异（保留差异，不覆盖）

| 项 | 旧记载 | 本会话的证据 | 处置 |
|---|---|---|---|
| `main` 位置 | 上一版写 `14bb122` / `89354a6` | 【本机命令】`git log origin/main` → **`9279e47`**（#64 合入） | 以证据为准（时间差） |
| 「`ActionRequest` 不带 id，审批桥只能从日志取 callId」 | 上一版 §3 这么记 | 【源码】`policy/decide.ts:16` 有 `readonly callId: string` | **已更正**：审批桥直接用请求上的 `callId`（ADR-064 ⑧） |
| 分支提交数 | 上一版写「3 个提交」 | 【本机命令】实为 4 个（含 `db111be` 交接提交） | 以证据为准 |
| 「本机 shell 是 Git Bash」 | `AGENTS.md` 这么写 | 本会话反复实测是 **PowerShell**（POSIX 链式写法 `ParserError`） | **标为待确认**：不改 `AGENTS.md`（可能是 OpenCode 会话差异），但按实测操作 |
| v1 最新发布版 | 前序会话【registry】`0.15.0` | 【本机命令】本会话复核 → **`0.15.0`** | 前序结论成立 |

---

## 7. 关键文件

| 路径 | 内容 |
|---|---|
| [`dev-plan-v2.md`](dev-plan-v2.md) | **权威计划**。P5 交付记录；**P6 段含 T0–T10 任务表（T1~T10 已标落地）**；P7 模块表 |
| [`architecture/README.md`](architecture/README.md) | **ADR-001~069**（047~054 P5；055~060 P6 协议/前端；062~065 T4a；061/066 T7；067 T8；068 T9） |
| [`architecture/06-frontend.md`](architecture/06-frontend.md) | **P6 契约文档**：协议方法表、包结构、分层规则、附件与图片通路、**「T10 收口」的人眼验收 8 条** |
| [`brand/brand-guide.md`](brand/brand-guide.md) | 品牌事实来源：§3.1 色彩（主题 token 的色值来源）、§2.2 状态文案、§4 界面结构 |
| `packages/cowcat/src/host/` | **组合根**：`paths.ts`（布局）、`config.ts`（三层配置 + 基线规则）、`host.ts`（`createHost` = 真实 `ProtocolHost`） |
| `packages/cowcat/src/adapters/{config-files,session-index}.ts`、`sandbox/fs-probe.ts` | 组合根要的字节与目录（`host/` 不得 import `node:fs`） |
| `packages/cli/src/cli/` | **可执行文件**：`spec.ts`（表 + 选项）、`run.ts`（解析与出口码）、`serve.ts` / `oneshot.ts` / `sessions.ts` / `tui.ts` / `doctor.ts`、`host.ts`（装配 + `COWCAT_HOME`） |
| `packages/tui/src/{app,text,ui,components,theme,image}/` | **TUI**：`project()`（纯函数）、`text/{width,wrap,diff}.ts`、`ui/{line,card,screen}.ts`（**`screen.ts` 与 `run.ts` 是仅有的两处渲染器入口**）、六个组件、主题 token、`image/layout.ts` |
| `packages/tui/test/frames.ts` | **帧快照的期望值**（人看过；`UPDATE_SNAPSHOTS=1` 重写） |
| `packages/cowcat/test/host.test.ts` / `packages/cli/test/exit-criteria.test.ts` | 宿主（协议服务端驱动）；**出口标准接缝**（协议事件流 → 前端渲染） |
| `tools/{lint-probe,check-tarball}.mjs` | 分层禁令探针（21 条，四包）/ 发布白名单守卫（CI 会跑） |
| `tools/{tui-api-probe,tui-smoke,glm-smoke}.mjs` | 装机 opentui API 探针（16 项）/ 真实 `cowcat tui` 进程探针（7 项，需 Node ≥26.4）/ 真请求探针（需 `ZHIPU_API_KEY`） |
