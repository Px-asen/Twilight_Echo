<script setup lang="ts">
import CoverImg from '../CoverImg.vue'

defineProps<{
  cover?: string | null
  coverSource?: string | null
  identity?: string
  name: string
  eager?: boolean
}>()
</script>

<template>
  <div class="album-artwork">
    <CoverImg
      :cover="cover"
      :cover-source="coverSource"
      :identity="identity"
      :alt="`${name}专辑封面`"
      :loading="eager ? 'eager' : 'lazy'"
      class="album-artwork-image"
    >
    </CoverImg>
  </div>
</template>

<style scoped>
.album-artwork {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: var(--te-library-cover-radius, 8px);
  background: var(--te-card-bg);
  box-shadow: none;
}
.album-artwork-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
