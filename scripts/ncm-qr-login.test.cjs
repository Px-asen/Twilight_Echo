const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')
const vm = require('node:vm')
const test = require('node:test')

test('NCM QR login uses a consistent native PC identity through the installed gateway', async (t) => {
  const readFileSync = fs.readFileSync
  t.mock.method(fs, 'readFileSync', (file, ...args) =>
    path.basename(String(file)) === 'anonymous_token' ? '' : readFileSync(file, ...args)
  )
  const ncmRequire = createRequire(require.resolve('@neteasecloudmusicapienhanced/api/server.js'))
  const { eapiReqDecrypt } = ncmRequire('./util/crypto.js')
  const calls = []
  let polls = 0
  t.mock.method(ncmRequire('axios'), 'default', async (settings) => {
    const decoded = eapiReqDecrypt(new URLSearchParams(settings.data).get('params'))
    calls.push({ settings, decoded })
    const isKey = decoded.url === '/api/login/qrcode/unikey'
    if (!isKey) assert.equal(decoded.url, '/api/login/qrcode/client/login')
    return {
      status: 200,
      headers: !isKey && polls === 2 ? { 'set-cookie': ['MUSIC_U=qr-test; Path=/;'] } : {},
      data: isKey ? { code: 200, unikey: 'integration-key' } : { code: [801, 802, 803][polls++] }
    }
  })
  t.mock.method(ncmRequire('./util/logger.js'), 'info', () => {})
  const { serveNcmApi } = ncmRequire('./server.js')
  const app = await serveNcmApi({ host: '127.0.0.1', port: '0', checkVersion: false,
    moduleDefs: ['key', 'create', 'check'].map(name => ({
      route: `/login/qr/${name}`, module: ncmRequire(`./module/login_qr_${name}.js`)
    }))
  })
  const providerModule = await import('../resources/plugins/ncm-provider/index.mjs')
  t.after(async () => {
    providerModule.deactivate()
    const cache = ncmRequire('./util/apicache')
    for (const key of [...cache.getIndex().all]) cache.clear(key)
    app.server.closeAllConnections()
    await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()))
  })
  if (!app.server.listening) await new Promise(resolve => app.server.once('listening', resolve))
  let provider
  let sequence = 0
  const settings = new Map()
  let qrUrl
  await providerModule.activate({
    twilight: {
      providers: { register: value => { provider = value } },
      internal: { ncm: { request: async (route, cookie) => {
        const separator = route.includes('?') ? '&' : '?'
        const response = await fetch(`http://127.0.0.1:${app.server.address().port}${route}${separator}timestamp=${++sequence}`, {
          headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(5000)
        })
        const result = await response.json()
        if (result.data?.qrurl) qrUrl = result.data.qrurl
        return result
      } } }
    },
    settings: { get: key => settings.get(key), set: (key, value) => settings.set(key, value), delete: key => settings.delete(key) },
    logger: { info() {}, warn() {}, debug() {}, error() {} }
  })
  const qr = await provider.getQrLogin()
  assert.equal(qrUrl, 'https://music.163.com/login?codekey=integration-key')
  assert.match(qr.imageDataUrl, /^data:image\/png;base64,/)
  for (const expected of [801, 802, 803]) assert.equal((await provider.checkQrLogin(qr.key)).code, expected)
  assert.match(settings.get('cookie'), /MUSIC_U=qr-test/)
  assert.equal(calls.length, 4)
  for (const { settings: request, decoded } of calls) {
    assert.match(request.headers['User-Agent'], /NeteaseMusicDesktop\//)
    assert.equal(decoded.data.header.os, 'pc')
    assert.equal(decoded.data.header.MUSIC_U, undefined)
    assert.equal(decoded.data.type, 3)
  }
  assert.equal(new Set(calls.map(({ settings }) => settings.headers['User-Agent'])).size, 1)
  assert.equal(new Set(calls.map(({ decoded }) => decoded.data.header.deviceId)).size, 1)
})

test('Android NCM bundle forwards QR client options and saves the confirmed session', () => {
  const root = path.resolve(__dirname, '..')
  const build = spawnSync(process.execPath, ['scripts/build-android-plugins.mjs'], { cwd: root, encoding: 'utf8' })
  assert.equal(build.status, 0, build.stderr)
  const settings = new Map()
  const calls = []
  let polls = 0
  let qrSize = 0
  const context = vm.createContext({ __PLUGIN_HOST__: { call(method, json) {
    const args = JSON.parse(json)
    let value = null
    if (method === 'settings.get') value = settings.get(args.key) ?? null
    else if (method === 'settings.set') settings.set(args.key, args.value)
    else if (method === 'settings.delete') settings.delete(args.key)
    else if (method === 'qrImage') {
      qrSize = args.size
      value = 'data:image/png;base64,test'
    } else if (method === 'ncm') {
      calls.push(args)
      const isKey = args.uri === '/api/login/qrcode/unikey'
      if (!isKey) assert.equal(args.uri, '/api/login/qrcode/client/login')
      value = {
        status: 200,
        body: isKey ? { code: 200, unikey: 'mobile-key' } : { code: [801, 802, 803][polls++] },
        cookie: polls === 3 ? ['MUSIC_U=mobile-test'] : []
      }
    } else assert.equal(method, 'sleep')
    return JSON.stringify({ ok: true, value })
  } } })
  vm.runInContext(fs.readFileSync(path.join(root, 'dist/android-plugins/ncm/android.js'), 'utf8'), context)
  const unwrap = promise => {
    if (promise.state === 2) throw promise.value
    assert.equal(promise.state, 1, 'serial mobile call must complete')
    return promise.value
  }
  const plugin = context.__TWILIGHT_PLUGIN__
  unwrap(plugin.activate())
  try {
    const qr = unwrap(plugin.call({ method: 'getQrLogin' }))
    assert.ok(qrSize >= 21)
    assert.match(qr.imageDataUrl, /^data:image\/png;base64,/)
    for (const expected of [801, 802, 803]) {
      assert.equal(unwrap(plugin.call({ method: 'checkQrLogin', args: [qr.key] })).code, expected)
    }
    assert.equal(settings.get('cookie'), 'MUSIC_U=mobile-test')
    assert.equal(calls.length, 4)
    for (const { options } of calls) {
      assert.equal(options.crypto, 'eapi')
      assert.match(options.ua, /NeteaseMusicDesktop\//)
    }
    assert.equal(new Set(calls.map(({ options }) => options.ua)).size, 1)
  } finally {
    plugin.deactivate()
  }
})
