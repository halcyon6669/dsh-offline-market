# 离线更新 / 安装 · Offline Updates / Install

一个 DSH 插件：在「插件」页增加一个「离线更新 / 安装」标签页，把**从 URL 安装**和**本地 tgz 更新/安装**合在一处。远程 tgz 会先下载到本地目录，再用 `file:` 本地路径安装，因此插件来源显示为本地路径，而不是远程 URL。

## 工作方式

1. 在标签页里设置一个本地 tgz 目录（例如 `D:\offline-plugins`）。目录路径持久化到插件配置，重载后保留。
2. **从 URL / 包名安装**：粘贴远程 `.tgz` 直链、Git 地址或 npm 包名。
   - 远程 tgz → 先下载到 tgz 目录（按 `包名-版本.tgz` 命名）→ 用本地 `file:` 路径安装（来源显示本地）。
   - 未配置目录时，远程 tgz 安装会报错并提示先配置目录。
   - npm 包名 / Git 地址 → 原样安装，不下载。
   - 来源 URL 会记录在 tgz 目录的 `.dsh-offline-market.json`，供刷新时检查版本与「从源更新」使用。
3. **插件列表**：点右上角「刷新」会扫描 tgz 目录里的所有 `*.tgz`，读取包内 `package.json` 得到包名与版本，并实时访问每个已装插件的来源 URL 检查最新版本，与本机已安装插件对比，分四类：
   - `有本地新包` — 目录里有比已装版本更高的 tgz → 「更新」从本地 tgz 装
   - `来源有更新` — 已装插件记录过来源 URL、且来源当前提供更高版本 → 「更新」点击时从来源下载最新包并安装
   - `未安装` — 目录里有但本机没装 → 「安装」
   - `已最新` — 来源与本地都没有更高版本（无主按钮）
   - 每行末尾都有「卸载」按钮，卸载后保留本地 tgz，便于之后从列表重新安装。
4. **从源更新**：通过本插件「从 URL 安装」装的插件，来源 URL 记录在 tgz 目录的 `.dsh-offline-market.json`。点「更新」时重新下载该地址 → 校验包内版本高于已装版本 → 安装 → **成功后删除被替换的旧版本 tgz**（并在 sidecar 更新文件指针）。目录里一开始不需要预先放新包；来源 URL 可以是固定版本，也可以是 `latest` 之类始终指向最新包的地址。是否「有更新」由刷新时的实时检查决定，只有真的更高版本才显示「更新」按钮。
5. 所有安装/更新都用 `file:<本地tgz绝对路径>` 调用安装器（`installBundle`，`enabled:true`），**本地安装零网络下载**；运行时依赖来自 pnpm 内容寻址 store 的硬链接。
6. 升级无需卸载旧版：新版本 `file:` spec 覆盖旧版是 pnpm 原子替换（+1 −1），desktop profile 无 HMR，安装器允许同包不同 spec 覆盖。

## 为什么每个版本要用不同的文件名

pnpm 会用 tgz 内容做 integrity 校验。同名覆盖（例如始终叫 `my-plugin.tgz` 却换掉内容）会触发 integrity 失配，被当成供应链风险拒绝安装。请为不同版本使用不同文件名：

```
my-plugin-1.0.0.tgz
my-plugin-1.1.0.tgz
my-plugin-2.0.0.tgz
```

远程 tgz 下载时自动按 `包名-版本.tgz` 命名，绝不覆盖。目录里同时存在多个版本时，自动选版本最高的那个；「从源更新」成功后会自动删除旧版本文件。

## 打包插件

请先用 `package-dsh-plugin-tgz` 技能把插件源码打成自包含的 tgz（含运行时依赖、可离线运行），再放进上面的目录。

## 诊断

Host API（本地回环端口 `/plugins/offline-market/api`）：

- `GET  /bundles` — 扫描结果（每行含 `status: update|source|install|current`），刷新时实时检查来源版本
- `GET  /updates` — 向后兼容：只返回 `status=update` 的行
- `GET  /config` — 当前配置的目录与已记录的来源 URL
- `POST /config` — `{"tgzDir":"..."}` 设置目录（会重启插件）
- `POST /install` — `{"file":"<tgz绝对路径>","name":"..."}` 从本地 tgz 安装/更新
- `POST /install-url` — `{"url":"...","requestId":"..."}` 从 URL/包名安装（远程 tgz 先下载再本地装，并记录来源）
- `POST /upgrade` — `{"name":"...","requestId":"..."}` 从来源重新下载最新包、安装、成功后删除旧版本 tgz
- `POST /remove` — `{"name":"..."}` 卸载插件，清除来源记录但保留本地 tgz

安装失败会返回 pnpm 的真实报错（`error.diagnostic`），而不是只显示 `operation-error`。
