<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import type { LibraryQuery } from '../../../../shared/libraryDatabase.ts'
import type { EntityMetadataLanguage } from '../../../../shared/entityMetadata.ts'
import { validMusicBrainzArtistId } from '../../../../shared/entityMetadata.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { useSettingsStore } from '../../stores/useSettingsStore.ts'
import { useLocale } from '../../app/useLocale.ts'
import { createLibraryCollectionPages } from '../../stores/library/libraryCollectionPages.ts'
import CoverImg from '../CoverImg.vue'
import ThemeIcon from '../ThemeIcon.vue'
import PlaybackIcon from '../icons/PlaybackIcon.vue'
import MetadataAttribution from '../music-metadata/MetadataAttribution.vue'
import ArtistImageCredit from '../music-metadata/ArtistImageCredit.vue'
import AlbumCard from './AlbumCard.vue'
import {
  artistProfileChoice,
  artistProfileChoices,
  saveArtistProfileChoice
} from '../music-metadata/artistProfileChoice.ts'
import {
  artistDetailPresentation,
  createArtistDetailView,
  type ArtistSection
} from './artistDetailView.ts'

const MusicExplorationPanel = defineAsyncComponent(
  () => import('../music-exploration/MusicExplorationPanel.vue')
)
const ArtistMetadataManager = defineAsyncComponent(() => import('./ArtistMetadataManager.vue'))
const ArtistIdentityPage = defineAsyncComponent(() => import('./ArtistIdentityPage.vue'))
const props = defineProps<{
  name: string
  section: ArtistSection
  play: (query: LibraryQuery, shuffle: boolean) => Promise<void> | void
}>()
const emit = defineEmits<{
  'update:section': [section: ArtistSection]
  openAlbum: [id: string]
  back: []
}>()
const core = useCoreConnection(),
  settings = useSettingsStore(),
  { locale } = useLocale()
const language = computed<EntityMetadataLanguage>(
  () =>
    settings.settings.value.musicIdentification.language ??
    (locale.value === 'en-US' ? 'en' : 'zh-Hans')
)
const view = createArtistDetailView({
  choice: artistProfileChoice,
  catalog: (query, signal) => core.query('catalog.query', query, signal),
  sources: (query, signal) => core.query('catalog.sources', query, signal),
  identity: (entityId, signal) => core.query('identification.detail', { entityId }, signal),
  detail: (entityId, language, sourceProvider, signal, includeAutomaticArtwork) =>
    core.query(
      'metadata.entity.detail',
      { entityId, language, sourceProvider, includeAutomaticArtwork },
      signal
    )
})
const state = view.state
const choiceError = ref('')
const savedChoice = computed(() => artistProfileChoice(props.name))
function rememberProfile(clear = false) {
  choiceError.value = ''
  try {
    const selected = state.value.selected,
      detail = state.value.detail
    if (!clear && (!selected || !detail || !state.value.exact)) return
    saveArtistProfileChoice(
      props.name,
      clear ? null : { entityId: selected!.id, targetId: detail!.targetId }
    )
  } catch (error) {
    choiceError.value = error instanceof Error ? error.message : String(error)
  }
}
const albums = createLibraryCollectionPages(
  { queryCollections: (kind, query) => core.query('library.collections', { kind, query }) },
  12
)
const albumState = albums.state
watch(
  () => props.section,
  (section) => {
    if (section === 'overview' && albumState.value.requestedPage !== 0) albums.goToPage(0)
  }
)
const stats = ref<{ total: number; revision: number } | null>(null),
  statsError = ref('')
let statsRequest: AbortController | null = null
async function readStats() {
  statsRequest?.abort()
  if (core.state.value?.phase !== 'ready') return
  const request = new AbortController()
  statsRequest = request
  statsError.value = ''
  try {
    const page = await core.query(
      'library.tracks',
      { artist: props.name, limit: 1 },
      request.signal
    )
    if (statsRequest === request) stats.value = { total: page.total, revision: page.revision }
  } catch (error) {
    if (statsRequest === request) {
      stats.value = null
      statsError.value = error instanceof Error ? error.message : String(error)
    }
  }
}
const expanded = ref(false),
  managerOpened = ref(false),
  now = ref(Date.now())
let expiryTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () =>
    JSON.stringify([
      props.name,
      language.value,
      core.state.value?.epoch,
      core.state.value?.phase,
      artistProfileChoices.value[props.name]
    ]),
  () => {
    const name = core.state.value?.phase === 'ready' ? props.name : null
    statsRequest?.abort()
    statsRequest = null
    stats.value = null
    expanded.value = false
    choiceError.value = ''
    void view.setContext(name, language.value)
    albums.setQuery(name ? 'albums' : null, {
      artist: props.name,
      collectionSort: 'label',
      direction: 'asc'
    })
    if (name) void readStats()
  },
  { immediate: true }
)
watch(
  [
    () => core.state.value?.catalogRevision,
    () => core.state.value?.libraryRevision,
    () =>
      core.state.value?.entityMetadataContentRevision ?? core.state.value?.entityMetadataRevision,
    () => core.state.value?.settingsRevision
  ],
  (value, previous) => {
    void view.refresh(value[3] !== previous[3])
    if (value[1] !== previous[1]) {
      albums.invalidate()
      void readStats()
    }
  }
)
watch(
  () => state.value.detail,
  (detail) => {
    clearTimeout(expiryTimer)
    const expire = () => {
      now.value = Date.now()
      const future = [...(detail?.facts ?? []), ...(detail?.artwork ?? [])].flatMap((item) =>
        item.usage?.expiresAt !== undefined && item.usage.expiresAt > now.value
          ? [item.usage.expiresAt]
          : []
      )
      if (future.length)
        expiryTimer = setTimeout(
          expire,
          Math.min(2147483647, Math.max(1, Math.min(...future) - now.value))
        )
    }
    expire()
  },
  { immediate: true }
)
watch([() => state.value.selected?.id, () => state.value.shared], () => {
  expanded.value = false
})
const presentation = computed(() =>
  artistDetailPresentation(
    state.value.detail,
    state.value.shared,
    props.name,
    language.value,
    now.value
  )
)
const tabs: Array<{ key: ArtistSection; label: string }> = [
  { key: 'overview', label: '概览' },
  { key: 'albums', label: '专辑' },
  { key: 'songs', label: '歌曲' },
  { key: 'participation', label: '参与作品' },
  { key: 'identity', label: '人物身份' }
]
const scope = computed(() =>
  JSON.stringify(['artist-page', props.name, language.value, core.state.value?.epoch])
)
const participationId = computed(() =>
  state.value.detail?.link?.state === 'confirmed' &&
  validMusicBrainzArtistId(state.value.detail.link.mbid)
    ? state.value.detail.link.mbid.toLowerCase()
    : null
)
const playing = ref(false),
  playbackError = ref('')
async function startPlayback(shuffle: boolean) {
  if (!stats.value?.total || playing.value) return
  playing.value = true
  playbackError.value = ''
  try {
    await props.play(
      {
        artist: props.name,
        contentRevision: stats.value.revision,
        sort: 'title',
        direction: 'asc'
      },
      shuffle
    )
  } catch (error) {
    playbackError.value = error instanceof Error ? error.message : String(error)
  } finally {
    playing.value = false
  }
}
function switchTab(event: KeyboardEvent, index: number) {
  const next =
    event.key === 'ArrowRight'
      ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft'
        ? (index + tabs.length - 1) % tabs.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : null
  if (next === null) return
  event.preventDefault()
  emit('update:section', tabs[next].key)
  const buttons = (
    event.currentTarget as HTMLElement
  ).parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')
  buttons?.[next]?.focus()
}
onBeforeUnmount(() => {
  statsRequest?.abort()
  statsRequest = null
  clearTimeout(expiryTimer)
  view.dispose()
  albums.dispose()
})
</script>

