import type { AudioEngineManager } from '../audioEngineManager.ts'
import type { SyncGroupOutput } from '../../core/playback/syncGroupEngine.ts'
import type { BridgeRuntimeState } from '../../shared/audioBridge.ts'

/** All group media remains in the existing supervised audio processes. Each
 * decoder has exactly one non-repeating item; only SyncGroupEngine advances. */
export function zoneGroupOutput(id: string, audio: AudioEngineManager, downstreamDelayMs = 0): SyncGroupOutput {
  let prepared = false
  return {
    id, downstreamDelayMs,
    read: async () => {
      const [bridge, playback, dsp] = await Promise.all([
        audio.callBridge('BridgeStatus') as Promise<BridgeRuntimeState>, audio.getPlaybackInfo(), audio.getDspGraphStatus()
      ])
      return { bridge, playback, dsp }
    },
    prepare: async (item, position, current) => {
      await audio.loadQueue([item], 0)
      await audio.setPlayMode('sequential')
      await audio.setPlaybackRate(1)
      if (!current()) throw new Error('同步组准备已取消')
      prepared = true
      const result = await audio.playTimedBridge(item.source, position, current)
      if (!result.nativeStarted || result.superseded) throw new Error('同步组媒体未启动或已取消')
    },
    arm: async (at, frame) => { await audio.callBridge('BridgeArmTimed', [at, frame, true]) },
    silence: async () => {
      // A normal idle member has no timed request to cancel. Once preparation
      // starts, cancel also revokes a pending prepare/arm and waits for close.
      if (prepared) { await audio.callBridge('BridgeCancelTimed'); prepared = false }
      else await audio.pause()
    },
    volume: value => audio.setVolume(value)
  }
}
