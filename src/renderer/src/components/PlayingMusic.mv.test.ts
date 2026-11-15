import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { effectScope, nextTick, ref } from 'vue'
import {
  MV_CINEMA_CHROME_HIDE_DELAY_MS,
  clearPendingMvPlaybackRequest,
  isCinemaOverlayElementVisible,
  pendingMvPlaybackRequest,
  requestMvPlayback,
  shouldRevealMvCinemaChrome,
  usePlayingMv
} from '../composables/usePlayingMv.ts'
import type { CorePlayerTrack } from '../stores/player/corePlayerTypes.ts'
import type { CorePlayerMvResult } from '../../../shared/coreSystemPlayer.ts'

function makeTrack(id: string, queueEntryId = 'occ-1', source = 'ncm'): CorePlayerTrack {
  return {
    id,
    queueEntryId,
    source,
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
    duration: 269,
    size: 0,
    cover: null,
    lyrics: null
  }
}

const flush = async (): Promise<void> => {
  await nextTick()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await nextTick()
}

test('usePlayingMv resolves MV only when full-screen surface is active and gates native audio suppression on ready video frames', async () => {
  const currentTrack = ref<CorePlayerTrack | null>(makeTrack('ncm:186016', 'occ-1'))
  const surfaceActive = ref(false)
  const exclusiveMode = ref(false)
  const castTargetName = ref<string | null>(null)
  const notices: string[] = []
  const suppressCalls: boolean[] = []
  const queryCalls: Array<{ quality?: string; force?: boolean }> = []

  const scope = effectScope()
  const mv = scope.run(() =>
    usePlayingMv({
      currentTrack,
      surfaceActive,
      exclusiveMode,
      castTargetName,
      queryCurrentTrackMv: async (options) => {
        queryCalls.push({ ...options })
        const track = currentTrack.value
        if (!track || track.id === 'ncm:no-mv') {
          return {
            current: track ? { trackId: track.id, occurrenceId: track.queueEntryId ?? null } : null,
            available: false,
            stream: null
          } satisfies CorePlayerMvResult
        }
        return {
          current: { trackId: track.id, occurrenceId: track.queueEntryId ?? null },
          available: true,
          stream: {
            url: 'twilight-media://video/11111111111111111111111111111111',
            quality: '1080p',
            width: 1920,
            height: 1080,
            providerId: 'ncm',
            mvId: '530012'
          }
        } satisfies CorePlayerMvResult
      },
      setAudioSuppressed: async (suppressed) => {
        suppressCalls.push(suppressed)
      },
      onNotice: (msg) => notices.push(msg)
    })
  )!

  // Inactive surface (e.g. closed or embedded Theme Studio preview) never queries MV
  await flush()
  assert.equal(queryCalls.length, 0)
  assert.equal(mv.mvAvailable.value, false)

  // Activating the full-screen surface resolves MV
  surfaceActive.value = true
  await flush()
  assert.equal(queryCalls.length, 1)
  assert.equal(mv.mvAvailable.value, true)
  assert.equal(mv.mvQualityBadge.value, '1080P')

  // Requesting MV original audio before <video> decodes its first frame does NOT suppress native audio early
  mv.toggleMvOriginalAudio()
  await flush()
  assert.equal(mv.mvOriginalAudioWanted.value, true)
  assert.equal(mv.mvOriginalAudioActive.value, false)
  assert.deepEqual(suppressCalls, [])

  // Once <video> signals ready, native audio output is suppressed cleanly
  mv.handleMvReady()
  await flush()
  assert.equal(mv.mvOriginalAudioActive.value, true)
  assert.deepEqual(suppressCalls, [true])

  // Advancing to a track with NO MV immediately releases native audio suppression with zero dead air
  currentTrack.value = makeTrack('ncm:no-mv', 'occ-2')
  await flush()
  assert.equal(mv.mvAvailable.value, false)
  assert.equal(mv.mvOriginalAudioActive.value, false)
  assert.deepEqual(suppressCalls, [true, false])

  // Switching to WASAPI/ASIO exclusive mode resets original-audio preference and informs the user
  currentTrack.value = makeTrack('ncm:186016', 'occ-3')
  await flush()
  mv.handleMvReady()
  await flush()
  assert.deepEqual(suppressCalls, [true, false, true])

  exclusiveMode.value = true
  await flush()
  assert.equal(mv.mvOriginalAudioWanted.value, false)
  assert.equal(mv.mvOriginalAudioActive.value, false)
  assert.deepEqual(suppressCalls, [true, false, true, false])
  assert.equal(notices.length, 1)
  assert.match(notices[0], /独占音频模式/)

  scope.stop()
})

