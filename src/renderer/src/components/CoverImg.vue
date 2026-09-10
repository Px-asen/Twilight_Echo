<template>
  <img
    v-if="displayCover"
    :key="coverIdentityKey"
    :src="displayCover"
    :alt="alt"
    :class="$attrs.class"
    decoding="async"
    :loading="loading"
    @error="onImageError"
  />
  <slot v-else name="placeholder">
    <img
      v-if="fallback"
      :key="`fb:${coverIdentityKey}`"
      :src="fallback"
      :alt="alt"
      :class="$attrs.class"
    />
  </slot>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  clearLocalCoverDataCache,
  invalidateRemoteCoverGrant,
  resolveCover
} from '../utils/coverLoader.ts'

const props = defineProps<{
  cover: string | null | undefined
  /** Durable remote origin used to re-grant expired twilight-media handles. */
  coverSource?: string | null | undefined
  /** Stable identity (track id) — changes force full remount + re-resolve. */
  identity?: string | null | undefined
  alt?: string
  fallback?: string
  loading?: 'lazy' | 'eager'
}>()

const emit = defineEmits<{ error: [event: Event] }>()

defineOptions({ inheritAttrs: false })

const displayCover = ref<string | null>(null)
const failed = ref(false)
const remountNonce = ref(0)
let requestId = 0

const coverIdentityKey = computed(
  () =>
    `${props.identity ?? ''}:${props.cover ?? ''}:${props.coverSource ?? ''}:${remountNonce.value}`
)

async function reloadCover(): Promise<void> {
  const id = ++requestId
  failed.value = false
  // Blank first so Chromium cannot keep the previous bitmap while we resolve.
  displayCover.value = null

  const cover = typeof props.cover === 'string' ? props.cover.trim() : ''
  const source = typeof props.coverSource === 'string' ? props.coverSource.trim() : ''
  if (!cover && !source) return

  try {
    const next = await resolveCover(cover || null, source || null)
    if (id !== requestId) return
    displayCover.value = next
  } catch {
    if (id !== requestId) return
    displayCover.value = null
    failed.value = true
  }
}

watch(
  () => [props.identity, props.cover, props.coverSource] as const,
  () => {
    remountNonce.value += 1
    void reloadCover()
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
  if (source) {
    invalidateRemoteCoverGrant(source)
    const next = await resolveCover(null, source)
    if (id !== requestId) return
    if (next && next !== displayCover.value) {
      displayCover.value = next
      remountNonce.value += 1
      return
    }
  }
  // Local protocol art: drop materialize cache and retry once.
  if (typeof props.cover === 'string' && /^cover:/i.test(props.cover)) {
    clearLocalCoverDataCache()
    const next = await resolveCover(props.cover, null)
    if (id !== requestId) return
    if (next && next !== displayCover.value) {
      displayCover.value = next
      remountNonce.value += 1
      return
    }
  }
  failed.value = true
  displayCover.value = null
  emit('error', event)
}
</script>
