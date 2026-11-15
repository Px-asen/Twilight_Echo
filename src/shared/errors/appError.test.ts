import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AppError,
  appError,
  encodeAppError,
  ipcError,
  isAppError,
  parseAppError,
  stripAppErrorSentinel,
  unwrapRemoteInvokeMessage
} from './appError.ts'
import { presentError, presentErrorDetail } from './presentError.ts'

test('native decode failures explain the audio problem and retain the original diagnostics', () => {
  for (const phase of ['receive', 'send', 'flush']) {
    const message = `Audio decoder ${phase} failed, code: -1094995529`
    const presented = presentErrorDetail('zh-CN', message)
    assert.match(presented.display, /音频读取或解码失败/)
    assert.equal(presented.developerMessage, message)
    assert.match(presentError('en-US', message), /Audio could not be read or decoded/)
  }
})

test('output route failures survive IPC and render localized copy with their actual params', () => {
  const cases = [
    {
      code: 'audio.output_switch_failed',
      params: { detail: 'busy' },
      zh: '输出后端切换失败：busy',
      en: 'Could not switch the output backend: busy'
    },
    {
      code: 'audio.default_device_rebind_failed',
      params: { detail: 'busy' },
      zh: '跟随系统默认输出设备失败：busy',
      en: 'Could not follow the system default output device: busy'
    },
    {
      code: 'audio.output_target_not_ready',
      params: {},
      zh: '目标输出设备未能保持当前播放状态',
      en: 'The target output device could not preserve the current playback session'
    },
    {
      code: 'audio.output_target_unavailable',
      params: { device: 'USB DAC' },
      zh: '目标输出设备不可用：USB DAC',
      en: 'The target output device is unavailable: USB DAC'
    }
  ]
  for (const entry of cases) {
    const error = ipcError(entry.code, 'developer detail', entry.params)
    const received = new Error(
      `Error invoking remote method 'audioEngine:setOutput': Error: ${error.message}`
    )
    assert.equal(presentError('zh-CN', received, 'error.generic.unknown'), entry.zh)
    assert.equal(presentError('en-US', received, 'error.generic.unknown'), entry.en)
  }
})

test('a local AppError exposes its code and params directly', () => {
  const error = appError('audio.service_start_failed', 'audio service failed to start', {
    reason: 'EPERM'
  })
  assert.ok(error instanceof AppError)
  assert.ok(error instanceof Error)
  const parsed = parseAppError(error)
  assert.equal(parsed.code, 'audio.service_start_failed')
  assert.equal(parsed.params.reason, 'EPERM')
  // The bare message stays readable for logs: no sentinel noise in a stack trace.
  assert.equal(parsed.message, 'audio service failed to start')
})

test('survives the exact wrapper Electron builds for a rejected invoke', () => {
  const thrown = ipcError('audio.diagnostics_recorder_unavailable', 'diagnostics recorder missing')
  // This is verbatim what reaches the renderer: Electron stringifies the
  // rejection and prepends its own wrapper, dropping every custom property.
  const overTheWire = `Error invoking remote method 'audioEngine:exportDiagnostics': Error: ${thrown.message}`

  const parsed = parseAppError(new Error(overTheWire))
  assert.equal(parsed.code, 'audio.diagnostics_recorder_unavailable')
  assert.equal(parsed.message, 'diagnostics recorder missing')
  assert.doesNotMatch(parsed.message, /TE-ERR/)
  assert.doesNotMatch(parsed.message, /invoking remote method/)
})

test('round-trips params through the wire form without loss', () => {
  const params = {
    device: 'Topping D90 (WASAPI)',
    reason: 'format not supported; retry=false',
    rate: 352800,
    exclusive: true
  }
  const wire = encodeAppError('audio.format_rejected', 'device rejected format', params)
  const parsed = parseAppError(new Error(wire))

  assert.equal(parsed.code, 'audio.format_rejected')
  assert.equal(parsed.params.device, 'Topping D90 (WASAPI)')
  // The separators used by the encoding must survive inside a value.
  assert.equal(parsed.params.reason, 'format not supported; retry=false')
  assert.equal(parsed.params.rate, '352800')
  assert.equal(parsed.params.exclusive, 'true')
})

test('an error with no sentinel reports no code and keeps its message', () => {
  const parsed = parseAppError(new Error('fetch failed'))
  assert.equal(parsed.code, null)
  assert.deepEqual(parsed.params, {})
  assert.equal(parsed.message, 'fetch failed')
  assert.equal(isAppError(new Error('fetch failed')), false)
  assert.equal(isAppError(ipcError('x.y', 'z')), true)
})

test('degrades gracefully on malformed input instead of throwing', () => {
  // Reporting an error must never itself throw, whatever shape arrives.
  for (const value of [
    null,
    undefined,
    0,
    '',
    '   ',
    [],
    {},
    { message: 42 },
    new Error(''),
    'plain string failure',
    '[TE-ERR:]',
    '[TE-ERR:code:',
    'msg [TE-ERR:a.b:=novalue]',
    'msg [TE-ERR:a.b:key=%E0%A4%A]' // truncated percent-escape
  ]) {
    assert.doesNotThrow(() => parseAppError(value))
    assert.doesNotThrow(() => presentError('zh-CN', value, 'error.generic.unknown'))
  }

  // A truncated escape keeps the raw text rather than losing the param.
  const salvaged = parseAppError('msg [TE-ERR:a.b:key=%E0%A4%A]')
  assert.equal(salvaged.code, 'a.b')
  assert.equal(salvaged.params.key, '%E0%A4%A')
})

