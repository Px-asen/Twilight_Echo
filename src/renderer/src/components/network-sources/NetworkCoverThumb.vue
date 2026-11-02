<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'

const props = defineProps<{
  profileId: string
  entryId: string
}>()

const MAX_THUMB_CACHE = 128
const THUMB_EDGE_PX = 96
const INLINE_PASSTHROUGH_CHARS = 16_384
const thumbCache = new Map<string, string>()

function cacheThumb(key: string, value: string): void {
  thumbCache.delete(key)
  thumbCache.set(key, value)
  if (thumbCache.size > MAX_THUMB_CACHE) {
    const oldest = thumbCache.keys().next().value
    if (oldest !== undefined) thumbCache.delete(oldest)
  }
}

async function downscaleCoverDataUrl(dataUrl: string): Promise<string> {
  if (
    dataUrl.length <= INLINE_PASSTHROUGH_CHARS ||
    typeof document === 'undefined' ||
    typeof Image === 'undefined'
  ) {
    return dataUrl
  }
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const sw = img.naturalWidth || img.width
        const sh = img.naturalHeight || img.height
        if (sw <= THUMB_EDGE_PX && sh <= THUMB_EDGE_PX) {
          img.removeAttribute('src')
          resolve(dataUrl)
          return
        }
        const canvas = document.createElement('canvas')
        canvas.width = THUMB_EDGE_PX
        canvas.height = THUMB_EDGE_PX
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          img.removeAttribute('src')
          resolve(dataUrl)
          return
        }
        const crop = Math.min(sw, sh)
        const sx = Math.max(0, (sw - crop) * 0.5)
        const sy = Math.max(0, (sh - crop) * 0.5)
        ctx.drawImage(img, sx, sy, crop, crop, 0, 0, THUMB_EDGE_PX, THUMB_EDGE_PX)
        const compact = canvas.toDataURL('image/jpeg', 0.82)
        canvas.width = 0
        canvas.height = 0
        img.removeAttribute('src')
        resolve(compact.length < dataUrl.length ? compact : dataUrl)
      } catch {
        img.removeAttribute('src')
        resolve(dataUrl)
      }
    }
    img.onerror = () => {
      img.removeAttribute('src')
      resolve(dataUrl)
    }
    img.src = dataUrl
  })
}

const src = ref('')
const core = useCoreConnection()
let disposed = false

onMounted(async () => {
  const key = `${props.profileId}:${props.entryId}`
  const cached = thumbCache.get(key)
  if (cached) {
    thumbCache.delete(key)
    thumbCache.set(key, cached)
    src.value = cached
    return
  }
  const result = await core.query('network.cover', {
    profileId: props.profileId,
    entryId: props.entryId
  })
  if (!result || disposed) return
  const thumb = await downscaleCoverDataUrl(result)
  cacheThumb(key, thumb)
  if (!disposed) src.value = thumb
})

onBeforeUnmount(() => {
  disposed = true
})
</script>

<template>
  <img v-if="src" :src="src" class="network-cover-thumb" alt="" loading="lazy" />
  <span v-else class="network-cover-placeholder"><i class="pi pi-music"></i></span>
</template>

<style scoped>
.network-cover-thumb {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  object-fit: cover;
}

.network-cover-placeholder {
  display: inline-flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: color-mix(in srgb, var(--te-primary-500) 8%, transparent);
  color: var(--te-settings-text-muted);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
}
</style>
