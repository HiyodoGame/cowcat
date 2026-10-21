# CowCat npm 发布手册（内部）

发布主体：心感科技（深圳）有限公司（CoreScense）
包名：`@corescense/cowcat`（可执行文件）＋ `@corescense/cowcat-core` / `-protocol` / `-tui`
许可：MIT

> 历史：无 scope 的 `cowcat` 被 npm 防仿冒策略拒绝（E403），因此使用 `@corescense` scope。
> v1（`agent/`）的发布流程已随 P8 删除；本文件只描述 v2 四包。

## ① 发布前检查

- [ ] `git status` 干净，发布 commit 已合并到 main 并打 tag。
- [ ] 四个 `package.json` 的版本与 `tools/pack-release.mjs` 的 `VERSION` 一致（脚本会检查）。
- [ ] `docs/changelog.md` 的新版本段落已摘掉「未发布」标记。
- [ ] 密钥从未进过 git 历史：`git log --all --full-history -- .keys.env` 无输出。
- [ ] 四包构建通过：

  ```bash
  (cd packages/protocol && npm ci && npm run build)
  (cd packages/cowcat && npm ci && npm run build)
  (cd packages/tui && npm ci && npm run build)
  (cd packages/cli && npm ci && npm run build)
  ```

- [ ] 发布白名单与安装演练：

  ```bash
  node tools/check-tarball.mjs --install --out "$TEMP/cowcat-release"
  ```

  它会把 `file:` 依赖改写成精确版本、排除 `.map`/test、检查顶层文件与入口，再把四个 tarball 装进临时项目并跑 `cowcat --version`。

- [ ] CI 全绿，尤其是 `package whitelist`。

## ② 凭据

```bash
npm login --registry=https://registry.npmjs.org   # 需要 2FA
npm whoami --registry=https://registry.npmjs.org
```

本机默认 registry 可能是 npmmirror（只读镜像），发布必须显式指向官方 registry。scoped 包未授权时 npm 会把 PUT 伪装成 404，先刷新登录再判断。

新 scope 首发会走 **staged publishing**：CLI 显示成功后包在暂存区，需要在 npm 网页点 **Approve / Publish**（2FA）才真正上线。

## ③ 发布顺序

依赖必须先于消费者：

1. `@corescense/cowcat-protocol`
2. `@corescense/cowcat-core`
3. `@corescense/cowcat-tui`
4. `@corescense/cowcat`

从 `tools/pack-release.mjs --out` 生成的暂存目录逐个发布（tarball 里已经是精确版本，不再依赖本仓库的 `file:` 链接）：

```bash
for pkg in protocol cowcat tui cli; do
  (cd "$TEMP/cowcat-stage/packages-$pkg" && npm publish --access=public --registry=https://registry.npmjs.org)
done
```

> `pack-release.mjs` 的暂存目录默认会清理；发布批次请显式传 `--out`，再手动进入每个暂存目录发布。

## ④ 发布后验证

```bash
npm i -g @corescense/cowcat --registry=https://registry.npmjs.org
cowcat --version          # 应为刚发布的版本
cowcat doctor             # 配置与 key 逐项检查
```

在干净环境（或 docker node:22）重复一次，排除「本机恰好能用」的假阳性。核对 shasum：

```bash
node -e "fetch('https://registry.npmjs.org/@corescense/cowcat/<版本>').then(r=>r.json()).then(j=>console.log(j.dist.shasum))"
```

与本地 `npm pack` 的 shasum 比较，一致才算发布的是这棵树。

## ⑤ 已知坑

1. **`npm publish --dry-run` 报 `bin[cowcat] script name ... invalid and removed`** 是 npm 的措辞 bug；`bin` 路径已写成规范化形式，安装后 `.bin/cowcat` 正常。
2. **发布成功是异步的**：看到 `PUT 202` + `exit 0` 即可，不要因为 registry 暂时查不到而重发（会 `E409`）。
3. **`npm stage` 不吃 scope 级 registry 配置**：`stage list/view/approve` 一律显式加 `--registry=https://registry.npmjs.org`。
4. **TUI 的 Node 门槛**：`@corescense/cowcat-tui` 要求 Node ≥ 26.4；在 Node 22 上安装 CLI 会出现 EBADENGINE 警告，但 `run`/`serve`/`doctor` 不受影响。
5. **版本号只有一处批次操作**：四个 `package.json` + `pack-release.mjs` 的 `VERSION` 必须一起改；不要只改一个。

## ⑥ 自动发布

不要使用绕过 2FA 的 long-lived token。正确路线是 npm Trusted Publishing（OIDC）+ GitHub Actions `id-token: write`；在切换到 OIDC 之前，发布保持人工 2FA。