test('params without a value decode to empty string, not undefined', () => {
  const parsed = parseAppError('msg [TE-ERR:a.b:flag]')
  assert.equal(parsed.code, 'a.b')
  assert.equal(parsed.params.flag, '')
})

test('an empty params object omits the trailing separator', () => {
  assert.equal(encodeAppError('a.b', 'prose'), 'prose [TE-ERR:a.b]')
  assert.equal(encodeAppError('a.b', 'prose', {}), 'prose [TE-ERR:a.b]')
  // Null and undefined params are dropped rather than encoded as "null".
  assert.equal(
    encodeAppError('a.b', 'prose', { keep: 1, drop: null, gone: undefined }),
    'prose [TE-ERR:a.b:keep=1]'
  )
})

test('stripping the sentinel leaves display-safe prose', () => {
  const wire = encodeAppError('a.b', 'developer detail', { x: 1 })
  assert.equal(stripAppErrorSentinel(wire), 'developer detail')
  assert.doesNotMatch(stripAppErrorSentinel(wire), /TE-ERR/)
  // Idempotent, and harmless on text that never had one.
  assert.equal(stripAppErrorSentinel('plain'), 'plain')
  assert.equal(stripAppErrorSentinel(stripAppErrorSentinel(wire)), 'developer detail')
})

test('unwrapping is a no-op for messages Electron did not wrap', () => {
  assert.equal(unwrapRemoteInvokeMessage('音频服务已重启'), '音频服务已重启')
  assert.equal(
    unwrapRemoteInvokeMessage("Error invoking remote method 'a:b': Error: 音频服务已重启"),
    '音频服务已重启'
  )
})

test('presentError renders the catalog entry in the requested locale', () => {
  const wire = ipcError('audio.service_fatal', 'audio service cannot start', {
    reason: 'binding missing'
  })
  const zh = presentError('zh-CN', wire, 'error.generic.unknown')
  const en = presentError('en-US', wire, 'error.generic.unknown')

  assert.match(zh, /音频服务无法启动/)
  assert.match(zh, /binding missing/)
  assert.match(en, /audio service (?:cannot|could not) start/i)
  assert.match(en, /binding missing/)
  assert.notEqual(zh, en)
  // Never leak the machine tail into user-facing copy.
  for (const text of [zh, en]) assert.doesNotMatch(text, /TE-ERR/)
})

test('presentError classifies raw network noise when no sentinel is present', () => {
  const cases: Array<[string, RegExp, RegExp]> = [
    ['fetch failed', /网络连接失败/, /network/i],
    ['net::ERR_CONNECTION_REFUSED', /网络连接失败/, /network/i],
    ['ETIMEDOUT', /网络连接失败/, /network/i],
    ['HTTP 401 Unauthorized', /登录状态已失效/, /sign in|log in|session/i],
    ['429 Too Many Requests', /请求过于频繁/, /too many|slow down|frequent/i],
    [
      'Plugin com.twilightecho.provider.ncm RPC circuit is open; retry after 522ms.',
      /请求过于频繁/,
      /too many|slow down|frequent/i
    ],
    ['NCM_METADATA_RATE_LIMITED', /请求过于频繁/, /too many|slow down|frequent/i]
  ]
  for (const [raw, zhPattern, enPattern] of cases) {
    assert.match(presentError('zh-CN', new Error(raw), 'error.generic.unknown'), zhPattern)
    assert.match(presentError('en-US', new Error(raw), 'error.generic.unknown'), enPattern)
  }
})

test('Chinese copy from our own code passes through untouched', () => {
  // Providers already produce user-facing Chinese. Under zh-CN it must survive
  // verbatim rather than being replaced by a generic fallback.
  const message = '歌单不存在或已被删除'
  assert.equal(presentError('zh-CN', new Error(message), 'error.generic.unknown'), message)
})

test('an unknown code falls back instead of rendering the raw key', () => {
  const wire = ipcError('totally.unregistered.code', 'developer prose here')
  const zh = presentError('zh-CN', wire, 'error.generic.unknown')
  assert.doesNotMatch(zh, /totally\.unregistered\.code/)
  assert.doesNotMatch(zh, /TE-ERR/)
  assert.ok(zh.length > 0)
})

test('presentErrorDetail keeps the developer prose for logs', () => {
  const wire = ipcError('audio.service_fatal', 'ENOENT: binding.node missing', {
    reason: 'ENOENT'
  })
  const detail = presentErrorDetail('en-US', wire, 'error.generic.unknown')
  assert.match(detail.display, /audio service/i)
  assert.equal(detail.code, 'audio.service_fatal')
  assert.equal(detail.developerMessage, 'ENOENT: binding.node missing')
  assert.doesNotMatch(detail.display, /TE-ERR/)
})
