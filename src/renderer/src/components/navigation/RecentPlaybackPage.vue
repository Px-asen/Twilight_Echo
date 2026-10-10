<script setup lang="ts">
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProviderStore } from '@renderer/stores/useProviderStore'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { useProviderHistory } from '@renderer/components/navigation/useProviderHistory.ts'
import CoverImg from '@renderer/components/CoverImg.vue'
import type { Track } from '@renderer/types/music'

const SongList = defineAsyncComponent(() => import('@renderer/components/SongList.vue'))
const props = defineProps<{
  hasPlayer: boolean
  active: boolean
  target?: { kind: 'recent'; scope?: 'device' | 'platform'; providerId?: string }
}>()
const emit = defineEmits<{
  selectView: [category: string, filter: string | null]
  login: [providerId: string]
}>()
const scope = ref<'device' | 'platform'>('device')
const providerId = ref('')
const page = ref(0)
const providerLoadError = ref('')
watch(
  () => props.target,
  (target) => {
    if (target?.scope) scope.value = target.scope
    if (target?.providerId) providerId.value = target.providerId
  },
  { immediate: true }
)
const providers = useProviderStore()
const player = usePlayerStore()
const options = computed(() =>
  providers.providers.value.filter((provider) =>
    provider.supportedMethods.includes('fetchRecentSongs')
  )
)
const selectedProvider = computed(() =>
  options.value.find((provider) => provider.id === providerId.value)
)
const history = useProviderHistory(async (id) => {
  const provider = providers.getProvider(id)
  if (provider?.health?.available === false) throw new Error('这个音源目前不可用，请检查插件状态')
  if (provider?.capabilities.includes('login')) {
    const login = await providers.checkLogin(id)
    if (!login.loggedIn) throw new Error('请先登录这个平台，再查看平台历史')
  }
  return providers.callProvider<Track[]>(id, 'fetchRecentSongs', [200])
})
const visibleTracks = computed(() =>
  history.tracks.value.slice(page.value * 50, (page.value + 1) * 50)
)
watch(
  options,
  (list) => {
    if (!list.length || list.some((provider) => provider.id === providerId.value)) return
    const requested = props.target?.providerId
    if (requested && list.some((provider) => provider.id === requested))
      providerId.value = requested
    else if (!list.some((provider) => provider.id === providerId.value))
      providerId.value = list[0]?.id ?? ''
  },
  { immediate: true }
)
watch(
  [scope, providerId, () => props.active, selectedProvider],
  ([nextScope, nextProvider, active], previous) => {
    if (!active) {
      history.invalidate(false)
      return
    }
    if (nextScope !== previous?.[0] || nextProvider !== previous?.[1]) {
      page.value = 0
      history.invalidate()
    }
    if (props.active && scope.value === 'platform' && selectedProvider.value)
      void history.load(providerId.value)
  },
  { immediate: true }
)
async function syncProviders(): Promise<void> {
  providerLoadError.value = ''
  try {
    await providers.syncProviders()
  } catch (cause) {
    providerLoadError.value = `无法加载音源：${cause instanceof Error ? cause.message : String(cause)}`
  }
}
onMounted(() => {
  void syncProviders()
})
onBeforeUnmount(history.invalidate)
function play(track: Track): void {
  player.playTrack(track, history.tracks.value)
}
</script>

