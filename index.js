/** Host half of dsh-offline-market — the unified offline plugin manager.
 *
 * The user-configured tgz directory serves two purposes:
 *   1. Remote tgz URLs are downloaded into it and installed from the LOCAL `file:`
 *      path, so the profile records a local source, never a remote URL.
 *   2. The same directory is scanned for local tgz files to install directly.
 *
 * For plugins installed from a remote URL, that URL is remembered in a small
 * sidecar manifest in the directory. "从源更新" re-downloads from that URL,
 * installs the new version, and deletes the superseded local tgz on success.
 * The sidecar avoids configEditor edits (which restart the plugin on every write).
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const inject = ['webServer', 'pluginManager', 'configEditor']

const API_PREFIX = '/plugins/offline-market/api'
const STATE_FILE = '.dsh-offline-market.json'

// ---------- sidecar state (source URL / local file per installed package) ----------

function statePath(dir) {
  return join(dir, STATE_FILE)
}

function readState(dir) {
  if (!dir) return { sources: {}, files: {}, synced: {} }
  try {
    const raw = JSON.parse(readFileSync(statePath(dir), 'utf8'))
    return {
      sources: raw.sources && typeof raw.sources === 'object' ? raw.sources : {},
      files: raw.files && typeof raw.files === 'object' ? raw.files : {},
      // version last downloaded from (and installed alongside) a remembered source
      synced: raw.synced && typeof raw.synced === 'object' ? raw.synced : {},
    }
  } catch {
    return { sources: {}, files: {}, synced: {} }
  }
}

function writeState(dir, state) {
  if (!dir) return
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(statePath(dir), JSON.stringify(state, null, 2))
  } catch { /* state is best-effort; never break an install */ }
}

function updateState(dir, mutate) {
  const state = readState(dir)
  mutate(state)
  writeState(dir, state)
  return state
}

// ---------- minimal tar reader ----------

function parseOctal(field) {
  let out = 0
  for (const byte of field) {
    if (byte >= 48 && byte <= 55) out = out * 8 + (byte - 48)
    else break
  }
  return out
}

/** Read name/version from `package/package.json` inside a tgz buffer. */
function readPackageJsonFromTgz(buffer) {
  try {
    const tar = gunzipSync(buffer)
    let offset = 0
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512)
      if (header.every((byte) => byte === 0)) break
      let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
      const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
      if (prefix) name = prefix + '/' + name
      const size = parseOctal(header.subarray(124, 136))
      const type = String.fromCharCode(header[156] || 48)
      const data = tar.subarray(offset + 512, offset + 512 + size)
      if (name === 'package/package.json' && type !== '5') {
        const pkg = JSON.parse(data.toString('utf8'))
        return { name: pkg.name, version: pkg.version }
      }
      offset += 512 + Math.ceil(size / 512) * 512
    }
  } catch {
    /* not a readable tgz */
  }
  return null
}

function readTgzFile(file) {
  const meta = readPackageJsonFromTgz(readFileSync(file))
  if (!meta || !meta.name || !meta.version) throw new Error('package.json not found in ' + basename(file))
  return meta
}

// ---------- version comparison (dependency-free) ----------

function parseVersion(value) {
  const raw = String(value || '').trim().replace(/^v/i, '')
  const cut = raw.search(/[-+]/)
  const core = cut === -1 ? raw : raw.slice(0, cut)
  const pre = cut === -1 ? '' : raw.slice(cut + 1).split('+')[0]
  const nums = core.split('.').map((part) => parseInt(part, 10) || 0)
  return { nums, pre }
}

/** > 0 when a is newer than b. */
function compareVersions(a, b) {
  const A = parseVersion(a)
  const B = parseVersion(b)
  const length = Math.max(A.nums.length, B.nums.length)
  for (let i = 0; i < length; i++) {
    const delta = (A.nums[i] || 0) - (B.nums[i] || 0)
    if (delta) return delta
  }
  if (!A.pre && !B.pre) return 0
  if (!A.pre) return 1
  if (!B.pre) return -1
  return A.pre.localeCompare(B.pre, undefined, { numeric: true })
}

const norm = (p) => String(p || '').replace(/\\/g, '/')
const fileSpec = (file) => 'file:' + norm(file)

// ---------- download (the only network path) ----------

