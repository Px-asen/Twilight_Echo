import assert from 'node:assert/strict'
import test from 'node:test'

async function fixture() {
  const module = await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )
  let provider: any
  let accountId = 7
  const officialCookie = 'MUSIC_U=fixture-web-login;__csrf=fixture-web-csrf'
  let response: any = {
    code: 200,
    data: 'scrobble_v1 上报成功',
    details: { plv: { fileName: 'view.log' }, pld: { fileName: 'duration.log' } }
  }
  const settings = new Map<string, unknown>([['cookie', 'MUSIC_U=fixture']])
  const reports: Array<{ url: URL; cookie: string }> = []
  await module.activate({
    twilight: {
      providers: {
        register: async (p: any) => {
          provider = p
        }
      },
      internal: {
        ncm: {
          officialLogin: async () => officialCookie,
          request: async (path: string, cookie: string) => {
            const url = new URL(path, 'http://fixture')
            if (url.pathname === '/login/status')
              return { code: 200, profile: { userId: accountId } }
            if (url.pathname === '/user/detail')
              return { code: 200, profile: { userId: accountId } }
            if (url.pathname === '/scrobble/v1') {
              reports.push({ url, cookie })
              return response
            }
            throw new Error(`Unexpected ${url.pathname}`)
          }
        }
      }
    },
    settings: {
      get: async (key: string) => settings.get(key),
      set: async (key: string, value: unknown) => {
        settings.set(key, value)
      },
      delete: async (key: string) => {
        settings.delete(key)
      }
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  })
  return {
    provider,
    reports,
    settings,
    officialCookie,
    stop: () => module.deactivate(),
    response(value: any) {
      response = value
    },
    account(value: number) {
      accountId = value
    }
  }
}
const report = {
  id: 123,
  accountId: 7,
  time: 37,
  total: 180,
  name: 'Song & title',
  artist: 'Artist'
}

test('NCM listening uses authenticated v1 seconds and deduplicates a logical submission', async (t) => {
  const f = await fixture()
  t.after(f.stop)
  const context = { idempotencyKey: 'listening-1', signal: new AbortController().signal }
  await Promise.all([
    f.provider.reportListening(report, context),
    f.provider.reportListening(report, context)
  ])
  await f.provider.reportListening(report, context)
  assert.equal(f.reports.length, 1)
  assert.equal(f.reports[0].cookie, 'MUSIC_U=fixture')
  assert.equal(f.reports[0].url.searchParams.get('time'), '37')
  assert.equal(f.reports[0].url.searchParams.get('total'), '180')
  assert.equal(f.reports[0].url.searchParams.get('name'), 'Song & title')
  await f.provider.reportListening(report, { idempotencyKey: 'listening-2' })
  assert.notEqual(f.reports[0].url.href, f.reports[1].url.href)
})

test('partial success is rejected even when the gateway returns code 200', async (t) => {
  const f = await fixture()
  t.after(f.stop)
  f.response({
    code: 200,
    msg: 'PLV 成功但 PLD 失败',
    details: { plv: { code: 200 }, pld: { code: 500 } }
  })
  await assert.rejects(f.provider.reportListening(report, { idempotencyKey: 'partial' }), /PLD/)
  assert.equal(f.reports.length, 1)
})

test('official web login supplies the same authenticated listening upload path as QR login', async (t) => {
  const f = await fixture()
  t.after(f.stop)
  await f.provider.logout()
  assert.equal(f.settings.has('cookie'), false)
  const login = await f.provider.openOfficialLogin()
  assert.equal(login.loggedIn, true)
  assert.equal(login.profile.userId, report.accountId)
  assert.equal(f.settings.get('cookie'), f.officialCookie)
  await f.provider.reportListening(report, { idempotencyKey: 'web-login-listening-1' })
  assert.equal(f.reports.length, 1)
  assert.equal(f.reports[0].url.pathname, '/scrobble/v1')
  assert.equal(f.reports[0].cookie, f.officialCookie)
  assert.equal(f.reports[0].url.searchParams.get('time'), '37')
})

test('account mismatch, missing login and invalid elapsed time never reach the upload', async (t) => {
  const f = await fixture()
  t.after(f.stop)
  f.account(8)
  await assert.rejects(f.provider.reportListening(report), /账号已切换/)
  f.settings.delete('cookie')
  await assert.rejects(f.provider.reportListening(report), /登录/)
  await assert.rejects(f.provider.reportListening({ ...report, time: 200 }), /实际收听时长/)
  assert.equal(f.reports.length, 0)
})
