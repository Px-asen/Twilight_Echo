<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import CoverImg from '@renderer/components/CoverImg.vue'
import type { CoreQueueReference } from '../../../../shared/coreProtocol.ts'
import type { CoreQueuePage, CoreTrackView } from '../../../../shared/coreViews.ts'
import { formatClock, trackArtists } from './zonesPresentation.ts'

const props = defineProps<{
  queue: CoreQueueReference | null
  page: CoreQueuePage | null
  /** Core's current track; used before the first queue page arrives. */
  current: CoreTrackView | null
  playing: boolean
  scope: 'zone' | 'group'
  /** Loading a queue replaces it; members of a group must use the group's queue. */
  canLoad: boolean
  loading: boolean
  /** Bumped by the page to open the loader and focus its field ("选择音乐"). */
  openRequest: number
}>()
const emit = defineEmits<{ load: [search: string] }>()

const loaderOpen = ref(false)
const search = ref('')
const field = ref<HTMLInputElement | null>(null)

const rows = computed(() => {
  const queue = props.queue
  if (!queue) return []
  const items = props.page?.items ?? []
  if (items.length) {
    return items
      .filter((item) => item.position >= queue.index)
      .slice(0, 6)
      .map((item) => ({
        key: item.queueEntryId,
        track: item.track,
        current: item.position === queue.index
      }))
  }
  return props.current ? [{ key: 'current', track: props.current, current: true }] : []
})
const remaining = computed(() => {
  const queue = props.queue
  if (!queue) return 0
  return Math.max(0, queue.total - queue.index - rows.value.length)
})
const caption = computed(() => {
  const queue = props.queue
  if (!queue || queue.total === 0) return '尚未载入音乐'
  return `第 ${Math.min(queue.index + 1, queue.total)} / ${queue.total} 首`
})

async function openLoader(): Promise<void> {
  loaderOpen.value = true
  await nextTick()
  field.value?.focus()
}
function submit(): void {
  if (props.loading || !props.canLoad) return
  emit('load', search.value)
}

watch(
  () => props.openRequest,
  (value, previous) => {
    if (value !== previous && props.canLoad) void openLoader()
  }
)
watch(
  () => props.loading,
  (value, previous) => {
    // A finished load leaves the loader closed and the field clean.
    if (previous && !value) {
      loaderOpen.value = false
      search.value = ''
    }
  }
)
</script>

<template>
  <section class="zones-panel zone-queue" aria-labelledby="zone-queue-title">
    <header class="zones-panel-head">
      <div>
        <h3 id="zone-queue-title">队列</h3>
        <p>{{ caption }}</p>
      </div>
      <button
        v-if="canLoad && !loaderOpen"
        type="button"
        class="zones-text-button"
        @click="openLoader"
      >
        <i class="ph ph-list-plus" aria-hidden="true" />从曲库载入
      </button>
    </header>

    <ol v-if="rows.length" class="zone-queue-list">
      <li v-for="row in rows" :key="row.key" :class="{ 'is-current': row.current }">
        <span class="zone-queue-thumb">
          <CoverImg
            v-if="row.track"
            :core-track-id="row.track.id"
            :identity="row.track.id"
            size="sm"
            alt=""
            loading="lazy"
          >
            <template #placeholder>
              <span class="zone-queue-thumb-blank" aria-hidden="true">
                <i class="ph ph-music-note-simple" />
              </span>
            </template>
          </CoverImg>
          <span v-else class="zone-queue-thumb-blank" aria-hidden="true">
            <i class="ph ph-music-note-simple" />
          </span>
        </span>
        <span class="zone-queue-copy">
          <strong>{{ row.track?.title || '不可用的曲目' }}</strong>
          <small>{{ row.track ? trackArtists(row.track) || '未知艺术家' : '源文件已移除' }}</small>
        </span>
        <span v-if="row.current" class="zone-queue-now" :class="{ 'is-live': playing }">
          <span v-if="playing" class="zone-bars" aria-hidden="true"><i /><i /><i /></span>
          {{ playing ? '正在播放' : '当前' }}
        </span>
        <span v-else class="zone-queue-time">{{ formatClock(row.track?.duration) }}</span>
      </li>
    </ol>
    <div v-else class="zone-queue-empty">
      <span class="zone-queue-empty-glyph" aria-hidden="true"><i class="ph ph-queue" /></span>
      <p>{{ scope === 'group' ? '组队列为空' : '这个声区还没有队列' }}</p>
      <small>每个声区的队列彼此独立，载入后保持暂停待播。</small>
    </div>
    <p v-if="remaining > 0" class="zone-queue-more">之后还有 {{ remaining }} 首</p>

    <form v-if="canLoad && loaderOpen" class="zone-queue-loader" @submit.prevent="submit">
      <label :for="`zone-queue-search-${scope}`">从曲库载入新队列</label>
      <div class="zone-queue-loader-row">
        <span class="zone-search">
          <i class="ph ph-magnifying-glass" aria-hidden="true" />
          <input
            :id="`zone-queue-search-${scope}`"
            ref="field"
            v-model="search"
            type="search"
            maxlength="512"
            autocomplete="off"
            spellcheck="false"
            placeholder="曲名、艺术家或专辑；留空使用整个曲库"
            :disabled="loading"
          />
        </span>
        <button type="submit" class="zones-pill is-ink" :disabled="loading">
          <i v-if="loading" class="ph ph-circle-notch zones-spin" aria-hidden="true" />
          载入并暂停
        </button>
        <button
          type="button"
          class="zones-pill is-outline"
          :disabled="loading"
          @click="loaderOpen = false"
        >
          取消
        </button>
      </div>
      <p class="zones-hint">
        {{ scope === 'group' ? '替换整个同步组的队列' : '替换此声区的队列' }}，载入后保持暂停，不影响其他声区。
      </p>
    </form>
    <p v-else-if="!canLoad" class="zones-hint">此声区正在同步组中，请在同步组里更换队列。</p>
  </section>
</template>
