# @local/dsh-offline-market

离线插件市场（合并版）：把「从 URL 安装」和「本地 tgz 更新/安装」合到「插件」页的同一个标签页里。远程 tgz 会先下载到本地目录，再用 `file:` 本地路径安装，因此 profile 里的来源显示为本地路径，而不是远程 URL。

## 功能

- 「插件」页新增「离线更新 / 安装」标签页，三个区域：
  1. **从 URL / 包名安装** — 粘贴远程 `.tgz` 直链、Git 地址或 npm 包名。远程 tgz 先下载到 tgz 目录，再用本地路径安装（来源显示本地）；npm/git spec 原样安装。
  2. **tgz 目录** — 设置一个本地目录并持久化。远程 tgz 下载到这里；同时也是本地扫描的来源。
  3. **插件列表** — 右上角「刷新」按钮会扫描目录内所有 `*.tgz`，读取包内 `package.json` 得到名称与版本，并实时访问每个已装插件的来源 URL 检查是否有新版本，对比本机已安装插件：
     - `有本地新包` — 目录里有比已装版本更高的 tgz → 「更新」按钮（从本地 tgz 装）
     - `来源有更新` — 已装插件记录过来源 URL、且来源当前提供更高版本 → 「更新」按钮：**点击时从来源 URL 下载最新包**，安装成功后删除被替换的旧版本 tgz
     - `未安装` — 目录里有但本机没装 → 「安装」按钮
     - `已最新` — 来源与本地都没有更高版本（无主按钮）
  - 每一行末尾都有「卸载」按钮，可卸载对应插件（保留本地 tgz，便于之后重装）。
- 从远程 URL 装的插件，其来源 URL 会记录在 tgz 目录内的 `.dsh-offline-market.json`；刷新时即按该地址检查版本，「从源更新」就是重新下载这个地址（`latest` 或固定 URL 都可用），不必事先把新包放进目录。
- 所有安装/更新都用 `file:<tgz绝对路径>` spec 调用 `pluginManager.installBundle(spec, { enabled: true })`：零网络下载、运行时依赖来自 pnpm 内容寻址 store 的硬链接。
- 升级无需卸载旧版：新版本 `file:` spec 覆盖旧版是 pnpm 原子替换（+1 −1），desktop profile 无 HMR，`installBundle` 允许同包不同 spec 覆盖。
- 安装失败会显示 `error.diagnostic`（pnpm 真实报错），不再只显示裸 `operation-error`。

## 安装

用 DSH 的「插件 → 添加插件」选本目录，或：

```
dsh plugin add <本目录的绝对路径>
```

## 使用约定

- 每个版本用**不同文件名**（`my-plugin-1.0.0.tgz` / `my-plugin-1.1.0.tgz`）。远程 tgz 下载时自动按 `包名-版本.tgz` 命名，绝不覆盖；同名覆盖会触发 pnpm integrity 校验失败（被当作供应链风险拒绝）。
- 目录里同时有多个版本时，自动选最高版本。
- 无效 tgz（无 package.json / 缺 name/version）会被跳过，不显示。
- 安装远程 tgz 前必须配置 tgz 目录，否则会提示先在 设置 → 通用 或本页配置。
- 「从源更新」要求该插件当初是通过本插件的「从 URL 安装」装的（这样才有来源记录）；npm/git 方式装的插件没有来源 URL，需要时用远程 tgz 重新安装一次。

## 文件

- `index.js` — Host 半侧：下载远程 tgz、扫描目录、版本比较、来源记录、REST API、调用安装器。
- `client.js` — Client 半侧：注册 `plugins.tab`，渲染 URL 安装框、目录设置、插件列表与卸载按钮。
- `cordis.patch.yml` — bundle 注入声明，配置字段 `tgzDir`。
- `.dsh-offline-market.json`（运行时生成于 tgz 目录）— 记录每个包的来源 URL、当前本地 tgz 文件与已同步版本。
- `locale/`、`icon.svg`、`docs/DETAIL.md` — 元数据与详情。
- `test-offline-market.cjs` — 无 DSH 实例的 headless 单元校验脚本。

## REST 端点（Host，`/plugins/offline-market/api`）

- `GET /bundles` — 扫描结果，每行含 `status: 'update'|'source'|'install'|'current'`。刷新时会检查来源 URL 的最新版本。
- `GET /updates` — 向后兼容：只返回 `status=update` 的行。
- `GET /config` / `POST /config {tgzDir}` — 读写 tgz 目录配置；`GET` 也返回已记录的来源 URL。
- `POST /install {file,name?}` — 从本地 tgz 文件安装/更新。
- `POST /install-url {url,requestId}` — 从 URL/包名安装（远程 tgz 先下载再本地装，并记录来源）。
- `POST /upgrade {name,requestId}` — 从来源 URL 重新下载最新包、安装、成功后删除旧版本 tgz。
- `POST /remove {name}` — 卸载插件，清除其来源记录但保留本地 tgz。

## 本地校验

```
node --check index.js
node --check client.js
node test-offline-market.cjs
```
