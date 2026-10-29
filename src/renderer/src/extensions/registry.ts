import { computed, ref } from 'vue'
import { useCoreConnection } from '../stores/coreConnection.ts'
import { corePlugins } from './corePlugins.ts'
import type { InstalledExperience } from '../../../shared/pluginExperience.ts'
import type { StructuredPluginTheme } from '../../../shared/theme.ts'
import { useAppNoticeStore } from '../stores/useAppNoticeStore.ts'

export type UiContributionKind =
  | 'sidebarPage'
  | 'playerBarButton'
  | 'settingsPanel'
  | 'localSidebarItem'
  | 'streamingHome'
  | 'titleBarButton'

export interface UiContribution {
  experience?: InstalledExperience
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
const experienceContributions = ref<InstalledExperience[]>([])
const syncInFlight = ref<Promise<void> | null>(null)
let listenerSetup = false
export function useExtensionRegistry(options: { listen?: boolean } = {}) {
  if (options.listen !== false) setupExtensionChangeListener()
  return {
    uiContributions: computed(() => uiContributions.value),
    themeContributions: computed(() => themeContributions.value),
    experiences: computed(() => experienceContributions.value),
    sidebarExperiences: computed(() =>
      experienceContributions.value.filter((experience) => experience.launch === 'sidebar')
    ),
    syncExtensions
  }
}

function setupExtensionChangeListener(): void {
  if (listenerSetup) return
  listenerSetup = true
  corePlugins.onChanged(() => {
    void syncExtensions()
  })
  useCoreConnection().subscribe((message) => {
    if (message.kind !== 'plugin-notice' || message.epoch !== useCoreConnection().state.value?.epoch) return
    const notice = message.notice
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
  const core = useCoreConnection()

  syncInFlight.value = (async () => {
    const entries = await core.query('extensions.list', {})
    const experiences = await core.query('extensions.experiences', {})
    experienceContributions.value = experiences as InstalledExperience[]
    const nextUi: UiContribution[] = []
    for (const experience of experiences) {
      // Embedded experiences are mounted separately; neither is a page or startup interface.
      if (experience.launch === 'panel' || experience.launch === 'sidebar') continue
      nextUi.push({
        pluginId: experience.pluginId,
        id: experience.id,
        kind: 'sidebarPage',
        title: experience.name,
        icon: 'pi pi-box',
        experience
      })
    }
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
