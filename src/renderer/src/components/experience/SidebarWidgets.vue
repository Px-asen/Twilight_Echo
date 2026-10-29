<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { InstalledExperience } from '../../../../shared/pluginExperience.ts'
import { usePluginFlyout } from '../../stores/usePluginFlyout'
import EmbeddedExperience from './EmbeddedExperience.vue'

const props = defineProps<{ experiences: InstalledExperience[] }>()
const flyout = usePluginFlyout()
const collapsed = ref(new Set<string>())
const rail = ref(document.documentElement.dataset.teNavigationStyle === 'rail')
let observer: MutationObserver | undefined
const key = (experience: InstalledExperience) => `${experience.pluginId}:${experience.id}`
const bodyId = (experience: InstalledExperience) => `sidebar-widget-${key(experience)}`
const expanded = (experience: InstalledExperience) =>
  rail.value
    ? flyout.target.value?.pluginId === experience.pluginId &&
      flyout.target.value?.experienceId === experience.id
    : !collapsed.value.has(key(experience))

function toggle(experience: InstalledExperience): void {
  if (rail.value) {
    flyout.toggle({
      pluginId: experience.pluginId,
      experienceId: experience.id,
      title: experience.name
    })
  } else if (collapsed.value.has(key(experience))) collapsed.value.delete(key(experience))
  else collapsed.value.add(key(experience))
}

onMounted(() => {
  observer = new MutationObserver(() => {
    const next = document.documentElement.dataset.teNavigationStyle === 'rail'
    if (rail.value && !next) closeOwnedFlyout()
    rail.value = next
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-te-navigation-style']
  })
})
function closeOwnedFlyout(): void {
  const target = flyout.target.value
  if (
    props.experiences.some(
      (entry) => entry.pluginId === target?.pluginId && entry.id === target?.experienceId
    )
  )
    flyout.close()
}
onBeforeUnmount(() => {
  observer?.disconnect()
  closeOwnedFlyout()
})
</script>

<template>
  <div class="sidebar-widgets" :class="{ 'is-rail': rail }">
    <section
      v-for="experience in experiences"
      :key="`${key(experience)}:${experience.version}`"
      class="sidebar-widget"
      :aria-label="experience.name"
    >
      <button
        type="button"
        class="sidebar-widget-toggle"
        :aria-label="experience.name"
        :aria-expanded="expanded(experience)"
        :aria-controls="rail ? undefined : bodyId(experience)"
        :title="experience.name"
        @click="toggle(experience)"
      >
        <svg class="widget-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <rect x="3" y="3" width="5" height="5" rx="1" />
          <rect x="12" y="3" width="5" height="5" rx="1" />
          <rect x="3" y="12" width="5" height="5" rx="1" />
          <rect x="12" y="12" width="5" height="5" rx="1" />
        </svg>
        <span class="widget-title">{{ experience.name }}</span>
        <i
          class="widget-chevron pi"
          :class="expanded(experience) ? 'pi-angle-down' : 'pi-angle-right'"
          aria-hidden="true"
        ></i>
      </button>
      <div v-if="!rail" :id="bodyId(experience)">
        <div
          v-if="expanded(experience)"
          class="sidebar-widget-body"
          :style="{ height: `${experience.sidebar?.height ?? 144}px` }"
        >
          <EmbeddedExperience :experience="experience" @exit="collapsed.add(key(experience))" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.sidebar-widgets {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.sidebar-widget {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--te-navigation-border);
  border-radius: var(--te-control-radius-lg, 10px);
  background: color-mix(in srgb, var(--te-card-bg) 48%, transparent);
  color: var(--te-chrome-text, var(--te-navigation-text));
}

.sidebar-widget-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  min-height: 36px;
  padding: 6px 10px;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  font: 600 calc(var(--te-font-size-body, 14px) * 12 / 14) / 1.4 var(--te-font-sans);
  text-align: left;
  cursor: pointer;
}

.sidebar-widget-toggle:hover {
  background: var(--te-navigation-hover);
}

.sidebar-widget-toggle:focus-visible {
  outline: 2px solid var(--te-navigation-indicator);
  outline-offset: -2px;
}

.widget-icon {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  color: var(--te-navigation-icon);
  stroke: currentColor;
  stroke-width: 1.4;
}

.widget-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.widget-chevron {
  flex-shrink: 0;
  color: var(--te-navigation-icon);
}

.sidebar-widget-body {
  max-height: 55vh;
}

.is-rail .sidebar-widget {
  border: 0;
  background: transparent;
}

.is-rail .sidebar-widget-toggle {
  justify-content: center;
  width: 44px;
  height: 40px;
  margin-left: 6px;
  padding: 0;
}

.is-rail .widget-title,
.is-rail .widget-chevron {
  display: none;
}
</style>