<template>
  <section class="artist-detail-page" aria-labelledby="local-artist-title">
    <header class="artist-hero" :class="{ 'has-portrait': !!presentation.cover }">
      <div class="artist-hero-copy">
        <button
          type="button"
          class="artist-eyebrow artist-back"
          @click="emit('back')"
          aria-label="返回艺术家列表"
        >
          音乐库 / 艺术家 <i class="ph ph-arrow-up-left" aria-hidden="true"></i>
        </button>
        <h2 id="local-artist-title" :title="presentation.name">{{ presentation.name }}</h2>
        <p v-if="presentation.name !== name" class="artist-original-name">{{ name }}</p>
        <p class="artist-library-stats">
          <span>{{ albumState.total === null ? '—' : albumState.total }} 张本地专辑</span
          ><span aria-hidden="true">/</span
          ><span>{{ stats === null ? '—' : stats.total }} 首歌曲</span>
        </p>
        <div class="artist-hero-actions" aria-label="艺术家播放控制">
          <button
            type="button"
            class="artist-play-primary"
            :disabled="!stats?.total || playing"
            @click="startPlayback(false)"
          >
            <PlaybackIcon name="play" />播放全部
          </button>
          <button
            type="button"
            class="artist-play-secondary"
            :disabled="!stats?.total || playing"
            @click="startPlayback(true)"
          >
            <i class="ph ph-shuffle" aria-hidden="true"></i>随机播放
          </button>
        </div>
      </div>
      <div class="artist-portrait">
        <CoverImg
          v-if="presentation.cover"
          :cover="presentation.cover"
          :identity="presentation.cover"
          size="grid"
          :alt="`${presentation.name} · 人物照片`"
          fallback=""
          loading="eager"
        >
          <template #placeholder
            ><div class="artist-portrait-placeholder">
              <ThemeIcon icon-slot="library.artist" /><span>人物照片暂不可用</span>
            </div></template
          >
        </CoverImg>
        <div v-else class="artist-portrait-placeholder">
          <ThemeIcon icon-slot="library.artist" /><span>{{
            state.loading
              ? '正在读取人物资料…'
              : state.error
                ? '人物资料读取失败'
                : presentation.hiddenImage
                  ? '已隐藏人物照片'
                  : '暂无人物照片'
          }}</span>
        </div>
        <ArtistImageCredit
          v-if="presentation.attribution"
          :attribution="presentation.attribution"
        />
      </div>
    </header>
    <p v-if="savedChoice && (!state.selected || state.shared)" class="artist-inline-status">
      已保存一个人物资料选择。
      <button type="button" class="artist-text-button" @click="rememberProfile(true)">
        恢复自动选择
      </button>
    </p>
    <p v-if="statsError" class="artist-inline-status" role="alert">
      音乐库统计读取失败：{{ statsError }} <button type="button" @click="readStats()">重试</button>
    </p>
    <p v-if="playbackError" class="artist-inline-status" role="alert">
      播放失败：{{ playbackError }}
    </p>
    <div class="artist-navigation-row">
      <nav class="artist-section-tabs" role="tablist" aria-label="艺术家详情分区">
        <button
          v-for="(tab, index) in tabs"
          :id="`artist-tab-${tab.key}`"
          :key="tab.key"
          type="button"
          role="tab"
          :aria-selected="section === tab.key"
          :tabindex="section === tab.key ? 0 : -1"
          :aria-controls="`artist-panel-${tab.key}`"
          @click="emit('update:section', tab.key)"
          @keydown="switchTab($event, index)"
        >
          {{ tab.label
          }}<span v-if="tab.key === 'albums' && albumState.total !== null">{{
            albumState.total
          }}</span
          ><span v-if="tab.key === 'songs' && stats !== null">{{ stats.total }}</span>
        </button>
      </nav>
    </div>
    <details
      class="artist-manage-disclosure"
      @toggle="managerOpened ||= ($event.target as HTMLDetailsElement).open"
    >
      <summary>管理资料 <i class="ph ph-sliders-horizontal" aria-hidden="true"></i></summary>
      <p class="artist-scope-note">
        未识别时，可在“人物身份”中核对当前条目，再更新资料。
        资料源没有收录的人物可手动设置图片和介绍；无公开照片的乐团保留人物占位。
      </p>
      <ArtistMetadataManager
        v-if="managerOpened"
        :detail="state.detail"
        :shared="state.shared"
        :language="language"
        :scope="scope"
        :available="!state.loading && !state.error"
        :refresh="view.refresh"
        @edit="state.selected && view.select(state.selected)"
      />
    </details>
    <p v-if="state.error" class="artist-inline-status" role="alert">
      人物资料读取失败：{{ state.error }}
      <button type="button" @click="view.refresh()">重试</button>
    </p>
    <div
      v-if="section === 'overview' || section === 'albums'"
      :id="`artist-panel-${section}`"
      role="tabpanel"
      :aria-labelledby="`artist-tab-${section}`"
      :aria-busy="state.loading || albumState.loading"
    >
      <div v-if="section === 'overview'" class="artist-overview">
        <div class="artist-biography-grid">
          <section class="artist-biography" aria-label="艺术家简介">
            <span class="artist-section-kicker">关于艺术家</span>
            <h3>音乐背后的人</h3>
            <p
              v-if="presentation.introduction"
              class="artist-biography-text"
              :class="{ collapsed: !expanded && presentation.introduction.value.length > 280 }"
              :lang="presentation.introduction.language"
            >
              {{ presentation.introduction.value }}
            </p>
            <p v-else class="artist-empty-copy">
              {{
                state.loading
                  ? '正在读取人物资料…'
                  : presentation.hiddenIntroduction
                    ? '已隐藏介绍'
                    : state.detail?.link?.state === 'confirmed'
                      ? '暂无可用的艺术家简介。'
                      : state.selected
                        ? '尚未确认人物身份，可在人物身份中核对，或在管理资料中填写介绍。'
                        : '暂无已保存的人物资料，可在管理资料中查看可用操作。'
              }}
            </p>
            <button
              v-if="presentation.introduction && presentation.introduction.value.length > 280"
              type="button"
              class="artist-text-button"
              :aria-expanded="expanded"
              @click="expanded = !expanded"
            >
              {{ expanded ? '收起简介' : '展开全文' }}
              <i :class="expanded ? 'ph ph-caret-up' : 'ph ph-caret-down'" aria-hidden="true"></i>
            </button>
            <div v-if="presentation.introduction" class="artist-biography-attribution">
              <MetadataAttribution
                v-if="presentation.introduction.attribution"
                :attribution="presentation.introduction.attribution"
              /><span v-else>{{
                presentation.introduction.origin === 'manual' ? '手工介绍' : '历史导入资料'
              }}</span
              ><span>
                ·
                {{
                  presentation.introduction.language === 'und'
                    ? '原文'
                    : presentation.introduction.language
                }}</span
              >
            </div>
          </section>
          <aside class="artist-library-aside" aria-label="人物与音乐库信息">
            <span class="artist-section-kicker">你的收藏</span>
            <dl>
              <div>
                <dt>本地专辑</dt>
                <dd>{{ albumState.total ?? '—' }}</dd>
              </div>
              <div>
                <dt>歌曲</dt>
                <dd>{{ stats?.total ?? '—' }}</dd>
              </div>
              <div v-if="presentation.country">
                <dt>地区</dt>
                <dd>{{ presentation.country.value }}</dd>
              </div>
            </dl>
            <MetadataAttribution
              v-if="presentation.country"
              :attribution="presentation.country.attribution"
            />
          </aside>
        </div>
      </div>
      <section
        class="artist-discography"
        aria-label="艺术家本地专辑"
        :aria-busy="albumState.loading"
      >
        <header class="artist-section-heading">
          <div>
            <span class="artist-section-kicker">在音乐库中</span>
            <h3>
              本地专辑<span v-if="albumState.total !== null">{{ albumState.total }}</span>
            </h3>
          </div>
          <button
            v-if="section === 'overview' && (albumState.total ?? 0) > 6"
            type="button"
            class="artist-text-button"
            @click="emit('update:section', 'albums')"
          >
            查看全部 <i class="ph ph-arrow-right" aria-hidden="true"></i>
          </button>
        </header>
        <p v-if="albumState.error" role="alert">
          专辑读取失败：{{ albumState.error }}
          <button type="button" class="artist-text-button" @click="albums.retry()">重试</button>
        </p>
        <p
          v-else-if="albumState.loading && !albumState.page"
          class="artist-empty-copy"
          role="status"
        >
          正在读取本地专辑…
        </p>
        <p v-else-if="albumState.total === 0" class="artist-empty-copy">
          音乐库中暂无这位艺术家的专辑。
        </p>
        <div v-else class="artist-album-grid">
          <AlbumCard
            v-for="album in (section === 'overview'
              ? albumState.page?.items.slice(0, 6)
              : albumState.page?.items) ?? []"
            :key="album.id"
            :album="album"
            :show-track-count="false"
            @open="emit('openAlbum', album.id)"
          />
        </div>
        <nav
          v-if="section === 'albums' && (albumState.total ?? 0) > 12"
          class="artist-album-pagination"
          aria-label="艺术家专辑分页"
        >
          <button
            type="button"
            :disabled="albumState.loading || albumState.requestedPage === 0"
            @click="albums.goToPage(albumState.requestedPage - 1)"
          >
            上一页专辑</button
          ><span
            >{{ albumState.requestedPage + 1 }} /
            {{ Math.ceil((albumState.total ?? 0) / 12) }}</span
          ><button
            type="button"
            :disabled="
              albumState.loading || (albumState.requestedPage + 1) * 12 >= (albumState.total ?? 0)
            "
            @click="albums.goToPage(albumState.requestedPage + 1)"
          >
            下一页专辑
          </button>
        </nav>
      </section>
    </div>
    <section
      v-if="section === 'identity'"
      id="artist-panel-identity"
      role="tabpanel"
      aria-labelledby="artist-tab-identity"
    >
      <ArtistIdentityPage
        :page="state.page"
        :samples="state.samples"
        :identities="state.identities"
        :selected="state.selected?.id ?? null"
        :shared="state.shared"
        :exact="state.exact"
        :loading="state.loading"
        :scope="scope"
        @select="view.select"
        @page="view.page"
        @changed="view.refresh()"
      >
        <div v-if="state.exact && state.selected" class="artist-profile-choice">
          <button
            v-if="savedChoice?.entityId !== state.selected.id || state.shared"
            type="button"
            class="artist-text-button"
            :disabled="state.loading || !state.detail"
            @click="rememberProfile()"
          >
            用于艺术家资料
          </button>
          <span v-else>已用于艺术家资料</span>
          <button
            v-if="savedChoice"
            type="button"
            class="artist-text-button"
            @click="rememberProfile(true)"
          >
            恢复自动选择
          </button>
        </div>
        <p v-if="choiceError" class="artist-inline-status" role="alert">{{ choiceError }}</p>
      </ArtistIdentityPage>
    </section>
    <section
      v-if="section === 'participation'"
      id="artist-panel-participation"
      class="artist-participation"
      role="tabpanel"
      aria-labelledby="artist-tab-participation"
    >
      <MusicExplorationPanel
        v-if="participationId"
        :reference="{
          provider: 'musicbrainz',
          kind: 'artist',
          idType: 'mbid',
          value: participationId
        }"
        :scope="scope"
      />
      <template v-else
        ><h3>参与作品</h3>
        <p class="artist-empty-copy">
          {{ state.loading ? '正在读取人物身份…' : '确认人物身份后，可浏览已有的参与作品资料。' }}
        </p>
      </template>
    </section>
  </section>
</template>

<style scoped src="./ArtistDetailPage.css"></style>