function safeName(name) {
  return String(name || 'plugin').replace(/^@/, '').replace(/[\\/:*?"<>|]/g, '-')
}

async function downloadTgz(url, dir) {
  const res = await fetch(url)
  if (!res || res.ok === false) throw new Error('HTTP ' + (res && res.status))
  const buffer = Buffer.from(await res.arrayBuffer())
  const meta = readPackageJsonFromTgz(buffer)
  let filename
  if (meta && meta.name && meta.version) {
    // One file per version: never overwrite the same path with different bytes.
    filename = safeName(meta.name) + '-' + meta.version + '.tgz'
  } else {
    let base = ''
    try { base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') } catch { /* keep empty */ }
    filename = /\.tgz$/i.test(base) ? base : 'plugin-' + Date.now() + '.tgz'
  }
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, filename)
  writeFileSync(dest, buffer)
  return { path: dest, filename, name: meta ? meta.name : null, version: meta ? meta.version : null }
}

/** Peek at a source URL's current version without writing anything to disk.
 *  Used by the top-level 刷新 so "有更新" reflects what the source serves now. */
async function peekSourceVersion(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null
  try {
    const res = await fetch(url)
    if (!res || res.ok === false) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    const meta = readPackageJsonFromTgz(buffer)
    return meta && meta.version ? meta.version : null
  } catch {
    return null
  }
}

// ---------- helpers ----------

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

/** Turn an installBundle ChangeResult into a clean API payload. */
function installPayload(result) {
  const application = result && result.application
  const failed = !result || application === 'failed' || application === 'cancelled'
  const err = result && result.error
  const detail = err && (err.diagnostic || err.message || err.code)
  return {
    ok: !failed,
    application,
    version: result && result.version,
    changed: result && result.changed,
    warnings: result && result.warnings,
    error: failed ? (detail ? String(detail) : '安装过程出错，请检查 DSH 日志。') : undefined,
  }
}

// ---------- scan ----------

async function collectBundles(ctx, config) {
  const dir = String((config && config.tgzDir) || '').trim()
  if (!dir) return { configured: false, dir: '', rows: [], count: 0, scanned: 0, skipped: 0, sources: {} }

  const { sources, synced } = readState(dir)
  const bundles = await ctx.pluginManager.listBundles()
  const installed = new Map()
  for (const bundle of bundles) {
    if (bundle.installed && bundle.name && bundle.version) {
      installed.set(bundle.name, bundle.version)
    }
  }

  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return {
      configured: true, dir, rows: [], count: 0, scanned: 0, skipped: 0, sources,
      error: String((error && error.message) || error),
    }
  }

  const newest = new Map()
  let scanned = 0
  let skipped = 0
  for (const entry of entries) {
    if (!entry.isFile() || !/\.tgz$/i.test(entry.name)) continue
    scanned++
    const file = join(dir, entry.name)
    try {
      const meta = readTgzFile(file)
      const previous = newest.get(meta.name)
      if (!previous || compareVersions(meta.version, previous.version) > 0) {
        newest.set(meta.name, { name: meta.name, version: meta.version, file })
      }
    } catch {
      skipped++
    }
  }

  const rows = []
  // Installed plugins. The top-level 刷新 re-checks each remembered source URL,
  // so an "更新" button appears only when that source actually serves a newer
  // version (or a newer local tgz exists). Otherwise the row is shown as "已最新"
  // with no action button at all.
  for (const [name, version] of installed) {
    const source = typeof sources[name] === 'string' && sources[name] ? sources[name] : null
    const local = newest.get(name) || null
    const localNewer = local && compareVersions(local.version, version) > 0
    if (localNewer) {
      rows.push({
        name, installed: version, available: local.version,
        file: local.file, basename: basename(local.file), spec: fileSpec(local.file),
        status: 'update', source,
      })
      continue
    }
    if (source) {
      // Refresh performs the source check: peek what the URL serves right now.
      const sourceVersion = await peekSourceVersion(source)
      if (sourceVersion && compareVersions(sourceVersion, version) > 0) {
        rows.push({
          name, installed: version, available: sourceVersion,
          file: local ? local.file : null,
          basename: local ? basename(local.file) : '',
          spec: local ? fileSpec(local.file) : '',
          status: 'source', source,
        })
      } else {
        rows.push({
          name, installed: version,
          available: local ? local.version : null,
          file: local ? local.file : null,
          basename: local ? basename(local.file) : '',
          spec: local ? fileSpec(local.file) : '',
          status: 'current', source,
        })
      }
      continue
    }
    if (local) {
      // Local tgz present but not newer than installed — nothing to do.
      rows.push({
        name, installed: version,
        available: local.version,
        file: local.file, basename: basename(local.file), spec: fileSpec(local.file),
        status: 'current', source: null,
      })
    }
    // No source and no local tgz: a plain installed plugin stays hidden.
  }
  // Local tgz for packages not currently installed.
  for (const [name, info] of newest) {
    if (installed.has(name)) continue
    rows.push({
      name, installed: null, available: info.version,
      file: info.file, basename: basename(info.file), spec: fileSpec(info.file),
      status: 'install', source: sources[name] || null,
    })
  }
  const rank = { source: 0, update: 1, install: 2, current: 3 }
  rows.sort((a, b) => (rank[a.status] - rank[b.status]) || a.name.localeCompare(b.name))
  return { configured: true, dir, rows, count: rows.length, scanned, skipped, sources }
}

// ---------- host service ----------

export function apply(ctx, config) {
  const currentDir = () => String((config && config.tgzDir) || '').trim()

  async function recordSource(name, url) {
    if (!name) return
    updateState(currentDir(), (state) => { state.sources[name] = url })
  }

  async function recordFile(name, file) {
    if (!name || !file) return
    updateState(currentDir(), (state) => { state.files[name] = norm(file) })
  }

  async function recordSynced(name, version) {
    if (!name || !version) return
    updateState(currentDir(), (state) => { state.synced[name] = version })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (request, response) => {
      const send = (status, body) => {
        response.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(JSON.stringify(body))
      }
      const method = (request.method || 'GET').toUpperCase()
      const route = new URL(request.url || '/', 'http://localhost').pathname
        .replace(/^\/plugins\/offline-market\/api/, '') || '/'

      try {
        if (route === '/bundles' && method === 'GET') {
          return send(200, { ok: true, ...(await collectBundles(ctx, config)) })
        }
        if (route === '/updates' && method === 'GET') {
          const scanned = await collectBundles(ctx, config)
          const rows = (scanned.rows || []).filter((row) => row.status === 'update')
          return send(200, {
            ok: true, configured: scanned.configured, dir: scanned.dir, rows, count: rows.length,
            scanned: scanned.scanned, skipped: scanned.skipped, error: scanned.error,
          })
        }
        if (route === '/config' && method === 'GET') {
          const dir = currentDir()
          return send(200, { ok: true, tgzDir: dir, sources: readState(dir).sources })
        }
        if (route === '/config' && method === 'POST') {
          const body = await readJson(request)
          const next = String(body.tgzDir || '').trim()
          const editor = ctx.get('configEditor')
          const entry = ctx.fiber && ctx.fiber.entry
          if (!editor || !entry) throw new Error('configEditor is not available')
          await editor.edit(entry, (current) => ({ ...(current || {}), tgzDir: next }))
          return send(200, { ok: true, tgzDir: next, restarting: true })
        }

        // Install from a local tgz file ("安装"/"更新" rows).
        if (route === '/install' && method === 'POST') {
          const body = await readJson(request)
          const file = String(body.file || '')
          if (!file || !/\.tgz$/i.test(file)) {
            return send(400, { ok: false, error: '需要一个本地 .tgz 文件。' })
          }
          const spec = fileSpec(file)
          const payload = installPayload(await ctx.pluginManager.installBundle(spec, { enabled: true }))
          if (payload.ok) {
            let name = body.name
            if (!name) { try { name = readTgzFile(file).name } catch { /* ignore */ } }
            await recordFile(name, file)
          }
          return send(200, { ...payload, spec, file })
        }

        // Install from a pasted spec: remote .tgz URLs are downloaded then installed
        // locally; npm names / git URLs / local paths are passed straight through.
        if (route === '/install-url' && method === 'POST') {
          const body = await readJson(request)
          const url = String(body.url || '').trim()
          if (!url) return send(400, { ok: false, error: '请先填写插件 URL 或包名。' })
          const isRemoteTgz = /^https?:\/\//i.test(url) && /\.tgz(?:[?#].*)?$/i.test(url)
          let spec = url
          let downloaded = null
          if (isRemoteTgz) {
            const dir = currentDir()
            if (!dir) {
              return send(400, {
                ok: false,
                error: '尚未配置 tgz 目录。请先在上方（或 设置 → 通用 →「插件 tgz 目录」）填写一个本地目录，再安装远程 tgz。',
              })
            }
            try {
              downloaded = await downloadTgz(url, dir)
              spec = fileSpec(downloaded.path)
            } catch (error) {
              return send(500, { ok: false, error: '下载失败：' + String((error && error.message) || error) })
            }
          }
          const requestId = typeof body.requestId === 'string' && body.requestId
            ? body.requestId
            : 'offline-market-' + Date.now()
          const payload = installPayload(await ctx.pluginManager.installBundle(spec, { enabled: true, requestId }))
          if (payload.ok && downloaded && downloaded.name) {
            await recordSource(downloaded.name, url)
            await recordFile(downloaded.name, downloaded.path)
            await recordSynced(downloaded.name, downloaded.version || payload.version)
          }
          return send(200, { ...payload, spec, downloaded })
        }

        // Update a package from its remembered source URL: re-download the newest
        // package, install it locally, then delete the superseded local tgz on success.
        if (route === '/upgrade' && method === 'POST') {
          const body = await readJson(request)
          const name = String(body.name || '').trim()
          if (!name) return send(400, { ok: false, error: '缺少插件名称。' })
          const dir = currentDir()
          if (!dir) return send(400, { ok: false, error: '尚未配置 tgz 目录，无法下载新版本。' })

          const source = readState(dir).sources[name]
          if (!source) {
            return send(400, {
              ok: false,
              error: '未记录 ' + name + ' 的来源 URL。请先用「从 URL / 包名安装」重新安装一次以记录来源。',
            })
          }

          let downloaded
          try {
            downloaded = await downloadTgz(source, dir)
          } catch (error) {
            return send(500, { ok: false, error: '下载失败：' + String((error && error.message) || error) })
          }
          if (!downloaded.name || !downloaded.version) {
            return send(500, { ok: false, error: '下载到的文件里找不到 package.json，无法确认版本。' })
          }

          // Avoid pointless reinstalls when the source still serves the same version.
          let currentVersion = null
          try {
            const bundles = await ctx.pluginManager.listBundles()
            const found = bundles.find((b) => b.name === name && b.installed)
            currentVersion = found && found.version ? found.version : null
          } catch { /* ignore */ }
          if (currentVersion && compareVersions(downloaded.version, currentVersion) <= 0) {
            // Not an error: the source simply has nothing newer. Return ok so the
            // client shows a neutral "already up to date" instead of a red failure.
            // Also backfill synced so a legacy source-backed install heals to "已最新".
            await recordSynced(name, currentVersion)
            return send(200, {
              ok: true,
              upToDate: true,
              version: currentVersion,
              fromVersion: currentVersion,
              downloaded,
              message: '来源提供 ' + downloaded.version + '，不高于已安装的 ' + currentVersion + '，无需更新。',
            })
          }

          const requestId = typeof body.requestId === 'string' && body.requestId
            ? body.requestId
            : 'offline-market-upgrade-' + Date.now()
          const payload = installPayload(await ctx.pluginManager.installBundle(
            fileSpec(downloaded.path), { enabled: true, requestId }
          ))
          const deleted = []
          if (payload.ok) {
            const state = readState(dir)
            const old = state.files[name]
            if (old && norm(old) !== norm(downloaded.path)) {
              try { unlinkSync(old); deleted.push(norm(old)) } catch { /* already gone */ }
            }
            // Delete older tgz files of the same package from the directory.
            try {
              for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (!entry.isFile() || !/\.tgz$/i.test(entry.name)) continue
                const file = join(dir, entry.name)
                if (norm(file) === norm(downloaded.path)) continue
                let meta
                try { meta = readTgzFile(file) } catch { continue }
                if (meta.name === name && compareVersions(meta.version, downloaded.version) < 0) {
                  try { unlinkSync(file); deleted.push(norm(file)) } catch { /* ignore */ }
                }
              }
            } catch { /* ignore */ }
            await recordFile(name, downloaded.path)
            await recordSynced(name, downloaded.version)
          }
          return send(200, { ...payload, downloaded, deleted, fromVersion: currentVersion })
        }

        // Uninstall an installed bundle. Clears its sidecar records but keeps the
        // local tgz so the package can be reinstalled from the list afterwards.
        if (route === '/remove' && method === 'POST') {
          const body = await readJson(request)
          const name = String(body.name || '').trim()
          if (!name) return send(400, { ok: false, error: '缺少插件名称。' })
          const payload = installPayload(await ctx.pluginManager.removeBundle(name))
          if (payload.ok) {
            updateState(currentDir(), (state) => {
              if (state.sources) delete state.sources[name]
              if (state.files) delete state.files[name]
              if (state.synced) delete state.synced[name]
            })
          }
          return send(200, { ...payload, name })
        }

        return send(404, { ok: false, error: 'unknown path ' + route })
      } catch (error) {
        return send(500, { ok: false, error: String((error && error.message) || error) })
      }
    },
  }))
}
