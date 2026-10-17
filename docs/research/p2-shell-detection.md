# P2 补充调研：Windows 上的 shell 探测与选择

> P2 T2 的前置。`research/p2-ports.md` 的 §7 第 8 条把「shell 解析的实际探测方式」列为待验证，并注明**旧版零实现、没有可继承的结论**——本文件回答它。
> 最后更新：2026-10-17。状态：**调研完成（Windows 侧实测），POSIX 侧已由 CI 腿实测**；§4 的决定已在 T2 实现并在本机跑通（见 §6 末尾）。

## 证据标注约定

沿用 [p1-kernel.md](p1-kernel.md) 与 [p2-ports.md](p2-ports.md)：**【实测】** 本次在本机跑过，脚本见附录 A；**【上游】** 官方文档；**【未验证】** 没有实测样本，不得作为决策依据（除非标注为「按此实现并补测」）。

## 0. 结论摘要

| 问题 | 结论 | 依据 |
|---|---|---|
| Windows 上怎么找到 Git Bash | **唯一在本机奏效的来源是「跟着 `git.exe` 找」**：`<git.exe 所在目录>/../bin/bash.exe`。PATH 解析、注册表、`C:\Program Files\Git` 三条路在本机**全部失效** | §2.1–2.3 |
| 能用「跑一下看结果」判断吗 | 不能只判断「能不能跑」：`OpenSSH\bin\bash.exe` 能跑、`$0` 是 `sh`、PATH 是 cygwin 拼法——它是**错的工具**。判定必须验到「它是 Git Bash」 | §2.4 |
| `bin\bash.exe` 还是 `usr\bin\bash.exe` | **`bin\bash.exe`**：它把 PATH 首项设为 `/mingw64/bin`（Git Bash 语义）；`usr\bin\bash.exe` 直接继承 Windows PATH 的 cygwin 翻译，缺 mingw64 | §2.4 |
| 回退到什么 | `pwsh` → PowerShell 5.1 → `ComSpec`(cmd)。但 PowerShell 5.1 **每次启动 ~745ms**（Git Bash 83ms、cmd 37ms），回退到它等于每条命令多付 0.7s | §2.5 |
| 已经跑在 Git Bash 里 | 信号是 `MSYSTEM=MINGW64` + `OSTYPE=cygwin`（`SHELL=/usr/bin/bash` 只在 Git Bash 里有，PowerShell 会话里实测为 `null`）。**环境自动继承，绝对路径仍按 git 相对发现取** | §2.6 |
| 会不会被影子二进制劫持 | 会，且是两条已实测的路径：cwd 里的 `bash.exe` 压过 `System32`；`shell:true` 时 cwd 里的 `bash.cmd` 也压过。**因此：只 spawn 绝对路径，永不用裸名，永不用 `shell:true`** | §2.7 |
| POSIX / macOS 怎么选 | `/bin/bash` → `$SHELL` → `/bin/sh`，与沙箱 profile 里已硬编码的 `/bin/bash` 保持一致。**本机没有 macOS/Linux，未验证** | §3 |

## 1. 验证环境

| 项 | 值 |
|---|---|
| 平台 | Windows 11，PowerShell 会话（`ComSpec=cmd.exe`，`SHELL` 未设） |
| Node | `v24.18.0` |
| Git for Windows | 装在 `E:\WorkSoftwares\Git`（**非默认盘符**，且注册表无 `Git\InstallPath`） |
| WSL | 只有一个 `docker-desktop` 发行版，**其内没有 bash**——这一点意外成了本调研的关键放大器 |
| PowerShell | 只有 5.1（`System32\WindowsPowerShell\v1.0\powershell.exe`），无 `pwsh` |
| 探测脚本 | 附录 A（未入库，`%TEMP%\opencode\oss\shell-probe.mjs`、`shell-shadow2.mjs`、`inside-git-bash.sh`） |

**这台的偏差要说清**：它不是「典型 Windows」。默认安装路径缺失、注册表缺失、WSL 无 bash——这三条恰好各对应一种常见的探测写法失效，所以本机是**偏严苛**的样本。结论因此比在标准机上更保守，而不是更宽松。

---

## 2. Windows

### 2.1 PATH 上那个 `bash` 是什么都不是【实测】

```
where bash → C:\Windows\System32\bash.exe
             C:\Users\...\Microsoft\WindowsApps\bash.exe
             C:\Program Files\OpenSSH\bin\bash.exe
```

逐个真跑（`spawn(exe, ['-c', 'echo MARK'], { shell: false })`）：

