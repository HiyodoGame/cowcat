# P2 沙箱设计调研

> T5 的前置。`research/p2-ports.md` §3 定义了 `system` 档的契约但没有把生成器落地；本文件回答「照着旧版迁移，哪些假设仍然成立、哪些必须改」。
> 最后更新：2026-10-17。状态：**bwrap 侧实测完成；seatbelt 侧沿用旧版实测结论并由 CI 复核；两条改动设计的发现见 §5。**

## 证据标注约定

沿用 [p1-kernel.md](p1-kernel.md) 与 [p2-ports.md](p2-ports.md)：**【实测】** 本次跑过，脚本见附录 A；**【上游】** 官方文档；**【推断】** 没有实测样本。

## 0. 结论摘要

| 问题 | 结论 | 依据 |
|---|---|---|
| 旧版 bwrap argv 在现代 bwrap 上还成立吗 | **成立**。CI 那条 Linux 腿是 bwrap 0.9.0，实测全部通过 | §2、§3 |
| 嵌套 user namespace 能不能在沙箱里创建 | **能**（实测 rc=0）。`--disable-userns` 能堵（rc=1），0.9.0 上可用 | §4.1 |
| 沙箱对**自己的调用者**是不是权限边界 | **不是**。调用者是 root 时沙箱内进程就是 root，能读 `/etc/shadow` | §4.2 |
| 沙箱里 `&` 起来的后台任务能活多久 | **活不过那条命令**。三种网络配置下都随沙箱一起死 | §4.3 |
| 环境变量脱敏能不能交给 bwrap 做 | **不能**。bwrap 原样透传调用者环境，脱敏必须在 spawn 之前 | §4.4 |
| 写策略里「还不存在的路径」会怎样 | **静默不生效**。绑一个不存在的源会让整条命令失败，所以旧版选择跳过——于是沙箱永远建不出它 | §4.5 |
| 私有 `/tmp` 有多大 | **宿主机内存的一半**，RAM 支撑，无上限 | §4.6 |
| argv 能不能直接拼成命令串 | **不能**。引号被 shell 重新解释，症状是 stdout 完全为空，像「沙箱挡住了所有东西」 | §4.7 |
| seatbelt 侧 | 无新原语；`sandbox-exec` 在 `macos-15` 上真实验证可用（我们自己的 CI） | §5 |
| 有一条合规缺口 | Seatbelt 的运行时白名单转写自 Apache-2.0 项目，仓库是 MIT 且无署名 | §6 |

## 1. 验证环境

**【实测】** 本机是 Windows，bwrap 无法直接跑。改用 Docker Desktop 的 Linux VM 起一个一次性容器：

| 项 | 值 |
|---|---|
| bwrap | **0.9.0**（与 `ubuntu-24.04` 官方包同版本，保证 argv 结论对 CI 那条腿有效） |
| 内核 | `6.18.33.2-microsoft-standard-WSL2`（Docker Desktop 的 WSL2 内核） |
| 容器 | `ubuntu:24.04`，`--privileged` |
| 附加工具 | git 2.43.0、python 3.12.3 |

**这条环境说明必须读**：

- 默认（非 privileged）容器里 **bwrap 起不来**：`Creating new namespace failed: Operation not permitted`——这恰好是我们 T2 探测器的 `userns-blocked` 分类，说明分类逻辑在真实故障上是对的。
- WSL2 内核**没有** Ubuntu 24.04 的 AppArmor `unprivileged_userns` 限制。所以「AppArmor profile 装上之后 bwrap 能不能用」**本轮无法验证，仍由 CI 负责**。所有关于 flag 可用性、挂载语义、profile 语义的结论都可信；关于 userns 策略的结论需要 CI 复核。
- 第一轮实验因为写死了 `/lib32`（该容器没有）而全部失败，**bwrap 从未真正启动**，那批「PASS」全部作废后重做。凡是用 `ps` 猜 pid 判存活的也改成了心跳文件。

