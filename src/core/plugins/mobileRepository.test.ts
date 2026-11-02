import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { mobileRepositoryRequest, mobilePluginManifest } from './mobileRepository.ts'

const manifest = JSON.parse(readFileSync(new URL('../../../resources/plugins/ncm-provider/plugin.json', import.meta.url), 'utf8'))
const entry = { ...manifest, sourceUrl: 'asset:ncm.tep', checksumSha256: 'a'.repeat(64) }
test('mobile repository retains desktop manifest and reports compatibility per entry', () => {
  const desktopOnly = { ...entry, id: 'com.example.desktop', androidRuntime: undefined }
  const entries = mobileRepositoryRequest({ operation: 'catalog', index: { schemaVersion: 1, plugins: [entry, desktopOnly] }, installed: [{ id: entry.id, version: '0.9.0', enabled: true }] }) as any[]
  assert.equal(entries[0].unsupportedReason, null)
  assert.equal(entries[0].updateAvailable, true)
  assert.equal(entries[0].enabled, true)
  assert.match(entries[1].unsupportedReason, /Android/)
  assert.equal(mobilePluginManifest(manifest).main, 'index.mjs')
})
test('mobile repository rejects unsafe entry paths, broader permissions, duplicate IDs and substituted packages', () => {
  for (const path of ['../index.js', '/index.js', 'a/../index.js', 'a\\index.js'])
    assert.throws(() => mobilePluginManifest({ ...manifest, androidRuntime: { ...manifest.androidRuntime, entry: path } }))
  assert.throws(() => mobilePluginManifest({ ...manifest, androidRuntime: { ...manifest.androidRuntime, permissions: ['filesystem:read'] } }))
  assert.throws(() => mobileRepositoryRequest({ operation: 'catalog', index: { schemaVersion: 1, plugins: [entry, entry] } }), /重复/)
  assert.throws(() => mobileRepositoryRequest({ operation: 'verifyIdentity', manifest: { ...manifest, id: 'com.evil.substitute' }, expected: entry }), /身份/)
  assert.throws(() => mobileRepositoryRequest({ operation: 'verifyIdentity', manifest: { ...manifest, androidRuntime: { ...manifest.androidRuntime, networkHosts: ['evil.example'] } }, expected: entry }), /权限/)
})
test('the packaged serial Android runtime executes the original NCM search, QR and YRC logic without Node', () => {
  const settings = new Map()
  const requests: any[] = []
  let now = Date.now()
  const sandbox = vm.createContext({ Date: class extends Date { static now() { return now } }, __PLUGIN_HOST__: { call(method: string, json: string) {
    const args = JSON.parse(json); let value: any = null
    if (method === 'settings.get') value = args.key ? settings.get(args.key) ?? null : Object.fromEntries(settings)
    else if (method === 'settings.set') settings.set(args.key, args.value)
    else if (method === 'settings.delete') settings.delete(args.key)
    else if (method === 'ncm') {
      requests.push(args)
      const body = args.uri.includes('cloudsearch') ? { code: 200, result: { songs: [{ id: 42, name: 'Shared NCM', ar: [{ name: 'Artist' }], al: { name: 'Album' }, dt: 5000 }], songCount: 1 } }
        : args.uri.includes('unikey') ? { code: 200, unikey: 'fixture-key' }
        : args.uri.endsWith('/playlist/detail') ? { code: 200, playlist: { name: 'Mixed rights', trackCount: 4, trackIds: [{ id: 42 }, { id: 43 }, { id: 42 }] } }
        : args.uri.endsWith('/song/detail') ? { code: 200, songs: [null, { id: 43, name: 'Restricted', ar: [null], noCopyrightRcmd: {} },
            { id: 42, name: 'Shared NCM', dt: 5000 }] }
        : { code: 200, yrc: { lyric: '[1000,2000](1000,500,0)Shared(1500,500,0) lyrics' } }
      value = { status: 200, body, cookie: [] }
    } else if (method === 'qrImage') { assert.equal(args.data.length, args.size ** 2); value = 'data:image/png;base64,fixture' }
    else if (method === 'sleep') now += args.ms
    else throw new Error('Unexpected host method ' + method)
    return JSON.stringify({ ok: true, value })
  } } })
  vm.runInContext(readFileSync(new URL('../../../dist/android-plugins/ncm/android.js', import.meta.url), 'utf8'), sandbox)
  function invoke(method: string, args: unknown[] = []) {
    sandbox.input = { method, args }; sandbox.output = undefined; sandbox.failure = undefined
    vm.runInContext(`Promise.resolve(__TWILIGHT_PLUGIN__.${method === 'activate' ? 'activate()' : 'call(input)'}).then(v => output = v,e => failure = e)`, sandbox)
    if (sandbox.failure) throw sandbox.failure
    assert.notEqual(sandbox.output, undefined, 'ABI v1 must settle synchronously')
    return sandbox.output as any
  }
  assert.equal(invoke('activate').id, 'ncm')
  assert.equal(invoke('searchSongs', ['fixture']).items[0].title, 'Shared NCM')
  assert.equal(requests[0].uri, '/api/cloudsearch/pc')
  const qr = invoke('getQrLogin'); assert.equal(qr.key, 'fixture-key'); assert.match(qr.imageDataUrl, /^data:/)
  const lyric = invoke('getLyrics', [{ ncmSongId: 42 }]); assert.match(lyric.mobileLrc, /\[00:01\.000\]Shared lyrics/)
  const page = invoke('fetchPlaylistTracksPage', ['77'])
  assert.equal(page.total, 3)
  assert.equal(page.reportedTotal, 4)
  assert.deepEqual(Array.from(page.tracks, (track: any) => track.ncmSongId), [42, 43, 42])
  assert.equal(page.tracks[1].unavailableReason, '原平台版权受限')
  assert.throws(() => invoke('readPlaylistImportPage', ['77']), /不完整的条目/)
  assert.equal(invoke('checkLogin').loggedIn, false)
})