| 候选 | 结果 |
|---|---|
| `System32\bash.exe` | **exit 1**，`<3>WSL ... execvpe(/bin/bash) failed: No such file or directory`——它是 WSL 启动器，把命令转给发行版里的 bash；本机发行版没有 bash，于是失败 |
| `WindowsApps\bash.exe` | 同上（Store 别名，同一个启动器） |
| `OpenSSH\bin\bash.exe` | **exit 0，但它是错的工具**：`$0=sh`，PATH 首项 `/cygdrive/e/WorkSoftwares/cuda130/bin/x64`——OpenSSH 自带的 Cygwin shim，没有 Git Bash 的 mingw64 环境，也不该拿来跑用户的构建命令 |

结论：**裸名 `bash` 在 Windows 上不能作为候选**。它要么失败，要么指向一个「能跑但语义不对」的二进制。

### 2.2 注册表与硬编码路径都不可靠【实测】

| 来源 | 本机结果 |
|---|---|
| `HKLM\SOFTWARE\Git` / `WOW6432Node\Git` / `HKCU\SOFTWARE\Git` 的 `InstallPath` | **全部不存在** |
| `C:\Program Files\Git\bin\bash.exe`、`...\usr\bin\bash.exe` | **不存在**（Git 装在 E:） |

注册表在标准安装下通常有 `InstallPath`，但它有两个已知问题：便携/自定义安装不写；32 位注册表视图在 64 位进程里要看 `WOW6432Node` 分支。硬编码路径同理。所以这两条只能当**补充候选**，不能当主路。

### 2.3 git 相对发现：唯一奏效的来源【实测】

`where git` → `E:\WorkSoftwares\Git\cmd\git.exe`。从它向上两级得到安装根，再拼：

| 候选 | 启动耗时 | 结果 |
|---|---|---|
| `<root>\bin\bash.exe` | 83ms | exit 0，`$0=/usr/bin/bash`，PATH 首项 `/mingw64/bin` |
| `<root>\usr\bin\bash.exe` | 47ms | exit 0，`$0=/usr/bin/bash`，PATH 首项 `/e/WorkSoftwares/cuda130/bin/x64` |
| `<root>\bin\sh.exe` | 88ms | exit 0（`sh` 最终也是同一个 bash） |

**为什么 git 相对发现可靠**：用户能用 `git`，说明 Git for Windows 装了，而它一定自带 bash。跟��� `git.exe` 走，等于跟着实际安装位置走，绕开了盘符、安装器变体、便携模式、注册表缺失四个变量。

反向缺口：**装了 Git Bash 但 `git.exe` 不在 PATH** 的情况本机无法构造（Git Bash 的 PATH 默认含 `cmd/`）。按推断这种情况应退到注册表与硬编码路径两条补充候选，并在都失败时直接进 PowerShell/cmd。

### 2.4 `bin` 与 `usr\bin` 的差别不是风格问题【实测】

两者都能跑，但 PATH 首项不同：`bin\bash.exe` → `/mingw64/bin`，`usr\bin\bash.exe` → 直接继承 Windows PATH 的 cygwin 翻译。Git Bash 的语义（mingw64 在前、`/c/...` 与 `C:\...` 都能用）来自前者。**选 `bin\bash.exe`。**

顺带一个对模型友好的事实【实测】：在 Git Bash 里 `ls "C:\Windows\System32\cmd.exe"` **可用**，POSIX 路径也可用。所以模型偶尔写出反斜杠路径时不会当场炸——这是选 Git Bash 而不是 PowerShell 的一个实际好处。

### 2.5 回退链与它的真实成本【实测】

| 候选 | 启动耗时 | 备注 |
|---|---|---|
| `bin\bash.exe` | 83ms | 首选 |
| `usr\bin\bash.exe` | 47ms | 次选（语义差一点，见 §2.4） |
| `pwsh.exe`（PowerShell 7） | — | 本机**未安装**，这条分支未验证 |
| PowerShell 5.1 | **745ms** | 总是存在的兜底 |
| `ComSpec`（cmd.exe） | 37ms | 最后兜底，语义与前两者都不同 |

**成本是关键**：shell 是每条命令都要 spawn 的进程。回退到 PowerShell 5.1 意味着**每条命令多付约 0.7 秒**。所以顺序必须是「Git Bash → PowerShell → cmd」，而不是「哪个先找到用哪个」；并且 `pwsh` 优先于 5.1（更快，且语义更接近 POSIX）。

