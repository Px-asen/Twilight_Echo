<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import { useThemeStore } from '@renderer/stores/useThemeStore'
import { useMusicStore } from '@renderer/stores/useMusicStore'
import type { StreamingPageTab } from '@renderer/app/navigationPages'

const OnlineDashboard = defineAsyncComponent(() => import('./OnlineDashboard.vue'))
defineProps<{ preview?: boolean }>()
const { tracks } = useMusicStore()

const LocalDashboard = defineAsyncComponent(() => import('@renderer/components/LocalDashboard.vue'))
const ArchiveDashboard = defineAsyncComponent(
  () => import('@renderer/components/local-dashboard/ArchiveDashboard.vue')
)
const NightHarborDashboard = defineAsyncComponent(
  () => import('@renderer/components/local-dashboard/NightHarborDashboard.vue')
)
const SoundFieldDashboard = defineAsyncComponent(
  () => import('@renderer/components/local-dashboard/SoundFieldDashboard.vue')
)
const { presetLayout } = useThemeStore()

const emit = defineEmits<{
  'select-view': [category: string, filter: string | null]
  'open-library-settings': []
  'open-streaming': [tab: StreamingPageTab]
  'open-plugins': []
  'open-radio': []
  login: [providerId: string]
}>()
</script>

<template>
  <div class="local-home-layout">
    <OnlineDashboard
      v-if="!preview && tracks.length === 0"
      @select-view="(category, filter) => emit('select-view', category, filter)"
      @open-library-settings="emit('open-library-settings')"
      @open-streaming="emit('open-streaming', $event)"
      @open-plugins="emit('open-plugins')"
      @open-radio="emit('open-radio')"
      @login="emit('login', $event)"
    />
    <component
      v-else
      :is="
        presetLayout === 'aurora-reference'
          ? ArchiveDashboard
          : presetLayout === 'obsidian-glass'
            ? NightHarborDashboard
            : presetLayout === 'paper-light'
              ? SoundFieldDashboard
              : LocalDashboard
      "
      @select-view="
        (category: string, filter: string | null) => emit('select-view', category, filter)
      "
      @open-library-settings="emit('open-library-settings')"
    />
  </div>
</template>

<style scoped>
.local-home-layout {
  --te-home-titlebar-clearance: var(--te-titlebar-inset, 35px);
  width: 100%;
  height: 100%;
  min-width: 0;
}
/* Custom shells already place content below their titlebar grid row. */
:global(html[data-te-shell-layout='custom']) .local-home-layout {
  --te-home-titlebar-clearance: 0px;
}
</style>
