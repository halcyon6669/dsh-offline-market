/* Headless tests for dsh-offline-market (merged plugin).
 * - Host half: load real index.js with stubbed node:fs/zlib/cordis services.
 * - Client half: load real client.js in a vm with a tiny React hook shim.
 * No DSH instance required.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const zlib = require('zlib');

const DIR = fs.existsSync(path.join(__dirname, 'index.js'))
  ? __dirname
  : path.join(__dirname, 'dsh-offline-market');
const hostSrc = fs.readFileSync(path.join(DIR, 'index.js'), 'utf8');
const clientSrc = fs.readFileSync(path.join(DIR, 'client.js'), 'utf8');

let passed = 0, failed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ok  - ' + name); }
  catch (e) { failed++; console.log('  FAIL- ' + name + ': ' + (e && e.stack || e)); }
}

// ---------------------------------------------------------------------------
// Build a fake .tgz: a gzip of a tar containing package/package.json.
// ---------------------------------------------------------------------------
function tarHeader(name, size) {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'utf8');
  h.write('0000000\0', 108, 8, 'utf8');
  h.write('0000000\0', 116, 8, 'utf8');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  h.write('00000000000\0', 136, 12, 'utf8');
  h[156] = '0'.charCodeAt(0);
  h.write('ustar\0', 257, 6, 'utf8');
  h.write('00', 263, 2, 'utf8');
  return h;
}
function makeTgz(pkg) {
  const json = Buffer.from(JSON.stringify(pkg), 'utf8');
  const pad = Buffer.alloc((512 - (json.length % 512)) % 512, 0);
  const tar = Buffer.concat([tarHeader('package/package.json', json.length), json, pad, Buffer.alloc(1024, 0)]);
  return zlib.gzipSync(tar);
}

// ---------------------------------------------------------------------------
// HOST tests
// ---------------------------------------------------------------------------
console.log('\nHost half:');
ok('index.js has no forbidden bare imports', () => {
  assert.ok(!/from ['"]zod['"]/.test(hostSrc), 'must not import zod');
  assert.ok(!/from ['"]semver['"]/.test(hostSrc), 'must not import semver');
});
ok('index.js reads error.diagnostic (fixes bare operation-error)', () => {
  assert.ok(/err\.diagnostic \|\| err\.message \|\| err\.code/.test(hostSrc));
});
ok('index.js uses sidecar state instead of configEditor writes for source', () => {
  assert.ok(/STATE_FILE = '\.dsh-offline-market\.json'/.test(hostSrc));
  assert.ok(/route === '\/upgrade'/.test(hostSrc));
});

const norm = (f) => String(f).replace(/\\/g, '/');
const virtualFiles = {
  '/dir/demo-1.0.0.tgz': makeTgz({ name: 'demo-plugin', version: '1.0.0' }),
  '/dir/demo-1.1.0.tgz': makeTgz({ name: 'demo-plugin', version: '1.1.0' }),
  '/dir/demo-0.9.0.tgz': makeTgz({ name: 'demo-plugin', version: '0.9.0' }),
  '/dir/other-2.0.0.tgz': makeTgz({ name: 'other-plugin', version: '2.0.0' }),
  '/dir/broken.tgz': Buffer.from('not a tgz'),
};
const fsStub = {
  readFileSync: (f) => {
    const key = norm(f);
    if (virtualFiles[key] === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return virtualFiles[key];
  },
  readdirSync: (d) => {
    const dir = norm(d);
    return Object.keys(virtualFiles).filter(f => f.startsWith(dir + '/')).map(f => ({
      name: path.basename(f), isFile: () => true,
    }));
  },
  mkdirSync: () => {},
  writeFileSync: (f, buf) => { virtualFiles[norm(f)] = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)); },
  unlinkSync: (f) => {
    const key = norm(f);
    if (virtualFiles[key] === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    delete virtualFiles[key];
  },
};
let remoteBuffer = makeTgz({ name: 'remote-plugin', version: '3.2.1' });
const fetchStub = async (url) => {
  if (String(url).includes('missing.tgz')) return { ok: false, status: 404 };
  return {
    ok: true, status: 200,
    arrayBuffer: async () => remoteBuffer.buffer.slice(remoteBuffer.byteOffset, remoteBuffer.byteOffset + remoteBuffer.byteLength),
  };
};

(async () => {
  try {
    const code = hostSrc
      .replace(/^import .*$/gm, '')
      .replace(/export const inject/g, 'const inject')
      .replace(/export function apply/g, 'function apply');
    const factory = new Function(
      'readdirSync', 'readFileSync', 'basename', 'join', 'gunzipSync',
      'mkdirSync', 'writeFileSync', 'unlinkSync', 'fetch', 'URL', 'Buffer',
      code + '\nreturn { apply, inject };'
    );
    const hostMod = factory(
      fsStub.readdirSync, fsStub.readFileSync, path.basename, path.join, zlib.gunzipSync,
      fsStub.mkdirSync, fsStub.writeFileSync, fsStub.unlinkSync, fetchStub, URL, Buffer
    );

    const routes = {};
    const bundlesData = [
      { name: 'demo-plugin', version: '1.0.0', installed: true },
      { name: 'fresh-plugin', version: '0.1.0', installed: true },
    ];
    const ctx = {
      pluginManager: {
        listBundles: async () => bundlesData,
        installBundle: async (spec, opts) => {
          ctx.lastInstall = { spec, opts };
          return { application: 'applied', changed: true, version: '1.1.0' };
        },
      },
      configEditor: { edit: async () => { ctx.editorCalled = true; } },
      fiber: { entry: {} },
      get: (name) => ctx[name],
      effect: (fn) => fn(),
      webServer: { register: ({ path, handler }) => { routes[path] = handler; return () => {}; } },
    };
    const config = { tgzDir: '/dir' };
    hostMod.apply(ctx, config);
    const handler = routes['/plugins/offline-market/api'];
    ok('registers webServer prefix route', () => assert.ok(handler, 'route registered'));

    function req(method, url, body) {
      const request = {
        method, url,
        async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
      };
      let status, payload;
      const response = {
        writeHead: (s) => { status = s; },
        end: (text) => { payload = JSON.parse(text); },
      };
      return handler(request, response).then(() => ({ status, payload }));
    }

    // --- GET /bundles: unified list ---
    const bundles = await req('GET', '/plugins/offline-market/api/bundles');
    ok('GET /bundles returns ok', () => assert.strictEqual(bundles.payload.ok, true));
    ok('marks installed-with-newer as update', () => {
      const row = bundles.payload.rows.find(r => r.name === 'demo-plugin');
      assert.ok(row, 'demo-plugin present');
      assert.strictEqual(row.status, 'update');
      assert.strictEqual(row.installed, '1.0.0');
      assert.strictEqual(row.available, '1.1.0');
    });
    ok('marks brand-new tgz as install', () => {
      const row = bundles.payload.rows.find(r => r.name === 'other-plugin');
      assert.ok(row, 'other-plugin present');
      assert.strictEqual(row.status, 'install');
    });
    ok('does not list installed plugin with no tgz and no source', () => {
      assert.ok(!bundles.payload.rows.some(r => r.name === 'fresh-plugin'));
    });
    ok('skips broken tgz and scans 5', () => {
      assert.strictEqual(bundles.payload.skipped, 1);
      assert.strictEqual(bundles.payload.scanned, 5);
    });
    ok('sorts update before install', () => {
      const statuses = bundles.payload.rows.map(r => r.status);
      assert.strictEqual(statuses.indexOf('update') < statuses.indexOf('install'), true, statuses.join(','));
    });
    ok('file: spec absolute with forward slashes', () => {
      const spec = bundles.payload.rows[0].spec;
      assert.ok(spec.startsWith('file:/dir/'), 'spec=' + spec);
      assert.ok(!spec.includes('\\'));
    });

    // --- GET /updates alias: only updates ---
    const updates = await req('GET', '/plugins/offline-market/api/updates');
    ok('GET /updates alias returns only update rows', () => {
      assert.strictEqual(updates.payload.count, 1);
      assert.strictEqual(updates.payload.rows[0].name, 'demo-plugin');
      assert.ok(!updates.payload.rows.some(r => r.name === 'other-plugin'));
    });

    // --- config ---
    const cfg = await req('GET', '/plugins/offline-market/api/config');
    ok('GET /config returns configured dir', () => assert.strictEqual(cfg.payload.tgzDir, '/dir'));
    const setCfg = await req('POST', '/plugins/offline-market/api/config', { tgzDir: '/newdir' });
    ok('POST /config persists via configEditor', () => {
      assert.strictEqual(setCfg.payload.ok, true);
      assert.ok(ctx.editorCalled);
    });

    // --- POST /install (local tgz) ---
    const installed = await req('POST', '/plugins/offline-market/api/install', { file: '/dir/demo-1.1.0.tgz' });
    ok('POST /install calls installBundle with file: spec + enabled', () => {
      assert.strictEqual(installed.payload.ok, true);
      assert.strictEqual(ctx.lastInstall.spec, 'file:/dir/demo-1.1.0.tgz');
      assert.strictEqual(ctx.lastInstall.opts.enabled, true);
    });
    const badInstall = await req('POST', '/plugins/offline-market/api/install', { file: '' });
    ok('POST /install rejects empty file', () => assert.strictEqual(badInstall.status, 400));

    // --- POST /install-url: npm spec passthrough (no download) ---
    const passthrough = await req('POST', '/plugins/offline-market/api/install-url', { url: 'some-npm-package@1.2.3' });
    ok('install-url passes npm spec through unchanged', () => {
      assert.strictEqual(passthrough.payload.ok, true);
      assert.strictEqual(ctx.lastInstall.spec, 'some-npm-package@1.2.3');
      assert.strictEqual(passthrough.payload.downloaded, null);
    });

    // --- POST /install-url: remote tgz with no dir → 400 ---
    let noDir;
    const routes2 = {};
    const ctx2 = { ...ctx, webServer: { register: ({ path, handler }) => { routes2[path] = handler; } } };
    hostMod.apply(ctx2, { tgzDir: '' });
    const handler2 = routes2['/plugins/offline-market/api'];
    const r2 = await handler2(
      { method: 'POST', url: '/plugins/offline-market/api/install-url', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ url: 'http://x/remote.tgz' })); } },
      { writeHead(s) { noDir = { status: s }; }, end(t) { noDir.payload = JSON.parse(t); } }
    );
    ok('remote tgz without configured dir → 400 with hint', () => {
      assert.strictEqual(noDir.status, 400);
      assert.ok(/目录/.test(noDir.payload.error));
    });

    // unconfigured scan → configured:false
    let unconf;
    await handler2(
      { method: 'GET', url: '/plugins/offline-market/api/bundles', async *[Symbol.asyncIterator](){} },
      { writeHead(){}, end(t){ unconf = JSON.parse(t); } }
    );
    ok('unconfigured dir returns configured:false with 0 rows', () => {
      assert.strictEqual(unconf.configured, false);
      assert.strictEqual(unconf.count, 0);
    });

    // --- POST /install-url: remote tgz with dir → download, local install, remember source ---
    const viaUrl = await req('POST', '/plugins/offline-market/api/install-url', {
      url: 'http://example.test/remote-plugin-3.2.1.tgz', requestId: 'test-1',
    });
    ok('remote tgz downloaded to versioned filename', () => {
      assert.ok(virtualFiles['/dir/remote-plugin-3.2.1.tgz'], 'file written');
      assert.strictEqual(viaUrl.payload.downloaded.filename, 'remote-plugin-3.2.1.tgz');
      assert.strictEqual(viaUrl.payload.downloaded.name, 'remote-plugin');
      assert.strictEqual(viaUrl.payload.downloaded.version, '3.2.1');
    });
    ok('remote tgz installed via local file: spec', () => {
      assert.strictEqual(ctx.lastInstall.spec, 'file:/dir/remote-plugin-3.2.1.tgz');
      assert.strictEqual(ctx.lastInstall.opts.requestId, 'test-1');
    });
    ok('install-url remembers source URL in sidecar', () => {
      const state = JSON.parse(virtualFiles['/dir/.dsh-offline-market.json'].toString('utf8'));
      assert.strictEqual(state.sources['remote-plugin'], 'http://example.test/remote-plugin-3.2.1.tgz');
      assert.strictEqual(state.files['remote-plugin'], '/dir/remote-plugin-3.2.1.tgz');
    });
    const cfgWithSources = await req('GET', '/plugins/offline-market/api/config');
    ok('GET /config exposes remembered sources', () => {
      assert.strictEqual(cfgWithSources.payload.sources['remote-plugin'], 'http://example.test/remote-plugin-3.2.1.tgz');
    });

    // --- /upgrade: no source recorded → 400 ---
    const noSource = await req('POST', '/plugins/offline-market/api/upgrade', { name: 'demo-plugin' });
    ok('upgrade without recorded source → 400', () => {
      assert.strictEqual(noSource.status, 400);
      assert.ok(/来源/.test(noSource.payload.error));
    });

    // --- /upgrade: source now serves a newer version → download, install, delete old ---
    remoteBuffer = makeTgz({ name: 'remote-plugin', version: '3.3.0' });
    const upgraded = await req('POST', '/plugins/offline-market/api/upgrade', {
      name: 'remote-plugin', requestId: 'upg-1',
    });
    ok('upgrade downloads newest from source and installs via file:', () => {
      assert.strictEqual(upgraded.payload.ok, true);
      assert.strictEqual(upgraded.payload.downloaded.version, '3.3.0');
      assert.strictEqual(ctx.lastInstall.spec, 'file:/dir/remote-plugin-3.3.0.tgz');
      assert.strictEqual(ctx.lastInstall.opts.requestId, 'upg-1');
    });
    ok('upgrade deletes superseded tgz', () => {
      assert.ok(virtualFiles['/dir/remote-plugin-3.3.0.tgz'], 'new file kept');
      assert.ok(!virtualFiles['/dir/remote-plugin-3.2.1.tgz'], 'old file removed');
      assert.ok(upgraded.payload.deleted.includes('/dir/remote-plugin-3.2.1.tgz'));
    });
    ok('upgrade updates sidecar file pointer', () => {
      const state = JSON.parse(virtualFiles['/dir/.dsh-offline-market.json'].toString('utf8'));
      assert.strictEqual(state.files['remote-plugin'], '/dir/remote-plugin-3.3.0.tgz');
    });

    // reflect the successful upgrade in the mocked installed list
    bundlesData.push({ name: 'remote-plugin', version: '3.3.0', installed: true });
    // --- /upgrade: source returns same version → no pointless reinstall ---
    const sameVersion = await req('POST', '/plugins/offline-market/api/upgrade', { name: 'remote-plugin' });
    ok('upgrade with same version returns upToDate (no reinstall, no red error)', () => {
      assert.strictEqual(sameVersion.payload.ok, true);
      assert.strictEqual(sameVersion.payload.upToDate, true);
      assert.ok(/无需更新/.test(sameVersion.payload.message));
    });

    // --- /upgrade: source returns older version → refused ---
    const installedEntry = bundlesData.find(b => b.name === 'remote-plugin');
    installedEntry.version = '9.9.9';
    remoteBuffer = makeTgz({ name: 'remote-plugin', version: '3.3.0' });
    const olderVersion = await req('POST', '/plugins/offline-market/api/upgrade', { name: 'remote-plugin' });
    ok('upgrade with older-than-installed version returns upToDate, no reinstall', () => {
      assert.strictEqual(olderVersion.payload.ok, true);
      assert.strictEqual(olderVersion.payload.upToDate, true);
      assert.ok(/不高于/.test(olderVersion.payload.message));
    });

    // --- install error exposes diagnostic ---
    ctx.pluginManager.installBundle = async () => ({
      application: 'failed', changed: false,
      error: { code: 'operation-error', diagnostic: 'ERR_PNPM_FETCH_404 package not found' },
    });
    const failedInstall = await req('POST', '/plugins/offline-market/api/install', { file: '/dir/demo-1.1.0.tgz' });
    ok('failed install surfaces error.diagnostic, not bare code', () => {
      assert.strictEqual(failedInstall.payload.ok, false);
      assert.ok(/ERR_PNPM_FETCH_404/.test(failedInstall.payload.error), failedInstall.payload.error);
      assert.ok(!/^operation-error$/.test(failedInstall.payload.error));
    });

    // -----------------------------------------------------------------------
    // CLIENT tests
    // -----------------------------------------------------------------------
    console.log('\nClient half:');
    ok('client.js loads as a module', () => {
      assert.ok(/window\.__ModuleLoader__\.load/.test(clientSrc));
      assert.ok(/id: 'dsh-offline-market'/.test(clientSrc));
    });
    ok('injects only slots', () => assert.ok(/inject: \['slots'\]/.test(clientSrc)));
    ok('registers plugins.tab with own id and order', () => {
      assert.ok(/plugins\.tab/.test(clientSrc));
      assert.ok(/id: 'offline-market'/.test(clientSrc));
      assert.ok(/order: 20/.test(clientSrc));
    });
    ok('uses unified endpoints', () => {
      assert.ok(/\/bundles/.test(clientSrc));
      assert.ok(/\/install-url/.test(clientSrc));
      assert.ok(/\/install'/.test(clientSrc));
      assert.ok(/\/upgrade/.test(clientSrc));
      assert.ok(!/\/update'/.test(clientSrc), 'no old /update endpoint');
    });
    ok('has URL install input, upgrade handler and status tags', () => {
      assert.ok(/从 URL \/ 包名安装/.test(clientSrc));
      assert.ok(/runUpgrade/.test(clientSrc));
      assert.ok(/om-tag-source/.test(clientSrc));
      assert.ok(/om-tag-update/.test(clientSrc));
      assert.ok(/om-tag-install/.test(clientSrc));
    });
    ok('styles use --dsw-alias-* tokens and data-plugin=module id', () => {
      assert.ok(/--dsw-alias-/.test(clientSrc));
      assert.ok(/tag\.dataset\.plugin = TAG_ID/.test(clientSrc));
      assert.ok(/style\[data-plugin-css="/.test(clientSrc));
    });
    ok('does not hard-inject remote or remote.pluginManager', () => {
      assert.ok(!/inject: \[[^\]]*remote/.test(clientSrc));
    });
    ok('no document.body.appendChild / iframe', () => {
      assert.ok(!/body\.appendChild/.test(clientSrc));
      assert.ok(!/createElement\(['"]iframe/.test(clientSrc));
    });
    ok('no 检查更新 button; current rows render no action button', () => {
      assert.ok(!/检查更新/.test(clientSrc), 'must not contain a 检查更新 button label');
      assert.ok(/row\.status === 'current' \? null/.test(clientSrc), 'current rows must have no button');
    });
    ok('per-row 卸载 button using /remove endpoint', () => {
      assert.ok(/route === '\/remove'/.test(hostSrc), 'host has /remove endpoint');
      assert.ok(/removeBundle\(name\)/.test(hostSrc), 'host calls removeBundle');
      assert.ok(/runRemove/.test(clientSrc), 'client has runRemove handler');
      assert.ok(/'\/remove'/.test(clientSrc), 'client posts to /remove');
      assert.ok(/'卸载'/.test(clientSrc), 'uninstall button label present');
    });
    ok('client.js syntax valid', () => { new Function(clientSrc.replace(/^window\.__ModuleLoader__\.load\(/, 'return (').replace(/\}\);\s*$/, '};')); });

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('\nFATAL: ' + (e && e.stack || e));
    process.exitCode = 1;
  }
})();
