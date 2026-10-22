import { watch, type Ref } from 'vue'
import type { Track } from '../../types/music'

export function createCastController({
  currentTrack,
  currentTime,
  castTargetName,
  castTargetUsn,
  getRemoteApi,
  resolvePlayTarget,
  isCurrentTrackLiveStream,
  recordPlaybackStart
}: {
  currentTrack: Ref<Track | null>
  currentTime: Ref<number>
  castTargetName: Ref<string | null>
  castTargetUsn: Ref<string | null>
  getRemoteApi: () => typeof window.api.remote | undefined
  resolvePlayTarget: (track: Track) => Promise<string>
  isCurrentTrackLiveStream: () => boolean
  recordPlaybackStart: (track: Track) => void
}) {
  let generation = 0
  let disposed = false
  let transport = Promise.resolve()
  const stopSelectionWatch = watch(
    [() => currentTrack.value?.id, () => currentTrack.value?.queueEntryId],
    () => {
      generation++
    },
    { flush: 'sync' }
  )
  function serializeTransport(action: () => Promise<void>): Promise<void> {
    const result = transport.then(action, action)
    transport = result.catch(() => {})
    return result
  }

  async function castCurrentTrackToDevice(usn: string): Promise<void> {
    if (disposed) return
    const request = ++generation
    const isCurrent = (): boolean => !disposed && request === generation
    const track = currentTrack.value
    if (!track) throw new Error('当前没有可投送的曲目')
    const remoteApi = getRemoteApi()
    if (!remoteApi?.castToDevice) throw new Error('远程控制 API 不可用')

    // Prefer a resolved local library / managed-cache path when available;
    // otherwise resolve the live stream URL (podcast / radio / provider) and
    // cast via the remote media token proxy. Provider streams may be
    // twilight-media:// grants — main resolves those to the real upstream.
    let filePath: string | undefined
    let mediaUrl: string | undefined
    const classifyCastTarget = (target: string): void => {
      if (!target) return
      if (target.startsWith('twilight-media:') || /^https?:\/\//i.test(target)) {
        mediaUrl = target
        return
      }
      // Local path (no scheme or file-like absolute path).
      if (!/^[a-z][a-z\d+.-]*:\/\//i.test(target)) {
        filePath = target
      }
    }
    try {
      classifyCastTarget(await resolvePlayTarget(track))
    } catch {
      // Fall through to direct fields when resolvePlayTarget fails.
    }
    if (!isCurrent()) return
    if (!filePath && !mediaUrl) {
      classifyCastTarget(track.streamUrl || track.filePath || '')
    }
    if (!filePath && !mediaUrl) {
      throw new Error('当前曲目不支持投送（缺少本地路径或流地址）')
    }

    const positionSeconds = isCurrentTrackLiveStream() ? 0 : currentTime.value
    await serializeTransport(async () => {
      if (!isCurrent()) return
      try {
        const result = await remoteApi.castToDevice({
          usn,
          ...(filePath ? { filePath } : { mediaUrl }),
          title: track.title,
          artist: track.artist,
          album: track.album,
          // Live radio: do not seek after load.
          positionSeconds
        })
        if (!isCurrent()) {
          // An issued device command cannot be recalled. Finish its cleanup in
          // this lane before a newer cast can begin, so it cannot stop that cast.
          // Disposed runtimes have handed global transport ownership to their
          // replacement, whose independent lane may already have started a cast.
          if (!disposed) await remoteApi.stopCast?.().catch(() => {})
          return
        }
        castTargetUsn.value = result.usn
        castTargetName.value = result.friendlyName
        recordPlaybackStart(track)
        // Main process already dispatches a 'pause' shortcut for local engine.
      } catch (error) {
        // The queue skip caller falls back to local playback on rejection.
        // A superseded cast must never start its departed track through that path.
        if (isCurrent()) throw error
      }
    })
  }

  async function stopCastSession(): Promise<void> {
    if (disposed) return
    generation++
    const remoteApi = getRemoteApi()
    await serializeTransport(async () => {
      if (disposed) return
      if (remoteApi?.stopCast) await remoteApi.stopCast()
      castTargetUsn.value = null
      castTargetName.value = null
    })
  }

  async function discoverCastDevices(): Promise<
    import('../../../../shared/remoteControl.ts').DlnaDeviceInfo[]
  > {
    const remoteApi = getRemoteApi()
    if (!remoteApi?.discoverDlna) return []
    return await remoteApi.discoverDlna()
  }

  async function refreshCastTarget(): Promise<void> {
    if (disposed) return
    const request = generation
    const remoteApi = getRemoteApi()
    if (!remoteApi?.getCastTarget) {
      castTargetUsn.value = null
      castTargetName.value = null
      return
    }
    const target = await remoteApi.getCastTarget()
    if (disposed || request !== generation) return
    castTargetUsn.value = target?.usn ?? null
    castTargetName.value = target?.friendlyName ?? null
  }
  function dispose(): void {
    disposed = true
    generation++
    stopSelectionWatch()
  }
  return {
    castCurrentTrackToDevice,
    stopCastSession,
    discoverCastDevices,
    refreshCastTarget,
    dispose
  }
}