<template>
  <section class="recent-playback-page" :class="{ 'has-player': hasPlayer }">
    <div class="recent-scope-tabs" aria-label="最近播放记录类型">
      <button type="button" :aria-pressed="scope === 'device'" @click="scope = 'device'">
        本机记录
      </button>
      <button type="button" :aria-pressed="scope === 'platform'" @click="scope = 'platform'">
        平台历史
      </button>
    </div>
    <SongList
      v-show="scope === 'device'"
      category="recent"
      :filter="null"
      :has-player="hasPlayer"
      transition-name="page-down"
      @select-view="(category, filter) => emit('selectView', category, filter)"
    />
    <div v-if="scope === 'platform'" class="platform-history">
      <header>
        <div>
          <h2>平台历史</h2>
          <p>来自所选平台的最近播放记录</p>
        </div>
        <select v-if="options.length" v-model="providerId" aria-label="选择历史记录平台">
          <option v-for="provider in options" :key="provider.id" :value="provider.id">
            {{ provider.name }}
          </option></select
        ><button
          v-if="selectedProvider"
          type="button"
          :disabled="history.loading.value"
          @click="history.load(providerId)"
        >
          刷新
        </button>
      </header>
      <div v-if="providerLoadError" class="history-empty" role="alert">
        <p>{{ providerLoadError }}</p>
        <button type="button" @click="syncProviders">重试</button>
      </div>
      <p v-else-if="!options.length" class="history-empty">
        当前启用的音源没有提供平台历史功能，本机记录仍可使用。
      </p>
      <div v-else-if="history.error.value" class="history-empty" role="alert">
        <p>{{ history.error.value }}</p>
        <button
          v-if="selectedProvider?.capabilities.includes('login')"
          type="button"
          @click="emit('login', providerId)"
        >
          登录账户</button
        ><button type="button" @click="history.load(providerId)">重试</button>
      </div>
      <p
        v-else-if="history.loading.value && !history.tracks.value.length"
        class="history-empty"
        role="status"
      >
        正在加载平台历史…
      </p>
      <p v-else-if="!history.tracks.value.length" class="history-empty">
        这个平台暂时没有最近播放记录。
      </p>
      <div v-else class="history-tracks">
        <div
          v-for="track in visibleTracks"
          :key="`${track.source}:${track.id}`"
          class="history-track"
        >
          <CoverImg
            :cover="track.cover"
            :cover-source="track.coverSource"
            :identity="track.id"
            :alt="track.title"
          />
          <div>
            <strong>{{ track.title }}</strong
            ><small>{{ track.artist }} · {{ track.album }}</small>
          </div>
          <button type="button" :aria-label="`播放${track.title}`" @click="play(track)">
            <PlaybackIcon name="play" aria-hidden="true" />
          </button>
        </div>
        <nav v-if="history.tracks.value.length > 50" aria-label="平台历史分页">
          <button type="button" :disabled="page === 0" @click="page--">上一页</button
          ><span>{{ page + 1 }} / {{ Math.ceil(history.tracks.value.length / 50) }}</span
          ><button
            type="button"
            :disabled="(page + 1) * 50 >= history.tracks.value.length"
            @click="page++"
          >
            下一页
          </button>
        </nav>
      </div>
    </div>
  </section>
</template>

<style scoped>
.recent-playback-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 0;
}
.recent-playback-page :deep(.song-list) {
  height: 0 !important;
  flex: 1;
  min-height: 0;
  padding-top: 24px;
}
.recent-scope-tabs {
  position: relative;
  z-index: 51;
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  padding: 52px clamp(24px, 4vw, 60px) 0;
  flex-wrap: wrap;
}
button,
select {
  border: 1px solid var(--te-card-border);
  border-radius: 10px;
  background: var(--te-card-bg);
  color: var(--te-neutral-900);
  padding: 9px 14px;
  font: inherit;
  cursor: pointer;
}
button[aria-pressed='true'] {
  background: var(--te-navigation-active);
  color: var(--te-navigation-active-text);
}
button:focus-visible,
select:focus-visible {
  outline: 2px solid var(--te-navigation-indicator);
  outline-offset: 2px;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
.platform-history {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 24px clamp(24px, 4vw, 60px) 40px;
  color: var(--te-neutral-900);
}
.has-player .platform-history {
  padding-bottom: 130px;
}
header {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}
header > div {
  flex: 1;
}
h2 {
  margin: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 1.5);
}
p,
small {
  color: var(--te-neutral-600);
}
.history-empty {
  padding: 48px 0;
  text-align: center;
}
.history-empty button {
  margin: 8px;
}
.history-tracks {
  margin-top: 24px;
}
.history-track {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 12px;
  border-bottom: 1px solid var(--te-card-border);
}
.history-track > :first-child {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  flex-shrink: 0;
}
.history-track > div {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
strong,
small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
nav {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
  margin-top: 24px;
}
:global(html[data-te-shell-layout='custom'] .recent-playback-page) {
  height: 100%;
}
:global(html[data-te-shell-layout='custom'] .recent-scope-tabs) {
  padding-top: 20px;
}
</style>