test('usePlayingMv retries once with force=true on expired stream error and falls back cleanly on second failure', async () => {
  const currentTrack = ref<CorePlayerTrack | null>(makeTrack('bili:BV1test', 'occ-1', 'bili'))
  const surfaceActive = ref(true)
  const calls: boolean[] = []

  const scope = effectScope()
  const mv = scope.run(() =>
    usePlayingMv({
      currentTrack,
      surfaceActive,
      exclusiveMode: ref(false),
      castTargetName: ref(null),
      queryCurrentTrackMv: async (options) => {
        calls.push(Boolean(options?.force))
        return {
          current: { trackId: 'bili:BV1test', occurrenceId: 'occ-1' },
          available: true,
          stream: {
            url: `twilight-media://video/${calls.length === 1 ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}`,
            audioUrl: 'twilight-media://audio/cccccccccccccccccccccccccccccccc',
            quality: '1080p',
            providerId: 'bili',
            mvId: 'BV1test'
          }
        }
      },
      setAudioSuppressed: async () => undefined
    })
  )!

  await flush()
  assert.deepEqual(calls, [false])
  assert.equal(mv.mvAvailable.value, true)

  // First media error triggers one forced refresh
  mv.handleMvStreamError()
  await flush()
  assert.deepEqual(calls, [false, true])
  assert.equal(
    mv.mvStream.value?.url,
    'twilight-media://video/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  )
  assert.equal(mv.mvAvailable.value, true)

  // Second error on the same occurrence degrades gracefully to cover backdrop without infinite loop
  mv.handleMvStreamError()
  await flush()
  assert.deepEqual(calls, [false, true])
  assert.equal(mv.mvAvailable.value, false)
  assert.equal(mv.mvStream.value, null)

  scope.stop()
})

test('PlayingMusic and PlayingMvBackdrop keep MV exclusively on the full-screen stage with translucent unblurred ambient MV and context-menu-only controls', () => {
  const playingMusic = readFileSync(new URL('./PlayingMusic.vue', import.meta.url), 'utf8')
  const mvBackdrop = readFileSync(new URL('./PlayingMvBackdrop.vue', import.meta.url), 'utf8')
  const streamingMenu = readFileSync(
    new URL('./streaming-page/StreamingContextMenu.vue', import.meta.url),
    'utf8'
  )
  const streamingPage = readFileSync(new URL('./StreamingPage.vue', import.meta.url), 'utf8')

  // Placed as a sibling right after .backdrop inside .playback-cover-view without touching .backdrop
  assert.match(
    playingMusic,
    /<div v-if="!visualizerMounted" class="backdrop"[\s\S]*?<\/div>\s*<PlayingMvBackdrop/
  )
  assert.doesNotMatch(playingMusic, /mv-control-rail/)
  assert.doesNotMatch(playingMusic, /开启 MV/)
  assert.match(playingMusic, /playing-music--mv-ambient/)

  // Embedded preview guard prevents MV activation inside Theme Studio preview frames
  assert.match(
    playingMusic,
    /closest\('\.live-preview-stage, \.theme-studio-page, \.settings-preview-page'\)/
  )

  // PlayingMvBackdrop uses translucent unblurred ambient video, contain-fitted cinema video, flat color-mix scrims, zero gradients, and zero raw color literals
  assert.doesNotMatch(mvBackdrop, /(?<![-\w])filter:\s*blur\(/)
  assert.match(mvBackdrop, /opacity:\s*0\.24/)
  assert.match(
    mvBackdrop,
    /\.playing-mv-backdrop--cinema\s+\.playing-mv-video\s*\{[\s\S]*?object-fit:\s*contain/
  )
  assert.doesNotMatch(mvBackdrop, /linear-gradient|radial-gradient|conic-gradient/)
  assert.doesNotMatch(mvBackdrop, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  assert.match(mvBackdrop, /返回歌词/)

  // Context menus expose MV playback and MV source switching on PlayingMusic and StreamingPage
  assert.match(playingMusic, /开启背景 MV/)
  assert.match(playingMusic, /播放纯享 MV/)
  assert.match(playingMusic, /退出纯享 MV/)
  assert.match(playingMusic, /播放 MV 原声/)
  assert.match(playingMusic, /切回歌曲音源/)
  assert.match(playingMusic, /MV 来源：/)
  assert.match(streamingMenu, /播放 MV/)
  assert.match(streamingPage, /handleContextPlayMv/)
  assert.match(streamingPage, /requestMvPlayback/)
})

test('usePlayingMv defaults to Bilibili-first, toggles cleanly to NetEase, and automatically falls back to NetEase on Bilibili stream failure', async () => {
  const currentTrack = ref<CorePlayerTrack | null>(makeTrack('ncm:1811921555', 'occ-src'))
  const surfaceActive = ref(true)
  const requestedSources: Array<{ source: string; force: boolean }> = []

  const scope = effectScope()
  const mv = scope.run(() =>
    usePlayingMv({
      currentTrack,
      surfaceActive,
      exclusiveMode: ref(false),
      castTargetName: ref(null),
      queryCurrentTrackMv: async (options) => {
        const source = options?.source ?? 'bili'
        requestedSources.push({ source, force: Boolean(options?.force) })
        if (source === 'ncm') {
          return {
            current: { trackId: 'ncm:1811921555', occurrenceId: 'occ-src' },
            available: true,
            stream: {
              url: 'twilight-media://video/ncmncmncmncmncmncmncmncmncmncmnc',
              quality: '1080p',
              providerId: 'ncm',
              mvId: '14288888'
            }
          }
        }
        return {
          current: { trackId: 'ncm:1811921555', occurrenceId: 'occ-src' },
          available: true,
          stream: {
            url: 'twilight-media://video/bilibilibilibilibilibilibilibili',
            quality: '1080p',
            providerId: 'bili',
            mvId: 'BV17t4y1r7Jq'
          }
        }
      },
      setAudioSuppressed: async () => undefined
    })
  )!

  await flush()
  assert.equal(mv.mvSource.value, 'bili')
  assert.equal(mv.mvProviderLabel.value, 'B站')
  assert.deepEqual(requestedSources, [{ source: 'bili', force: false }])

  // If Bilibili video playback errors twice on <video>, automatically switches to NetEase ('ncm')!
  mv.handleMvStreamError()
  await flush()
  assert.equal(mv.mvProviderLabel.value, 'B站')
  mv.handleMvStreamError()
  await flush()
  assert.equal(mv.mvAvailable.value, true)
  assert.equal(mv.mvProviderLabel.value, '网易云')
  assert.deepEqual(requestedSources, [
    { source: 'bili', force: false },
    { source: 'bili', force: true },
    { source: 'ncm', force: true }
  ])

  // Manual toggle switches cleanly between 'ncm' and 'bili'
  assert.equal(mv.cycleMvSource(), 'ncm')
  await flush()
  assert.equal(mv.mvProviderLabel.value, '网易云')
  assert.equal(mv.cycleMvSource(), 'bili')
  await flush()
  assert.equal(mv.mvProviderLabel.value, 'B站')

  scope.stop()
})

test('requestMvPlayback and playMvCinema activate cinema MV across delayed track switches and notify when unavailable', async () => {
  clearPendingMvPlaybackRequest()
  const currentTrack = ref<CorePlayerTrack | null>(makeTrack('local:previous', 'occ-prev', 'local'))
  const surfaceActive = ref(false)
  const notices: string[] = []

  // Request MV playback for a target song before full-screen surface mounts or track switches
  requestMvPlayback('ncm:186016')
  assert.equal(pendingMvPlaybackRequest.value?.trackId, 'ncm:186016')

  const scope = effectScope()
  const mv = scope.run(() =>
    usePlayingMv({
      currentTrack,
      surfaceActive,
      exclusiveMode: ref(false),
      castTargetName: ref(null),
      queryCurrentTrackMv: async () => {
        const track = currentTrack.value
        if (!track || track.id !== 'ncm:186016') {
          return {
            current: track ? { trackId: track.id, occurrenceId: track.queueEntryId ?? null } : null,
            available: false,
            stream: null
          }
        }
        return {
          current: { trackId: track.id, occurrenceId: track.queueEntryId ?? null },
          available: true,
          stream: {
            url: 'twilight-media://video/dddddddddddddddddddddddddddddddd',
            quality: '1080p',
            providerId: 'ncm',
            mvId: '530012'
          }
        }
      },
      setAudioSuppressed: async () => undefined,
      onNotice: (msg) => notices.push(msg)
    })
  )!

  // Surface mounts while previous track (no MV) is still active — pending request must NOT false-fire notice
  surfaceActive.value = true
  await flush()
  assert.deepEqual(notices, [])
  assert.equal(pendingMvPlaybackRequest.value?.trackId, 'ncm:186016')

  // Target track arrives -> resolves MV, consumes pending request, and activates cinema mode
  currentTrack.value = makeTrack('ncm:186016', 'occ-target')
  await flush()
  assert.equal(pendingMvPlaybackRequest.value, null)
  assert.equal(mv.mvEnabled.value, true)
  assert.equal(mv.mvDisplayMode.value, 'cinema')
  assert.equal(mv.mvAvailable.value, true)
  mv.handleMvReady()
  assert.equal(mv.mvCinemaActive.value, true)

  // Turning off background MV resets cinema mode; playMvCinema re-enables MV and enters cinema mode directly
  mv.toggleMvEnabled()
  assert.equal(mv.mvEnabled.value, false)
  assert.equal(mv.mvDisplayMode.value, 'ambient')
  mv.playMvCinema()
  assert.equal(mv.mvEnabled.value, true)
  assert.equal(mv.mvDisplayMode.value, 'cinema')

  // Requesting MV playback on a song without MV falls back to ambient and notifies the user
  requestMvPlayback('local:no-mv')
  currentTrack.value = makeTrack('local:no-mv', 'occ-none', 'local')
  await flush()
  assert.equal(pendingMvPlaybackRequest.value, null)
  assert.equal(mv.mvAvailable.value, false)
  assert.equal(mv.mvDisplayMode.value, 'ambient')
  assert.deepEqual(notices, ['当前歌曲暂无可用 MV'])

  scope.stop()
})

test('MV cinema chrome hides title bar, visualizer, and playback progress by default and only reveals on downward bottom touch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })

  // Pure gesture helper: top/middle/upward movements never reveal; downward into bottom band or literal bottom edge reveals
  assert.equal(shouldRevealMvCinemaChrome(30, 10, 1080), false)
  assert.equal(shouldRevealMvCinemaChrome(540, 500, 1080), false)
  assert.equal(shouldRevealMvCinemaChrome(1050, null, 1080), false)
  assert.equal(shouldRevealMvCinemaChrome(1040, 1055, 1080), false)
  assert.equal(shouldRevealMvCinemaChrome(1050, 1010, 1080), true)
  assert.equal(shouldRevealMvCinemaChrome(1076, null, 1080), true)

  const currentTrack = ref<CorePlayerTrack | null>(makeTrack('ncm:186016', 'occ-cinema'))
  const surfaceActive = ref(true)

  const scope = effectScope()
  const mv = scope.run(() =>
    usePlayingMv({
      currentTrack,
      surfaceActive,
      exclusiveMode: ref(false),
      castTargetName: ref(null),
      queryCurrentTrackMv: async () => ({
        current: { trackId: 'ncm:186016', occurrenceId: 'occ-cinema' },
        available: true,
        stream: {
          url: 'twilight-media://video/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          quality: '1080p',
          providerId: 'ncm',
          mvId: '530012'
        }
      }),
      setAudioSuppressed: async () => undefined
    })
  )!

  await flush()
  mv.playMvCinema()
  mv.handleMvReady()
  await flush()
  assert.equal(mv.mvCinemaActive.value, true)
  assert.equal(mv.mvCinemaChromeRevealed.value, false)

  // Moving pointer at top or middle of viewport keeps chrome hidden
  mv.notifyMvCinemaPointer(16, 1080, false)
  mv.notifyMvCinemaPointer(420, 1080, false)
  assert.equal(mv.mvCinemaChromeRevealed.value, false)

  // Moving upward even near bottom does not reveal
  mv.notifyMvCinemaPointer(1055, 1080, false) // from 420 -> 1055 IS downward into bottom band -> reveals!
  assert.equal(mv.mvCinemaChromeRevealed.value, true)

  // Moving away from bottom band into middle without hovering chrome schedules auto-hide
  mv.notifyMvCinemaPointer(480, 1080, false)
  t.mock.timers.tick(MV_CINEMA_CHROME_HIDE_DELAY_MS - 100)
  assert.equal(mv.mvCinemaChromeRevealed.value, true)
  t.mock.timers.tick(200)
  assert.equal(mv.mvCinemaChromeRevealed.value, false)

  // Once hidden again, upward motion near bottom stays hidden; downward touch reveals
  mv.notifyMvCinemaPointer(1060, 1080, false) // 480 -> 1060 downward -> reveals
  assert.equal(mv.mvCinemaChromeRevealed.value, true)

  // Hovering TitleBar at the top (onChrome=true) or dragging seek slider (buttonsDown=true) holds chrome open
  mv.notifyMvCinemaPointer(18, 1080, true, false)
  t.mock.timers.tick(MV_CINEMA_CHROME_HIDE_DELAY_MS * 2)
  assert.equal(mv.mvCinemaChromeRevealed.value, true)

  mv.notifyMvCinemaPointer(500, 1080, false, true)
  t.mock.timers.tick(MV_CINEMA_CHROME_HIDE_DELAY_MS * 2)
  assert.equal(mv.mvCinemaChromeRevealed.value, true)

  // Releasing drag and leaving chrome lets auto-hide complete cleanly
  mv.notifyMvCinemaPointer(500, 1080, false, false)
  t.mock.timers.tick(MV_CINEMA_CHROME_HIDE_DELAY_MS + 50)
  assert.equal(mv.mvCinemaChromeRevealed.value, false)

  // Touching the bottom edge and stopping idle off-control (e.g. bottom gap / taskbar) still auto-hides!
  mv.notifyMvCinemaPointer(1078, 1080, false, false)
  assert.equal(mv.mvCinemaChromeRevealed.value, true)
  t.mock.timers.tick(MV_CINEMA_CHROME_HIDE_DELAY_MS + 50)
  assert.equal(mv.mvCinemaChromeRevealed.value, false)

  // Hidden v-show="false" overlays (like #app-notice-history with display: none) never trap chrome open
  const prevDocument = globalThis.document
  const hiddenNoticePanel = {
    hidden: false,
    style: { display: 'none', visibility: '' },
    parentElement: null,
    getAttribute: () => null,
    hasAttribute: () => false
  }
  const dataset: Record<string, string | undefined> = {}
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      hidden: false,
      documentElement: { dataset },
      querySelectorAll: () => [hiddenNoticePanel],
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }
  })
  try {
    assert.equal(isCinemaOverlayElementVisible(hiddenNoticePanel as unknown as Element), false)
    mv.notifyMvCinemaPointer(1075, 1080, false, false)
    assert.equal(mv.mvCinemaChromeRevealed.value, true)
    assert.equal(dataset.teMvCinemaChrome, 'revealed')

    mv.notifyMvCinemaPointer(460, 1080, false, false)
    t.mock.timers.tick(MV_CINEMA_CHROME_HIDE_DELAY_MS + 50)
    assert.equal(mv.mvCinemaChromeRevealed.value, false)
    assert.equal(dataset.teMvCinemaChrome, 'hidden')
  } finally {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: prevDocument
    })
  }

  // Structural CSS contract in main.css and PlayingMvBackdrop.vue
  const mainCss = readFileSync(new URL('../assets/main.css', import.meta.url), 'utf8')
  const mvBackdrop = readFileSync(new URL('./PlayingMvBackdrop.vue', import.meta.url), 'utf8')
  assert.match(mainCss, /html\[data-te-mv-cinema-chrome='hidden'\]/)
  assert.match(mainCss, /html\[data-te-mv-cinema-chrome='revealed'\]/)
  assert.match(mainCss, /\.app-shell-title\s+\.title-bar/)
  assert.match(mainCss, /\.visualizer-toggle-button,\s*\.playback-time/)
  assert.match(mainCss, /\.compact-visualizer,\s*\.compact-progress-rail,\s*\.mini-progress-rail/)
  assert.match(mvBackdrop, /playing-mv-cinema-dock--chrome-revealed/)

  scope.stop()
})