### 2.6 已经跑在 Git Bash 里时【实测】

| 变量 | Git Bash 会话内 | PowerShell 会话内 |
|---|---|---|
| `MSYSTEM` | `MINGW64` | 未设 |
| `OSTYPE` | `cygwin` | 未设 |
| `SHELL` | `/usr/bin/bash` | **未设** |
| `TERM` | `xterm-256color` | `xterm-256color` |

`MSYSTEM` / `OSTYPE` 是可靠信号；`SHELL` 不能单独用（PowerShell 会话里没有）。从 Git Bash 内部看：`command -v git` → `/mingw64/bin/git`（Windows 路径 `E:\WorkSoftwares\Git\mingw64\bin\git.exe`）——注意这是**另一个** `git.exe`，但仍在同一个安装根下，所以 git 相对发现在两种入口下都成立。

**环境不需要我们做什么**：`MSYSTEM` 等变量会随 `process.env` 传给子进程。真正要做的只是把 `executable` 解析成绝对路径。

### 2.7 影子二进制：两条已实测的劫持路径【实测】

Windows 的解析顺序是 `<exe 所在目录> → cwd → System32 → Windows → PATH`。实测：

| 场景 | 结果 |
|---|---|
| cwd 里放一个真 `bash.exe`，spawn 裸名 `bash` | **影子赢**——跑起来的是那个文件（证据：它作为 node 启动并因 `-c` 参数报 node 自己的加载错误），压过了 `System32\bash.exe` |
| 同上，且把 cwd 也放到 PATH 最前 | 影子赢（cwd 在 PATH 之前，所以加 PATH 没有额外风险也没有额外保护） |
| cwd 里放 `bash.cmd`，spawn 裸名 `bash` 且 `shell:true` | **影子赢**（exit 0，stdout 是我们脚本里的 `SHADOWED_CMD`）。Node 还会为此打出 DEP0190 弃用警告 |
| 用**绝对路径**指向真正的 Git Bash | 正常执行，完全不做名字解析 |

因此契约里有三条硬规则：**只 spawn 绝对路径；永不 spawn 裸名；永不为了省事用 `shell:true` 跑用户命令**。这与旧版调研里「不要把会在沙箱外解析的可执行名落在沙箱内可写目录里」是同一类问题，而这次测的是 agent **自己**选 shell 的那条路径。

---

## 3. POSIX 与 macOS（未验证）

决策（按此实现，并补测）：

1. `/bin/bash` 存在就用它——**理由是与沙箱 profile 一致**：`bwrap.js` 与 `seatbelt.js` 都硬编码 `/bin/bash`（`agent/src/sandbox/backends/bwrap.js:22`、`seatbelt.js:44`）。shell 与沙箱内层用不同解释器，会让「沙箱外跑通、沙箱内失败」这类问题更难查。
2. 否则 `$SHELL`（用户自己的 shell，可能不是 bash——这是取舍，不是缺陷）。
3. 否则 `/bin/sh`。

**未验证项**：macOS 15 上 `/bin/bash` 存在但版本老（3.2），而 `/bin/zsh` 才是系统默认；`process.env.SHELL` 在从 Terminal.app 启动时是 `/bin/zsh`。按上面的顺序，macOS 上会选到 `/bin/bash`——**这是有意的**（与沙箱一致），但需要在 macOS CI 腿上实测并写进断言。

---

## 4. 决定：`PlatformPort.resolveShell()`

```
resolveShell(): Shell
  1. 平台是 windows 时：
     a. <git 根>\bin\bash.exe      —— git 相对发现（主路）
     b. <git 根>\usr\bin\bash.exe   —— 次选，语义略差
     c. 注册表 Git\InstallPath 与 HKCU\SOFTWARE\Git\InstallPath 派生的两条（补充）
     d. C:\Program Files\Git\{bin,usr\bin}\bash.exe              （补充）
     e. pwsh.exe → PowerShell 5.1 → ComSpec(cmd)
  2. 平台是 posix 时：/bin/bash → $SHELL → /bin/sh（未验证）
  3. 每个候选都要**真跑一次**再采纳：spawn <exe> <flag> 'printf MARK'（PowerShell 用
     Write-Output），要求 exit 0 且 stdout 含标记；第一个通过的胜出
  4. 结果按会话记忆（探测一次；PowerShell 那条要 745ms，不能每条命令重探）
  5. 一个都不可用 → 抛错并说明，不要静默退到 cmd
```

