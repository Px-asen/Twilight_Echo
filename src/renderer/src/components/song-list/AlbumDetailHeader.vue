<script setup lang="ts">
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { GridItem } from './types'
import AlbumArtwork from './AlbumArtwork.vue'
import { formatReleaseDate } from '../../../../shared/releaseDate.ts'
import { resolveCover } from '../../utils/coverLoader.ts'
import { extractAverageColor, normalizeAccentColor } from '../../utils/colorExtractor.ts'
import { useAlbumReleaseDate } from './albumReleaseDate.ts'
import MetadataAttribution from '../music-metadata/MetadataAttribution.vue'

const props = defineProps<{
  album: GridItem
  durationText: string
  canPlay: boolean
  genres?: string[]
  formatText?: string
  typeText?: string
  favorited?: boolean | null
  favoritePending?: boolean
  showOverview?: boolean
}>()
const emit = defineEmits<{
  play: []
  shuffle: []
  favorite: []
  addToPlaylist: []
  openVersions: []
  openGenre: [genre: string]
  openArtist: [artist: string]
}>()
const tint = ref<string | null>(null)
const releaseDate = useAlbumReleaseDate(() => props.album)
const menuOpen = ref(false)
const menuRoot = ref<HTMLElement | null>(null)
const menuTrigger = ref<HTMLButtonElement | null>(null)
const menuAction = ref<HTMLButtonElement | null>(null)
const displayTypeText = computed(
  () => props.typeText || (props.album.compilation ? '合辑' : '专辑')
)
const displayGenres = computed(() => {
  if (props.genres && props.genres.length > 0) return props.genres
  if (props.album.genre) {
    return props.album.genre
      .split(/[/,;，；、|]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
})
const conciseIntroText = computed(() => {
  const artist = props.album.artist || '未知歌手'
  const release = formatReleaseDate(releaseDate.value)
  const releaseClause = release && release !== '发行时间未知' ? `，发行于 ${release}` : ''
  const trackCount = props.album.trackCount ?? props.album.tracks?.length ?? 0
  const durationClause = props.durationText ? `，总时长 ${props.durationText}` : ''
  const genreClause =
    displayGenres.value.length > 0
      ? `，流派涵盖 ${displayGenres.value.slice(0, 3).join(' / ')}`
      : ''
  return `《${props.album.name}》由 ${artist} 演绎${releaseClause}。本${displayTypeText.value}共收录 ${trackCount} 首曲目${durationClause}${genreClause}。`
})
const ambientStyle = computed(() => (tint.value ? { '--album-tint': tint.value } : {}))
let generation = 0
watch(
  [() => props.album.id, () => props.album.cover, () => props.album.coverSource],
  async () => {
    const request = ++generation
    tint.value = null
    menuOpen.value = false
    if (!props.album.cover && !props.album.coverSource) return
    try {
      const cover = await resolveCover(props.album.cover, props.album.coverSource)
      if (!cover || request !== generation) return
      const color = await extractAverageColor(cover)
      if (request === generation && color) {
        tint.value = normalizeAccentColor(color)
      }
    } catch {
      /* Neutral theme background is the fallback for unreadable artwork. */
    }
  },
  { immediate: true }
)
function dismissMenu(event: PointerEvent): void {
  if (!menuRoot.value?.contains(event.target as Node)) menuOpen.value = false
}
function closeMenu(): void {
  menuOpen.value = false
  menuTrigger.value?.focus()
}
function openVersions(): void {
  closeMenu()
  emit('openVersions')
}
async function focusMenu(): Promise<void> {
  menuOpen.value = true
  await nextTick()
  menuAction.value?.focus()
}
onMounted(() => document.addEventListener('pointerdown', dismissMenu))
onBeforeUnmount(() => {
  generation++
  document.removeEventListener('pointerdown', dismissMenu)
})
</script>

<template>
  <section class="album-detail-header" :style="ambientStyle" aria-labelledby="local-album-title">
    <div class="album-header-grid">
      <AlbumArtwork
        class="album-detail-artwork"
        :cover="album.cover"
        :cover-source="album.coverSource"
        :identity="album.id"
        :name="album.name"
        eager
      />
      <div class="album-detail-information">
        <div class="album-kicker-row">
          <span class="album-type-label">{{ displayTypeText }}</span>
          <span class="album-kicker-dot" aria-hidden="true">·</span>
          <p class="album-detail-release">{{ formatReleaseDate(releaseDate) }}<template
            v-if="!album.releaseDate && releaseDate && album.metadataReleaseDate"
          > · <MetadataAttribution :attribution="album.metadataReleaseDate.attribution" /></template></p>
        </div>
        <h2 id="local-album-title" class="album-detail-title" :title="album.name">
          {{ album.name }}
        </h2>
        <button
          type="button"
          class="album-detail-artist"
          :title="album.artist || '未知歌手'"
          :disabled="!album.artist || album.artist === '未知歌手'"
          @click="$emit('openArtist', album.artist!)"
        >
          {{ album.artist || '未知歌手' }}
          <i
            v-if="album.artist && album.artist !== '未知歌手'"
            class="pi pi-angle-right"
            aria-hidden="true"
          ></i>
        </button>
        <div class="album-meta-row">
          <p class="album-detail-stats">
            {{ album.trackCount ?? album.tracks?.length ?? 0 }} 首<span v-if="durationText">
              · {{ durationText }}</span
            ><span v-if="formatText"> · {{ formatText }}</span>
          </p>
          <div class="album-genre-pills" role="list" aria-label="专辑流派与分类">
            <template v-if="displayGenres.length">
              <button
                v-for="genre in displayGenres"
                :key="genre"
                type="button"
                role="listitem"
                class="genre-pill"
                @click="$emit('openGenre', genre)"
              >
                {{ genre }}
              </button>
            </template>
          </div>
        </div>
        <div class="album-detail-actions">
          <button
            type="button"
            class="album-play-primary"
            :disabled="!canPlay"
            @click="$emit('play')"
          >
            <PlaybackIcon name="play" aria-hidden="true" />播放全部
          </button>
          <button
            type="button"
            class="album-play-secondary"
            :disabled="!canPlay"
            @click="$emit('shuffle')"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                d="M3 6h2c5 0 9 12 14 12h2m-4-4 4 4-4 4M3 18h2c1.8 0 3.5-1.6 5.2-4M14 9c1.7-1.9 3.3-3 5-3h2m-4-4 4 4-4 4"
              /></svg
            >随机播放
          </button>
          <button
            type="button"
            class="album-favorite-btn"
            :class="{ 'is-favorited': !!favorited }"
            :aria-pressed="favorited === null ? 'mixed' : !!favorited"
            :disabled="!canPlay || favoritePending"
            :title="
              favorited === null
                ? '收藏状态待确认，点击切换收藏'
                : favorited
                  ? '取消收藏专辑'
                  : '收藏专辑'
            "
            @click="$emit('favorite')"
          >
            <i :class="favorited ? 'pi pi-heart-fill' : 'pi pi-heart'" aria-hidden="true"></i>
            <span>{{ favorited ? '已收藏' : '收藏' }}</span>
          </button>
          <button
            type="button"
            class="album-playlist-btn"
            :disabled="!canPlay"
            title="加入歌单"
            aria-label="加入歌单"
            @click="$emit('addToPlaylist')"
          >
            <i class="pi pi-plus" aria-hidden="true"></i><span>加入歌单</span>
          </button>
          <div ref="menuRoot" class="album-more" @keydown.esc.stop.prevent="closeMenu">
            <button
              ref="menuTrigger"
              type="button"
              class="album-more-trigger"
              aria-label="更多专辑操作"
              aria-haspopup="menu"
              :aria-expanded="menuOpen"
              @click="menuOpen ? closeMenu() : focusMenu()"
              @keydown.down.prevent="focusMenu"
            >
              <i class="pi pi-ellipsis-h" aria-hidden="true"></i><span>更多</span>
            </button>
            <div v-if="menuOpen" class="album-more-menu" role="menu" aria-label="更多专辑操作">
              <button
                ref="menuAction"
                type="button"
                role="menuitem"
                class="album-versions-btn"
                @click="openVersions"
              >
                <i class="pi pi-clone" aria-hidden="true"></i>专辑版本管理
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="showOverview" class="album-standalone-overview" aria-label="专辑简洁资料">
      <div class="standalone-prose">
        <p class="standalone-intro">{{ conciseIntroText }}</p>
      </div>
      <dl class="standalone-specs">
        <div class="spec-row">
          <dt>时长</dt>
          <dd>{{ durationText || `${album.trackCount ?? 0} 首` }}</dd>
        </div>
        <div class="spec-row">
          <dt>类型</dt>
          <dd>{{ displayTypeText }}</dd>
        </div>
        <div v-if="formatText" class="spec-row">
          <dt>格式</dt>
          <dd class="spec-format"><span class="format-spark">✦</span>{{ formatText }}</dd>
        </div>
      </dl>
    </div>
  </section>
</template>

<style scoped>
.album-detail-header {
  --album-tint: var(--te-neutral-500);
  margin-bottom: 26px;
  color: var(--te-neutral-900);
}
.album-header-grid {
  display: grid;
  grid-template-columns: 192px minmax(0, 1fr);
  align-items: center;
  gap: 32px;
}
.album-detail-artwork {
  width: 192px;
  border-radius: 10px;
  box-shadow: 0 8px 22px color-mix(in srgb, var(--album-tint) 14%, transparent);
}
.album-detail-information {
  min-width: 0;
}
.album-kicker-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  color: var(--te-neutral-500);
  font-size: calc(var(--te-font-size-body, 14px) * 0.86);
  line-height: 1.5;
}
.album-type-label {
  font-weight: 500;
}
.album-kicker-dot {
  opacity: 0.6;
}
.album-detail-release {
  margin: 0;
}
.album-detail-title {
  margin: 0 0 10px;
  font-family: var(--te-font-display, inherit);
  font-size: clamp(28px, 2.5vw, 38px);
  font-weight: 700;
  letter-spacing: -0.035em;
  line-height: 1.22;
  color: var(--te-neutral-900);
  overflow-wrap: anywhere;
  text-wrap: pretty;
}
.album-detail-artist {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  max-width: 100%;
  margin: 0 0 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--te-primary-600);
  font: inherit;
  font-size: var(--te-font-size-body, 14px);
  line-height: 1.5;
  font-weight: 500;
  text-align: left;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.album-detail-artist i {
  font-size: 11px;
  opacity: 0.65;
}
.album-detail-artist:hover:not(:disabled) {
  text-decoration: underline;
  text-underline-offset: 4px;
}
.album-detail-artist:disabled {
  cursor: default;
  color: var(--te-neutral-500);
}
.album-meta-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
}
.album-detail-stats {
  margin: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 0.93);
  line-height: 1.6;
  color: var(--te-neutral-500);
}
.album-genre-pills {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.genre-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border: 1px solid var(--te-card-border);
  border-radius: 4px;
  background: transparent;
  color: var(--te-neutral-600);
  font: inherit;
  font-size: calc(var(--te-font-size-body, 14px) * 0.8);
  line-height: 1.5;
  cursor: pointer;
}
.genre-pill:hover {
  background: var(--te-subtle-bg);
  color: var(--te-primary-600);
}
.album-detail-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin-top: 20px;
}
.album-detail-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 38px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--te-neutral-700);
  font: inherit;
  font-size: calc(var(--te-font-size-body, 14px) * 0.93);
  font-weight: 500;
  cursor: pointer;
  transition:
    background-color 150ms ease,
    color 150ms ease;
}
.album-detail-actions svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.album-detail-actions i {
  font-size: 14px;
}
.album-detail-actions .album-play-primary {
  padding-inline: 17px;
  margin-right: 3px;
  color: var(--te-on-accent, #fff);
  background: var(--te-primary-500);
  font-weight: 600;
}
.album-favorite-btn.is-favorited {
  color: var(--te-favorite-500, var(--te-primary-500));
}
.album-more {
  position: relative;
}
.album-detail-actions .album-more-trigger {
  padding-inline: 9px;
  color: var(--te-neutral-500);
}
.album-more-menu {
  position: absolute;
  left: 0;
  top: calc(100% + 8px);
  z-index: 15;
  width: max-content;
  max-width: min(260px, 80vw);
  padding: 5px;
  border: 1px solid var(--te-card-border);
  border-radius: 9px;
  background: var(--te-card-bg);
  box-shadow: 0 8px 26px rgb(0 0 0 / 12%);
}
.album-detail-actions .album-more-menu button {
  width: 100%;
  border-radius: 5px;
  text-align: left;
  justify-content: flex-start;
}
.album-detail-actions button:focus-visible,
.genre-pill:focus-visible,
.album-detail-artist:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
.album-detail-actions button:disabled {
  cursor: default;
  opacity: 0.45;
}
.album-standalone-overview {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 250px;
  gap: 32px;
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--te-card-border);
}
.standalone-intro {
  margin: 0;
  line-height: 1.8;
  color: var(--te-neutral-700);
}
.standalone-specs {
  display: grid;
  gap: 8px;
  margin: 0;
}
.spec-row {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  gap: 10px;
  font-size: 13px;
}
.spec-row dt {
  color: var(--te-neutral-500);
}
.spec-row dd {
  margin: 0;
}
.format-spark {
  color: var(--te-primary-500);
}
@media (hover: hover) and (pointer: fine) {
  .album-detail-actions .album-play-primary:hover:not(:disabled) {
    background: var(--te-primary-600);
  }
  .album-detail-actions button:not(.album-play-primary):hover:not(:disabled) {
    background: var(--te-subtle-bg);
    color: var(--te-neutral-900);
  }
}
@container te-song-list (max-width: 1000px) {
  .album-header-grid {
    grid-template-columns: 168px minmax(0, 1fr);
    gap: 26px;
  }
  .album-detail-artwork {
    width: 168px;
  }
  .album-detail-title {
    font-size: 29px;
  }
}
@container te-song-list (max-width: 640px) {
  .album-detail-header {
    margin-bottom: 22px;
  }
  .album-header-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 22px;
  }
  .album-detail-artwork {
    width: 160px;
  }
  .album-detail-title {
    font-size: 27px;
  }
  .album-detail-actions {
    gap: 5px;
    margin-top: 16px;
  }
  .album-detail-actions button {
    padding-inline: 9px;
  }
  .album-standalone-overview {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (prefers-reduced-motion: reduce) {
  .album-detail-actions button {
    transition: none;
  }
}
</style>
