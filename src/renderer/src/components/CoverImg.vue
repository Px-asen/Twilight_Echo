<template>
  <slot v-if="!displayCover && $slots.placeholder" name="placeholder" />
  <img
    v-else-if="displayCover || fallback"
    :key="displayCover ? coverIdentityKey : `fb:${coverIdentityKey}`"
    :src="displayCover || fallback"
    :alt="alt"
    :class="[
      $attrs.class,
      { 'default-track-cover': !displayCover && fallback === DEFAULT_TRACK_COVER }
    ]"
    decoding="async"
    :loading="loading"
    @error="displayCover && onImageError($event)"
    @load="displayCover && onImageLoad()"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import DEFAULT_TRACK_COVER from '../assets/images/default-track-cover-light.webp'
import '../assets/default-track-cover.css'
import { coreArtworkEpoch, coreArtworkKey, readCoreArtwork } from '../stores/library/coreArtwork.ts'
import { recordCoverDiagnostic } from '../utils/coverDiagnostics.ts'
import {
  clearLocalCoverDataCache,
  invalidateRemoteCoverGrant,
  readCachedCover,
  resolveCover
} from '../utils/coverLoader.ts'

const props = withDefaults(
  defineProps<{
    cover?: string | null | undefined
    /** Durable remote origin used to re-grant expired twilight-media handles. */
    coverSource?: string | null | undefined
    /** Stable identity (track id) — changes force full remount + re-resolve. */
    identity?: string | null | undefined
    /** Core-owned local track identity; no source path or durable URL is required. */
    coreTrackId?: string
    /** Compact row ('sm', 128px) or card ('grid', 256px) thumbnails avoid decoding 500px bitmaps. */
    size?: 'sm' | 'grid' | 'md'
    alt?: string
    fallback?: string
    loading?: 'lazy' | 'eager'
  }>(),
  { fallback: DEFAULT_TRACK_COVER }
)

const emit = defineEmits<{ error: [event: Event] }>()

defineOptions({ inheritAttrs: false })

const displayCover = ref<string | null>(null)
const remountNonce = ref(0)
let requestId = 0
let retriedCover = false

const coverIdentityKey = computed(
  () =>
    `${props.identity ?? ''}:${props.cover ?? ''}:${props.coverSource ?? ''}:${remountNonce.value}`
)

async function reloadCover(preserveDisplay = false): Promise<void> {
  const id = ++requestId
  retriedCover = false
  // Never keep another identity's bitmap, but reuse this cover's resolved src
  // immediately when a virtualized card returns to the viewport.
  if (!preserveDisplay)
    displayCover.value = props.coreTrackId
      ? null
      : readCachedCover(props.cover, props.coverSource, props.size)

  const cover = typeof props.cover === 'string' ? props.cover.trim() : ''
  const source = typeof props.coverSource === 'string' ? props.coverSource.trim() : ''
  if (!cover && !source && !props.coreTrackId) {
    recordCoverDiagnostic('source.missing', null, null)
    return
  }

  try {
    const handle = props.coreTrackId ? await readCoreArtwork(props.coreTrackId) : cover || null
    const next = await resolveCover(handle, props.coreTrackId ? null : source || null, props.size)
    if (id !== requestId) return
    displayCover.value = next
    if (!next) recordCoverDiagnostic('resolve.empty', cover, source, {}, 'warn')
  } catch {
    if (id !== requestId) return
    recordCoverDiagnostic('resolve.failed', cover, source, {}, 'warn')
    displayCover.value = null
  }
}

watch(
  [
    () => props.identity,
    () => props.cover,
    () => props.coverSource,
    () => props.coreTrackId,
    () => props.size,
    () => (props.coreTrackId ? coreArtworkEpoch() : ''),
    () => (props.coreTrackId ? coreArtworkKey() : '')
  ],
  (current, previous) => {
    // Progress-only Core snapshots need no reload. A new library revision does,
    // but the same track in the same Core epoch keeps its decoded bitmap while
    // its artwork is revalidated. Identity/epoch changes still clear it at once.
    const preserveDisplay =
      !!current[3] &&
      !!current[5] &&
      current.slice(0, -1).every((value, index) => value === previous[index])
    if (!preserveDisplay) remountNonce.value += 1
    void reloadCover(preserveDisplay)
  },
  { immediate: true }
)

async function onImageError(event: Event): Promise<void> {
  const id = requestId
  const source =
    (typeof props.coverSource === 'string' && props.coverSource.trim()) ||
    (typeof props.cover === 'string' && /^https?:\/\//i.test(props.cover.trim())
      ? props.cover.trim()
      : '')
  recordCoverDiagnostic(
    'image.failed',
    displayCover.value,
    source,
    { retried: retriedCover },
    'warn'
  )
  // Recover an expired handle once per identity; a broken image must not loop.
  if (!retriedCover) {
    retriedCover = true
    try {
      if (props.coreTrackId) {
        const handle = await readCoreArtwork(props.coreTrackId, true)
        const next = await resolveCover(handle, null, props.size)
        if (id !== requestId) return
        if (next && next !== displayCover.value) {
          displayCover.value = next
          remountNonce.value += 1
          return
        }
      }
      if (source) {
        invalidateRemoteCoverGrant(source)
        const next = await resolveCover(null, source, props.size)
        if (id !== requestId) return
        recordCoverDiagnostic('retry.resolved', next, source, {
          sameHandle: next === displayCover.value,
          available: Boolean(next)
        })
        if (next && next !== displayCover.value) {
          displayCover.value = next
          remountNonce.value += 1
          return
        }
      }
      // Local protocol art: drop materialize cache and retry once.
      if (typeof props.cover === 'string' && /^cover:/i.test(props.cover)) {
        clearLocalCoverDataCache()
        const next = await resolveCover(props.cover, null, props.size)
        if (id !== requestId) return
        if (next && next !== displayCover.value) {
          displayCover.value = next
          remountNonce.value += 1
          return
        }
      }
    } catch {
      // Failed grants/materialization use the same local fallback as missing art.
    }
  }
  if (id !== requestId) return
  recordCoverDiagnostic(
    'fallback.shown',
    displayCover.value,
    source,
    { retried: retriedCover },
    'warn'
  )
  displayCover.value = null
  emit('error', event)
}

function onImageLoad(): void {
  if (retriedCover) recordCoverDiagnostic('image.recovered', displayCover.value, props.coverSource)
}
</script>
