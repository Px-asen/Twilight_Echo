import {
  normalizeThemeProfile,
  type ThemeProfileV2,
  type ThemeTone
} from '../../../../shared/theme'

const recoveryKey = 'twilightecho.appearance-recovery'

export interface ThemeStudioRecovery {
  draft: ThemeProfileV2
  selectedKey: string
  tone: ThemeTone
  dirty: true
  savedDraft?: string
}

export function readThemeStudioRecovery(): ThemeStudioRecovery | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(recoveryKey) ?? 'null')
    const draft = normalizeThemeProfile(value?.draft)
    if (!draft || value.dirty !== true || typeof value.selectedKey !== 'string') return null
    return {
      draft,
      selectedKey: value.selectedKey,
      tone: value.tone === 'dark' ? 'dark' : 'pureWhite',
      dirty: true,
      ...(typeof value.savedDraft === 'string' ? { savedDraft: value.savedDraft } : {})
    }
  } catch {
    return null
  }
}

export function storeThemeStudioRecovery(value: ThemeStudioRecovery | null): void {
  try {
    if (value) window.sessionStorage.setItem(recoveryKey, JSON.stringify(value))
    else window.sessionStorage.removeItem(recoveryKey)
  } catch {
    // A full or unavailable session store must not prevent editing or applying a theme.
  }
}
