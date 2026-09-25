import { computed, ref } from 'vue'
import type { StructuredPluginTheme } from '../../../shared/theme.ts'
import { useAppNoticeStore } from '../stores/useAppNoticeStore'

export type UiContributionKind =
  | 'sidebarPage'
  | 'playerBarButton'
  | 'settingsPanel'
  | 'localSidebarItem'
  | 'streamingHome'

export interface UiContribution {
  pluginId: string
  id: string
  kind: UiContributionKind
  title: string
  description?: string
  icon?: string
  command?: string
  /** Legacy transport field. The host always normalizes this to command-only rendering. */
  renderMode?: 'command'
  autoLoad?: boolean
}

export interface ThemeContribution {
  pluginId: string
  id: string
  name: string
  description?: string
  variables?: Record<string, string>
  stylesheet?: string
  structured?: StructuredPluginTheme
  compatibilityNotes?: string[]
}

interface PluginExtensionContribution {
  pluginId: string
  ui: UiContribution[]
  themes: ThemeContribution[]
}

const uiContributions = ref<UiContribution[]>([])
const themeContributions = ref<ThemeContribution[]>([])
const syncInFlight = ref<Promise<void> | null>(null)
let listenerSetup = false

export function useExtensionRegistry() {
  setupExtensionChangeListener()
  return {
    uiContributions: computed(() => uiContributions.value),
    themeContributions: computed(() => themeContributions.value),
    syncExtensions
  }
}

function setupExtensionChangeListener(): void {
  if (listenerSetup) return
  listenerSetup = true
  window.api.plugins.onChanged(() => {
    void syncExtensions()
  })
  window.api.plugins.onNotice((notice) => {
    useAppNoticeStore().pushNotice({
      kind: notice.kind,
      message: notice.message,
      durationMs: notice.durationMs,
      dedupeKey: `plugin-notice:${notice.pluginId}:${notice.kind}`
    })
  })
}

export async function syncExtensions(): Promise<void> {
  if (syncInFlight.value) return syncInFlight.value
  const api = window.api?.extensions
  if (!api) return

  syncInFlight.value = (async () => {
    const entries = await api.list()
    const nextUi: UiContribution[] = []
    const nextThemes: ThemeContribution[] = []
    for (const entry of entries as PluginExtensionContribution[]) {
      nextUi.push(
        ...entry.ui.map((contribution) => ({
          ...contribution,
          pluginId: entry.pluginId
        }))
      )
      nextThemes.push(
        ...entry.themes.map((theme) => ({
          ...theme,
          pluginId: entry.pluginId
        }))
      )
    }
    uiContributions.value = nextUi
    themeContributions.value = nextThemes
  })()

  try {
    await syncInFlight.value
  } finally {
    syncInFlight.value = null
  }
}
