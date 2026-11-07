import {
  computed,
  effectScope,
  onScopeDispose,
  ref,
  shallowReadonly,
  shallowRef,
  watch,
  type Ref
} from 'vue'
import type { CorePlayerClient, CorePlayerTrack } from './corePlayerTypes.ts'
import { createCorePlayerAudio } from './corePlayerAudio.ts'
import { createCorePlayerPersonal } from './corePlayerPersonal.ts'
import { createCorePlayerClock, type CorePlayerClockOptions } from './corePlayerClock.ts'
import { createCorePlayerVisualization } from './corePlayerVisualization.ts'
import { createCorePlayerQueue } from './corePlayerQueue.ts'
import { createCorePlayerResource } from './corePlayerResource.ts'
import type { CoreCommandName, CoreCommands } from '../../../../shared/coreProtocol.ts'
import type { PlayMode } from '../../../../shared/audioEngineTypes.ts'
import type { LyricSource } from '../../../../shared/lyricsManagement.ts'
import type { SleepTimerMode } from '../../../../shared/sleepTimer.ts'
import type { PersonalizedStreamKey } from '../../../../shared/corePersonalized.ts'
import { formatTime } from '../../utils/playerTime.ts'
import { extractDominantColor } from '../../utils/colorExtractor.ts'
import { resolveCover } from '../../utils/coverLoader.ts'
import { isDeepStrictEqual } from '../../../../shared/portableAsync.ts'

export interface CorePlayerStoreOptions extends CorePlayerClockOptions {
  visible?: Readonly<Ref<boolean>>
  useCoverTheme?: () => boolean
  extractColor?: (url: string) => Promise<string>
  resolveArtwork?: typeof resolveCover
  newId?: () => string
}

