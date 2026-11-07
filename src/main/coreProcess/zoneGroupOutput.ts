import type { AudioEngineManager } from '../audioEngineManager.ts'
import type { SyncGroupOutput } from '../../core/playback/syncGroupEngine.ts'
import type { BridgeRuntimeState } from '../../shared/audioBridge.ts'
import type { BridgeSourceTimeline } from '../../shared/bridgeSourceTimeline.ts'
import { setTimeout as delay } from 'node:timers/promises'

/** Physical decoders get one bounded sequential window; SQL order and each
 * promotion's authorization belong to SyncGroupEngine alone. */
export function zoneGroupOutput(id: string, audio: AudioEngineManager, downstreamDelayMs = 0): SyncGroupOutput {
  let prepared = false
  let windowTransitionSerial = 0
  return {
    id, downstreamDelayMs,
    read: async () => {
      const [bridge, playback, dsp, sourceTimeline] = await Promise.all([
        audio.callBridge('BridgeStatus') as Promise<BridgeRuntimeState>, audio.getPlaybackInfo(), audio.getDspGraphStatus(),
        audio.callBridge('BridgeSourceTimeline') as Promise<BridgeSourceTimeline | null>
      ])
      return { bridge, playback, dsp, sourceTimeline }
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
    volume: value => audio.setVolume(value),
    autoMix: {
      mode: mode => audio.setBridgeAutoMixMode(mode),
      select: request => audio.selectAutoMix(request), bind: request => audio.bindBridgeAutoMixSelection(request),
      prepare: request => audio.prepareAutoMix(request), status: () => audio.getAutoMixNativeStatus(),
      submit: id => audio.submitAutoMix(id), cancel: () => audio.cancelAutoMix()
    },
    continuous: {
      acquire: () => audio.acquireGroupPlayback(), release: () => audio.releaseGroupPlayback(),
      hold: async () => { await audio.callBridge('BridgeQueueControl', [true]) },
      advance: async (current, next) => { await audio.callBridge('BridgeQueueControl', [true, current, next]) },
      prepare: async (items, position, current) => {
        await audio.acquireGroupPlayback() // Reapply after a supervised audio-service restart.
        await audio.loadQueue(items, 0)
        await audio.setPlayMode('sequential'); await audio.setPlaybackRate(1)
        if (!current()) throw new Error('同步组准备已取消')
        prepared = true
        windowTransitionSerial = 0
        const result = await audio.playTimedBridge(items[0].source, position, current)
        if (!result.nativeStarted || result.superseded) throw new Error('同步组媒体未启动或已取消')
      },
      rebind: async (expected, items) => {
        const queue = audio.getQueueSnapshot()
        let timeline = await audio.callBridge('BridgeSourceTimeline') as BridgeSourceTimeline | null
        let nativeQueue = await audio.getQueueState?.()
        const deadline = Date.now()+500
        // A capture promotion leads the engine's 100ms queue metadata clock.
        // Wait for that control-plane ACK before issuing CAS; never allow one
        // member to rebase at old index0 while another has reached index1.
        while (timeline && timeline.transitionSerial > windowTransitionSerial && nativeQueue && nativeQueue.currentIndex !== 1) {
          if (Date.now() >= deadline) return false
          await delay(10)
          nativeQueue = await audio.getQueueState()
          timeline = await audio.callBridge('BridgeSourceTimeline') as BridgeSourceTimeline | null
        }
        const index = nativeQueue?.currentIndex ?? (await audio.getPlaybackInfo()).queueIndex
        if (!expected.queueEntryId || queue[index]?.queueEntryId !== expected.queueEntryId) return false
        const committed = !!await audio.rebindQueue({ expected: { queueToken: audio.getQueueToken(), index,
          id: expected.id, source: expected.source }, items, startIndex: 0, playMode: 'sequential' })
        if (committed) windowTransitionSerial = timeline?.transitionSerial ?? windowTransitionSerial
        return committed
      }
    }
  }
}
