<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useProviderStore } from '@renderer/stores/useProviderStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { useLibraryRecentTracks } from '@renderer/composables/useLibraryRecentTracks.ts'
import { getTrackSource } from '@renderer/utils/logicalTrackModel'
import type { Track } from '@renderer/types/music'
import type { StreamingPageTab } from '@renderer/app/navigationPages'
import type { MediaProviderPlaylistSummary } from '@renderer/providers/mediaProvider'
import { friendlyStreamingError } from '../streaming-page/friendlyStreamingError'
import { useOnlineHome } from './useOnlineHome'
import OnlineHome from './OnlineHome.vue'

const emit = defineEmits<{
  'select-view': [category: string, filter: string | null]
  'open-library-settings': []
  'open-streaming': [tab: StreamingPageTab]
  'open-plugins': []
  'open-radio': []
  login: [providerId: string]
}>()
const providerStore = useProviderStore()
const { settings, updateSettings } = useSettingsStore()
const player = usePlayerStore()
const history = useLibraryRecentTracks()
const recent = history.tracks
const recentState = history.state
const recentActionError = ref('')
const recentError = computed(() => recentActionError.value || history.error.value)
const selectedProvider = ref(settings.value.streamingActiveProvider || '')
const home = useOnlineHome({
  providers: providerStore.providers,
  preferredProvider: selectedProvider,
  checkLogin: providerStore.checkLogin,
  callProvider: providerStore.callProvider
})
const {
  providers,
  provider,
  loading,
  loggedIn,
  error,
  tracks,
  playlists,
  sectionTitle,
  playlistTitle
} = home
const hero = computed(() => {
  const current = player.currentTrack.value
  if (current) {
    const matched =
      recent.value.find((track) => track.id === current.id) ??
      tracks.value.find((track) => track.id === current.id)
    return matched
      ? {
          ...matched,
          ...current,
          cover: current.cover ?? matched.cover,
          coverSource:
            current.coverSource ?? ('coverSource' in matched ? matched.coverSource : undefined)
        }
      : current
  }
  return recent.value[0] ?? tracks.value[0] ?? null
})


const actionError = ref('')
const pendingPlaylist = ref<string | null>(null)
let actionRevision = 0

function reload(): void {
  actionError.value = ''
  void home.reload()
}
function retryRecent(): void {
  recentActionError.value = ''
  history.retry()
}

watch(
  () => provider.value?.id,
  () => {
    actionRevision += 1
    pendingPlaylist.value = null
    actionError.value = ''
  }
)
watch(
  [player.currentTrack, player.isPlaying],
  () => {
    actionRevision++
    pendingPlaylist.value = null
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  actionRevision += 1
})

async function selectProvider(id: string): Promise<void> {
  selectedProvider.value = id
  try {
    await updateSettings({ streamingActiveProvider: id })
  } catch (cause) {
    actionError.value = friendlyStreamingError(cause, '保存音源偏好失败')
  }
}

async function canPlay(providerId: string, request: number): Promise<boolean> {
  const source = providerStore.getProvider(providerId)
  if (!source) {
    // Built-in radio/network/local tracks are resolved by the player itself.
    if (['local', 'radio', 'podcast', 'network'].includes(providerId)) return true
    throw new Error('此歌曲的音源尚未启用，请先在插件中心接入')
  }
  if (source.capabilities.includes('login')) {
    const state = await providerStore.checkLogin(providerId)
    if (request !== actionRevision) return false
    if (!state.loggedIn) {
      emit('login', providerId)
      return false
    }
  }
  return request === actionRevision
}

async function play(track: Track, queue: Track[]): Promise<void> {
  const request = ++actionRevision
  const fromRecent = queue === recent.value
  pendingPlaylist.value = null
  actionError.value = ''
  recentActionError.value = ''
  try {
    if (player.currentTrack.value?.id === track.id) {
      await player.togglePlay()
      return
    }
    if (!(await canPlay(getTrackSource(track), request)) || request !== actionRevision) return
    if (request === actionRevision) await player.playTrack(track, queue)
  } catch (cause) {
    if (request === actionRevision) {
      const message = friendlyStreamingError(cause, '暂时无法播放')
      if (fromRecent) recentActionError.value = message
      else actionError.value = message
    }
  }
}

function playHero(): void {
  const track = hero.value
  if (!track) return
  const queue = recent.value.some((item) => item.id === track.id) ? recent.value : tracks.value
  void play(track, queue.some((item) => item.id === track.id) ? queue : [track])
}

async function playPlaylist(playlist: MediaProviderPlaylistSummary): Promise<void> {
  const source = provider.value
  if (!source) return
  const request = ++actionRevision
  pendingPlaylist.value = String(playlist.id)
  actionError.value = ''
  try {
    if (!(await canPlay(source.id, request))) return
    const queue = await providerStore.fetchPlaylistTracks(source.id, playlist.id)
    if (request !== actionRevision) return
    if (!queue.length) throw new Error('这个歌单暂时没有可播放的歌曲')
    await player.playTrack(queue[0], queue)
  } catch (cause) {
    if (request === actionRevision)
      actionError.value = friendlyStreamingError(cause, '歌单暂时无法播放')
  } finally {
    if (request === actionRevision) pendingPlaylist.value = null
  }
}
</script>

<template>
  <OnlineHome
    :providers="providers"
    :provider="provider"
    :loading="loading"
    :logged-in="loggedIn"
    :error="actionError || error"
    :tracks="tracks"
    :playlists="playlists"
    :section-title="sectionTitle"
    :playlist-title="playlistTitle"
    :recent="recent"
    :recent-loading="recentState.loading"
    :recent-error="recentError"
    :hero="hero"
    :current-track-id="player.currentTrack.value?.id"
    :is-playing="player.isPlaying.value"
    :pending-playlist="pendingPlaylist"
    @select-provider="selectProvider"
    @play="play"
    @play-hero="playHero"
    @play-playlist="playPlaylist"
    @reload="reload"
    @retry-recent="retryRecent"
    @login="provider && emit('login', provider.id)"
    @open-streaming="emit('open-streaming', $event)"
    @open-plugins="emit('open-plugins')"
    @open-radio="emit('open-radio')"
    @open-recent="emit('select-view', 'recent', null)"
    @open-library-settings="emit('open-library-settings')"
  />
</template>