/** One document's disposable view. Constructing/attaching never loads or seeks audio. */
export function createCorePlayerStore(
  core: CorePlayerClient,
  options: CorePlayerStoreOptions = {}
) {
  const scope = effectScope(true)
  const store = scope.run(() => {
    const commandError = shallowRef<Error | null>(null)
    const failed = (error: unknown) => {
      commandError.value = error instanceof Error ? error : new Error(String(error))
    }
    async function command<K extends CoreCommandName>(name: K, payload: CoreCommands[K]) {
      try {
        const value = await core.command(name, payload)
        commandError.value = null
        return value
      } catch (error) {
        failed(error)
        throw error
      }
    }
    const client: CorePlayerClient = { ...core, command }
    const personal = createCorePlayerPersonal(client, failed)
    const audio = createCorePlayerAudio(client, failed)
    const clock = createCorePlayerClock(client, options)
    const queue = createCorePlayerQueue(client, failed)
    const presentation = createCorePlayerResource(
      () => {
        const state = core.state.value
        return state?.phase === 'ready' && state.presentationRevision != null
          ? `${state.epoch}:${state.presentationRevision}:${state.queue?.occurrenceId}`
          : ''
      },
      () => core.query('player.presentation', {}),
      failed
    )
    const visible = ref(typeof document === 'undefined' || !document.hidden)
    if (!options.visible && typeof document !== 'undefined') {
      const visibilityChanged = () => {
        visible.value = !document.hidden
      }
      document.addEventListener('visibilitychange', visibilityChanged)
      onScopeDispose(() => document.removeEventListener('visibilitychange', visibilityChanged))
    }
    const visualization = createCorePlayerVisualization(
      client,
      failed,
      options.visible ?? visible,
      options.newId
    )
    const playbackInfo = computed(() => {
      const playback = core.state.value?.playback
      return playback ? Object.freeze({ ...audio.outputInfo.value, ...playback, outputInfo: audio.outputInfo.value }) : null
    })
    const currentTrack = computed<CorePlayerTrack | null>((previous) => {
      const track = core.state.value?.track
      if (!track) return null
      const content = personal.lyricsContent.value
      const lyrics =
        content?.current?.trackId === track.id &&
        content.current.occurrenceId === (core.state.value?.queue?.occurrenceId ?? null)
          ? content.effective
          : null
      const display = presentation.value.value
      const artwork = display?.current?.trackId === track.id &&
        display.current.occurrenceId === (core.state.value?.queue?.occurrenceId ?? null) ? display : null
      const next = {
        ...track,
        cover: artwork?.cover ?? null,
        coverSource: artwork?.coverSource,
        lyrics: lyrics?.original ?? null,
        translatedLyrics: lyrics?.translation,
        romanizedLyrics: lyrics?.romanization,
        lyricsSource: lyrics?.originalSource as LyricSource | null,
        translatedLyricsSource: lyrics?.translationSource as LyricSource | null,
        romanizedLyricsSource: lyrics?.romanizationSource as LyricSource | null
      }
      // Full Core snapshots also carry background progress. Keep the unchanged
      // display track stable so lyrics, covers and track consumers stay idle.
      return previous && isDeepStrictEqual(previous, next) ? previous : Object.freeze(next)
    })
    const isPlaying = computed(() => playbackInfo.value?.state === 'playing')
    const playMode = computed<PlayMode>(() => playbackInfo.value?.playMode ?? 'sequential')
    const heartModeAvailable = computed(() => core.state.value?.heart?.available ?? false)
    const coverThemeColor = shallowRef('#1a73e8')
    const themeCoverUrl = shallowRef('')
    const themeCoverIdentity = computed(
      () => `${currentTrack.value?.id ?? ''}:${themeCoverUrl.value}`
    )
    watch([() => currentTrack.value?.cover, () => currentTrack.value?.coverSource], async ([handle, source], _old, cleanup) => {
      let active = true
      cleanup(() => {
        active = false
      })
      const url = await (options.resolveArtwork ?? resolveCover)(handle, source)
      if (!active) return
      themeCoverUrl.value = url ?? ''
      const color = url ? await (options.extractColor ?? extractDominantColor)(url) : '#1a73e8'
      if (active) coverThemeColor.value = color
    })
    const dismissedRecovery = ref('')
    const recoveryKey = computed(() => `${core.status.value?.epoch}:${core.status.value?.phase}:${core.failure.value?.message}`)
    const setPlayMode = (mode: PlayMode) => command('playback.mode', { mode })
    const cyclePlayMode = () => {
      const modes: PlayMode[] = ['sequential', 'listLoop', 'repeat', 'shuffle']
      if (heartModeAvailable.value) modes.push('heart')
      return setPlayMode(modes[(modes.indexOf(playMode.value) + 1) % modes.length])
    }
    const editAbLoop = (action: 'a' | 'b' | 'toggle' | 'clear', position?: number) => {
      const state = core.state.value
      if (!state?.abLoop || !state.queue?.occurrenceId) return Promise.resolve()
      return command('playback.abLoop', {
        revision: state.abLoop.revision,
        occurrenceId: state.queue.occurrenceId,
        action,
        ...(position === undefined ? {} : { position })
      })
    }
    const castToDevice = (device: { id: string } | string) => {
      const state = core.state.value,
        queue = state?.queue
      if (!state?.cast || !queue?.occurrenceId) throw new Error('当前没有可投放的曲目')
      return command('cast.start', {
        revision: state.cast.revision,
        deviceId: typeof device === 'string' ? device : device.id,
        queue: { id: queue.id, revision: queue.revision, occurrenceId: queue.occurrenceId }
      })
    }
    return {
      ...audio,
      ...personal,
      ...clock,
      ...visualization,
      ...queue,
      currentTrack,
      playbackInfo,
      isPlaying,
      isStreamBuffering: computed(() => core.state.value?.isStreamBuffering ?? false),
      streamNowPlaying: computed(() => core.state.value?.playback?.streamTitle ?? ''),
      playMode,
      heartModeAvailable,
      volume: computed(() => core.state.value?.mute?.userVolume ?? playbackInfo.value?.volume ?? 1),
      muted: computed(() => core.state.value?.mute?.muted ?? false),
      playbackRate: computed(() => playbackInfo.value?.playbackRate ?? 1),
      abLoopA: computed(() => core.state.value?.abLoop?.a ?? null),
      abLoopB: computed(() => core.state.value?.abLoop?.b ?? null),
      audioEngineReady: computed(
        () => core.status.value?.phase === 'ready' && core.state.value?.phase === 'ready' &&
          !core.state.value.audioRecovery?.error &&
          !['confirming', 'restarting-engine', 'restarting-services'].includes(core.state.value.audioRecovery?.phase ?? '')
      ),
      audioEngineError: computed(
        () =>
          commandError.value?.message ??
          core.failure.value?.message ??
          core.state.value?.audioRecovery?.error ??
          core.state.value?.error ??
          null
      ),
      audioEngineRecoveryNotice: computed(() =>
        core.failure.value && recoveryKey.value !== dismissedRecovery.value
          ? { kind: 'service-fatal' as const, message: core.failure.value.message }
          : null),
      dismissAudioEngineRecoveryNotice: () => { dismissedRecovery.value = recoveryKey.value },
      isLoading: computed(() =>
        core.state.value?.loading || ['starting', 'recovering'].includes(core.status.value?.phase ?? '')
      ),
      loudnormStatus: computed(() => core.state.value?.loudness?.status ?? 'idle'),
      loudnormStatusSource: computed(() => null),
      clearBpmAnalysisFromPlaybackState: () => core.refresh(),
      isCurrentTrackNativePlaybackInfo: (info: NonNullable<typeof playbackInfo.value>) =>
        !!core.state.value?.track && info === playbackInfo.value,
      sleepTimerState: computed(() => core.state.value?.sleepTimer?.timer ?? null),
      sleepTimerNotice: computed(() =>
        core.state.value?.sleepTimer?.timer?.triggered ? '睡眠定时器已停止播放' : null
      ),
      personalizedStreamSession: computed(() => core.state.value?.personalized ?? null),
      personalizedStreamRemaining: computed(() => core.state.value?.personalized?.remaining ?? 0),
      castTargetName: computed(() => core.state.value?.cast?.target?.name ?? null),
      currentFavorite: computed(() => {
        const display = presentation.value.value
        const state = core.state.value
        return display?.current?.trackId === state?.track?.id &&
          display?.current?.occurrenceId === (state?.queue?.occurrenceId ?? null) ? display?.favorite ?? null : null
      }),
      toggleFavorite: () => {
        const state = core.state.value
        if (!state?.track) return Promise.resolve()
        return command('playback.favorite', {
          trackId: state.track.id, occurrenceId: state.queue?.occurrenceId ?? null
        }).then(() => {})
      },
      coverThemeColor: shallowReadonly(coverThemeColor),
      themeCoverUrl,
      themeCoverIdentity,
      dominantColor: computed(() =>
        (options.useCoverTheme?.() ?? true) ? coverThemeColor.value : '#7c4dff'
      ),
      togglePlay: () => command(isPlaying.value ? 'playback.pause' : 'playback.play', {}).then(() => {}),
      stopPlayback: () => command('playback.stop', {}),
      next: () => command('playback.next', {}),
      prev: () => command('playback.previous', {}),
      seek: (position: number) => command('playback.seek', { position }),
      setVolume: (volume: number) => command('playback.volume', { volume }),
      setUnityVolume: () => command('playback.volume', { volume: 1 }),
      toggleMute: () => command('playback.mute', {}),
      setPlaybackRate: (rate: number) => command('playback.rate', { rate }),
      setPlayMode,
      cyclePlayMode,
      setAbLoopPoint: (point: 'a' | 'b', position?: number) => editAbLoop(point, position),
      toggleAbLoopAtCurrentTime: () => editAbLoop('toggle'),
      clearAbLoop: () => editAbLoop('clear'),
      configureSleepTimer: (mode: SleepTimerMode, minutes?: number) =>
        command('sleep.configure', {
          revision: core.state.value!.sleepTimer!.revision,
          mode,
          ...(minutes === undefined ? {} : { minutes })
        }),
      cancelSleepTimer: () =>
        command('sleep.cancel', { revision: core.state.value!.sleepTimer!.revision }),
      startPersonalizedStream: (
        key: PersonalizedStreamKey,
        providerId: string,
        selectedId?: string
      ) =>
        command('personalized.start', {
          key,
          providerId,
          ...(selectedId ? { selectedId } : {}),
          play: true
        }),
      castToDevice,
      stopCast: () => command('cast.end', { revision: core.state.value!.cast!.revision }),
      discoverCastDevices: async () => {
        await command('cast.discover', {})
        return (await core.query('cast.devices', { offset: 0, limit: 200 })).items
      },
      refreshCastTarget: () => core.refresh(),
      attach: () => core.attach(),
      formatTime
    }
  })!
  return { ...store, dispose: () => scope.stop() }
}
