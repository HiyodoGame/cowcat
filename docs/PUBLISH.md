# CowCat npm 企业发布操作手册（内部文档）

发布主体：心感科技（深圳）有限公司（CoreScense）
包名：`@corescense/cowcat`（scoped）
许可：MIT
> 历史决策记录：无 scope 的 `cowcat` 曾计划首发，但被 npm 防仿冒策略拒绝（"too similar to existing packages concat, cowsay"，2026-10-13 实测 E403），故改用 scope 方案——`@corescense` 与品牌一致，归属清晰，且避免了包名抢注纠纷。

## ① npm 账号与企业身份

1. 在 https://www.npmjs.com/signup 注册账号，**邮箱使用企业邮箱**（如 `dev@corescense.com`），用户名建议 `corescense`（被占用时加后缀，如 `corescense-dev`）。
2. 账号设置中开启 **2FA（Two-Factor Authentication）**，建议用 Authenticator App 而非 SMS。
3. 本机登录：`npm login`（会要求输入 2FA 验证码）。
4. 确认发布身份：`npm whoami`。

## ② 组织化管理（可选但推荐）

1. https://www.npmjs.com/org/create 创建 org，scope 名首选 `corescense`。
   - **创建时若 `@corescense` 被占用**：备选 `@corescense-cn`、`@corescense-dev`、`@xingen-tech`（心感拼音）。
2. 创建后把企业账号加为 owner，后续可发 scoped 包（`@corescense/cowcat`）或把无 scope 的 `cowcat` 加入 org 管理（npm 支持将 unscoped 包迁入 org）。
3. **先发先得**：scope `@corescense` 本身具有唯一性（org 创建即锁定）；首次发布 scoped 包时若 npm 提示创建 org，按提示确认即可（免费 org 默认支持公开发布）。

## ③ 发布前 checklist

- [ ] `git status` 干净；发布 commit 已打 tag。
- [ ] **确认密钥从未进过 git 历史**：
  ```bash
  git log --all --full-history -- .keys.env
  ```
  只要有任何输出，先换 key 并清理历史（`git filter-repo`）再发布。
- [ ] 版本号与 `docs/changelog.md` 同步；README、LICENSE、package.json 的 author 信息正确。
- [ ] tarball 内容检查（关键）：
  ```bash
  cd agent
  npm publish --dry-run
  ```
  确认文件列表**只有** `bin/`、`src/`、`assets/` + README/LICENSE/package.json；
  必须**不含** `analysis/`、`docs/`、`test/`、`logs/`、`sandbox/`、`tools/` 及任何抓包/prompt 素材（`files` 白名单已限定，dry-run 再目视确认一遍）。
- [ ] `cd agent && npm install && npm test` 全绿（`pretest` 会先跑 ESLint 的 `no-undef`/`no-unused-vars`）。
- [ ] 本地一次干净安装演练：`npm pack` 后解包到临时目录，`node bin/cowcat.mjs --version` 正常。

## ④ 发布

```bash
cd agent
npm publish --access=public   # 首次发布（scoped 公开包；package.json 已配 publishConfig，可省略参数）
```

> **本机默认 registry 是 npmmirror（只读镜像），不能发布**：直接 `npm publish` 会以
> `npm error code ENEEDAUTH … requires you to be logged in to https://registry.npmmirror.com`
> 失败。`agent/.npmrc` 已把 `@corescense` scope 指向官方 registry，因此 **npm 登录也要
> 对官方 registry 做一次**：
>
> ```bash
> npm login --registry=https://registry.npmjs.org
> npm whoami --registry=https://registry.npmjs.org
> cd agent && npm publish --access=public   # 由 agent/.npmrc 送到 npmjs
> ```
>
> 不想用 .npmrc 时也可以临时指定：`npm publish --registry=https://registry.npmjs.org`。