## 2. 旧版 argv 在 0.9.0 上是否成立

**【实测】成立。** 旧版 `agent/src/sandbox/backends/bwrap.js` 生成的形式（`--die-with-parent --new-session --unshare-pid --unshare-ipc --unshare-uts --unshare-net --dev-bind-try /dev /dev --proc /proc` + 只读系统路径 + `--tmpfs /tmp` + `--bind <cwd>` + `--chdir`）在 0.9.0 上全部可用，包括 `--dev-bind-try`（0.6.0 引入）与 `--tmpfs`。

G1/G2/G3 的实测结果：

| 断言 | 实测输出 | 结论 |
|---|---|---|
| G1 项目外写入 | `/etc/out.txt` → `Read-only file system`；`/root/secret-dir/out.txt` → `No such file or directory`（根本没绑定） | **成立**，两种拒绝形态都对 |
| G1 被拒路径不可改写 | 重定向写 `/root/secret-dir/data.txt` 后内容仍是原值 | **成立** |
| G1 项目内写入与 `rm` | 写入成功、`rm` 成功 | **成立** |
| G2 读不到的面 | `cat /root/secret-dir/data.txt` → `No such file or directory`，rc=1 | **成立**，而且是**隐藏**（ENOENT）不是「无权限」（EACCES）——这一点很要紧，见下 |
| G2 宿主 `/tmp` | 宿主 marker 读不到，沙箱内 `/tmp` 可写 | **成立**，私有 tmpfs 生效 |
| G3 无网络 | `/dev/tcp` 裸连 → `Network is unreachable`；DNS rc=2 | **成立**，且是命名空间级的 |
| G3 反证（授予网络） | `--share-net` 下 DNS 解析出 `20.205.243.166 github.com` rc=0 | **对照组成立**，说明上一条不是坏测试 |
| `/proc` 可见性 | 沙箱内只有 4 个数字项（自己的 pid 命名空间） | 宿主进程不可见 |
| 未绑定路径 | `cd /somewhere-not-bound` → `No such file or directory` | 不可见 |
| git 能否用 | `git log` / `git status` 正常 | 正常开发不被破坏 |

**为什么「隐藏」比「无权限」重要**：一个被拒绝的路径若报 EACCES，模型会以为是权限问题；报 ENOENT 则会被当成「文件不存在」而做出错误结论。旧版 `violations.js` 专门为此做了说明。bwrap 的 workspace 档从空 root 起步，只绑定允许的路径——**不存在的东西自然报 ENOENT**，这是该设计的直接收益。

**但这是 bwrap 独有的**：**【实测，两个 CI 腿】** seatbelt 拒绝读一个未授权路径时报的是 **EPERM**，不是 ENOENT，因为路径本身是真实存在的、被 profile 拒绝了操作。两个后端的拒绝措辞不同，含义相同，工具层必须都能解释——断言里不能只认一种。

### 2.1 同一条命令在两个平台结果相反【实测】

写一个位于**宿主临时目录**下的文件：

| 平台 | 结果 | 原因 |
|---|---|---|
| Linux / bwrap | **exit 0**，宿主无此文件 | 沙箱的 `/tmp` 是私有 tmpfs，路径在**沙箱内可写**，写入落到了那里 |
| macOS / seatbelt | **EPERM**，宿主无此文件 | 没有挂载命名空间，该路径根本没有被授予，直接拒绝 |

两者都是正确的隔离。唯一跨平台成立的不变量是**宿主侧文件不存在**；退出码是平台属性。这一条连着踩了两次（先断言「必须拒绝」在 Linux 上失败，再断言「必须成功」在 macOS 上失败），所以写进这里而不是只留在测试注释里。

## 3. 已知边界（非本轮发现，沿用并复核）

