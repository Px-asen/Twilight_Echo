import { normalizeAppearanceLayers } from '../../../shared/appearanceLayers.ts'
import type { AppSettings } from '../../../shared/appSettings.ts'
import { cloneAppearance, type AppearanceDraft } from '../../../shared/appAppearance.ts'
import type { ThemeProfileV2 } from '../../../shared/theme.ts'

export async function persistAppearanceLayers(
  draft: AppearanceDraft,
  options: {
    settings: AppearanceDraft
    theme?: AppSettings['theme']
    profile: ThemeProfileV2 | null
    saveProfile: (profile: ThemeProfileV2) => Promise<unknown>
    updateSettings: (patch: Partial<AppSettings>) => Promise<unknown>
  }
): Promise<void> {
  const tonePatch = options.theme === undefined ? {} : { theme: options.theme }
  if (!options.profile) {
    await options.updateSettings({ ...draft, ...tonePatch })
    return
  }
  const layers = normalizeAppearanceLayers(draft.appearanceLayers)
  const baseline = normalizeAppearanceLayers(
    options.profile.appearanceLayers ?? options.settings.appearanceLayers
  )
  let layersSaved = false
  if (JSON.stringify(layers) !== JSON.stringify(baseline)) {
    await options.saveProfile({
      ...options.profile,
      updatedAt: new Date().toISOString(),
      appearanceLayers: layers
    })
    layersSaved = true
  }
  const patch = cloneAppearance(draft)
  const confirmed = cloneAppearance(options.settings)
  delete patch.appearanceLayers
  delete confirmed.appearanceLayers
  if (JSON.stringify(patch) === JSON.stringify(confirmed) && options.theme === undefined) return
  try {
    await options.updateSettings({ ...patch, ...tonePatch })
  } catch (cause) {
    if (!layersSaved) throw cause
    throw new Error(
      '主题图层已保存，其他外观设置未能保存。' +
        (cause instanceof Error ? cause.message : String(cause))
    )
  }
}
