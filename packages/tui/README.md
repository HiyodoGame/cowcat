# @corescense/cowcat-tui

CowCat 的终端渲染器：对话流、工具卡、审批卡、固定活动/信息侧栏、原生对话框，以及 64×40 灰阶 Braille 点阵猫。

`@corescense/cowcat` 只在默认 TUI / `sessions resume` 时动态加载它，因此其他动词不受渲染器的 Node 门槛影响。

- Node.js **>= 26.4**，推荐 **26.12+**（26.4 需要 `--experimental-ffi`）
- 只依赖协议与 `@opentui/core`，不依赖内核
- 完整三栏建议至少 160 列 × 32 行；支持 `COWCAT_ANIMATIONS=off`

文档见仓库：<https://github.com/HiyodoGame/cowcat>。
