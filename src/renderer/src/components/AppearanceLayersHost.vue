<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import type { AppearanceLayersSettings } from '../../../shared/appearanceLayers'
import { mountAppearanceLayers } from '../app/appearanceLayersRuntime'
const props = defineProps<{ settings?: AppearanceLayersSettings }>()
let runtime: ReturnType<typeof mountAppearanceLayers> | undefined
let rootObserver: MutationObserver | undefined
function update(): void {
  runtime?.update(
    props.settings,
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  )
}
watch(() => props.settings, update, { deep: true })
onMounted(() => {
  runtime = mountAppearanceLayers(document)
  rootObserver = new MutationObserver(update)
  rootObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-te-surface-material']
  })
  update()
})
onBeforeUnmount(() => {
  rootObserver?.disconnect()
  runtime?.dispose()
})
</script>
<template><span hidden aria-hidden="true" /></template>
