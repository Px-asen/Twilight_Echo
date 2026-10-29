<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { findFlyoutExperience, usePluginFlyout } from '../stores/usePluginFlyout'
import { useExtensionRegistry } from '../extensions/registry.ts'
import EmbeddedExperience from './experience/EmbeddedExperience.vue'
import { useEscapeToClose, useFocusTrap } from '../app/useDismissLayer'

/**
 * Right-side flyout hosting a plugin panel experience. Deliberately does NOT
 * reuse ExperienceView: that component is built for the full-interface mode —
 * it teleports a fixed full-window surface and marks the app shell inert.
 * A flyout keeps the main interface live and shares its iframe lifecycle with
 * inline sidebar widgets, not with the full-window ExperienceView.
 */
const flyout = usePluginFlyout()
const { experiences } = useExtensionRegistry({ listen: false })
const target = computed(() => flyout.target.value)
const experience = computed(() => findFlyoutExperience(experiences.value ?? [], target.value))
watch(experience, (next, previous) => {
  if (!next && previous?.launch === 'sidebar') flyout.close()
})
const container = ref<HTMLElement | null>(null)
const active = computed(() => !!target.value && !!experience.value)
useEscapeToClose(active, () => flyout.close())
useFocusTrap(container, active)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="target && experience"
      ref="container"
      class="experience-flyout"
      role="dialog"
      aria-modal="true"
      :aria-label="target.title"
    >
      <div class="experience-flyout-backdrop" @click="flyout.close()"></div>
      <section class="experience-flyout-panel">
        <header class="experience-flyout-header">
          <span class="experience-flyout-title">{{ target.title }}</span>
          <button
            type="button"
            class="experience-flyout-close"
            aria-label="关闭面板"
            title="关闭面板"
            @click="flyout.close()"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m3.5 3.5 9 9m0-9-9 9" />
            </svg>
          </button>
        </header>
        <div class="experience-flyout-body">
          <EmbeddedExperience
            :key="`${experience.pluginId}:${experience.id}:${experience.version}`"
            :experience="experience"
            @exit="flyout.close()"
          />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.experience-flyout {
  position: fixed;
  inset: 0;
  z-index: 9500;
  pointer-events: none;
}

.experience-flyout-backdrop {
  position: absolute;
  inset: 0;
  pointer-events: auto;
  background: rgb(0 0 0 / 28%);
}

.experience-flyout-panel {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  width: min(420px, 94vw);
  display: flex;
  flex-direction: column;
  pointer-events: auto;
  background: var(--te-app-bg, #141418);
  border-left: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  box-shadow: -18px 0 48px rgb(0 0 0 / 38%);
  animation: experience-flyout-in 0.22s var(--te-ease-soft, ease-out);
}

@keyframes experience-flyout-in {
  from {
    transform: translateX(24px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.experience-flyout-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 40px;
  min-height: 40px;
  padding: 0 4px 0 16px;
  font-family: var(--te-font-sans);
  font-size: 13px;
  font-weight: 600;
  color: var(--te-shell-control-text, #e8e8ee);
  border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}

.experience-flyout-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.experience-flyout-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.experience-flyout-close:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}

.experience-flyout-close svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
}

.experience-flyout-body {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
}

@media (prefers-reduced-motion: reduce) {
  .experience-flyout-panel {
    animation: none;
  }
}
</style>