| 边界 | 结论 |
|---|---|
| `--die-with-parent` 的作用 | **【实测】SIGKILL bwrap 会带走整个沙箱**（心跳文件停止增长）；SIGTERM 同样。T4 的终止路径（杀 bwrap）因此对沙箱成立 |
| 退出码 | **【实测】** 命令 `exit 42` → bwrap 退出码 42；命令被信号杀死 → `128+n`（实测 SIGTERM → 143） |
| stdin | **【实测】** 透传 |
| `--chdir` 指向未授权目录 | **【实测】** `Can't chdir to /root: No such file or directory`——错误可理解，不是神秘失败 |

## 4. 改变设计的发现

### 4.1 沙箱里可以创建嵌套 user namespace【实测】

```
# 默认（无 --disable-userns）
unshare -U true            → rc=0        # 成功

# 加 --unshare-user --disable-userns --assert-userns-disabled
unshare -U true            → rc=1        # No space left on device
                                        # （user.max_user_namespaces=0）
```

三个 flag 在 0.9.0 上都被接受。含义：沙箱内进程可以新建 user namespace 并因此获得该命名空间内的 `CAP_SYS_ADMIN`，进而重排自己的挂载视图。bwrap 的只读绑定不会因此被解除（那些挂载属于 bwrap 的 userns，嵌套 userns 不拥有它们），但「沙箱内进程可以重排自己的文件系统视图」本身是一条不该默认开放的能力。

**取舍**：bwrap 提供了 `--disable-userns`，但它需要 `--unshare-user`，而**旧版 argv 完全没有显式声明 user namespace**（非 root 时由 bwrap 隐式创建）。加上之后行为更紧，但若某些内核不接受，就会在第一次真实运行时才失败。

**因此设计决定**：探测分两次——一次不带加固 flag（判定后端**可用**），一次带（判定加固**是否可用**）。前者过、后者不过时，按**不带加固**执行并把「本内核无法禁用嵌套 user namespace」写进限制项上报，而不是让第一条命令失败。

### 4.2 沙箱对它的调用者不是权限边界【实测】

这是本轮最重要的一条，旧版文档没有。

```
调用者 = root        : uid_map = 0 0 4294967295      沙箱内 uid=0     /etc/shadow  可读
调用者 = 非特权(1001): uid_map = 1001 1001 1        沙箱内 uid=1001  /etc/shadow  拒绝
```

bwrap 的 user namespace 是**映射**而不是提权。调用者是 root 时它甚至**根本不创建 userns**（恒等映射 `0 0 4294967295` 就是证据），沙箱内进程在内核层面就是 root，于是 `/etc`（workspace 档整体授予读，因为工具链需要）里的 root 属主文件照样能读。

同一实验的旁证：容器外用 `setpriv --reuid 65534` 读 `/etc/shadow` 是**拒绝**的，进沙箱后（同为非 root 调用者）是**拒绝**的——差别只来自调用者身份。

**为什么这条重要**：架构文档写明 CowCat 是 npm 分发的产品、不能要求管理员安装，所以**推荐部署下这条不成立**（调用者非特权 → 文件权限照常生效）。但只要有人在 root 容器里跑 CowCat，`system` 档给出的隔离就比它看起来弱得多，而 UI 上写着「已沙箱化」。这正是 ADR-016 要防的那类「声称有隔离其实没有」。

**因此设计决定**：`system` 档在 Linux 且调用者为 root 时，把「本进程以 root 运行，沙箱映射而非降低权限，沙箱内命令拥有 root 凭据」写进限制项上报。不拒绝——root 容器里往往是唯一能用的环境——但**必须让用户知道**。

### 4.3 沙箱不能承载后台任务【实测】

沙箱里 `setsid nohup ... &` 起来、脱离 shell 的子进程，**在三种网络配置下都随沙箱一起死亡**（先用 `/etc` 不可写证明沙箱确实生效，再用 14 秒的宽限与心跳文件判存活）。

