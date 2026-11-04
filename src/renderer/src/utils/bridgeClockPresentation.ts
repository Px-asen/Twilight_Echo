import type { BridgeClockStatus } from '../../../shared/audioBridgeClock.ts'
import type { BridgeReceiverFacts } from '../../../shared/audioBridge.ts'

export function bridgeAdaptiveObservation(receiver?: BridgeReceiverFacts | null): string[] {
  const adaptive = receiver?.adaptive
  if (!adaptive) return []
  const phase = receiver.timedStart?.state
  const state = phase === 'prepared' ? '静音准备' : phase === 'armed' ? '等待起播' : phase === 'running' ? '运行中' :
    phase === 'completed' ? '已完成' : '已停止'
  const lines = [`FFmpeg SWR · Kaiser FIR · ${state}`, '时钟适配会重采样，不是位完美输出']
  if (adaptive.inputFrames > 0) lines.push(`修正请求 ${adaptive.requestedPpm.toFixed(1)} ppm · 已生成 PCM ${adaptive.effectivePpm.toFixed(1)} ppm`)
  const position = receiver.timedStart?.presentedMediaFrames
  if (position !== null && position !== undefined) lines.push(`媒体呈现 ${position.toFixed(2)} 帧`)
  return lines
}

export function bridgeClockObservation(timing?: BridgeClockStatus | null): string[] {
  if (!timing) return ['输出桥未提供时钟观测']
  const { output, network } = timing
  const states: Record<typeof output.state, string> = {
    unsupported: '此输出未提供设备播放时钟', stopped: '输出已停止', unreliable: '驱动时间戳暂不可靠',
    warming: '正在积累漂移样本', ready: '漂移已估计', stale: '观测已过期', discontinuity: '时钟不连续，等待输出重建'
  }
  const lines = [states[output.state]]
  if (output.state === 'ready' && output.driftPpm !== null) lines.push(
    `漂移 ${output.driftPpm >= 0 ? '+' : ''}${output.driftPpm.toFixed(1)} ppm · ${(output.windowMs / 1000).toFixed(1)} s / ${output.samples} 次`)
  if (['ready', 'warming'].includes(output.state) && output.positionFrames !== null && output.ageMs !== null)
    lines.push(`呈现位置 ${Math.round(output.positionFrames)} 帧 · 观测年龄 ${Math.round(output.ageMs)} ms`)
  if (network.state !== 'stale' && network.roundTripMs !== null && network.uncertaintyMs !== null)
    lines.push(`网络往返 ${network.roundTripMs.toFixed(1)} ms · 时差估计 ±${network.uncertaintyMs.toFixed(1)} ms`)
  else lines.push('网络时钟采样已过期')
  return lines
}