> **新 scope 首发会走 staged publishing**（2026 起 npm 默认安全机制）：CLI 显示成功后，包其实进了暂存区，registry 会先有 `0.0.0-stage` 占位版本。必须登录 npm 网页打开包页面，点 **Approve / Publish**（要 2FA）才真正上线；此前 `npm i` 会得到 404，且 registry 的 404 有 CDN 缓存，批准后可能还要等 1-2 分钟才能安装到。

### 暂存期的三个实测坑（v0.12.0 发布时踩到）

1. **对已暂存的同一版本再 publish → `E409 Conflict`**：`Cannot publish over previously staged version "0.12.0"`。这不是失败，是「同一个版本不能重复暂存」。处理：批准已暂存的那份，不要重发同一版本——
   ```bash
   npm stage list  --registry=https://registry.npmjs.org     # 拿 stage-id
   npm stage view  <stage-id> --registry=https://registry.npmjs.org
   npm stage approve <stage-id> --registry=https://registry.npmjs.org   # 等价于网页 Approve
   ```
   若暂存产物已经过期（例如批准前又改了代码），先 `npm stage reject <stage-id>`，再 bump 版本重新发布。
   另可用 `npm stage download <stage-id>` 取回暂存 tarball 做校验。
2. **`npm stage` 不吃 scope 级 registry 配置**：`agent/.npmrc` 里的 `@corescense:registry` 对 `npm stage list/view/approve` 不生效，实测会打到默认镜像（npmmirror）并报 `E422 … must match format "semver-spec"`。这几个子命令一律显式加 `--registry=https://registry.npmjs.org`。
3. **发布后核对产物身份**：比较本地打包与 registry 上的 shasum，二者一致才算「发布的就是这棵树」——
   ```bash
   cd agent && npm pack --pack-destination "$TEMP"   # 记下 shasum
   node -e "fetch('https://registry.npmjs.org/@corescense/cowcat/<版本>').then(r=>r.json()).then(j=>console.log(j.dist.shasum, j.dist.fileCount))"
   ```

后续版本迭代：

```bash
cd agent
npm version patch      # 0.3.1 -> 0.3.2，自动打 git tag（需先提交干净工作区）
npm publish
git push && git push --tags
```

`npm version` 会同步改写 package.json 的版本号；**记得同步更新 `docs/changelog.md`**。

## ⑤ 发布后验证

```bash
npm i -g @corescense/cowcat
cowcat --version                 # 应输出 cowcat/<刚发布的版本>
cowcat setup                     # 向导可用
cowcat doctor                    # 配好 key 后逐项 ✓
```

另用一台干净机器（或 docker node:20）重复上述验证，排除"本机恰好能用"的假阳性。

## ⑥ 风险与防护

- **品牌资产**：建议同步注册 "CowCat" / "CoreScense" 商标（中国商标局 + 必要时马德里体系），并注册 GitHub org（`github.com/corescense`）。npm 包名、GitHub 名、商标三者保持一致最稳。
- **抢注防护**：包名已定 `@corescense/cowcat`，scope 与品牌绑定；若后续要防个人账号失控，在 npm 页面把包移入 `@corescense` org 并保证 owner 至少两人。无 scope 的 `cowcat` 已被防仿冒策略保护（第三方无法抢注近似名），无需再占位。
- **密钥风险**：任何时刻 `.keys.env` 不得进入 git 与 tarball；若疑似泄露，立即轮换 API key。
- **发布权限**：开启 npm 账号 2FA 后，publish 也需要 OTP；保管好 recovery codes。
- **CI 自动发布**：不要再用 "bypass 2FA" 的 granular access token——npm 已宣布废弃（2026-08 起禁账号管理操作，2027-01 起失去直接发布能力，见 [npm 官方 changelog](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)）。正确路线是 **Trusted Publishing（OIDC）**：GitHub Actions 建 workflow，用 `id-token: write` 权限直连 npm 换短期令牌，零长期密钥。CowCat 零依赖、无 install 脚本，npm v12 的 install 时安全默认（allowScripts/--allow-git/--allow-remote 全关）对安装本包无影响。