第一轮出现过一次「授予网络时存活」的假阳性，原因是那次 argv 里同时有 `--unshare-net` 和 `--share-net`；我们实际只会发其中一个，配置下重测为「死亡」。

产品含义：`system` 档下 `npm run dev &` 这类用法不成立，沙箱生命周期 = 那条命令的生命周期。这其实符合「沙箱内没有东西能活过这次调用」的直觉，但需要写进文档，否则用户会当成 bug 报上来。

### 4.4 环境变量脱敏必须在 spawn 之前【实测】

```
MY_SECRET=leaked <沙箱内 echo ${MY_SECRET}>   →  leaked
```

bwrap **原样透传调用者环境**。所以「沙箱会帮你脱敏」是不成立的假设，脱敏只可能发生在 spawn 之前——这正是 ADR-015 把脱敏放进 `ProcessPort` 而不是后端生成器的原因，也解释了为什么 T4 的网关是唯一正确的位置。这条**证实了既有设计**，不是改动。

### 4.5 写策略里「尚不存在的路径」被静默丢弃【实测】

```
--bind /proj/target /proj/target   （target 不存在）
→ bwrap: Can't find source path /proj/target: No such file or directory
```

绑定一个不存在的源会让**整条命令**失败，所以旧版 `allowWrite()` 选择跳过（`if (!fs.exists(p)) return null`）。结果是：一条 `write.allow: ['./dist']` 在 `dist/` 尚未创建时被静默丢弃，沙箱因此**永远建不出它**，用户看到的是 `EROFS` 这类难以定位的报错。

同一实验的另一半：在**已授权**的目录树内部创建新的子目录是正常的（`mkdir -p /proj/sub/deep` 成功）。缺口只在「条目本身指向一个还不存在的路径」。

**因此设计决定**：跳过时**必须写进限制项**——「`write.allow: /proj/dist` 未授予：该路径尚不存在，沙箱无法创建它」。这正是架构文档反复强调的「声称限制了却什么都没做，比没有策略更糟」。

### 4.7 argv 不能用空格拼成命令串【实测，由 macOS CI 抓到】

网关收到的是 **argv**，而后端需要的是**命令字符串**（它得交给一个 shell）。把 argv 用空格拼起来再交给 `sh -c`，等于让 shell 把每个引号重新解释一遍：

