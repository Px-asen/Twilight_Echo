const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const test = require('node:test')

test('installed NCBL endpoint sends both encrypted uploads through the authenticated gateway', async (t) => {
  const ncmRequire = createRequire(require.resolve('@neteasecloudmusicapienhanced/api/server.js'))
  const axiosPath = ncmRequire.resolve('axios')
  const originalAxios = ncmRequire('axios')
  const uploads = []
  let failDuration = false
  // Keep the installed module, encryption and HTTP gateway; replace only upstream transport.
  require.cache[axiosPath].exports = async (settings) => {
    uploads.push(settings)
    const fileName = settings.data.toString('latin1').match(/filename="([^"]+)"/)[1]
    return {
      data: {
        code: 200,
        data: { successfiles: failDuration && uploads.length % 2 === 0 ? [] : [fileName] }
      }
    }
  }
  t.after(() => {
    require.cache[axiosPath].exports = originalAxios
  })
  const module = ncmRequire('./module/scrobble_v1.js')
  const { serveNcmApi } = ncmRequire('./server.js')
  const logger = ncmRequire('./util/logger.js')
  t.mock.method(logger, 'info', () => {})
  const api = await serveNcmApi({
    host: '127.0.0.1',
    port: '0',
    checkVersion: false,
    moduleDefs: [{ route: '/scrobble/v1', module }]
  })
  if (!api.server.listening) await new Promise((resolve) => api.server.once('listening', resolve))
  t.after(async () => {
    const cache = ncmRequire('./util/apicache')
    for (const key of [...cache.getIndex().all]) cache.clear(key)
    api.server.closeAllConnections()
    await new Promise((resolve) => api.server.close(resolve))
  })
  const origin = `http://127.0.0.1:${api.server.address().port}`
  const call = async (key) =>
    (
      await fetch(`${origin}/scrobble/v1?id=123&time=37&total=180&reportId=${key}`, {
        headers: { Cookie: 'MUSIC_U=fixture-token; __csrf=fixture-csrf' },
        signal: AbortSignal.timeout(5000)
      })
    ).json()
  const first = await call('one')
  assert.equal(first.code, 200)
  assert.ok(first.details.plv.fileName)
  assert.ok(first.details.pld.fileName)
  assert.equal(uploads.length, 2)
  for (const upload of uploads) {
    assert.equal(upload.method, 'POST')
    assert.equal(
      upload.url,
      'https://clientlog3.music.163.com/api/clientlog/encrypt/upload?multiupload=true'
    )
    assert.match(upload.headers.Cookie, /MUSIC_U=fixture-token/)
    assert.match(upload.headers['Content-Type'], /^multipart\/form-data/)
    assert.ok(upload.data.length > 200)
    assert.equal(
      upload.data.includes(Buffer.from('fixture-token')),
      false,
      'credentials inside the log are encrypted'
    )
  }
  await call('two')
  assert.equal(uploads.length, 4, 'distinct occurrences bypass the gateway response cache')
  failDuration = true
  const partial = await call('three')
  assert.equal(partial.code, 200)
  assert.match(partial.msg, /PLV 成功但 PLD 失败/)
  assert.equal(partial.data, undefined)
})