**验收一个候选要验两件事**（§2.1 与 §2.4 的教训）：能跑 **且** 是我们想要的那种 shell。第二件不能只看 `$0`，建议看 PATH 首项或 `BASH_VERSION`，否则 OpenSSH 的 shim 会被误判为可用。

**会话头记录什么**：`{ kind, executable }` 两项。**不记版本**——`bash --version` 很便宜，但版本对「这条命令当时跑成什么样」的解释力有限，而它会让会话头的取值空间变成需要维护的字符串。真要复现问题，日志里记路径已足够定位到那一版。

`Shell` 类型里的 `baseArgs` 与 `commandFlag` 已有契约（`ports/platform.ts`）：bash 系 `-c`、PowerShell `-Command`、cmd `/d /s /c`。实测过 PowerShell 5.1 与 cmd 的这一组参数可用。

---

## 5. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 裸名 `bash` | §2.1：前两个候选直接失败，第三个是语义不对的 OpenSSH shim；§2.7：还能被 cwd 影子劫持 |
| 只用注册表 `Git\InstallPath` | 本机没有；便携安装与部分安装器也不写 |
| 只用硬编码 `C:\Program Files\Git` | 本机没有；换盘符即失效 |
| `PATH` 上第一个能跑的就是它 | 会选中 OpenSSH 的 shim（能跑、语义错） |
| 尊重用户的 `$SHELL` 优先（POSIX 也一样） | 会让 shell 解释器随用户配置变化，而沙箱内层固定 `/bin/bash`；「外面跑通、里面失败」更难查。POSIX 侧把它放在 `/bin/bash` 之后作为退路 |
| 为了绕开 `.cmd`/`.bat` 而用 `shell:true` | 实测能被 cwd 影子劫持，Node 还会打 DEP0190 弃用警告；正确做法是绝对路径 |
| 每次命令都重新探测 | PowerShell 那条要 745ms；探测按会话记忆即可，环境在会话内不会变 |

## 6. 待验证

1. ~~**macOS 上的选择顺序**~~：**已由 CI 结清**（P2 T2，`packages/cowcat · node 22 · macos-15`）。`test/platform.test.ts` 里有一条硬断言：POSIX 主机解析结果必须是 `/bin/bash`，在 Windows 上 skip。macOS 是唯一默认 shell 不是 bash 的平台，所以这条只能在那里成立。
2. **`pwsh` 分支**：本机没有 PowerShell 7，`pwsh` 优先于 5.1 这条未实测。
3. **Git Bash 不在 PATH 但存在的布局**（`git.exe` 不在 PATH、只有 bash）：无法在本机构造，属于推断。
4. **探测一次记忆多久**：会话级记忆是否够（长会话里用户装了 Git 会怎样）——当前决定是会话级。
5. POSIX 的 `/bin/bash` 与 `$SHELL` 分支：`ubuntu-24.04` 与 `macos-15` 两条腿现在都会真跑一遍链（`NodePlatform` 默认接真实宿主）。

### 已由实现结清的部分

- §4 的决定已按 `adapters/shell.ts` 落地，`test/shell.test.ts` 用假宿主覆盖了链序、「装了但跑不起来要跳过」、「绝不接受裸名」、上溯发现安装根、四条分支全不可用时报错这四类决定。
- **Windows 侧在真机上跑通了整条链**：本机（Git 在 `E:\WorkSoftwares\Git`、注册表三键全缺、`C:\Program Files\Git` 不存在）解析结果为 `E:\WorkSoftwares\Git\bin\bash.exe`、kind = `git-bash`，与 §2.3、§2.4 的实测一致。上面第 3 条仍未覆盖（那台机器上 `git.exe` 就在 PATH 里）。

## 附录 A：探测脚本

未入库（`%TEMP%\opencode\oss\`）：

| 脚本 | 回答什么 |
|---|---|
| `shell-probe.mjs` | `where` / 注册表 / 环境变量 / 逐个真跑所有候选 / PATH 影子 |
| `shell-shadow2.mjs` | 影子二进制的三条场景（cwd `.exe`、cwd `.cmd` + `shell:true`、绝对路径） |
| `inside-git-bash.sh` | 在 Git Bash 内部看 `MSYSTEM`/`OSTYPE`/`SHELL`、`git` 的解析、两种路径语法 |

T2 实现时建议把 `shell-probe.mjs` 的候选枚举与真跑逻辑收进 `PlatformPort` 适配器，并把它改造成可复用的契约测试（用假文件系统喂候选，不依赖真机布局）。