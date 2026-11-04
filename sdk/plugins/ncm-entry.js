/* global __hostCall */
import { activate, deactivate } from '../../resources/plugins/ncm-provider/index.mjs'
import { endpoints } from 'twilight:ncm-endpoints'
import QRCode from 'qrcode/lib/core/qrcode.js'
import { parseTimedLrc } from '../../src/shared/lyrics/lyricParser.ts'

let provider = null
const noop = () => {
  // The serial mobile ABI has no plugin logging channel.
}
const api = {
  officialLoginAvailable: false,
  request(path, cookie) {
    const q = path.indexOf('?'), route = q < 0 ? path : path.slice(0, q)
    const query = { cookie: cookie || '' }
    for (const pair of (q < 0 ? '' : path.slice(q + 1)).split('&')) {
      if (!pair) continue
      const i = pair.indexOf('=')
      query[decodeURIComponent(i < 0 ? pair : pair.slice(0, i))] = decodeURIComponent((i < 0 ? '' : pair.slice(i + 1)).replace(/\+/g, ' '))
    }
    // Android does not route copyrighted tracks through third-party unlock services.
    if (route === '/song/url/match' || query.unblock === 'true') throw new Error('Android 不支持第三方音源解锁')
    if (route === '/login/qr/create') {
      const qrurl = 'https://music.163.com/login?codekey=' + encodeURIComponent(query.key)
      const code = QRCode.create(qrurl, { errorCorrectionLevel: 'M' }).modules
      return Promise.resolve({ code: 200, data: { qrurl, qrimg: __hostCall('qrImage', { size: code.size, data: Array.from(code.data) }) } })
    }
    const endpoint = endpoints[route]
    if (!endpoint) throw new Error('Android 尚不支持此网易云接口：' + route)
    return Promise.resolve(endpoint(query, (uri, data, options) => Promise.resolve(__hostCall('ncm', { uri, data, options })))).then(res => res.body)
  },
  getCachedSong: () => Promise.resolve(null),
  cacheSong: () => Promise.resolve(null),
  officialLogin: () => { throw new Error('请在 Android 使用二维码或账号登录') }
}
const context = {
  twilight: { internal: { ncm: api }, providers: { register: p => { provider = p; return Promise.resolve() } } },
  settings: {
    get: key => Promise.resolve(__hostCall('settings.get', { key })),
    set: (key, value) => Promise.resolve(__hostCall('settings.set', { key, value })),
    delete: key => Promise.resolve(__hostCall('settings.delete', { key }))
  },
  logger: { info: noop, warn: noop, error: noop, debug: noop }
}
globalThis.__TWILIGHT_PLUGIN__ = {
  activate() { return activate(context).then(() => ({ id: provider.id, name: provider.name, capabilities: provider.capabilities,
    methods: Object.keys(provider).filter(k => typeof provider[k] === 'function' && !['openOfficialLogin', 'prepareCloudUpload', 'completeCloudUpload', 'reportListening'].includes(k)) })) },
  call(input) {
    if (!provider || typeof provider[input.method] !== 'function' || input.method === 'openOfficialLogin') throw new Error('Provider 方法不可用')
    if (input.method === 'getPlaybackUrl') return context.settings.get('cookie').then(cookie => {
      if (!cookie) throw new Error('请先登录网易云音乐后播放')
      return Promise.resolve(provider.getPlaybackUrl(...(input.args || []))).then(value => {
        if (!value) throw new Error('网易云未提供可播放的官方音源，请检查账号权益、歌曲版权或网络状态')
        return value
      })
    })
    const result = provider[input.method](...(input.args || []))
    if (input.method !== 'getLyrics') return result
    return Promise.resolve(result).then(value => ({ ...value, mobileLrc: parseTimedLrc(value.lyrics).map(line => {
      const minutes = Math.floor(line.time / 60), seconds = (line.time % 60).toFixed(3).padStart(6, '0')
      return '[' + String(minutes).padStart(2, '0') + ':' + seconds + ']' + line.text
    }).join('\n') }))
  },
  deactivate() { deactivate(); provider = null }
}