```
naive join :  exit 2   stdout ""   stderr "syntax error near unexpected token `('"
quoted     :  exit 1   stdout ""   stderr "node:fs:441"      ← 脚本跑起来了，只是文件不在
```

第一行的形态是 **stdout 完全为空**。这看起来和「沙箱把什么都挡住了」一模一样——实际上只是引号被吃掉了。失败发生在 macOS CI 上，因为那两条真机用例在 Windows 本机是 skip 的。

修法是 POSIX 单引号转义（`shellQuote`），并且**必须做**：沙箱不能直接 exec argv，因为可执行文件本身可能落在读面之外——CI runner 的 `node` 在 tool cache 里，既不在 `/usr` 也不在 `/opt`，所以沙箱里只能用 `/bin/bash`（旧版硬编码 `/bin/bash` 是有道理的）。

顺带验证过：含空格与单引号的路径经 `shellQuote` 后由真 shell 原样还原。

### 4.9 遍历符号链接需要 SYMLINK vnode 的读权限【实测】

现象：profile 正确授权了家目录，命令读**它自己会用的那种拼写**却得到 EPERM。

```
read-canonical-home    = OK      /private/var/folders/…/home/n.txt
read-friendly-home     = EPERM   /var/folders/…/home/n.txt
read-relative          = OK      ./r.txt（相对路径不受影响）
readlink /var          = EPERM
```

最初的判断是「`subpath` 匹配字面路径，所以要给两种拼写」。**这个判断错了**，而且第一版修复（`spellings()`）也因此无效：加了双拼写、跑 CI，仍然 EPERM。

把两组变量分开跑才拿到答案（六个变体，同一 profile、同一文件）：

| 变体 | profile 里的拼写 | SYMLINK 规则 | friendly |
|---|---|---|---|
| A | 双拼写 | 无 | EPERM |
| B | 双拼写 | 有 | OK |
| G | 仅 canonical | 无 | EPERM |
| **F** | **仅 canonical** | **有** | **OK** |

所以真正的机制是：解析从调用方写的拼写开始，而 `/var` 是符号链接，解析它需要读 SYMLINK vnode；`subpath` 本身匹配的是**内核解析后**的路径（原本的判断成立）。修法是补一条 `file-read-metadata (vnode-type SYMLINK)`。

**记下走错的那一步**，因为它看起来非常像对的：双拼写不但无效，还把 deny 面扩大了一倍——每条 deny 都要手工复制两份，漏一处就是绕过。为了零收益扩大拒绝面，比不做更糟。现在有一条测试钉住「不生成双拼写」。

它之所以能一路错到 CI：`subpath` 是对的、profile 是对的、相对路径是对的，只有「人写的绝对路径」这一条不对。

### 4.8 挂载顺序会静默吃掉授权【实测】

挂载按命令行顺序生效、后者覆盖前者。因此 `--tmpfs /tmp` 放在读绑定**之后**，会遮住宿主 `/tmp` 下的每一个读授权：

```
顺序 A（tmpfs 在后）：GONE notes.txt    present readable.txt
顺序 B（tmpfs 在前）：present notes.txt  present readable.txt
```

这条是在写 T6 的测试时发现的——测试夹具用 `mkdtemp` 建在 `/tmp` 下，于是「家目录可读」那条用例必然失败。真实影响比测试更大：**任何位于宿主 `/tmp` 下的读授权都会被静默丢弃**，包括 `$HOME` 落在 `/tmp` 的开发环境与 CI。那正是「策略看起来授予了、实际什么都没做」这一类。

两个 profile 的顺序要求**相反**，且各有原因：

- `workspace`：tmpfs **在前**，让策略自己的绑定把该暴露的重新暴露出来；
- `hide`：`--ro-bind / /` 把宿主的 `/tmp` 一起绑了进来，所以 tmpfs 必须在它**之后**，否则沙箱会重新继承宿主的临时目录（旧版 CI 第一次跑就因为这个半真半假而失败）。

### 4.6 私有 `/tmp` 是宿主机内存的一半【实测】

```
宿主机内存   : 40014 MiB
沙箱 /tmp    : tmpfs 20487492 KB  ≈ 19.5 GiB   （恰好一半，RAM 支撑）
写入 200 MiB : 4.2 GB/s
```

`--tmpfs /tmp` 不带 `--size` 时按内存的一半分配。沙箱内一个失控的构建可以吃掉半个机器的内存。这是**资源耗尽**风险而非数据泄漏风险。

另外实测：tmpfs 默认权限是 `0755`，而真实 `/tmp` 是 `1777`。沙箱内进程与宿主同 uid，写入正常（实测 writable），但工具若检查「/tmp 是否 world-writable + sticky」会看到与预期不同的结果。`--perms 1777 --size <N>` 在 0.9.0 上均被接受。

## 5. seatbelt 侧

| 问题 | 结论 | 依据 |
|---|---|---|
| 有没有更新的原语 | **【上游】没有**。Apple 未公开替代品，`sandbox-exec` 仍是唯一的每进程原语（本轮网络检索不可用，此条沿用旧版结论并由下面一条实测支撑） | — |
| 它还能用吗 | **【实测】能用**。我们自己的 `packages/cowcat · node 22 · macos-15` 必过检查里，`PlatformPort.sandboxBackends()` 报 `seatbelt / usable: true / /usr/bin/sandbox-exec`——那是探测**真跑**一条宽松 profile 得出的（T2） | CI |
| `network: 'on'` 为什么不可满足 | 沿用旧版在真实 macOS 15 上的夹逼实验：放行全部 mach service 与 unix socket 后，getaddrinfo 仍不恢复。v2 保持**拒绝**而非降级（ADR-016） | `p2-ports.md` §3 |
| macOS 版本选择 | 保持 `macos-15`。`macos-latest` 跟踪 macOS 26，旧版记录过 zsh 5.9 因未白名单的 sysctl 而在 profile 应用前就中止 | 旧版实测 |

profile 生成器本身是**纯函数**，因此可以在 Windows 上单测完整 profile 结构（`seatbelt.js` 的做法）。真机行为仍需 `macos-15` 腿。

## 6. 合规缺口：转写自 Apache-2.0 的运行时白名单

`agent/src/sandbox/backends/seatbelt.js` 的 `RUNTIME_ALLOWS` 是从 `@anthropic-ai/sandbox-runtime`（**Apache-2.0**）的 profile 转写的，代码注释里写了「transcribed」，但：

- 仓库 `LICENSE` 是 MIT；
- 全仓库**没有任何** NOTICE 或署名文件（本次 grep 确认）；
- Apache-2.0 §4 要求保留版权声明、附许可证、说明修改、传递 NOTICE。

在私有仓库时这是可接受的疏漏；**仓库公开之后**，一条 180 行的第三方转写缺署名是实际风险。

**处理建议**：加 `NOTICE` 文件 + 在该常量处写明来源、许可证与「已修改」；不重写这份清单（重写要重新推导，而 macOS 的 dyld 失败模式是静默 SIGABRT，验证成本极高）。清单本身经我们自己的 `macos-15` 腿实测可用。

## 7. 待验证

1. **AppArmor 与 `--disable-userns` 的交互**：WSL2 内核无此限制，只能由 `ubuntu-24.04` 腿验证。风险点：加固 flag 可能让原本可用的机器变成不可用——这正是 §4.1 要求「探测两次、后者失败则降级并上报」的原因。
2. **`--disable-userns` 在 AppArmor profile 生效后的真实效果**：同上。
3. **root 调用者下的 G1/G2/G3 是否仍然成立**：§4.2 说明文件权限不再保护，但挂载隔离与网络隔离仍在。需要一次以 root 调用者跑完整 G1/G2/G3 的实验，确认「root 下到底还剩哪些隔离」。
4. **`--size` 上限取多少**（若采纳）：需要一个不会打断合法大构建、又能挡住失控写入的值。属产品取舍。
5. **seatbelt 在 macOS 26**：保持钉 `macos-15`，但若将来要跟 `macos-latest`，那批 sysctl 白名单要重新推导。

## 附录 A：实验脚本

未入库（`%TEMP%\opencode\`）：

| 脚本 | 回答什么 |
|---|---|
| `sandbox-exp2.sh` | G1/G2/G3、私有 `/tmp`、嵌套 userns、bwrap 环境透传 |
| `sandbox-exp3.sh` | 终止语义（SIGKILL/SIGTERM bwrap → 沙箱死亡）、退出码传播、stdin |
| `sandbox-exp5.sh` | 后台任务存活的复核（带「沙箱确实生效」的证明） |
| `sandbox-exp6.sh` `sandbox-exp7.sh` | 未授权目录、hide profile、`write.allow` 指向不存在路径、tmpfs 尺寸 |
| `asroot.sh` | 调用者身份 → 沙箱内 uid 与 `/etc/shadow` 可读性 |

复现方式：`docker run --privileged -d --name bwrap-lab ubuntu:24.04 sleep 900`，容器内 `apt-get install -y bubblewrap git python3`，再逐个 `docker cp` + `docker exec`。**第一轮实验因为容器未加 `--privileged` 而全部无效**（见 §1），重做时务必带该参数。