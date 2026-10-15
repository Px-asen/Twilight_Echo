<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AppBackgroundPage } from '../../../shared/appSettings.ts'
import { mountBackgroundImageFallback } from '../app/backgroundImageFallback'
const props = defineProps<{
  page: AppBackgroundPage | 'app'
  embedded?: boolean
  reading?: boolean
  ambient?: boolean
}>()
const layer = ref<HTMLElement>()
let fallback: ReturnType<typeof mountBackgroundImageFallback> | undefined
onMounted(() => {
  if (layer.value) fallback = mountBackgroundImageFallback(layer.value)
})
watch(
  () => props.page,
  () => fallback?.refresh(),
  { flush: 'post' }
)
onBeforeUnmount(() => fallback?.dispose())
const style = computed(() =>
  Object.fromEntries(
    [
      ['color', `var(--te-${props.page}-bg)`],
      ['image', `var(--te-${props.page}-bg-image, none)`],
      ...['blur', 'brightness', 'dim', 'scale', 'position'].map((field) => [
        field,
        `var(--te-${props.page}-background-${field})`
      ])
    ].map(([field, value]) => [`--appearance-${field}`, value])
  )
)
</script>
<template>
  <div
    ref="layer"
    class="app-background-layer"
    data-te-material="canvas"
    :class="{
      'app-background-layer--embedded': embedded,
      'app-background-layer--reading': reading
    }"
    :data-background-page="page"
    :style="style"
    aria-hidden="true"
  >
    <div class="app-background-image" />
    <div class="app-background-dim" />
    <div v-if="reading" class="app-background-reading-wash" />
  </div>
  <div v-if="ambient" class="app-background-ambient" aria-hidden="true" />
</template>
