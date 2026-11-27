# 发布与升级操作说明

`dsh-offline-market` 发布在 npm：<https://www.npmjs.com/package/dsh-offline-market>。
源码与发布流水线在 GitHub：<https://github.com/halcyon6669/dsh-offline-market>。

## 一、用户怎么装 / 怎么升级

安装（首次）：

```
dsh plugin add dsh-offline-market
```

或在 DSH「插件 → 添加插件」对话框里粘贴包名 `dsh-offline-market`、远程 `.tgz` 直链或本地 tgz/目录后安装。

升级：重新执行同一条命令即可（pnpm 会用新版本覆盖旧版本，无需先卸载）。插件页本身的「离线更新 / 安装」标签页也支持从来源 URL 或本地 tgz 更新其它插件。

## 二、维护者怎么发新版本

发布采用 GitHub Actions + npm OIDC trusted publishing，**不需要任何 npm token**。

1. 改代码，跑本地校验：

   ```
   node --check index.js
   node --check client.js
   node test-offline-market.cjs
   ```

2. 更新 `package.json` 的 `version`（遵循 semver；每个版本在 dist-packages 里用独立文件名，不要覆盖旧 tgz —— 覆盖同名 tgz 会触发 pnpm integrity 校验失败）。

3. 提交并推送到 `main`：

   ```
   git add -A
   git commit -m "Release vX.Y.Z" -F <msg文件>   # 中文说明用 -F 文件，避免 -m 拆坏
   git push origin main
   ```

4. 打 annotated tag 并推送，触发发布：

   ```
   git tag -a vX.Y.Z -F <msg文件>
   git push origin vX.Y.Z
   ```

5. GitHub Actions（`.github/workflows/publish.yml`）会：校验 tag 与 package.json 版本一致 → 语法检查 → 跑单测 → `npm pack --dry-run` → `npm publish --access public --provenance` → 轮询 registry 直到确认上线。
   - 若该版本已在 npm 上，流水线会**自动跳过**发布（幂等），重复推 tag 不会报错。
   - 可在 Actions 页面用 `workflow_dispatch` 手动触发。

## 三、npm 端一次性配置（仅首次需要）

在 <https://www.npmjs.com/package/dsh-offline-market/settings/access> 配置 trusted publisher：

- Provider: **GitHub Actions**
- Owner: **halcyon6669**
- Repository: **dsh-offline-market**
- Workflow filename: **publish.yml**（只填文件名，含 `.yml`）
- Environment: **留空**
- Allowed actions: 勾选 **npm publish（direct publish）** —— 本流水线用的是 `npm publish`，不是 staged-publish。

注意：新创建的 trusted publisher 配置必须在 **2 天内完成首次发布**，否则过期需删除重建。

## 四、本包 1.1.0 发布历史（备查）

`1.1.0` 因账号 2FA 是 WebAuthn 安全密钥（非验证器 App 的 6 位码），bypass-2FA token 又只允许 staged publish，最终通过 `npm stage publish` + 浏览器完成安全密钥验证后的 `npm stage approve` 发布上线。因此：

- registry 里残留一个占位版本 `0.0.0-stage`，但 `dist-tags.latest = 1.1.0`，不影响安装。
- 对话中曾暴露过几个 npm token（`npm_ceUz...` / `npm_hgNd...` / `npm_TMEn...`），发布完成后应全部在 npm 网页 revoke。
- 后续版本一律走上面的 OIDC tag 流程，不再需要任何 token 或安全密钥交互。
