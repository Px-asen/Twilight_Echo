import { computed, ref } from 'vue'
import type { InstalledExperience } from '../../../shared/pluginExperience.ts'

export interface PluginFlyoutTarget {
  pluginId: string
  title: string
  /** Specific sidebar widget. Omit to retain the titlebar's first panel target. */
  experienceId?: string
}

const target = ref<PluginFlyoutTarget | null>(null)

export function findFlyoutExperience(
  experiences: InstalledExperience[],
  target: PluginFlyoutTarget | null
): InstalledExperience | null {
  if (!target) return null
  return (
    experiences.find(
      (entry) =>
        entry.pluginId === target.pluginId &&
        (target.experienceId
          ? entry.id === target.experienceId &&
            (entry.launch === 'sidebar' || entry.launch === 'panel')
          : entry.launch === 'panel')
    ) ?? null
  )
}

/** Host-owned flyout for titlebar panels and widgets in icon-only navigation. */
export function usePluginFlyout() {
  return {
    target: computed(() => target.value),
    open(next: PluginFlyoutTarget): void {
      target.value = next
    },
    toggle(next: PluginFlyoutTarget): void {
      target.value =
        target.value?.pluginId === next.pluginId && target.value?.experienceId === next.experienceId
          ? null
          : next
    },
    close(): void {
      target.value = null
    }
  }
}
