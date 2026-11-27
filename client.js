window.__ModuleLoader__.load({
  id: 'dsh-offline-market',
  factory: function (require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const TAG_ID = 'dsh-offline-market'
    const API = '/plugins/offline-market/api'

    const CSS = `
.om-wrap{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px}
.om-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.om-title{margin:0;font-size:16px;font-weight:600}
.om-sub{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.om-card{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.om-card-title{font-weight:600}
.om-rowline{display:flex;gap:8px;align-items:center}
.om-dir-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.om-input{flex:1;min-width:0;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}
.om-btn{flex:none;padding:7px 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-on-color);cursor:pointer;font:inherit;white-space:nowrap}
.om-btn:hover{background:var(--dsw-alias-button-primary-hover)}
.om-btn:disabled{opacity:.55;cursor:default}
.om-btn-ghost{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.om-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}
.om-btn-danger{color:var(--dsw-alias-state-error-primary)}
.om-actions{display:flex;gap:8px;flex:none}
.om-list{display:flex;flex-direction:column;gap:8px}
.om-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.om-name{font-weight:600;word-break:break-all}
.om-ver{margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:12px}
.om-file{margin-top:2px;color:var(--dsw-alias-label-dimmed);font-size:11px;word-break:break-all}
.om-tag{display:inline-block;margin-left:8px;padding:1px 6px;border-radius:10px;font-size:11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.om-tag-update{color:var(--dsw-alias-state-warn-primary)}
.om-tag-install{color:var(--dsw-alias-state-success-primary)}
.om-tag-source{color:var(--dsw-alias-state-warn-primary)}
.om-empty{padding:22px;text-align:center;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}
.om-msg{padding:8px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:12px;word-break:break-all}
.om-msg-ok{color:var(--dsw-alias-state-success-primary)}
.om-msg-err{color:var(--dsw-alias-state-error-primary)}
`

    function ensureStyles() {
      if (typeof document === 'undefined' || !document.head) return
      try {
        const existing = document.head.querySelector('style[data-plugin-css="' + TAG_ID + '"]')
        if (existing) return
        const tag = document.createElement('style')
        tag.dataset.plugin = TAG_ID
        tag.dataset.pluginCss = TAG_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      } catch (_) {
        // Styling must never break the plugin.
      }
    }

    async function api(path, options) {
      const response = await fetch(API + path, options)
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) {
        throw new Error(body.error || ('HTTP ' + response.status))
      }
      return body
    }

    function OfflineMarket() {
      const [dir, setDir] = useState('')
      const [dirInput, setDirInput] = useState('')
      const [editingDir, setEditingDir] = useState(false)
      const [url, setUrl] = useState('')
      const [rows, setRows] = useState([])
      const [scanned, setScanned] = useState(0)
      const [skipped, setSkipped] = useState(0)
      const [loading, setLoading] = useState(true)
      const [savingDir, setSavingDir] = useState(false)
      const [installingUrl, setInstallingUrl] = useState(false)
      const [busyName, setBusyName] = useState('')
      const [msg, setMsg] = useState('')
      const [msgKind, setMsgKind] = useState('')

      const refresh = useCallback(async () => {
        setLoading(true)
        try {
          const [configResult, bundleResult] = await Promise.all([
            api('/config'),
            api('/bundles'),
          ])
          const nextDir = configResult.tgzDir || ''
          setDir(nextDir)
          if (!editingDir) setDirInput(nextDir)
          setRows(bundleResult.rows || [])
          setScanned(bundleResult.scanned || 0)
          setSkipped(bundleResult.skipped || 0)
          if (bundleResult.error) {
            setMsg(bundleResult.error)
            setMsgKind('err')
          }
        } catch (error) {
          setMsg(String((error && error.message) || error))
          setMsgKind('err')
        } finally {
          setLoading(false)
        }
      }, [editingDir])

      useEffect(() => {
        ensureStyles()
        refresh()
      }, [refresh])

      const saveDir = useCallback(async () => {
        const next = String(dirInput || '').trim()
        if (!next) {
          setMsg('请填写本地 tgz 目录的绝对路径。')
          setMsgKind('err')
          return
        }
        setSavingDir(true)
        setMsg('')
        try {
          await api('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tgzDir: next }),
          })
          setMsg('目录已保存，插件正在重启，请稍后刷新。')
          setMsgKind('ok')
          setEditingDir(false)
          setTimeout(refresh, 1200)
        } catch (error) {
          setMsg(String((error && error.message) || error))
          setMsgKind('err')
        } finally {
          setSavingDir(false)
        }
      }, [dirInput, refresh])

      const installFromUrl = useCallback(async () => {
        const spec = String(url || '').trim()
        if (!spec) {
          setMsg('请先填写插件 URL 或包名。')
          setMsgKind('err')
          return
        }
        setInstallingUrl(true)
        setMsg('')
        try {
          const result = await api('/install-url', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: spec, requestId: 'offline-market-' + Date.now() }),
          })
          const where = result.downloaded
            ? '已下载到 ' + result.downloaded.filename + '，并从本地路径安装。'
            : '安装完成。'
          setMsg(where + (result.application === 'restart-required' ? '（需重启生效）' : '') + ' 插件已启用。')
          setMsgKind('ok')
          setUrl('')
          await refresh()
        } catch (error) {
          setMsg('安装失败：' + String((error && error.message) || error))
          setMsgKind('err')
        } finally {
          setInstallingUrl(false)
        }
      }, [url, refresh])

      // 从源更新：重新下载来源 URL 的最新包 → 安装 → 成功后删旧包。
      const runUpgrade = useCallback(async (row) => {
        setBusyName(row.name)
        setMsg('')
        try {
          const result = await api('/upgrade', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: row.name, requestId: 'offline-market-upgrade-' + Date.now() }),
          })
          if (result.upToDate) {
            setMsg((result.message || '来源没有更新版本') + ' 当前已是 ' + (result.version || row.installed) + '。')
            setMsgKind('ok')
            return
          }
          const ver = result.downloaded && result.downloaded.version
          const removed = result.deleted && result.deleted.length
          setMsg('已从来源下载并安装 ' + row.name + (ver ? ' ' + ver : '') +
            (result.fromVersion ? '（原 ' + result.fromVersion + '）' : '') +
            (removed ? '，已删除 ' + removed + ' 个旧包。' : '。') +
            (result.application === 'restart-required' ? '（需重启生效）' : ''))
          setMsgKind('ok')
          await refresh()
        } catch (error) {
          setMsg('更新失败：' + String((error && error.message) || error))
          setMsgKind('err')
        } finally {
          setBusyName('')
        }
      }, [refresh])

      // 安装本地 tgz（未安装包，或用户手动放进去的新包）。
      const runInstall = useCallback(async (row) => {
        setBusyName(row.name)
        setMsg('')
        try {
          const result = await api('/install', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ file: row.file, name: row.name }),
          })
          setMsg('已安装 ' + row.name + (row.available ? ' ' + row.available : '') +
            (result.application === 'restart-required' ? '（需重启生效）' : '') + '。')
          setMsgKind('ok')
          await refresh()
        } catch (error) {
          setMsg('安装失败：' + String((error && error.message) || error))
          setMsgKind('err')
        } finally {
          setBusyName('')
        }
      }, [refresh])

      // 卸载已安装的插件（update/source/current 行才装了包；install 行未安装）。
      const runRemove = useCallback(async (row) => {
        setBusyName(row.name)
        setMsg('')
        try {
          const result = await api('/remove', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: row.name }),
          })
          setMsg('已卸载 ' + row.name +
            (result.application === 'restart-required' ? '（需重启生效）' : '') + '。')
          setMsgKind('ok')
          await refresh()
        } catch (error) {
          setMsg('卸载失败：' + String((error && error.message) || error))
          setMsgKind('err')
        } finally {
          setBusyName('')
        }
      }, [refresh])

      const updateCount = rows.filter((r) => r.status === 'update' || r.status === 'source').length
      const installCount = rows.filter((r) => r.status === 'install').length

      return h('div', { className: 'om-wrap' },
        h('div', { className: 'om-head' },
          h('div', null,
            h('h2', { className: 'om-title' }, '离线更新 / 安装'),
            h('p', { className: 'om-sub' }, '远程 tgz 先下载到本地再用本地路径安装 · 更新会重新下载来源包并安装、删除旧包')
          ),
          h('button', {
            type: 'button', className: 'om-btn om-btn-ghost', onClick: refresh, disabled: loading,
          }, '刷新')
        ),

        // URL install card
        h('div', { className: 'om-card' },
          h('div', { className: 'om-card-title' }, '从 URL / 包名安装'),
          h('div', { className: 'om-rowline' },
            h('input', {
              className: 'om-input', value: url,
              placeholder: '远程 .tgz 直链、Git 地址或 npm 包名',
              onChange: (event) => setUrl(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') installFromUrl() },
            }),
            h('button', {
              type: 'button', className: 'om-btn', onClick: installFromUrl, disabled: installingUrl,
            }, installingUrl ? '安装中…' : '下载并安装')
          ),
          h('div', { className: 'om-sub' }, '远程 tgz 会先下载到下方 tgz 目录，再用本地路径安装（来源显示为本地）。来源 URL 会被记住，供「更新」使用。')
        ),

        // Directory card
        dir && !editingDir
          ? h('div', { className: 'om-dir' },
              h('span', { className: 'om-dir-path', title: dir }, dir),
              h('button', {
                type: 'button', className: 'om-btn om-btn-ghost',
                onClick: () => { setDirInput(dir); setEditingDir(true) },
              }, '更改')
            )
          : h('div', { className: 'om-card' },
              h('div', { className: 'om-card-title' }, 'tgz 目录'),
              h('div', { className: 'om-rowline' },
                h('input', {
                  className: 'om-input', value: dirInput,
                  placeholder: '本地 tgz 目录，例如 D:\\offline-plugins',
                  onChange: (event) => setDirInput(event.target.value),
                  onKeyDown: (event) => { if (event.key === 'Enter') saveDir() },
                }),
                dir ? h('button', {
                  type: 'button', className: 'om-btn om-btn-ghost',
                  onClick: () => { setEditingDir(false); setDirInput(dir) },
                }, '取消') : null,
                h('button', {
                  type: 'button', className: 'om-btn', onClick: saveDir, disabled: savingDir,
                }, savingDir ? '保存中…' : '保存目录')
              )
            ),

        msg ? h('div', { className: 'om-msg ' + (msgKind === 'ok' ? 'om-msg-ok' : 'om-msg-err'), role: 'status' }, msg) : null,

        h('div', { className: 'om-sub' },
          '扫描 ' + scanned + ' 个 tgz' + (skipped ? '，跳过 ' + skipped + ' 个无效文件' : '') +
          ' · 可更新 ' + updateCount + ' · 可安装 ' + installCount
        ),

        loading
          ? h('div', { className: 'om-empty' }, '正在读取…')
          : rows.length === 0
            ? h('div', { className: 'om-empty' }, dir ? '目录里没有可安装或可更新的插件。' : '请先设置本地 tgz 目录。')
            : h('div', { className: 'om-list' }, rows.map((row) => {
                const isUpdatable = row.status === 'update' || row.status === 'source'
                const tag = row.status === 'update'
                  ? h('span', { className: 'om-tag om-tag-update' }, '有本地新包')
                  : row.status === 'source'
                    ? h('span', { className: 'om-tag om-tag-source' }, '来源有更新')
                    : row.status === 'install'
                      ? h('span', { className: 'om-tag om-tag-install' }, '未安装')
                      : h('span', { className: 'om-tag' }, '已最新')
                const verText = row.status === 'update'
                  ? '已装 ' + row.installed + '  →  本地有 ' + row.available
                  : row.status === 'source'
                    ? '已装 ' + row.installed + '  →  来源有 ' + row.available
                    : row.status === 'install'
                      ? '版本 ' + row.available
                      : '已装 ' + row.installed + '（已是最新）'
                const detail = row.status === 'source' && row.source
                  ? h('div', { className: 'om-file', title: row.source }, '来源：' + row.source)
                  : h('div', { className: 'om-file', title: row.file || '' }, row.basename)
                // 本地已有新包 (update) → 直接装本地文件；来源有新版 (source) → 重新下载安装。
                const onClick = row.status === 'source' ? () => runUpgrade(row) : () => runInstall(row)
                const label = busyName === row.name
                  ? '处理中…'
                  : row.status === 'install' ? '安装' : '更新'
                const isInstalled = row.status !== 'install'
                return h('div', { className: 'om-row', key: row.name + '|' + (row.file || 'source') },
                  h('div', null,
                    h('div', { className: 'om-name' }, row.name, tag),
                    h('div', { className: 'om-ver' }, verText),
                    detail
                  ),
                  h('div', { className: 'om-actions' },
                    // 只有 update/source/install 才有主按钮；current(已最新) 不显示主按钮。
                    row.status === 'current' ? null : h('button', {
                      type: 'button', className: 'om-btn',
                      disabled: busyName === row.name,
                      onClick,
                    }, label),
                    // 每行后卸载按钮（已安装的行才有意义）。
                    isInstalled ? h('button', {
                      type: 'button', className: 'om-btn om-btn-ghost om-btn-danger',
                      disabled: busyName === row.name,
                      onClick: () => runRemove(row),
                    }, '卸载') : null
                  )
                )
              }))
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyles()
        return ctx.slots.inject('plugins.tab', () => {
          try {
            const dispose = ctx.slots.register(
              { name: 'plugins.tab', id: 'offline-market', order: 20, label: '离线更新 / 安装' },
              () => h(OfflineMarket, { ctx })
            )
            return dispose
          } catch (_) {
            return undefined
          }
        })
      },
    }
  },
})
