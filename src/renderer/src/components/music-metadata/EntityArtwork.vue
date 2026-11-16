<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { MusicArtwork } from '../../../../shared/musicArtwork.ts'
import CoverImg from '../CoverImg.vue'
import MetadataAttribution from './MetadataAttribution.vue'
import { musicBrainzReferenceUrl } from './musicCreditsView.ts'

const props = defineProps<{ artwork: MusicArtwork; name: string; busy?: boolean }>()
const emit = defineEmits<{ refresh: [] }>()
const failed = ref(false)
const expired = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
// Remove already-painted images at expiry too; an expired grant alone cannot
// remove a bitmap Chromium has already decoded.
watch(
  () => props.artwork,
  (artwork) => {
    clearTimeout(timer)
    failed.value = false
    expired.value = false
    const checkExpiry = () => {
      const remaining = (artwork.usage.expiresAt ?? Infinity) - Date.now()
      expired.value = remaining <= 0
      if (!expired.value && Number.isFinite(remaining))
        timer = setTimeout(checkExpiry, Math.min(remaining, 2147483647))
    }
    checkExpiry()
  },
  { immediate: true }
)
onBeforeUnmount(() => clearTimeout(timer))
const label = computed(() =>
  props.artwork.scope === 'artist'
    ? '人物图片'
    : props.artwork.scope === 'release'
      ? '具体发行封面'
      : '专辑作品图片'
)
const releaseUrl = computed(() =>
  props.artwork.sourceReleaseId
    ? musicBrainzReferenceUrl({
        provider: 'musicbrainz',
        kind: 'release',
        idType: 'mbid',
        value: props.artwork.sourceReleaseId
      })
    : null
)
function openRelease() {
  if (releaseUrl.value) void window.api.shell.openExternal(releaseUrl.value)
}
</script>

<template>
  <figure class="entity-artwork">
    <div class="artwork-frame" :class="{ portrait: artwork.scope === 'artist' }">
      <CoverImg
        v-if="!expired"
        :cover="artwork.handle"
        :identity="artwork.handle"
        size="grid"
        :alt="`${name} · ${label}`"
        fallback=""
        loading="lazy"
        @error="failed = true"
      >
        <template #placeholder>
          <span class="artwork-placeholder" role="status">
            {{ failed ? '图片暂不可用' : '正在加载图片…' }}
          </span>
        </template>
      </CoverImg>
      <span v-else class="artwork-placeholder" role="status">图片授权已过期</span>
    </div>
    <figcaption>
      <strong>{{ label }}</strong>
      <p v-if="artwork.sourceReleaseId">
        {{
          artwork.scope === 'album_project'
            ? '取自关联发行，不代表当前具体发行：'
            : '图片所属发行：'
        }}
        <a v-if="releaseUrl" :href="releaseUrl" @click.prevent="openRelease()">{{
          artwork.sourceReleaseId
        }}</a>
        <span v-else>{{ artwork.sourceReleaseId }}</span>
      </p>
      <MetadataAttribution :attribution="artwork.attribution" />
      <button v-if="failed || expired" type="button" :disabled="busy" @click="emit('refresh')">
        重新读取图片
      </button>
    </figcaption>
  </figure>
</template>

<style scoped>
.entity-artwork {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin: 16px 0;
}
.artwork-frame {
  width: 144px;
  aspect-ratio: 1;
  flex: none;
  overflow: hidden;
  border-radius: 8px;
  background: var(--te-hover-bg);
}
.portrait {
  border-radius: 50%;
}
.artwork-frame :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.artwork-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 16px;
  box-sizing: border-box;
  text-align: center;
  color: var(--te-neutral-500);
}
figcaption {
  min-width: 0;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
figcaption > strong,
figcaption > span {
  display: block;
}
p {
  margin: 6px 0;
}
button,
a {
  color: var(--te-primary-600);
  font: inherit;
}
button {
  display: block;
  border: 0;
  border-radius: 6px;
  margin-top: 8px;
  padding: 6px 10px;
  background: var(--te-hover-bg);
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:focus-visible,
a:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
@media (max-width: 540px) {
  .entity-artwork {
    flex-direction: column;
  }
}
</style>
