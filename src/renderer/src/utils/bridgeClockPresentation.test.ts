import assert from 'node:assert/strict'
import test from 'node:test'
import { bridgeClockObservation, bridgeAdaptiveObservation } from './bridgeClockPresentation.ts'
import { BridgeClockMonitor } from '../../../shared/audioBridgeClock.ts'

test('clock UI distinguishes unsupported, estimated and stale data instead of displaying missing values as zero', () => {
  assert.deepEqual(bridgeClockObservation(null), ['输出桥未提供时钟观测'])
  const timing = new BridgeClockMonitor().view(0)
  assert.deepEqual(bridgeClockObservation(timing), ['此输出未提供设备播放时钟', '网络时钟采样已过期'])
  Object.assign(timing.output, { state: 'ready', driftPpm: 100.12, windowMs: 60000, samples: 241, positionFrames: 96000, ageMs: 12 })
  Object.assign(timing.network, { state: 'ready', roundTripMs: 2.4, uncertaintyMs: 1.2 })
  assert.deepEqual(bridgeClockObservation(timing), ['漂移已估计', '漂移 +100.1 ppm · 60.0 s / 241 次',
    '呈现位置 96000 帧 · 观测年龄 12 ms', '网络往返 2.4 ms · 时差估计 ±1.2 ms'])
  timing.output.state = 'stale'; timing.network.state = 'stale'
  assert.deepEqual(bridgeClockObservation(timing), ['观测已过期', '网络时钟采样已过期'])
})
test('adaptive signal node is explicit and distinguishes converted PCM from source presentation', () => {
  assert.deepEqual(bridgeAdaptiveObservation(null), [])
  assert.deepEqual(bridgeAdaptiveObservation({} as any), [])
  const receiver = { adaptive: { requestedPpm: 200, effectivePpm: 199.7, inputFrames: 48000 },
    timedStart: { state: 'running', presentedMediaFrames: 39000.5 } } as any
  assert.deepEqual(bridgeAdaptiveObservation(receiver), ['FFmpeg SWR · Kaiser FIR · 运行中',
    '时钟适配会重采样，不是位完美输出', '修正请求 200.0 ppm · 已生成 PCM 199.7 ppm', '媒体呈现 39000.50 帧'])
  receiver.timedStart = { state: 'prepared', presentedMediaFrames: null }; receiver.adaptive.inputFrames = 0
  assert.deepEqual(bridgeAdaptiveObservation(receiver), ['FFmpeg SWR · Kaiser FIR · 静音准备', '时钟适配会重采样，不是位完美输出'])
})
